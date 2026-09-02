import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MANUAL_OPEN_GRACE_MS, TopicStore, parseTopic, topicsToClose, topicsToPrune, type TopicRecord,
} from '../../telegram/topics';
import { topicsDir } from '../../telegram/bus';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-topics-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function record(over: Partial<TopicRecord> = {}): TopicRecord {
  return {
    threadId: 7,
    sessionId: 's1',
    source: 'claude',
    name: '🟠 app / a title · claude',
    mirroredTurns: 3,
    closed: false,
    lastActivityAt: 1000,
    openedAt: 500,
    createdAt: 500,
    ...over,
  };
}

describe('parseTopic', () => {
  it('round-trips a record', () => {
    expect(parseTopic(JSON.stringify(record()))).toEqual(record());
  });

  it('reads a record written before openedAt existed, using its creation time', () => {
    // An installed extension already has topic files on disk from the previous version. Treating a
    // missing openedAt as 0 would strip the grace window from every one of them.
    const legacy: Record<string, unknown> = { ...record({ createdAt: 1234 }) };
    delete legacy.openedAt;
    expect(parseTopic(JSON.stringify(legacy))?.openedAt).toBe(1234);
  });

  it('rejects a record with no thread or session', () => {
    expect(parseTopic(JSON.stringify({ sessionId: 's1' }))).toBeNull();
    expect(parseTopic(JSON.stringify({ threadId: 7 }))).toBeNull();
  });

  it('rejects an unknown source', () => {
    expect(parseTopic(JSON.stringify({ ...record(), source: 'gemini' }))).toBeNull();
  });

  it('defaults a missing cursor to zero rather than to undefined', () => {
    const rest: Record<string, unknown> = { ...record() };
    delete rest.mirroredTurns;
    expect(parseTopic(JSON.stringify(rest))?.mirroredTurns).toBe(0);
  });

  it('rejects junk', () => {
    expect(parseTopic('nope')).toBeNull();
  });
});

describe('TopicStore', () => {
  it('saves and reads a record back by thread and by session', async () => {
    const store = new TopicStore(home);
    await store.save(record());
    expect(await store.byThread(7)).toEqual(record());
    expect(await store.bySession('s1')).toEqual(record());
  });

  it('returns null for a thread or session it does not know', async () => {
    const store = new TopicStore(home);
    expect(await store.byThread(99)).toBeNull();
    expect(await store.bySession('nope')).toBeNull();
  });

  it('returns an empty list before anything is written', async () => {
    expect(await new TopicStore(home).all()).toEqual([]);
  });

  it('gives each thread its own file, so two windows never contend', async () => {
    // A single shared topics.json would be a lost-update race between windows, with no lock to
    // arbitrate it.
    const store = new TopicStore(home);
    await store.save(record({ threadId: 7, sessionId: 'a' }));
    await store.save(record({ threadId: 8, sessionId: 'b' }));
    expect(fs.readdirSync(topicsDir(home)).sort()).toEqual(['7.json', '8.json']);
    expect(await store.all()).toHaveLength(2);
  });

  it('overwrites a record in place when it is updated', async () => {
    const store = new TopicStore(home);
    await store.save(record({ mirroredTurns: 3 }));
    await store.save(record({ mirroredTurns: 9 }));
    expect((await store.byThread(7))?.mirroredTurns).toBe(9);
    expect(await store.all()).toHaveLength(1);
  });

  it('removes a record and tolerates a repeat', async () => {
    const store = new TopicStore(home);
    await store.save(record());
    await store.remove(7);
    expect(await store.byThread(7)).toBeNull();
    await expect(store.remove(7)).resolves.toBeUndefined();
  });

  it('skips a malformed file instead of failing the whole read', async () => {
    const store = new TopicStore(home);
    await store.save(record());
    fs.writeFileSync(path.join(topicsDir(home), '9.json'), 'not json');
    expect(await store.all()).toHaveLength(1);
  });

  it('sees a record another window wrote, holding no stale cache', async () => {
    const a = new TopicStore(home);
    const b = new TopicStore(home);
    expect(await b.all()).toEqual([]);
    await a.save(record());
    expect(await b.byThread(7)).not.toBeNull();
  });
});

describe('topicsToClose', () => {
  const idleMs = 24 * 3600_000;

  it('closes a topic whose session has been quiet too long', () => {
    const stale = record({ lastActivityAt: 1000 });
    expect(topicsToClose([stale], 1000 + idleMs + 1, idleMs)).toEqual([stale]);
  });

  it('leaves a recently active topic open', () => {
    expect(topicsToClose([record({ lastActivityAt: 1000 })], 1000 + 60_000, idleMs)).toEqual([]);
  });

  it('never closes an already-closed topic twice', () => {
    const closed = record({ lastActivityAt: 1000, closed: true });
    expect(topicsToClose([closed], 1000 + idleMs + 1, idleMs)).toEqual([]);
  });

  it('skips a topic with no recorded activity', () => {
    // Activity of 0 means "not known yet", not "quiet since the epoch".
    expect(topicsToClose([record({ lastActivityAt: 0 })], Date.now(), idleMs)).toEqual([]);
  });
});

describe('topicsToPrune', () => {
  // Well past MANUAL_OPEN_GRACE_MS, so the grace window is out of the way unless a test wants it.
  const LATER = 500 + MANUAL_OPEN_GRACE_MS * 10;

  it('closes the topic of a session that has left the active list', () => {
    // The group's topic list has to equal the panel's session list, or every session that ever ran
    // accumulates as a dead thread in the sidebar.
    const gone = record({ threadId: 7, sessionId: 'gone' });
    expect(topicsToPrune([gone], new Set(['still-here']), LATER)).toEqual([gone]);
  });

  it('leaves the topic of an active session alone', () => {
    const live = record({ threadId: 7, sessionId: 'live' });
    expect(topicsToPrune([live], new Set(['live']), LATER)).toEqual([]);
  });

  it('never closes an already-closed topic twice', () => {
    const closed = record({ sessionId: 'gone', closed: true });
    expect(topicsToPrune([closed], new Set<string>(), LATER)).toEqual([]);
  });

  it('spares a topic you just opened by hand', () => {
    // `/history` opens the topic of a session that is by definition not active. Closing it on the
    // next pass would make the button look broken.
    const justOpened = record({ sessionId: 'gone', openedAt: 1_000 });
    expect(topicsToPrune([justOpened], new Set<string>(), 1_000 + 60_000)).toEqual([]);
  });

  it('closes it once the grace window has passed', () => {
    const opened = record({ sessionId: 'gone', openedAt: 1_000 });
    expect(topicsToPrune([opened], new Set<string>(), 1_000 + MANUAL_OPEN_GRACE_MS + 1))
      .toEqual([opened]);
  });

  it('does not treat an unknown open time as freshly opened', () => {
    // 0 means "not recorded", so it must not buy an old topic an indefinite reprieve.
    const legacy = record({ sessionId: 'gone', openedAt: 0 });
    expect(topicsToPrune([legacy], new Set<string>(), 60_000)).toEqual([legacy]);
  });

  it('would close everything for an empty active set — which is why the caller guards it', () => {
    // Documented deliberately: this function cannot tell "nothing is active" from "the session
    // list has not loaded yet". `pruneInactiveTopics` makes that distinction before calling.
    const a = record({ threadId: 1, sessionId: 'a' });
    const b = record({ threadId: 2, sessionId: 'b' });
    expect(topicsToPrune([a, b], new Set<string>(), LATER)).toEqual([a, b]);
  });
});
