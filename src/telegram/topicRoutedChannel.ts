/**
 * Post a supervision card into the topic of the session it is about.
 *
 * A `MessagingChannel` decorator, not a replacement: the wrapped channel keeps doing everything else —
 * correlating replies, ticking countdowns, its own error handling — and this only changes *where* an
 * outbound card lands.
 *
 * ## Why this is worth doing
 *
 * Without it, a decision about session A and a decision about session B arrive in one undifferentiated
 * feed, and you have to read the session line on each card to tell which is which. With the remote
 * interface on, each session already has a thread carrying its transcript, so the card belongs beside
 * the conversation it concerns — the same place you would answer it from.
 *
 * ## Why it falls back rather than failing
 *
 * A session with no topic yet is normal: topics are created on the owning window's next pass, and a
 * prompt can be raised before that happens. So no topic means "send it the old way", never "drop it".
 * A supervision card is a question an agent is blocked on with a timeout running; losing one turns
 * into a denied action minutes later, which is far worse than a card in the wrong thread.
 *
 * The card's buttons are untouched, so their `<requestId>|<index>` payloads still route back to
 * supervision through `updateRouter.ts` — that is what makes answering from inside a topic work.
 */

import type { MessagingChannel, SendResult } from '../supervisor/messaging';
import type { SupervisionRecord } from '../supervisor/models';
import type { ForumApi, ReplyMarkup } from './forum';
import type { TopicStore } from './topics';

/**
 * What the wrapped channel would have sent, so the same text and buttons can be posted into a topic.
 *
 * `TelegramChannel` builds its card text and keyboard inside `send`, so the decorator is given the
 * same builder rather than reimplementing it — a second card format would drift from the first.
 */
export type CardBuilder = (
  record: SupervisionRecord, notification: string, interactive: boolean,
) => [string, ReplyMarkup | null];

export interface TopicRoutedChannelOptions {
  inner: MessagingChannel;
  topics: TopicStore;
  forum: ForumApi;
  buildCard: CardBuilder;
  log?: (msg: string) => void;
}

export class TopicRoutedChannel implements MessagingChannel {
  constructor(private readonly opts: TopicRoutedChannelOptions) {}

  async send(
    record: SupervisionRecord, notification: string, interactive = true,
  ): Promise<SendResult> {
    const log = this.opts.log ?? (() => { /* silent */ });
    let threadId: number | null = null;
    try {
      threadId = (await this.opts.topics.bySession(record.session_id))?.threadId ?? null;
    } catch (err) {
      log(`topic routing: could not look up a topic for ${record.session_id}: ${String(err)}`);
    }
    if (threadId === null) {
      return this.opts.inner.send(record, notification, interactive);
    }

    const [text, replyMarkup] = this.opts.buildCard(record, notification, interactive);
    const sent = await this.opts.forum.send(text, threadId, replyMarkup ?? undefined);
    if (!sent.ok) {
      // The topic may have been deleted in the app, or Telegram may be rate limiting. Either way the
      // card still has to reach the user, so fall back rather than lose the decision.
      log(`topic routing: falling back to the plain channel for ${record.request_id}: ${sent.error}`);
      return this.opts.inner.send(record, notification, interactive);
    }
    return { messageId: String(sent.value), sentAt: new Date().toISOString() };
  }

  async pollResponses(pending: SupervisionRecord[]) {
    return this.opts.inner.pollResponses(pending);
  }

  async refreshTimers(pending: SupervisionRecord[]): Promise<void> {
    await this.opts.inner.refreshTimers?.(pending);
  }

  async ensurePollingReady(): Promise<void> {
    await this.opts.inner.ensurePollingReady?.();
  }
}
