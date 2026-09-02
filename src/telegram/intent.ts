/**
 * Turning a raw Telegram update into something this extension will act on — and refusing the rest.
 *
 * ## This module is the security boundary
 *
 * Moving from a private chat to a group changes the threat model. A private chat has exactly one
 * possible sender; a group has everyone who was ever invited, and Telegram invite links spread.
 * Since acting on a message means injecting text into a live coding agent, an unrecognised sender
 * must be dropped **before** anything else looks at the message.
 *
 * So parsing is deliberately ordered: chat id, then sender id, then content. A message that fails
 * either of the first two checks never reaches intent parsing at all, and no part of its text is
 * used — not even for logging, beyond the sender id needed to add someone to the allowlist.
 *
 * An empty allowlist authorises **nobody**. The alternative default — empty means everyone — turns
 * a half-finished setup into an open door, and the failure is silent until it is abused.
 *
 * Pure by construction, so every rule here is unit-tested without a network or a bot.
 */

/** What the extension should do about one update. */
export type Intent =
  | { kind: 'ignore'; reason: string }
  | { kind: 'unauthorized'; userId: string }
  | { kind: 'listSessions' }
  /** The sessions the worklist does not show, so one can be brought back. */
  | { kind: 'listHistory' }
  | { kind: 'help' }
  | { kind: 'who' }
  | { kind: 'newSessionMenu' }
  /** A button tap. `data` is the raw callback payload. */
  | { kind: 'callback'; data: string; callbackId: string; threadId: number | null }
  /** Free text typed inside a session topic — a prompt for that session. */
  | { kind: 'sendToTopic'; threadId: number; text: string }
  /** Free text with no topic, in a group that is not a forum. Cannot be routed. */
  | { kind: 'unroutableText'; text: string };

export interface AuthConfig {
  /** Telegram chat id of the group. Messages from any other chat are ignored. */
  chatId: string;
  /** Telegram user ids permitted to drive the bot. Empty authorises nobody. */
  allowedUserIds: string[];
}

/**
 * Telegram's General topic has no `message_thread_id` on its messages, so "no thread" and
 * "General" are the same thing on the wire. Represented as null throughout.
 */
export const GENERAL_THREAD: number | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return (value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : null;
}

/** True when this sender may drive the bot. An empty allowlist permits nobody, by design. */
export function isAuthorized(userId: string, allowed: string[]): boolean {
  if (allowed.length === 0) { return false; }
  return allowed.includes(userId);
}

/**
 * Strip a bot mention from a command: in a group, Telegram delivers `/sessions@my_bot`.
 * Returns the bare command in lower case, or null when the text is not a command.
 */
export function parseCommandWord(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) { return null; }
  const word = trimmed.split(/\s+/)[0].slice(1);
  const bare = word.includes('@') ? word.slice(0, word.indexOf('@')) : word;
  return bare.toLowerCase();
}

/**
 * Classify one update.
 *
 * `ignore` and `unauthorized` are separate outcomes on purpose: an ignore is routine (a message in
 * another chat, an edit, a photo) and stays silent, whereas an unauthorized attempt is worth one
 * rate-limited line in the Activity topic, because it is the only way a user learns that someone is
 * knocking — and the only way they get the id to add.
 */
export function classifyUpdate(update: Record<string, unknown>, auth: AuthConfig): Intent {
  const callback = asRecord(update.callback_query);
  if (callback !== null) {
    return classifyCallback(callback, auth);
  }

  const message = asRecord(update.message);
  if (message === null) { return { kind: 'ignore', reason: 'not a message or a button tap' }; }

  const chat = asRecord(message.chat);
  if (chat === null || String(chat.id ?? '') !== auth.chatId) {
    return { kind: 'ignore', reason: 'different chat' };
  }

  const from = asRecord(message.from);
  const userId = String(from?.id ?? '');
  if (!userId) { return { kind: 'ignore', reason: 'no sender' }; }
  if (!isAuthorized(userId, auth.allowedUserIds)) { return { kind: 'unauthorized', userId }; }

  const text = typeof message.text === 'string' ? message.text : '';
  if (!text.trim()) { return { kind: 'ignore', reason: 'no text' }; }

  const threadId = typeof message.message_thread_id === 'number'
    ? message.message_thread_id
    : GENERAL_THREAD;

  const command = parseCommandWord(text);
  if (command !== null) {
    switch (command) {
      case 'sessions': case 'start': return { kind: 'listSessions' };
      case 'history': return { kind: 'listHistory' };
      case 'help': return { kind: 'help' };
      case 'who': return { kind: 'who' };
      case 'new': return { kind: 'newSessionMenu' };
      default: return { kind: 'ignore', reason: `unknown command /${command}` };
    }
  }

  // Free text. Inside a session topic it is a prompt for that session; in General it has no
  // target, and guessing one is exactly the mistake this design refuses to make.
  if (threadId === null) {
    return { kind: 'unroutableText', text: text.trim() };
  }
  return { kind: 'sendToTopic', threadId, text: text.trim() };
}

function classifyCallback(callback: Record<string, unknown>, auth: AuthConfig): Intent {
  const from = asRecord(callback.from);
  const userId = String(from?.id ?? '');
  const message = asRecord(callback.message);
  const chat = message !== null ? asRecord(message.chat) : null;
  if (chat === null || String(chat.id ?? '') !== auth.chatId) {
    return { kind: 'ignore', reason: 'different chat' };
  }
  if (!userId) { return { kind: 'ignore', reason: 'no sender' }; }
  if (!isAuthorized(userId, auth.allowedUserIds)) { return { kind: 'unauthorized', userId }; }
  const threadId = message !== null && typeof message.message_thread_id === 'number'
    ? message.message_thread_id
    : null;
  return {
    kind: 'callback',
    data: String(callback.data ?? ''),
    callbackId: String(callback.id ?? ''),
    threadId,
  };
}

// --------------------------------------------------------------------------- callback payloads

/**
 * Button payloads. Telegram caps `callback_data` at 64 bytes, which will not hold a session id
 * (36 chars) plus a verb plus a workspace path — so payloads carry short keys and the receiver
 * looks the rest up. Anything longer is a bug that only shows up as a silently dead button.
 */
export type Callback =
  | { kind: 'refresh' }
  | { kind: 'newMenu' }
  | { kind: 'history' }
  /** Open (or create) the topic for a session, addressed by a short index into the last list. */
  | { kind: 'openSession'; index: number }
  /**
   * Bring a history session back: open its topic and focus it in its IDE, which is what makes it
   * active again. Indexed into the last `/history` list, kept separate from `openSession` so a
   * stale index can never resolve against the wrong list.
   */
  | { kind: 'loadHistory'; index: number }
  /** Launch a session: workspace by index into the last `/new` menu, plus the agent. */
  | { kind: 'launch'; index: number; source: 'claude' | 'bob' }
  | { kind: 'focus'; sessionId: string }
  | { kind: 'transcript'; sessionId: string }
  | { kind: 'closeTopic'; threadId: number }
  | { kind: 'unknown'; raw: string };

export function encodeCallback(cb: Callback): string {
  switch (cb.kind) {
    case 'refresh': return 'rc|refresh';
    case 'newMenu': return 'rc|newmenu';
    case 'history': return 'rc|history';
    case 'openSession': return `rc|open|${cb.index}`;
    case 'loadHistory': return `rc|load|${cb.index}`;
    case 'launch': return `rc|launch|${cb.index}|${cb.source}`;
    case 'focus': return `rc|focus|${cb.sessionId}`;
    case 'transcript': return `rc|tx|${cb.sessionId}`;
    case 'closeTopic': return `rc|close|${cb.threadId}`;
    default: return 'rc|unknown';
  }
}

export function decodeCallback(raw: string): Callback {
  const parts = raw.split('|');
  if (parts[0] !== 'rc') { return { kind: 'unknown', raw }; }
  const verb = parts[1] ?? '';
  const arg = parts[2] ?? '';
  switch (verb) {
    case 'refresh': return { kind: 'refresh' };
    case 'newmenu': return { kind: 'newMenu' };
    case 'history': return { kind: 'history' };
    case 'open': {
      const index = Number(arg);
      return Number.isInteger(index) && index >= 0
        ? { kind: 'openSession', index }
        : { kind: 'unknown', raw };
    }
    case 'load': {
      const index = Number(arg);
      return Number.isInteger(index) && index >= 0
        ? { kind: 'loadHistory', index }
        : { kind: 'unknown', raw };
    }
    case 'launch': {
      const index = Number(arg);
      const source = parts[3];
      if (!Number.isInteger(index) || index < 0) { return { kind: 'unknown', raw }; }
      if (source !== 'claude' && source !== 'bob') { return { kind: 'unknown', raw }; }
      return { kind: 'launch', index, source };
    }
    case 'focus': return arg ? { kind: 'focus', sessionId: arg } : { kind: 'unknown', raw };
    case 'tx': return arg ? { kind: 'transcript', sessionId: arg } : { kind: 'unknown', raw };
    case 'close': {
      const threadId = Number(arg);
      return Number.isInteger(threadId)
        ? { kind: 'closeTopic', threadId }
        : { kind: 'unknown', raw };
    }
    default: return { kind: 'unknown', raw };
  }
}

/** Telegram's hard limit on a callback payload. Enforced in tests so a button cannot ship dead. */
export const MAX_CALLBACK_BYTES = 64;

export function callbackFits(cb: Callback): boolean {
  return Buffer.byteLength(encodeCallback(cb), 'utf8') <= MAX_CALLBACK_BYTES;
}
