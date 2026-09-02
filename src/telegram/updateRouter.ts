/**
 * Splitting one Telegram update stream between the two things that consume it.
 *
 * ## Why this has to exist
 *
 * Supervision and remote control both want inbound Telegram updates, and a bot token has exactly one
 * update stream that is consumed destructively. Letting both call `getUpdates` would recreate the
 * defect the reader lease was introduced to fix — each consumer would see a random half of the
 * messages — so instead **remote control owns the read** and hands supervision what belongs to it.
 *
 * ## How an update is attributed
 *
 * By its callback payload, because that is the only part of an update whose format each side controls:
 *
 *  - Remote control's own buttons are prefixed `rc|` (see `intent.ts`).
 *  - Supervision's buttons are `<requestId>|<index>`, `<requestId>|q<n>|<opt>` or `<requestId>|__submit`
 *    (see `supervisor/telegram.ts`).
 *
 * Text messages are attributed by **where** they were typed. A message in a session topic is a prompt
 * for that session. A reply to a supervision card is a decision. A bare message in General is neither,
 * and is reported as unroutable rather than guessed at.
 *
 * ## Why unknown updates go to supervision
 *
 * The default has to favour supervision, because its updates are answers to a question it is actively
 * waiting on with a timeout running. A misrouted remote-control message is reported back to the user
 * within a second; a swallowed supervision reply silently becomes a denied action minutes later.
 */

/** Prefix on every callback payload this feature owns. Kept in sync with `encodeCallback`. */
export const REMOTE_CONTROL_PREFIX = 'rc|';

export type UpdateOwner = 'remoteControl' | 'supervision';

export interface RoutingContext {
  /** Telegram thread ids that are session topics owned by remote control. */
  sessionThreadIds: ReadonlySet<number>;
  /** Message ids of live supervision cards, so a reply to one is recognised as a decision. */
  supervisionMessageIds: ReadonlySet<string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return (value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : null;
}

/**
 * Decide which consumer an update belongs to.
 *
 * Deliberately total: every update gets an owner, because an update with no owner is a message that
 * disappears, and this feature's rule is that nothing disappears silently.
 */
export function routeUpdate(
  update: Record<string, unknown>, context: RoutingContext,
): UpdateOwner {
  const callback = asRecord(update.callback_query);
  if (callback !== null) {
    const data = String(callback.data ?? '');
    return data.startsWith(REMOTE_CONTROL_PREFIX) ? 'remoteControl' : 'supervision';
  }

  const message = asRecord(update.message);
  if (message === null) { return 'supervision'; }

  // A reply to a live supervision card is a decision, wherever it was typed.
  const replyTo = asRecord(message.reply_to_message);
  if (replyTo !== null && context.supervisionMessageIds.has(String(replyTo.message_id ?? ''))) {
    return 'supervision';
  }

  // Text in a session topic is a prompt for that session.
  const threadId = typeof message.message_thread_id === 'number' ? message.message_thread_id : null;
  if (threadId !== null && context.sessionThreadIds.has(threadId)) { return 'remoteControl'; }

  // A slash command is remote control's, wherever it was typed.
  //
  // General is where most of them live, but the thread cases matter more than they look. A topic is
  // only reachable through its record, because the Bot API cannot list a group's topics —
  // `getForumTopics` is a user-API method and says so — so a thread whose record has gone missing is
  // invisible to pruning and to everything else. Somebody typing in it is the only thing left that
  // still says the thread is there, and sending that to supervision, which has no concept of a
  // topic, discarded the one signal that could ever reach these threads. `/forget` is what a user
  // types into such a thread to be rid of it.
  const text = typeof message.text === 'string' ? message.text : '';
  if (text.trimStart().startsWith('/')) { return 'remoteControl'; }

  // Anything else in General could be a supervision reply with no reply-to — which is how the
  // existing channel already treats a bare message — so it goes there.
  return 'supervision';
}

/**
 * A hand-off point between the one reader and a consumer that used to poll for itself.
 *
 * `TelegramChannel` drains this instead of calling `getUpdates` when remote control is active, so
 * exactly one component talks to Telegram while both still get their updates. Bounded, because an
 * unbounded queue would grow without limit if a consumer stopped draining — and dropping the oldest
 * update is better than exhausting memory, since supervision times out safely on its own.
 */
export class UpdateQueue {
  private items: Array<Record<string, unknown>> = [];

  constructor(private readonly limit = 500) {}

  push(update: Record<string, unknown>): void {
    this.items.push(update);
    while (this.items.length > this.limit) { this.items.shift(); }
  }

  /** Take everything queued, leaving the queue empty. */
  drain(): Array<Record<string, unknown>> {
    const out = this.items;
    this.items = [];
    return out;
  }

  get size(): number {
    return this.items.length;
  }
}
