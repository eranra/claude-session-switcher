/**
 * The session ↔ forum-topic mapping, and how much of each session has been mirrored.
 *
 * ## Why one file per topic
 *
 * Several windows on a machine write here — each creates topics for the sessions it owns. A
 * single `topics.json` would need read-modify-write from every one of them, which is a lost-update
 * race with no locking primitive to fix it. One file per thread means writers never touch the same
 * path, so the contention disappears instead of being managed.
 *
 * ## Why the cursor matters
 *
 * Mirroring appends transcript turns as messages. Without a record of how far it got, a window
 * restart would repost a session's whole history into its topic. `mirroredTurns` is that record:
 * the number of turns already posted. It is written after a successful post, so a crash between
 * post and write repeats at most one message — the safe direction to fail.
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { topicsDir } from './bus';

export interface TopicRecord {
  /** Telegram `message_thread_id`. Also the record's filename, so it is unique by construction. */
  threadId: number;
  sessionId: string;
  /** Agent this session belongs to; kept so a command can be routed without re-scanning. */
  source: 'claude' | 'bob' | 'codex' | 'chat';
  /** The topic name last written to Telegram, so it is only edited when it actually changes. */
  name: string;
  /** How many transcript turns have already been posted into the topic. */
  mirroredTurns: number;
  /** Whether the topic is currently closed on the Telegram side. */
  closed: boolean;
  /** Last time this session showed activity — drives idle auto-close. */
  lastActivityAt: number;
  /**
   * When this topic was last opened — created, or reopened.
   *
   * Separate from `createdAt` because it is what protects a topic you opened *by hand* from being
   * closed again immediately. Asking for a history session's topic and having it vanish on the next
   * pass would make the button look broken; see `topicsToPrune`.
   */
  openedAt: number;
  createdAt: number;
}

export function parseTopic(raw: string): TopicRecord | null {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (typeof d.threadId !== 'number' || typeof d.sessionId !== 'string') { return null; }
    const source = d.source;
    if (source !== 'claude' && source !== 'bob' && source !== 'codex' && source !== 'chat') {
      return null;
    }
    return {
      threadId: d.threadId,
      sessionId: d.sessionId,
      source,
      name: typeof d.name === 'string' ? d.name : '',
      mirroredTurns: typeof d.mirroredTurns === 'number' ? d.mirroredTurns : 0,
      closed: d.closed === true,
      lastActivityAt: typeof d.lastActivityAt === 'number' ? d.lastActivityAt : 0,
      // Records written before this field existed fall back to their creation time, which is when
      // they were in fact last opened.
      openedAt: typeof d.openedAt === 'number'
        ? d.openedAt
        : (typeof d.createdAt === 'number' ? d.createdAt : 0),
      createdAt: typeof d.createdAt === 'number' ? d.createdAt : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Reads and writes topic records. Shared by every window on the machine, so it holds no cached
 * state beyond one load — a window must see topics another window created.
 */
export class TopicStore {
  private readonly dir: string;

  constructor(homedir?: string) {
    this.dir = topicsDir(homedir);
  }

  async all(): Promise<TopicRecord[]> {
    let files: string[];
    try {
      files = (await fs.promises.readdir(this.dir))
        .filter(f => f.endsWith('.json') && !f.includes('.tmp-'));
    } catch {
      return [];
    }
    const out: TopicRecord[] = [];
    for (const file of files) {
      try {
        const rec = parseTopic(await fs.promises.readFile(path.join(this.dir, file), 'utf8'));
        if (rec !== null) { out.push(rec); }
      } catch { /* malformed or vanished — skip */ }
    }
    return out;
  }

  async bySession(sessionId: string): Promise<TopicRecord | null> {
    return (await this.all()).find(t => t.sessionId === sessionId) ?? null;
  }

  async byThread(threadId: number): Promise<TopicRecord | null> {
    try {
      return parseTopic(await fs.promises.readFile(this.path(threadId), 'utf8'));
    } catch {
      return null;
    }
  }

  async save(rec: TopicRecord): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const target = this.path(rec.threadId);
    const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
    await fs.promises.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
    await fs.promises.rename(tmp, target);
  }

  async remove(threadId: number): Promise<void> {
    try { await fs.promises.unlink(this.path(threadId)); } catch { /* gone */ }
  }

  private path(threadId: number): string {
    return path.join(this.dir, `${threadId}.json`);
  }
}

/**
 * Topics whose session has been quiet longer than `idleMs` and are still open.
 *
 * They are closed rather than deleted: closing keeps the scrollback and search, and the topic is
 * reopened if the session comes back. Deleting would throw away the record of what happened.
 */
export function topicsToClose(
  topics: TopicRecord[], now: number, idleMs: number,
): TopicRecord[] {
  return topics.filter(t => !t.closed && t.lastActivityAt > 0 && now - t.lastActivityAt > idleMs);
}

/**
 * How long a freshly opened topic is left alone even though its session is not active.
 *
 * `/history` opens the topic of a session that is, by definition, not in the worklist. Without this
 * window the reader would close it on the very next pass, and the button would look broken. Long
 * enough to read a transcript and type a reply; short enough that a topic you abandon still tidies
 * itself away.
 */
export const MANUAL_OPEN_GRACE_MS = 10 * 60_000;

/**
 * Topics whose session has dropped out of the active worklist.
 *
 * The Telegram group is meant to show the same set of sessions the panel does, so a session leaving
 * the worklist has to leave the group's topic list too — otherwise every session that ever ran
 * accumulates as a thread and the sidebar becomes unreadable, which is the state this fixes.
 *
 * Closed, not deleted, for the same reason as `topicsToClose`: the scrollback and the search stay,
 * and the topic reopens by itself when the session has something new to say.
 *
 * A topic opened within `MANUAL_OPEN_GRACE_MS` is left alone, because you asked for it.
 *
 * `activeSessionIds` **must** be a set the caller actually knows. Passing an empty set because the
 * session list has not loaded yet would close every topic in the group, so the caller checks that
 * first — see `pruneInactiveTopics`.
 */
export function topicsToPrune(
  topics: TopicRecord[], activeSessionIds: ReadonlySet<string>, now: number,
  graceMs: number = MANUAL_OPEN_GRACE_MS,
): TopicRecord[] {
  return topics.filter(t => !t.closed
    && !activeSessionIds.has(t.sessionId)
    && !(t.openedAt > 0 && now - t.openedAt < graceMs));
}
