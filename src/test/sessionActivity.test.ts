/**
 * The active / History rule, which both the panel and Telegram now apply.
 *
 * It used to be a closure inside the view provider, reachable only by a test that could build a
 * webview. As a pure function every branch is directly checkable — and that matters more than
 * usual here, because a session wrongly filed under History is a session silently hidden from
 * both surfaces at once.
 */

import { describe, expect, it } from 'vitest';
import type { ClaudeSession } from '../SessionManager';
import {
  DEFAULT_PROBELESS_ACTIVE_WINDOW_MINUTES,
  STALE_FALLBACK_WINDOW_MS,
  isActiveSession,
  partitionByActivity,
} from '../sessionActivity';

const NOW = new Date('2026-09-01T12:00:00Z').getTime();
const PROBELESS_WINDOW_MS = DEFAULT_PROBELESS_ACTIVE_WINDOW_MINUTES * 60_000;

function session(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 'sid',
    projectName: 'app',
    projectPath: '/work/app',
    title: 'fix the sort order',
    updatedAt: new Date(NOW - 60_000),
    status: 'dormant',
    source: 'claude',
    ...over,
  };
}

function inputs(over: Partial<Parameters<typeof isActiveSession>[1]> = {}) {
  return {
    claudeOpenIds: new Set<string>(),
    bobOpenIds: new Set<string>(),
    probelessWindowMs: PROBELESS_WINDOW_MS,
    nowMs: NOW,
    ...over,
  };
}

describe('isActiveSession — a probe report is authoritative while work is moving', () => {
  it('counts a working session a window reports open, however old', () => {
    // Someone is in this session right now. The transcript's own age says nothing.
    const old = session({ updatedAt: new Date(NOW - 30 * 86400_000), status: 'working' });
    expect(isActiveSession(old, inputs({ claudeOpenIds: new Set(['sid']) }))).toBe(true);
  });

  it('drops a finished session a window reports open once it has gone quiet', () => {
    // The case this bound exists for: a remote IDE's extension host outlives the client window it
    // belonged to, so it keeps publishing a registry entry — alive by `process.kill`, with nobody
    // sitting in front of it. An open tab is not work in progress.
    const abandoned = session({
      status: 'finished',
      updatedAt: new Date(NOW - STALE_FALLBACK_WINDOW_MS - 1_000),
    });
    expect(isActiveSession(abandoned, inputs({ claudeOpenIds: new Set(['sid']) }))).toBe(false);
  });

  it('keeps a finished session a window reports open while it is still recent', () => {
    // You have just read the result and may still act on it. Only age moves it out.
    const fresh = session({ status: 'finished', updatedAt: new Date(NOW - 60_000) });
    expect(isActiveSession(fresh, inputs({ claudeOpenIds: new Set(['sid']) }))).toBe(true);
  });

  it('counts an open session sitting exactly on the bound', () => {
    // The comparison is inclusive, so the two branches meet at the same instant rather than
    // leaving a one-millisecond hole where a session is in neither list's reasoning.
    const edge = session({
      status: 'seen',
      updatedAt: new Date(NOW - STALE_FALLBACK_WINDOW_MS),
    });
    expect(isActiveSession(edge, inputs({ claudeOpenIds: new Set(['sid']) }))).toBe(true);
  });

  it('counts a Bob task a window reports open', () => {
    const task = session({ source: 'bob', status: 'seen' });
    expect(isActiveSession(task, inputs({ bobOpenIds: new Set(['sid']) }))).toBe(true);
  });

  it('does not read a Bob task id out of the Claude set, or the reverse', () => {
    // The two id spaces are unrelated; crossing them would make one agent's session vouch for
    // another's.
    const bob = session({ source: 'bob', status: 'seen' });
    expect(isActiveSession(bob, inputs({ claudeOpenIds: new Set(['sid']) }))).toBe(false);
    const claude = session({ status: 'seen' });
    expect(isActiveSession(claude, inputs({ bobOpenIds: new Set(['sid']) }))).toBe(false);
  });
});

describe('isActiveSession — blocked on you never ages out', () => {
  it('keeps a session waiting on your approval, at any age', () => {
    // Stuck, not stale. Filing it under History hides the one row you actually need to see.
    const ancient = session({ status: 'approval', updatedAt: new Date(NOW - 90 * 86400_000) });
    expect(isActiveSession(ancient, inputs())).toBe(true);
  });

  it('keeps a session waiting on an answer, at any age', () => {
    const ancient = session({ status: 'question', updatedAt: new Date(NOW - 90 * 86400_000) });
    expect(isActiveSession(ancient, inputs())).toBe(true);
  });
});

describe('isActiveSession — the working fallback is bounded', () => {
  it('keeps a recently working session even with no probe report', () => {
    // Survives a momentary probe failure: a WSL2 or inspector hiccup must not empty the worklist.
    const recent = session({ status: 'working', updatedAt: new Date(NOW - 60_000) });
    expect(isActiveSession(recent, inputs())).toBe(true);
  });

  it('drops a working session whose transcript stopped changing long ago', () => {
    // The status came from a file that will never be written again. Without the bound, one
    // abandoned mid-turn transcript sits in the worklist forever.
    const stale = session({
      status: 'working',
      updatedAt: new Date(NOW - STALE_FALLBACK_WINDOW_MS - 1_000),
    });
    expect(isActiveSession(stale, inputs())).toBe(false);
  });

  it('drops a finished or seen session that no window reports open', () => {
    expect(isActiveSession(session({ status: 'finished' }), inputs())).toBe(false);
    expect(isActiveSession(session({ status: 'seen' }), inputs())).toBe(false);
    expect(isActiveSession(session({ status: 'dormant' }), inputs())).toBe(false);
  });
});

describe('isActiveSession — probeless sources fall back to recency', () => {
  it('counts a recent Codex session, whatever its status says', () => {
    // Codex exposes no liveness signal at all, so its status can only ever be a guess. Recency is
    // the one honest proxy left.
    const recent = session({ source: 'codex', status: 'dormant' });
    expect(isActiveSession(recent, inputs())).toBe(true);
  });

  it('drops a Codex session older than the window', () => {
    const old = session({
      source: 'codex', updatedAt: new Date(NOW - PROBELESS_WINDOW_MS - 1_000),
    });
    expect(isActiveSession(old, inputs())).toBe(false);
  });

  it('treats VS Code Chat the same way', () => {
    const chat = session({ source: 'chat', status: 'dormant' });
    expect(isActiveSession(chat, inputs())).toBe(true);
  });

  it('honours a zero window as "never active on recency alone"', () => {
    const codex = session({ source: 'codex', updatedAt: new Date(NOW - 1) });
    expect(isActiveSession(codex, inputs({ probelessWindowMs: 0 }))).toBe(false);
  });
});

describe('partitionByActivity', () => {
  it('splits the two lists and keeps the given order in both', () => {
    // The caller sorts by recency before calling, and the panel's cap is applied to that order —
    // so a partition that reordered would silently drop the wrong rows.
    const sessions = [
      session({ sessionId: 'a', status: 'approval' }),
      session({ sessionId: 'b', status: 'seen' }),
      session({ sessionId: 'c', status: 'question' }),
      session({ sessionId: 'd', status: 'dormant' }),
    ];
    const { active, history } = partitionByActivity(sessions, inputs());
    expect(active.map(s => s.sessionId)).toEqual(['a', 'c']);
    expect(history.map(s => s.sessionId)).toEqual(['b', 'd']);
  });

  it('puts every session in exactly one list', () => {
    const sessions = [
      session({ sessionId: 'a', status: 'working' }),
      session({ sessionId: 'b', status: 'seen' }),
    ];
    const { active, history } = partitionByActivity(sessions, inputs());
    expect(active.length + history.length).toBe(sessions.length);
  });

  it('returns two empty lists for an empty fleet', () => {
    expect(partitionByActivity([], inputs())).toEqual({ active: [], history: [] });
  });
});
