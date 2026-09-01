import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TopicStore, parseTopic, topicsToClose, type TopicRecord } from '../../telegram/topics';
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
    name: '🟡 claude · app / a title',
    mirroredTurns: 3,
    closed: false,
    lastActivityAt: 1000,
    createdAt: 500,
    ...over,
  };
}

describe('parseTopic', () => {
  it('round-trips a record', () => {
    expect(parseTopic(JSON.stringify(record()))).toEqual(record());
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
