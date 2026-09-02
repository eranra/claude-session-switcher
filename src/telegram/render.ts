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
import { needsYou, type SessionStatus } from '../sessionStatus';
import type { Ownership } from './ownership';

/** Telegram's message body limit. */
export const MAX_MESSAGE_CHARS = 4096;
/** Telegram's forum topic name limit. */
export const MAX_TOPIC_NAME_CHARS = 128;
/** Turns posted per mirror pass, per topic. Overflow collapses into one summary line. */
export const MAX_TURNS_PER_PASS = 4;

/**
 * One glyph per status, matched as closely to the panel's marker as characters allow.
 *
 * Telegram renders no shapes, only text, so what carries over from `docs/STATUS-INDICATORS.md` is
 * the colour language and the silhouette. Amber means your turn, green means the agent's, grey
 * means nothing is happening:
 *
 * | Status     | Panel marker          | Here | Why this character                                |
 * |------------|-----------------------|------|---------------------------------------------------|
 * | `approval` | solid amber triangle  | 🟠   | Amber and filled — the most solid thing in a list |
 * | `question` | amber question mark   | ❓   | The one symbol that needs no learning             |
 * | `finished` | green dot in a ring   | 🟢   | Green and filled — a result waiting to be read    |
 * | `working`  | spinning green ring   | 🔄   | The only glyph in the set that reads as motion    |
 * | `seen`     | small flat grey dot   | ⚫   | Filled and quiet — present, asking for nothing    |
 * | `dormant`  | hollow grey circle    | ⚪   | Hollow, so it is a different shape from `seen`    |
 *
 * The icon leads every row and every topic name, so it is the first thing read in a list of twenty:
 * `approval` and `question` have to be distinguishable from each other at a glance, because one
 * needs a tap and the other needs typing. The whole set is pinned by a test, so changing one is a
 * deliberate act rather than a silent drift away from the panel.
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
 * How a session is named wherever it is named: `workspace / title · agent[@host]`.
 *
 * The order is not cosmetic. The workspace answers "which piece of work is this?", which is the
 * question actually being asked when twenty rows go past — so it comes first, and it is never the
 * part that gets truncated. The title distinguishes two sessions in that workspace. Which agent it
 * is, and which machine it runs on, are worth knowing but never worth reading first, so they trail.
 *
 * The host is shown only for a peer session: on this machine it would be noise on every row.
 */
export function sessionLabel(session: ClaudeSession, titleChars: number): string {
  const agent = session.peer
    ? `${SOURCE_LABEL[session.source]}@${session.peer}`
    : SOURCE_LABEL[session.source];
  return `${session.projectName} / ${truncate(session.title, titleChars)} · ${agent}`;
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
 * The name of a session's topic: `🟠 workspace / title · claude`.
 *
 * The status icon leads so the topic list doubles as a status board — Telegram shows topic names in
 * a sidebar, and an icon there is the cheapest possible "what needs me" signal. Everything after it
 * follows `sessionLabel`: workspace, title, then the agent and the machine.
 *
 * The title is what gets truncated, never the workspace, because two topics from the same workspace
 * still have to be told apart by title.
 */
export function topicName(session: ClaudeSession): string {
  const icon = `${statusIcon(session.status)} `;
  // What the name costs before a single character of title: the icon, the workspace, the separators
  // and the agent. Measured rather than guessed, so a long workspace or an `agent@host` cannot push
  // the result past Telegram's limit.
  const overhead = icon.length + sessionLabel({ ...session, title: '' }, 0).length;
  const room = MAX_TOPIC_NAME_CHARS - overhead;
  if (room < 8) {
    return truncate(`${icon}${session.projectName}`, MAX_TOPIC_NAME_CHARS);
  }
  return truncate(`${icon}${sessionLabel(session, room)}`, MAX_TOPIC_NAME_CHARS);
}

export interface ListEntry {
  session: ClaudeSession;
  owner: Ownership;
}

/** Sort rows by workspace, then title. Never by time — see `renderFleetList`. */
function byWorkspaceThenTitle(a: ListEntry, b: ListEntry): number {
  const ws = a.session.projectName.localeCompare(b.session.projectName);
  return ws !== 0 ? ws : a.session.title.localeCompare(b.session.title);
}

/** One list row: `🟠 workspace / title · claude · 2m · read-only`. */
function listRow(entry: ListEntry, now: number): string {
  const { session, owner } = entry;
  const readOnly = owner.pid === null ? ' · read-only' : '';
  return `${statusIcon(session.status)} ${sessionLabel(session, 40)}`
    + ` · ${relativeAge(session.updatedAt, now)}${readOnly}`;
}

/**
 * The General topic's one live message: the **active** sessions, exactly the panel's worklist.
 *
 * Active-only, not everything the machine can see. A fleet accumulates hundreds of past sessions,
 * and a list of hundreds answers no question — you cannot find the one that needs you in it. The
 * rule for what counts as active is `sessionActivity.ts`, shared with the panel, so this list and
 * the panel's cannot disagree. Everything else is behind `/history`.
 *
 * Sorted by workspace and then title, **never** by time, because this message is *edited in place*:
 * a time ordering would reshuffle every row on every poll and be impossible to read. A row moves
 * only when a session appears, disappears, or changes status.
 *
 * The host is not a heading here. It used to group the list, which put the machine name above the
 * workspace — and the machine is the last thing you need when you are looking for a piece of work.
 * It now trails inside each row, and only for a session on another machine.
 */
export function renderFleetList(
  entries: ListEntry[], hostname: string, now: number,
): string {
  // Counted by what they ask of you, not by internal state name: "needs you" is the number you act
  // on, and it is the only figure worth reading at the top of a list of twenty.
  const yours = entries.filter(e => needsYou(e.session.status)).length;
  const running = entries.filter(e => e.session.status === 'working').length;

  const header = `Session Sitter · ${hostname}`;
  const counts = `${yours} need you · ${running} working · ${entries.length} active`;
  if (entries.length === 0) {
    return `${header}\n${counts}\n\nNo active sessions. /history shows the earlier ones.`;
  }

  const lines = [header, counts, ''];
  for (const entry of entries.slice().sort(byWorkspaceThenTitle)) {
    lines.push(`  ${listRow(entry, now)}`);
  }
  return truncate2(lines.join('\n'));
}

/**
 * A fingerprint of what the list says, ignoring anything that changes on its own.
 *
 * The pinned General message is edited in place, and Telegram rate-limits edits. Ages ("2m") tick
 * every pass, so treating the rendered body as the comparison would mean an edit every few seconds
 * carrying no new information. What actually matters is which sessions exist, what state each is in,
 * and whether it can be written to — so that, and only that, is what the fingerprint covers.
 *
 * Sorted, because the caller may hand these over in any order and a reordering is not a change.
 */
export function fleetSignature(entries: ListEntry[]): string {
  return entries
    .map(e => `${e.session.sessionId}:${e.session.status}:${e.owner.pid ?? 'none'}`)
    .sort()
    .join('|');
}

/**
 * `/history` — the sessions the worklist does not show, newest first.
 *
 * Newest first, unlike the active list, and for the opposite reason: this message is posted fresh
 * each time rather than edited in place, so nothing reshuffles under you, and "what was I last
 * working on?" is the actual question a history list is asked.
 */
export function renderHistoryList(
  entries: ListEntry[], now: number,
): string {
  if (entries.length === 0) {
    return 'No earlier sessions — everything this machine can see is already in the active list.';
  }
  const lines = [
    `History · ${entries.length} session${entries.length === 1 ? '' : 's'}`,
    'Tap one to open its topic and bring it back into the active list.',
    '',
  ];
  for (const entry of entries) {
    lines.push(`  ${listRow(entry, now)}`);
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

/**
 * The message posted when a topic is created: what this session is, and what can be done to it.
 *
 * Same reading order as every other surface — workspace, then title, then the agent and the machine
 * — so the header confirms what the topic name already said instead of restating it differently.
 */
export function renderTopicHeader(
  session: ClaudeSession, owner: Ownership, blockedReason: string | null,
): string {
  const lines = [
    `${statusIcon(session.status)} ${session.projectName}`,
    session.title,
    '',
    `agent: ${SOURCE_LABEL[session.source]}`,
    `host: ${session.peer ?? 'this machine'}`,
    `path: ${session.projectPath}`,
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
    '  /sessions   refresh the list of active sessions',
    '  /history    the earlier ones — tap to bring one back',
    '  /new        start a session in a workspace on this machine',
    '  /who        show which window owns what',
    '  /help       this message',
    '',
    'The list holds the active sessions only, the same ones the Sessions panel shows.',
    'A session that leaves that list has its topic closed; its scrollback is kept.',
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
    lines.push(`${statusIcon(session.status)} ${sessionLabel(session, 30)} → ${who}`);
  }
  return truncate2(lines.join('\n'));
}
