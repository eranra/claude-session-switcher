/**
 * The one-reader guarantee, at the seam where it is actually enforced.
 *
 * A bot token has a single update stream and reading it is destructive. When the remote interface is
 * active it owns that read, and the supervision channel must take its updates from the handover queue
 * instead of calling `getUpdates` — otherwise both poll and each sees a random half of the replies,
 * which is the defect the reader lease exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { TelegramChannel } from '../../supervisor/telegram';
import type { ApiFn } from '../../supervisor/telegram';
import { SupervisionState } from '../../supervisor/models';
import type { SupervisionRecord } from '../../supervisor/models';

function awaitingRecord(): SupervisionRecord {
  return {
    request_id: 'req-1',
    session_id: 's1',
    state: SupervisionState.ORANGE_AWAITING_USER,
    notification_id: '555',
    notified_at: '2026-09-01T10:00:00Z',
    created_at: '2026-09-01T09:00:00Z',
    question_spec: null,
    assessment: { human_options: ['✅ Approve', '⛔ Reject'] },
  } as unknown as SupervisionRecord;
}

function channelWith(
  updates: Array<Record<string, unknown>>,
): { channel: TelegramChannel; methods: string[] } {
  const methods: string[] = [];
  const api: ApiFn = async (method) => {
    methods.push(method);
    return { ok: true, result: [] };
  };
  const channel = new TelegramChannel({
    token: 'tok',
    chatId: '-1',
    offsetPath: path.join(os.tmpdir(), 'ss-never-written.txt'),
    api,
    updateSource: () => updates,
  });
  return { channel, methods };
}

describe('TelegramChannel with an injected update source', () => {
  it('does not call getUpdates at all', async () => {
    const { channel, methods } = channelWith([]);
    await channel.pollResponses([awaitingRecord()]);
    expect(methods).not.toContain('getUpdates');
  });

  it('resolves a button tap handed to it', async () => {
    const { channel } = channelWith([{
      update_id: 10,
      callback_query: { id: 'cb', data: 'req-1|0', message: { chat: { id: -1 } } },
    }]);
    const responses = await channel.pollResponses([awaitingRecord()]);
    expect(responses).toHaveLength(1);
    expect(responses[0].correlationId).toBe('req-1');
    expect(responses[0].text).toBe('✅ Approve');
  });

  it('resolves a text reply to a live card handed to it', async () => {
    const { channel } = channelWith([{
      update_id: 11,
      message: { chat: { id: -1 }, text: 'do the other thing', reply_to_message: { message_id: 555 } },
    }]);
    const responses = await channel.pollResponses([awaitingRecord()]);
    expect(responses).toHaveLength(1);
    expect(responses[0].correlationId).toBe('req-1');
    expect(responses[0].text).toBe('do the other thing');
  });

  it('returns nothing when handed nothing', async () => {
    const { channel } = channelWith([]);
    expect(await channel.pollResponses([awaitingRecord()])).toEqual([]);
  });

  it('still calls getUpdates when no source is injected', async () => {
    // The default path must be untouched: with the remote interface off, supervision polls for
    // itself exactly as before.
    const methods: string[] = [];
    const api: ApiFn = async (method) => {
      methods.push(method);
      return { ok: true, result: [] };
    };
    const channel = new TelegramChannel({
      token: 'tok',
      chatId: '-1',
      offsetPath: path.join(os.tmpdir(), `ss-offset-${Date.now()}.txt`),
      api,
    });
    await channel.pollResponses([awaitingRecord()]);
    expect(methods).toContain('getUpdates');
  });
});
