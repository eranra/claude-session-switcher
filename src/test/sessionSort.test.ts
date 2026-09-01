import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_SORT,
  SESSION_SORT_MODES,
  isSessionSortMode,
  sessionSortLabel,
  sortSessions,
  toSessionSortMode,
  type SortableSession,
} from '../sessionSort';

// The whole point of the non-recency modes is that a row keeps its place while sessions update.
// That only holds if the comparators are total, so these cases pin both the grouping AND the
// stability: the same set in a different input order must come out in the same order.

function session(over: Partial<SortableSession> = {}): SortableSession {
  return {
    sessionId: 'id-1',
    projectName: 'alpha',
    title: 'a task',
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    status: 'seen',
    source: 'claude',
    ...over,
  };
}

const ids = (rows: SortableSession[]): string[] => rows.map(r => r.sessionId);

describe('sort modes', () => {
  it('lists recency as the default, and every mode has a distinct id and label', () => {
    expect(DEFAULT_SESSION_SORT).toBe('recent');
    expect(SESSION_SORT_MODES[0].id).toBe('recent');
    expect(new Set(SESSION_SORT_MODES.map(m => m.id)).size).toBe(SESSION_SORT_MODES.length);
    expect(new Set(SESSION_SORT_MODES.map(m => m.label)).size).toBe(SESSION_SORT_MODES.length);
  });

  it('accepts a known mode and rejects anything else', () => {
    expect(isSessionSortMode('hostWorkspace')).toBe(true);
    expect(isSessionSortMode('sideways')).toBe(false);
    expect(isSessionSortMode(undefined)).toBe(false);
  });

  it('falls back to the default for a value a hand-edited setting could hold', () => {
    expect(toSessionSortMode('title')).toBe('title');
    expect(toSessionSortMode('nonsense')).toBe('recent');
    expect(toSessionSortMode(7)).toBe('recent');
    expect(sessionSortLabel('nonsense')).toBe('Recently updated');
  });
});

describe('sortSessions: recent', () => {
  it('puts the newest first', () => {
    const rows = [
      session({ sessionId: 'old', updatedAt: new Date('2026-08-01T00:00:00Z') }),
      session({ sessionId: 'new', updatedAt: new Date('2026-09-01T00:00:00Z') }),
      session({ sessionId: 'mid', updatedAt: new Date('2026-08-15T00:00:00Z') }),
    ];
    expect(ids(sortSessions(rows, 'recent'))).toEqual(['new', 'mid', 'old']);
  });

  it('breaks a same-timestamp tie by session id, so equal rows never swap places', () => {
    const at = new Date('2026-09-01T00:00:00Z');
    const rows = [session({ sessionId: 'b', updatedAt: at }), session({ sessionId: 'a', updatedAt: at })];
    expect(ids(sortSessions(rows, 'recent'))).toEqual(['a', 'b']);
    expect(ids(sortSessions([...rows].reverse(), 'recent'))).toEqual(['a', 'b']);
  });

  it('does not mutate the input', () => {
    const rows = [
      session({ sessionId: 'old', updatedAt: new Date('2026-08-01T00:00:00Z') }),
      session({ sessionId: 'new', updatedAt: new Date('2026-09-01T00:00:00Z') }),
    ];
    sortSessions(rows, 'recent');
    expect(ids(rows)).toEqual(['old', 'new']);
  });
});

describe('sortSessions: machine then workspace', () => {
  it('groups this machine ahead of every peer, then by workspace and title', () => {
    const rows = [
      session({ sessionId: 'peer-b', projectName: 'zeta', peer: 'me@build.example.com' }),
      session({ sessionId: 'local-z', projectName: 'zeta' }),
      session({ sessionId: 'local-a', projectName: 'alpha' }),
      session({ sessionId: 'peer-a', projectName: 'alpha', peer: 'me@build.example.com' }),
    ];
    expect(ids(sortSessions(rows, 'hostWorkspace')))
      .toEqual(['local-a', 'local-z', 'peer-a', 'peer-b']);
  });

  it('orders peers by short host name, ignoring the user and the domain', () => {
    const rows = [
      session({ sessionId: 'on-zulu', peer: 'aaa@zulu.example.com' }),
      session({ sessionId: 'on-alpha', peer: 'zzz@alpha.example.com' }),
    ];
    expect(ids(sortSessions(rows, 'hostWorkspace'))).toEqual(['on-alpha', 'on-zulu']);
  });

  it('holds the same order no matter what order the scan produced', () => {
    const rows = [
      session({ sessionId: 'c', projectName: 'beta', title: 'b' }),
      session({ sessionId: 'a', projectName: 'alpha', title: 'z' }),
      session({ sessionId: 'b', projectName: 'alpha', title: 'a' }),
    ];
    const forward = ids(sortSessions(rows, 'hostWorkspace'));
    const backward = ids(sortSessions([...rows].reverse(), 'hostWorkspace'));
    expect(forward).toEqual(['b', 'a', 'c']);
    expect(backward).toEqual(forward);
  });

  it('ignores an updatedAt change entirely — that is what keeps rows still', () => {
    const before = [
      session({ sessionId: 'a', projectName: 'alpha', updatedAt: new Date('2026-08-01T00:00:00Z') }),
      session({ sessionId: 'b', projectName: 'beta', updatedAt: new Date('2026-08-02T00:00:00Z') }),
    ];
    const after = [
      session({ sessionId: 'a', projectName: 'alpha', updatedAt: new Date('2026-09-09T00:00:00Z') }),
      session({ sessionId: 'b', projectName: 'beta', updatedAt: new Date('2026-08-02T00:00:00Z') }),
    ];
    expect(ids(sortSessions(after, 'hostWorkspace'))).toEqual(ids(sortSessions(before, 'hostWorkspace')));
  });

  it('sorts a session with no workspace last instead of first', () => {
    const rows = [
      session({ sessionId: 'nameless', projectName: '' }),
      session({ sessionId: 'zeta', projectName: 'zeta' }),
    ];
    expect(ids(sortSessions(rows, 'hostWorkspace'))).toEqual(['zeta', 'nameless']);
  });
});

describe('sortSessions: workspace then title', () => {
  it('groups by workspace across machines', () => {
    const rows = [
      session({ sessionId: 'peer-alpha', projectName: 'alpha', peer: 'me@build' }),
      session({ sessionId: 'local-beta', projectName: 'beta' }),
      session({ sessionId: 'local-alpha', projectName: 'alpha' }),
    ];
    expect(ids(sortSessions(rows, 'workspace')))
      .toEqual(['local-alpha', 'peer-alpha', 'local-beta']);
  });

  it('compares workspace and title case-insensitively', () => {
    const rows = [
      session({ sessionId: 'upper', projectName: 'Beta', title: 'A task' }),
      session({ sessionId: 'lower', projectName: 'alpha', title: 'z task' }),
    ];
    expect(ids(sortSessions(rows, 'workspace'))).toEqual(['lower', 'upper']);
  });
});

describe('sortSessions: agent then workspace', () => {
  it('groups Claude, Bob, Codex and Chat in that order', () => {
    const rows = [
      session({ sessionId: 'chat', source: 'chat' }),
      session({ sessionId: 'bob', source: 'bob' }),
      session({ sessionId: 'claude', source: 'claude' }),
      session({ sessionId: 'codex', source: 'codex' }),
    ];
    expect(ids(sortSessions(rows, 'source'))).toEqual(['claude', 'bob', 'codex', 'chat']);
  });

  it('puts an unknown source last rather than dropping it', () => {
    const rows = [
      session({ sessionId: 'future', source: 'someNewAgent' }),
      session({ sessionId: 'chat', source: 'chat' }),
    ];
    expect(ids(sortSessions(rows, 'source'))).toEqual(['chat', 'future']);
  });
});

describe('sortSessions: title', () => {
  it('sorts alphabetically, and puts an untitled session first', () => {
    const rows = [
      session({ sessionId: 'z', title: 'zebra' }),
      session({ sessionId: 'a', title: 'apple' }),
      session({ sessionId: 'none', title: '' }),
    ];
    expect(ids(sortSessions(rows, 'title'))).toEqual(['none', 'a', 'z']);
  });
});

describe('sortSessions: needs you first', () => {
  it('orders the states most-actionable first', () => {
    const rows = [
      session({ sessionId: 'dormant', status: 'dormant' }),
      session({ sessionId: 'seen', status: 'seen' }),
      session({ sessionId: 'working', status: 'working' }),
      session({ sessionId: 'finished', status: 'finished' }),
      session({ sessionId: 'question', status: 'question' }),
      session({ sessionId: 'approval', status: 'approval' }),
    ];
    expect(ids(sortSessions(rows, 'status')))
      .toEqual(['approval', 'question', 'finished', 'working', 'seen', 'dormant']);
  });

  it('falls back to recency inside a status group', () => {
    const rows = [
      session({ sessionId: 'older', status: 'approval', updatedAt: new Date('2026-08-01T00:00:00Z') }),
      session({ sessionId: 'newer', status: 'approval', updatedAt: new Date('2026-09-01T00:00:00Z') }),
    ];
    expect(ids(sortSessions(rows, 'status'))).toEqual(['newer', 'older']);
  });
});

describe('sortSessions: bad input', () => {
  it('sorts by recency when the mode is unknown or missing', () => {
    const rows = [
      session({ sessionId: 'old', updatedAt: new Date('2026-08-01T00:00:00Z') }),
      session({ sessionId: 'new', updatedAt: new Date('2026-09-01T00:00:00Z') }),
    ];
    expect(ids(sortSessions(rows, 'gibberish'))).toEqual(['new', 'old']);
    expect(ids(sortSessions(rows))).toEqual(['new', 'old']);
  });

  it('treats an unparsable timestamp as the epoch instead of throwing', () => {
    const rows = [
      session({ sessionId: 'broken', updatedAt: new Date('not a date') }),
      session({ sessionId: 'fine', updatedAt: new Date('2026-09-01T00:00:00Z') }),
    ];
    expect(ids(sortSessions(rows, 'recent'))).toEqual(['fine', 'broken']);
  });
});
