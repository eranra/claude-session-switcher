/**
 * Everything the remote-control feature shows a human, as pure functions.
 *
 * Kept free of network and filesystem on purpose. The Telegram surface is the part most likely to
 * be wrong in a way only a person notices — a truncated title, a list that reflows every poll, a
 * transcript that floods the group — and pure render functions are the only part of that which a
 * test can hold still. `telegram.ts` already follows this split (`buildCard` is pure and tested);
 * this continues it.
 *
 * ## The limits that shape these functions
 *
 * Telegram is not a terminal, and three of its limits are load-bearing here:
 *
 *  - A message body caps at 4096 characters. A transcript is far larger, so it is never a
 *    message — long text is truncated with a pointer to the uploaded file.
 *  - A forum topic name caps at 128 characters.
 *  - A bot may send on the order of 20 messages per minute to one group. A busy agent produces
 *    far more turns than that, so mirroring *must* drop and summarise rather than queue. Queuing
 *    would put the group minutes behind the session, which is worse than saying "12 turns not
 *    shown".
 */

import type { ClaudeSession } from '../SessionManager';
import type { MessageExchange } from '../SessionManager';
import { isWorklistSignal, needsYou, type SessionStatus } from '../sessionStatus';
import type { Ownership } from './ownership';

/** Telegram's message body limit. */
export const MAX_MESSAGE_CHARS = 4096;
/** Telegram's forum topic name limit. */
export const MAX_TOPIC_NAME_CHARS = 128;
/** Turns posted per mirror pass, per topic. Overflow collapses into one summary line. */
export const MAX_TURNS_PER_PASS = 4;

/**
 * One glyph per status, carrying the same meaning as the panel's shapes.
 *
 * Telegram has no shapes, only text, so the panel's amber/green/grey language is what carries over
 * — see `docs/STATUS-INDICATORS.md`, which these must agree with. Amber means your turn, green
 * means the agent's, grey means nothing is happening.
 *
 * The icon leads every row and every topic name, so it is the first thing read in a list of twenty:
 * `approval` and `question` have to be distinguishable from each other at a glance, because one
 * needs a tap and the other needs typing.
 */
const STATUS_ICON: Record<SessionStatus, string> = {
  approval: '🟠',
  question: '❓',
  finished: '🟢',
  working: '🔄',
  seen: '⚫',
  dormant: '⚪',
};

const SOURCE_LABEL: Record<ClaudeSession['source'], string> = {
  claude: 'claude',
  bob: 'bob',
  codex: 'codex',
  chat: 'chat',
};

export function statusIcon(status: SessionStatus): string {
  return STATUS_ICON[status] ?? '⚪';
}

/**
 * Whether a session is live enough to be given a topic without being asked for.
 *
 * Anything that needs you (`approval`, `question`, `finished`) or is running (`working`). The three
 * quiet states get a topic only on demand: auto-creating one per historical session would put weeks
 * of them in the group's topic list and make it unusable.
 */
export function deservesTopic(status: SessionStatus): boolean {
  return needsYou(status) || isWorklistSignal(status);
}

/** Cut `text` to `max` characters on a word boundary where one is close enough to the end. */
export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) { return clean; }
  const hard = clean.slice(0, Math.max(0, max - 1));
  const lastSpace = hard.lastIndexOf(' ');
  const body = lastSpace > max * 0.6 ? hard.slice(0, lastSpace) : hard;
  return `${body}…`;
}

/** Human-readable age, in the compact form the session panel uses. */
export function relativeAge(updatedAt: Date, now: number): string {
  const seconds = Math.max(0, Math.round((now - updatedAt.getTime()) / 1000));
  if (seconds < 45) { return 'now'; }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) { return `${minutes}m`; }
  const hours = Math.round(minutes / 60);
  if (hours < 24) { return `${hours}h`; }
  return `${Math.round(hours / 24)}d`;
}

/**
 * The name of a session's topic: `🟡 claude · workspace / title`.
 *
 * The status icon leads so the topic list doubles as a status board — Telegram shows topic names
 * in a sidebar, and an icon there is the cheapest possible "what needs me" signal. The title is
 * truncated rather than the workspace, because two topics from the same workspace still need to be
 * told apart by title.
 */
export function topicName(session: ClaudeSession): string {
  const prefix = `${statusIcon(session.status)} ${SOURCE_LABEL[session.source]} · ${session.projectName} / `;
  const room = MAX_TOPIC_NAME_CHARS - prefix.length;
  if (room < 8) { return truncate(prefix.replace(/ \/ $/, ''), MAX_TOPIC_NAME_CHARS); }
  return `${prefix}${truncate(session.title, room)}`;
}

export interface ListEntry {
  session: ClaudeSession;
  owner: Ownership;
}

/**
 * The General topic's one live message: every session this machine can see, grouped by host.
 *
 * Grouped by host rather than sorted by time, because this message is *edited in place* — a
 * time-ordered list would reshuffle on every poll and be impossible to read. Rows only move when a
 * session appears or disappears. That is the same reasoning behind the panel's `hostWorkspace`
 * sort order.
 */
export function renderFleetList(
  entries: ListEntry[], hostname: string, now: number,
): string {
  // Counted by what they ask of you, not by internal state name: "needs you" is the number you act
  // on, and it is the only figure worth reading at the top of a list of twenty.
  const yours = entries.filter(e => needsYou(e.session.status)).length;
  const running = entries.filter(e => e.session.status === 'working').length;

  const header = `Session Sitter · ${hostname}`;
  const counts = `${yours} need you · ${running} working · ${entries.length} total`;
  if (entries.length === 0) {
    return `${header}\n${counts}\n\nNo sessions found.`;
  }

  // Group by host: this machine first, then peers alphabetically.
  const groups = new Map<string, ListEntry[]>();
  for (const entry of entries) {
    const host = entry.session.peer ?? hostname;
    const list = groups.get(host) ?? [];
    list.push(entry);
    groups.set(host, list);
  }
  const hosts = [...groups.keys()].sort((a, b) => {
    if (a === hostname) { return -1; }
    if (b === hostname) { return 1; }
    return a.localeCompare(b);
  });

  const lines: string[] = [header, counts];
  for (const host of hosts) {
    lines.push('', host === hostname ? `${host} (this machine)` : host);
    const rows = (groups.get(host) ?? []).slice().sort((a, b) => {
      const ws = a.session.projectName.localeCompare(b.session.projectName);
      return ws !== 0 ? ws : a.session.title.localeCompare(b.session.title);
    });
    for (const { session, owner } of rows) {
      const readOnly = owner.pid === null ? ' · read-only' : '';
      lines.push(
        `  ${statusIcon(session.status)} ${SOURCE_LABEL[session.source]} · `
        + `${session.projectName} / ${truncate(session.title, 40)}`
        + `  ${relativeAge(session.updatedAt, now)}${readOnly}`,
      );
    }
  }
  return truncate2(lines.join('\n'));
}

/**
 * Trim a whole message to Telegram's body limit, keeping the start.
 *
 * Distinct from `truncate`: this works on multi-line bodies and must not collapse whitespace,
 * because the layout is the information.
 */
export function truncate2(body: string): string {
  if (body.length <= MAX_MESSAGE_CHARS) { return body; }
  const keep = MAX_MESSAGE_CHARS - 40;
  return `${body.slice(0, keep)}\n… truncated`;
}

/** The message posted when a topic is created: what this session is, and what can be done to it. */
export function renderTopicHeader(
  session: ClaudeSession, owner: Ownership, blockedReason: string | null,
): string {
  const lines = [
    `${statusIcon(session.status)} ${SOURCE_LABEL[session.source]} · ${session.projectName}`,
    session.title,
    '',
    `path: ${session.projectPath}`,
    `host: ${session.peer ?? 'this machine'}`,
    `session: ${session.sessionId}`,
  ];
  if (owner.pid !== null) {
    lines.push(`window: pid ${owner.pid} (${owner.basis === 'holds' ? 'has it open' : 'owns the workspace'})`);
  }
  lines.push('');
  lines.push(blockedReason === null
    ? 'Type here to send a message to this session.'
    : `⚠ ${blockedReason}`);
  return truncate2(lines.join('\n'));
}

/** One mirrored transcript turn. */
export function renderTurn(turn: MessageExchange): string {
  const icon = turn.role === 'user' ? '🧑' : '🤖';
  return truncate2(`${icon} ${turn.text.trim()}`);
}

export interface MirrorPlan {
  /** Messages to post, in order. */
  messages: string[];
  /** New cursor value to persist once every message is posted. */
  nextCursor: number;
}

/**
 * Decide what to post into a topic given the transcript and how far mirroring got.
 *
 * The cap is the point of this function. When a session produces 30 turns between passes, posting
 * all 30 would blow the group's rate limit and push everything else minutes behind. So the most
 * recent `MAX_TURNS_PER_PASS` are posted and the rest are acknowledged in one line — the cursor
 * still advances past all of them, because the skipped turns are in the transcript the user can
 * fetch, and pretending otherwise would replay them forever.
 */
export function planMirror(
  turns: MessageExchange[], cursor: number,
): MirrorPlan {
  if (turns.length <= cursor) { return { messages: [], nextCursor: turns.length }; }
  const fresh = turns.slice(cursor);
  if (fresh.length <= MAX_TURNS_PER_PASS) {
    return { messages: fresh.map(renderTurn), nextCursor: turns.length };
  }
  const skipped = fresh.length - MAX_TURNS_PER_PASS;
  const shown = fresh.slice(-MAX_TURNS_PER_PASS);
  return {
    messages: [
      `… ${skipped} earlier turn${skipped === 1 ? '' : 's'} not shown — use Full transcript`,
      ...shown.map(renderTurn),
    ],
    nextCursor: turns.length,
  };
}

/**
 * True when `text` is one this window just injected, so the mirror must not echo it back.
 *
 * A prompt sent from Telegram reappears as a user turn in the transcript, and reposting it makes
 * the topic read as though the message was sent twice. Matched on trimmed text rather than an id
 * because the transcript keeps no record of where a message came from.
 */
export function isEchoOfSent(text: string, recentlySent: string[]): boolean {
  const needle = text.replace(/\s+/g, ' ').trim();
  if (!needle) { return false; }
  return recentlySent.some(sent => sent.replace(/\s+/g, ' ').trim() === needle);
}

/** The `/help` body. Lists only what this build can actually do. */
export function renderHelp(): string {
  return [
    'Session Sitter — remote control',
    '',
    'In this topic (General):',
    '  /sessions   refresh the session list',
    '  /new        start a session in a workspace on this machine',
    '  /who        show which window owns what',
    '  /help       this message',
    '',
    'In a session topic:',
    '  type anything   sent to that session as a user message',
    '',
    'Read works for Claude, Bob, Codex and Chat sessions.',
    'Writing works for Bob, and for Claude sessions open in their window.',
    'Codex and Chat expose no message API, so they are read-only.',
  ].join('\n');
}

/** `/who` — the ownership table, so a read-only session can be explained rather than guessed at. */
export function renderWho(entries: ListEntry[], hostname: string): string {
  if (entries.length === 0) { return 'No sessions found.'; }
  const lines = [`Ownership on ${hostname}`, ''];
  for (const { session, owner } of entries) {
    const who = owner.pid === null
      ? 'nobody — read-only'
      : `pid ${owner.pid} · ${owner.basis === 'holds' ? 'has it open' : 'owns workspace'}`;
    lines.push(`${statusIcon(session.status)} ${session.projectName} / ${truncate(session.title, 30)} → ${who}`);
  }
  return truncate2(lines.join('\n'));
}
