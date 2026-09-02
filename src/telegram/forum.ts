/**
 * The Telegram forum (Topics) calls this feature needs, over the same injectable `ApiFn` the
 * supervision channel already uses.
 *
 * Reusing `ApiFn` rather than calling `fetch` here is what makes the whole surface testable with a
 * fake — the pattern `telegram.ts` established. Nothing in this file knows about sessions.
 *
 * ## Errors are values, not exceptions
 *
 * Every method returns an outcome instead of throwing. Mirroring a transcript is best-effort work
 * that must never take down the poll loop or block an agent: a failed post is worth a log line and
 * a retry next pass, not an unwound stack. The two failures worth naming are handled explicitly:
 *
 *  - **Not a forum.** `createForumTopic` fails when the group does not have Topics enabled. That is
 *    a setup problem with a specific fix, so it is detected and reported as such rather than
 *    surfacing as a generic API error the user cannot act on.
 *  - **Rate limited.** A 429 carries `retry_after`. It is returned so the caller can wait exactly
 *    that long; guessing a backoff either wastes time or gets throttled again.
 */

import type { ApiFn } from '../supervisor/telegram';

export interface InlineButton {
  text: string;
  callback_data: string;
}
export interface ReplyMarkup {
  inline_keyboard: InlineButton[][];
}

export type ForumOutcome<T> =
  | { ok: true; value: T }
  | {
    ok: false;
    error: string;
    notAForum?: boolean;
    topicGone?: boolean;
    retryAfterSeconds?: number;
  };

/** Read `retry_after` out of a Telegram error body, when it is a 429. */
export function retryAfterOf(resp: Record<string, unknown>): number | undefined {
  const params = resp.parameters;
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const value = (params as Record<string, unknown>).retry_after;
    if (typeof value === 'number') { return value; }
  }
  return undefined;
}

/**
 * True when a Telegram error means "this chat is not a forum".
 *
 * Matched on the description text because Telegram returns 400 with a message rather than a
 * distinct code. Deliberately broad: several wordings mean the same setup mistake, and treating
 * one of them as a generic failure would leave the user with no idea what to fix.
 */
export function isNotAForumError(description: string): boolean {
  // Punctuation is flattened first so `TOPIC_NOT_ENABLED` and "topic not enabled" read the same.
  const d = description.toLowerCase().replace(/[^a-z]+/g, ' ');
  if (d.includes('forum')) { return true; }
  return d.includes('topic')
    && (d.includes('not enabled') || d.includes('unavailable') || d.includes('disabled'));
}

/**
 * True when a Telegram error means "that topic does not exist any more".
 *
 * Deleting a topic is how a session leaves the group, and the record is only dropped once Telegram
 * agrees the topic is gone. A topic someone deleted by hand in the app would otherwise be retried
 * on every pass forever, so that case has to be told apart from a real failure.
 *
 * Kept narrow on purpose. "not enough rights to manage chat topics" also mentions topics but has a
 * fix — grant the bot `can_manage_topics` — so it must stay a failure that keeps the record.
 */
export function isTopicGoneError(description: string): boolean {
  const d = description.toLowerCase().replace(/[^a-z]+/g, ' ');
  if (!d.includes('thread') && !d.includes('topic')) { return false; }
  return d.includes('not found') || d.includes('deleted');
}

export class ForumApi {
  constructor(
    private readonly api: ApiFn,
    private readonly chatId: string,
    private readonly log: (msg: string) => void = () => { /* silent */ },
  ) {}

  /** One call, with Telegram's `ok` envelope reduced to an outcome. */
  private async call<T>(method: string, payload: Record<string, unknown>): Promise<ForumOutcome<T>> {
    let resp: Record<string, unknown>;
    try {
      resp = await this.api(method, { chat_id: this.chatId, ...payload });
    } catch (err) {
      return { ok: false, error: `${method}: ${String(err)}` };
    }
    if (resp.ok === true) {
      return { ok: true, value: resp.result as T };
    }
    const description = String(resp.description ?? JSON.stringify(resp));
    const retryAfterSeconds = retryAfterOf(resp);
    if (retryAfterSeconds !== undefined) {
      this.log(`telegram ${method}: rate limited, retry after ${retryAfterSeconds}s`);
    }
    return {
      ok: false,
      error: `${method}: ${description}`,
      notAForum: isNotAForumError(description),
      topicGone: isTopicGoneError(description),
      retryAfterSeconds,
    };
  }

  /** Create a topic and return its `message_thread_id`. */
  async createTopic(name: string): Promise<ForumOutcome<number>> {
    const result = await this.call<Record<string, unknown>>('createForumTopic', { name });
    if (!result.ok) { return result; }
    const threadId = Number(result.value.message_thread_id);
    if (!Number.isFinite(threadId)) {
      return { ok: false, error: 'createForumTopic: no message_thread_id in result' };
    }
    return { ok: true, value: threadId };
  }

  async renameTopic(threadId: number, name: string): Promise<ForumOutcome<true>> {
    return this.call<true>('editForumTopic', { message_thread_id: threadId, name });
  }

  async closeTopic(threadId: number): Promise<ForumOutcome<true>> {
    return this.call<true>('closeForumTopic', { message_thread_id: threadId });
  }

  async reopenTopic(threadId: number): Promise<ForumOutcome<true>> {
    return this.call<true>('reopenForumTopic', { message_thread_id: threadId });
  }

  /**
   * Remove a topic and everything posted in it.
   *
   * This is how a session leaves the group. Closing was tried first and is not enough: Telegram
   * keeps a closed topic in the group's topic list, so the sidebar still grew by one dead thread
   * per session that ever ran. Deleting is permanent — the transcript on disk stays the source of
   * truth, and `/history` builds a fresh topic from it.
   */
  async deleteTopic(threadId: number): Promise<ForumOutcome<true>> {
    return this.call<true>('deleteForumTopic', { message_thread_id: threadId });
  }

  /**
   * Post a message, optionally into a topic. Returns the new message id.
   *
   * `threadId === null` targets the group's General topic, which is what Telegram does when
   * `message_thread_id` is absent.
   */
  async send(
    text: string, threadId: number | null, replyMarkup?: ReplyMarkup,
  ): Promise<ForumOutcome<number>> {
    const payload: Record<string, unknown> = { text };
    if (threadId !== null) { payload.message_thread_id = threadId; }
    if (replyMarkup !== undefined) { payload.reply_markup = replyMarkup; }
    const result = await this.call<Record<string, unknown>>('sendMessage', payload);
    if (!result.ok) { return result; }
    return { ok: true, value: Number(result.value.message_id ?? 0) };
  }

  /** Edit a message in place — how the General list stays one message instead of a stream. */
  async edit(
    messageId: number, text: string, replyMarkup?: ReplyMarkup,
  ): Promise<ForumOutcome<true>> {
    const payload: Record<string, unknown> = { message_id: messageId, text };
    if (replyMarkup !== undefined) { payload.reply_markup = replyMarkup; }
    return this.call<true>('editMessageText', payload);
  }

  async pin(messageId: number): Promise<ForumOutcome<true>> {
    return this.call<true>('pinChatMessage', { message_id: messageId, disable_notification: true });
  }

  /** Clear a tapped button's spinner. Best-effort: a failure here has no user-visible effect. */
  async answerCallback(callbackId: string, text: string): Promise<void> {
    try {
      await this.api('answerCallbackQuery', { callback_query_id: callbackId, text });
    } catch { /* best-effort */ }
  }

  /**
   * Upload a file into a topic — how a full transcript is delivered.
   *
   * A transcript is far past the 4096-character message limit, so it cannot be a message. This
   * sends multipart/form-data, which the plain JSON `ApiFn` cannot express, so the caller injects
   * an uploader. Absent one, the caller is told rather than silently getting nothing.
   */
  async sendDocument(
    threadId: number | null,
    filename: string,
    content: string,
    caption: string,
    upload?: (form: FormData) => Promise<Record<string, unknown>>,
  ): Promise<ForumOutcome<true>> {
    if (upload === undefined) {
      return { ok: false, error: 'sendDocument: no uploader configured' };
    }
    const form = new FormData();
    form.append('chat_id', this.chatId);
    if (threadId !== null) { form.append('message_thread_id', String(threadId)); }
    form.append('caption', caption.slice(0, 1024));
    form.append('document', new Blob([content], { type: 'text/markdown' }), filename);
    try {
      const resp = await upload(form);
      if (resp.ok === true) { return { ok: true, value: true }; }
      return { ok: false, error: `sendDocument: ${String(resp.description ?? 'failed')}` };
    } catch (err) {
      return { ok: false, error: `sendDocument: ${String(err)}` };
    }
  }
}
