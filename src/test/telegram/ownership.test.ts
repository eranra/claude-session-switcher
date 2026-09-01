import { describe, expect, it } from 'vitest';
import {
  isWritableSource,
  pathContains,
  resolveOwner,
  resolveOwners,
  writeBlockedReason,
} from '../../telegram/ownership';
import type { ClaudeSession } from '../../SessionManager';
import type { WindowEntry } from '../../WindowRegistry';

function session(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 's1',
    projectName: 'app',
    projectPath: '/work/app',
    title: 'a title',
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    status: 'working',
    source: 'claude',
    ...over,
  };
}

function window(over: Partial<WindowEntry> = {}): WindowEntry {
  return {
    pid: 100,
    workspaceFolders: ['/work/app'],
    ideCli: 'code',
    ipcSocket: '/tmp/sock',
    updatedAt: Date.now(),
    ...over,
  };
}

describe('pathContains', () => {
  it('matches the folder itself and its descendants', () => {
    expect(pathContains('/work/app', '/work/app')).toBe(true);
    expect(pathContains('/work/app', '/work/app/src/index.ts')).toBe(true);
  });

  it('does not let a folder claim a sibling with a shared prefix', () => {
    // The bug this guards: '/work/app' must not own a session in '/work/app-legacy'.
    expect(pathContains('/work/app', '/work/app-legacy')).toBe(false);
  });

  it('ignores a trailing separator on the folder', () => {
    expect(pathContains('/work/app/', '/work/app/sub')).toBe(true);
  });

  it('never matches on an empty folder', () => {
    expect(pathContains('', '/work/app')).toBe(false);
    expect(pathContains('/', '/work/app')).toBe(false);
  });
});

describe('resolveOwner', () => {
  it('prefers the window that actually holds the session', () => {
    const holder = window({ pid: 200, workspaceFolders: ['/elsewhere'], openClaudeSessionIds: ['s1'] });
    const byPath = window({ pid: 100, workspaceFolders: ['/work/app'] });
    const owner = resolveOwner(session(), [byPath, holder]);
    expect(owner).toEqual({ pid: 200, basis: 'holds', workspace: '/elsewhere' });
  });

  it('recognises a Bob task id as held', () => {
    const holder = window({ pid: 300, openBobTaskIds: ['task-9'] });
    const owner = resolveOwner(session({ sessionId: 'task-9', source: 'bob' }), [holder]);
    expect(owner.basis).toBe('holds');
    expect(owner.pid).toBe(300);
  });

  it('falls back to the longest containing workspace', () => {
    // The worktree case this project creates on purpose: the session's cwd is a subdirectory of
    // one window's workspace and the exact workspace of another. The deeper one must win.
    const parent = window({ pid: 100, workspaceFolders: ['/work/app'] });
    const worktree = window({ pid: 101, workspaceFolders: ['/work/app/.claude/worktrees/feat'] });
    const owner = resolveOwner(
      session({ projectPath: '/work/app/.claude/worktrees/feat' }), [parent, worktree]);
    expect(owner).toEqual({
      pid: 101, basis: 'workspace', workspace: '/work/app/.claude/worktrees/feat',
    });
  });

  it('still claims a session in a subdirectory when only the parent is open', () => {
    const parent = window({ pid: 100, workspaceFolders: ['/work/app'] });
    const owner = resolveOwner(session({ projectPath: '/work/app/.claude/worktrees/feat' }), [parent]);
    expect(owner.pid).toBe(100);
    expect(owner.basis).toBe('workspace');
  });

  it('breaks a workspace tie on the lowest pid so every window agrees', () => {
    const a = window({ pid: 400, workspaceFolders: ['/work/app'] });
    const b = window({ pid: 200, workspaceFolders: ['/work/app'] });
    expect(resolveOwner(session(), [a, b]).pid).toBe(200);
    expect(resolveOwner(session(), [b, a]).pid).toBe(200);
  });

  it('breaks a holder tie on the lowest pid too', () => {
    const a = window({ pid: 400, openClaudeSessionIds: ['s1'] });
    const b = window({ pid: 200, openClaudeSessionIds: ['s1'] });
    expect(resolveOwner(session(), [a, b]).pid).toBe(200);
  });

  it('leaves a session unowned when no window matches', () => {
    const other = window({ pid: 100, workspaceFolders: ['/somewhere/else'] });
    expect(resolveOwner(session(), [other]).basis).toBe('none');
    expect(resolveOwner(session(), []).pid).toBeNull();
  });

  it('never lets a local window own a session on another machine', () => {
    // A peer session is reachable read-only over SSH; only that machine can act on it.
    const holder = window({ pid: 100, openClaudeSessionIds: ['s1'], workspaceFolders: ['/work/app'] });
    expect(resolveOwner(session({ peer: 'me@laptop2' }), [holder]).pid).toBeNull();
  });
});

describe('resolveOwners', () => {
  it('keys the result by session id', () => {
    const windows = [window({ pid: 100 })];
    const owners = resolveOwners([session({ sessionId: 'a' }), session({ sessionId: 'b' })], windows);
    expect([...owners.keys()].sort()).toEqual(['a', 'b']);
    expect(owners.get('a')?.pid).toBe(100);
  });
});

describe('isWritableSource', () => {
  it('allows only the agents that expose a message API', () => {
    expect(isWritableSource('bob')).toBe(true);
    expect(isWritableSource('claude')).toBe(true);
    expect(isWritableSource('codex')).toBe(false);
    expect(isWritableSource('chat')).toBe(false);
  });
});

describe('writeBlockedReason', () => {
  const owned = { pid: 100, basis: 'holds' as const, workspace: '/work/app' };

  it('passes a writable, owned session', () => {
    expect(writeBlockedReason(session(), owned)).toBeNull();
  });

  it('reports a peer session by naming the machine', () => {
    const reason = writeBlockedReason(session({ peer: 'me@laptop2' }), owned);
    expect(reason).toContain('me@laptop2');
  });

  it('names the agent when the source has no message API', () => {
    expect(writeBlockedReason(session({ source: 'codex' }), owned)).toContain('Codex');
    expect(writeBlockedReason(session({ source: 'chat' }), owned)).toContain('VS Code Chat');
  });

  it('explains an unowned session rather than failing later', () => {
    const reason = writeBlockedReason(session(), { pid: null, basis: 'none', workspace: '' });
    expect(reason).toContain('No open window');
  });

  // A peer session's own machine also has no message API for Codex, but the peer message is the
  // more actionable one, so it must win.
  it('reports the peer before the source when both apply', () => {
    const reason = writeBlockedReason(session({ peer: 'me@laptop2', source: 'codex' }), owned);
    expect(reason).toContain('laptop2');
  });
});
