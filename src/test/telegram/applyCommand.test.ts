import { describe, expect, it, vi } from 'vitest';

// applyCommand pulls in ClaudeSender for its status helpers, which imports 'vscode'; stub it.
vi.mock('vscode', () => ({ window: {}, extensions: { getExtension: () => undefined } }));

import { applyCommand, commandIsMine, type ApplyDeps } from '../../telegram/applyCommand';
import type { BusCommand } from '../../telegram/bus';

function command(over: Partial<BusCommand> = {}): BusCommand {
  return {
    cmdId: 'cmd-1',
    kind: 'sendText',
    sessionId: 's1',
    source: 'claude',
    text: 'run the tests',
    threadId: 42,
    issuedAt: 1000,
    ...over,
  };
}

/** Fakes for the two senders and the launcher; the real ones need a live extension host. */
function deps(over: Partial<ApplyDeps> = {}) {
  const bobSent: Array<[string, string]> = [];
  const claudeSent: Array<[string, string]> = [];
  const launched: Array<[string, string]> = [];
  const base: ApplyDeps = {
    pid: 100,
    bobSender: {
      send: async (id, text) => { bobSent.push([id, text]); },
      isAvailable: async () => true,
    },
    claudeSender: {
      send: async (id, text) => { claudeSent.push([id, text]); },
      isAvailable: async () => true,
      sendToSession: async (id, text) => { claudeSent.push([id, text]); return 'ok:matched'; },
    },
    launcher: {
      launch: async (source, workspace) => {
        launched.push([source, workspace]);
        return { ok: true, detail: 'Opened.' };
      },
      focus: async () => true,
    },
    now: () => 2000,
    ...over,
  };
  return { deps: base, bobSent, claudeSent, launched };
}

describe('applyCommand — sendText', () => {
  it('sends to Bob by task id', async () => {
    const f = deps();
    const result = await applyCommand(command({ source: 'bob' }), f.deps);
    expect(result.ok).toBe(true);
    expect(f.bobSent).toEqual([['s1', 'run the tests']]);
  });

  it('targets the named Claude session', async () => {
    const f = deps();
    const result = await applyCommand(command(), f.deps);
    expect(result.ok).toBe(true);
    expect(f.claudeSent).toEqual([['s1', 'run the tests']]);
    expect(result.detail).toContain('Sent to this session');
  });

  it('reports a Claude send that could not be targeted, and does not claim success', async () => {
    // Sending a prompt to the wrong agent is the one failure this feature must not have, so an
    // ambiguous target is a refusal — reported as such, never as a success.
    const f = deps();
    f.deps.claudeSender.sendToSession = async () => 'ambiguous:3';
    const result = await applyCommand(command(), f.deps);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('3 Claude sessions');
  });

  it('explains a closed Claude session', async () => {
    const f = deps();
    f.deps.claudeSender.sendToSession = async () => 'no-channel';
    const result = await applyCommand(command(), f.deps);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Focus in IDE');
  });

  it('accepts a sole-channel send but says which one it was', async () => {
    const f = deps();
    f.deps.claudeSender.sendToSession = async () => 'ok:sole';
    const result = await applyCommand(command(), f.deps);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('only Claude session');
  });

  it.each(['codex', 'chat'] as const)('refuses %s, which has no message API', async (source) => {
    const result = await applyCommand(command({ source }), deps().deps);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('read-only');
  });

  it('refuses empty text', async () => {
    const result = await applyCommand(command({ text: '   ' }), deps().deps);
    expect(result.ok).toBe(false);
  });
});

describe('applyCommand — focus and newSession', () => {
  it('reports a successful focus', async () => {
    const result = await applyCommand(command({ kind: 'focus' }), deps().deps);
    expect(result.ok).toBe(true);
  });

  it('reports a focus that failed', async () => {
    const f = deps();
    f.deps.launcher.focus = async () => false;
    expect((await applyCommand(command({ kind: 'focus' }), f.deps)).ok).toBe(false);
  });

  it('launches in the workspace carried by the command', async () => {
    const f = deps();
    const result = await applyCommand(
      command({ kind: 'newSession', source: 'bob', text: '/work/app', sessionId: '' }), f.deps);
    expect(result.ok).toBe(true);
    expect(f.launched).toEqual([['bob', '/work/app']]);
  });

  it('refuses to start a session for an agent that cannot be started', async () => {
    const result = await applyCommand(
      command({ kind: 'newSession', source: 'codex', text: '/work/app' }), deps().deps);
    expect(result.ok).toBe(false);
  });
});

describe('applyCommand — failure handling', () => {
  it('turns a thrown sender error into a reportable result', async () => {
    // A command that produces no result leaves the user staring at a message that vanished.
    const f = deps();
    f.deps.bobSender.send = async () => { throw new Error('inspector detached'); };
    const result = await applyCommand(command({ source: 'bob' }), f.deps);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('inspector detached');
  });

  it('rejects an unknown command kind', async () => {
    const result = await applyCommand(
      command({ kind: 'explode' as BusCommand['kind'] }), deps().deps);
    expect(result.ok).toBe(false);
  });

  it('carries the thread and pid back so the reader knows where to post', async () => {
    const result = await applyCommand(command({ source: 'bob' }), deps().deps);
    expect(result).toMatchObject({ cmdId: 'cmd-1', threadId: 42, pid: 100, finishedAt: 2000 });
  });
});

describe('commandIsMine', () => {
  it('takes a command for a session this window owns', () => {
    expect(commandIsMine(command(), 100, new Set(['s1']))).toBe(true);
  });

  it('leaves a command for a session another window owns', () => {
    expect(commandIsMine(command(), 100, new Set(['other']))).toBe(false);
  });

  it('addresses newSession by pid, since the session does not exist yet', () => {
    const cmd = command({ kind: 'newSession', sessionId: '', targetPid: 100 });
    expect(commandIsMine(cmd, 100, new Set())).toBe(true);
    expect(commandIsMine(cmd, 200, new Set())).toBe(false);
  });

  it('ignores a newSession command with no target', () => {
    expect(commandIsMine(command({ kind: 'newSession', sessionId: '' }), 100, new Set())).toBe(false);
  });
});
