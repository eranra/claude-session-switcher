import { describe, expect, it } from 'vitest';
import {
  ForumApi, isNotAForumError, isTopicGoneError, retryAfterOf,
} from '../../telegram/forum';
import type { ApiFn } from '../../supervisor/telegram';

/** Records every call and replies from a scripted queue. No network anywhere. */
function fakeApi(replies: Record<string, Record<string, unknown>>) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const api: ApiFn = async (method, payload) => {
    calls.push({ method, payload });
    return replies[method] ?? { ok: true, result: {} };
  };
  return { api, calls };
}

describe('retryAfterOf', () => {
  it('reads retry_after out of a 429 body', () => {
    expect(retryAfterOf({ ok: false, parameters: { retry_after: 12 } })).toBe(12);
  });

  it('returns undefined when there is none', () => {
    expect(retryAfterOf({ ok: false })).toBeUndefined();
    expect(retryAfterOf({ ok: false, parameters: {} })).toBeUndefined();
    expect(retryAfterOf({ ok: false, parameters: 'nope' })).toBeUndefined();
  });
});

describe('isNotAForumError', () => {
  it('recognises the wordings that mean Topics are off', () => {
    // Telegram returns a plain 400 with prose, so this is matched on text. Several wordings mean
    // the same fixable setup mistake, and treating one as generic would leave the user stuck.
    expect(isNotAForumError('Bad Request: the chat is not a forum')).toBe(true);
    expect(isNotAForumError('Bad Request: TOPIC_NOT_ENABLED')).toBe(true);
    expect(isNotAForumError('Bad Request: topics are unavailable in this chat')).toBe(true);
  });

  it('does not claim an unrelated error is a forum problem', () => {
    expect(isNotAForumError('Bad Request: message is too long')).toBe(false);
    expect(isNotAForumError('Forbidden: bot was blocked by the user')).toBe(false);
  });
});

describe('isTopicGoneError', () => {
  it('recognises the wordings that mean the topic is already gone', () => {
    // A topic deleted by hand in the app must not be retried forever. Matched on text for the
    // same reason as `isNotAForumError`: Telegram sends a plain 400 with prose.
    expect(isTopicGoneError('Bad Request: message thread not found')).toBe(true);
    expect(isTopicGoneError('Bad Request: topic not found')).toBe(true);
    expect(isTopicGoneError('Bad Request: TOPIC_DELETED')).toBe(true);
  });

  it('does not mistake a missing permission for a missing topic', () => {
    // This one has a fix — grant the bot can_manage_topics — so it must stay a real failure and
    // keep the record, rather than being swallowed as "already tidy".
    expect(isTopicGoneError('Bad Request: not enough rights to manage chat topics')).toBe(false);
    expect(isTopicGoneError('Bad Request: message is too long')).toBe(false);
  });
});

describe('ForumApi', () => {
  it('creates a topic and returns its thread id', async () => {
    const { api, calls } = fakeApi({
      createForumTopic: { ok: true, result: { message_thread_id: 77 } },
    });
    const result = await new ForumApi(api, '-100999').createTopic('a name');
    expect(result).toEqual({ ok: true, value: 77 });
    expect(calls[0].payload).toEqual({ chat_id: '-100999', name: 'a name' });
  });

  it('reports a missing thread id rather than returning NaN', async () => {
    const { api } = fakeApi({ createForumTopic: { ok: true, result: {} } });
    const result = await new ForumApi(api, '-1').createTopic('n');
    expect(result.ok).toBe(false);
  });

  it('flags a non-forum chat so the caller can explain the fix', async () => {
    const { api } = fakeApi({
      createForumTopic: { ok: false, description: 'Bad Request: the chat is not a forum' },
    });
    const result = await new ForumApi(api, '-1').createTopic('n');
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.notAForum).toBe(true); }
  });

  it('surfaces retry_after so the caller waits the right amount', async () => {
    const { api } = fakeApi({
      sendMessage: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 8 } },
    });
    const result = await new ForumApi(api, '-1').send('hi', 7);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.retryAfterSeconds).toBe(8); }
  });

  it('returns a failure instead of throwing when the transport dies', async () => {
    // A thrown error here would unwind the poll loop, and every session would go quiet with no
    // explanation. Mirroring is best-effort by design.
    const api: ApiFn = async () => { throw new Error('socket hang up'); };
    const result = await new ForumApi(api, '-1').send('hi', null);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toContain('socket hang up'); }
  });

  it('omits message_thread_id for General, which is how Telegram addresses it', async () => {
    const { api, calls } = fakeApi({ sendMessage: { ok: true, result: { message_id: 5 } } });
    await new ForumApi(api, '-1').send('hi', null);
    expect(calls[0].payload).not.toHaveProperty('message_thread_id');
  });

  it('includes message_thread_id for a topic', async () => {
    const { api, calls } = fakeApi({ sendMessage: { ok: true, result: { message_id: 5 } } });
    await new ForumApi(api, '-1').send('hi', 7);
    expect(calls[0].payload.message_thread_id).toBe(7);
  });

  it('passes an inline keyboard through when given one', async () => {
    const { api, calls } = fakeApi({ sendMessage: { ok: true, result: { message_id: 5 } } });
    const markup = { inline_keyboard: [[{ text: 'x', callback_data: 'rc|refresh' }]] };
    await new ForumApi(api, '-1').send('hi', null, markup);
    expect(calls[0].payload.reply_markup).toEqual(markup);
  });

  it('edits a message in place, which is how the list stays one message', async () => {
    const { api, calls } = fakeApi({ editMessageText: { ok: true, result: true } });
    expect((await new ForumApi(api, '-1').edit(5, 'new body')).ok).toBe(true);
    expect(calls[0].method).toBe('editMessageText');
    expect(calls[0].payload.message_id).toBe(5);
  });

  it.each(['closeTopic', 'reopenTopic', 'renameTopic'] as const)('calls through for %s', async (fn) => {
    const { api, calls } = fakeApi({
      closeForumTopic: { ok: true, result: true },
      reopenForumTopic: { ok: true, result: true },
      editForumTopic: { ok: true, result: true },
    });
    const forum = new ForumApi(api, '-1');
    if (fn === 'renameTopic') { await forum.renameTopic(7, 'x'); } else { await forum[fn](7); }
    expect(calls[0].payload.message_thread_id).toBe(7);
  });

  it('never lets a failed callback acknowledgement surface', async () => {
    const api: ApiFn = async () => { throw new Error('nope'); };
    await expect(new ForumApi(api, '-1').answerCallback('cb', 'ok')).resolves.toBeUndefined();
  });

  it('reports that a transcript cannot be uploaded without an uploader', async () => {
    // The JSON transport cannot express multipart, and a transcript is far past the message
    // limit, so silence here would look like a broken button.
    const { api } = fakeApi({});
    const result = await new ForumApi(api, '-1').sendDocument(7, 'a.md', 'body', 'caption');
    expect(result.ok).toBe(false);
  });

  it('uploads a transcript through the injected uploader', async () => {
    const { api } = fakeApi({});
    const result = await new ForumApi(api, '-100999').sendDocument(
      7, 'a.md', 'body', 'caption', async () => ({ ok: true }));
    expect(result.ok).toBe(true);
  });

  it('reports an upload the server rejected', async () => {
    const { api } = fakeApi({});
    const result = await new ForumApi(api, '-1').sendDocument(
      7, 'a.md', 'body', 'caption', async () => ({ ok: false, description: 'too big' }));
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toContain('too big'); }
  });
  it('deletes a topic through deleteForumTopic', async () => {
    const { api, calls } = fakeApi({ deleteForumTopic: { ok: true, result: true } });
    expect((await new ForumApi(api, '-100999').deleteTopic(7)).ok).toBe(true);
    expect(calls[0].method).toBe('deleteForumTopic');
    expect(calls[0].payload).toEqual({ chat_id: '-100999', message_thread_id: 7 });
  });

  it('flags a topic that is already gone so the caller stops retrying it', async () => {
    const { api } = fakeApi({
      deleteForumTopic: { ok: false, description: 'Bad Request: message thread not found' },
    });
    const result = await new ForumApi(api, '-1').deleteTopic(7);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.topicGone).toBe(true); }
  });

  it('does not flag a permission failure as a gone topic', async () => {
    // A bot without can_manage_topics must keep its record and fall back, not lose the topic.
    const { api } = fakeApi({
      deleteForumTopic: { ok: false, description: 'Bad Request: not enough rights' },
    });
    const result = await new ForumApi(api, '-1').deleteTopic(7);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.topicGone).toBeFalsy(); }
  });
});
