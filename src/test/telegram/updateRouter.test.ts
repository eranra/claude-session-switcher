import { describe, expect, it } from 'vitest';
import {
  REMOTE_CONTROL_PREFIX,
  UpdateQueue,
  routeUpdate,
  type RoutingContext,
} from '../../telegram/updateRouter';
import { encodeCallback } from '../../telegram/intent';

const context: RoutingContext = {
  sessionThreadIds: new Set([7, 8]),
  supervisionMessageIds: new Set(['555']),
};

describe('routeUpdate — button taps', () => {
  it('claims a tap on one of our own buttons', () => {
    const update = { callback_query: { data: encodeCallback({ kind: 'refresh' }) } };
    expect(routeUpdate(update, context)).toBe('remoteControl');
  });

  it('gives a supervision decision tap to supervision', () => {
    // Supervision's payloads are `<requestId>|<index>` — no `rc|` prefix.
    expect(routeUpdate({ callback_query: { data: 'req-abc|0' } }, context)).toBe('supervision');
  });

  it('gives supervision its question-card taps', () => {
    expect(routeUpdate({ callback_query: { data: 'req-abc|q0|1' } }, context)).toBe('supervision');
    expect(routeUpdate({ callback_query: { data: 'req-abc|__submit' } }, context)).toBe('supervision');
  });

  it('sends an unrecognised tap to supervision rather than dropping it', () => {
    // Supervision is the side with a running timeout, so an unattributable update must go there:
    // a swallowed reply becomes a denied action minutes later.
    expect(routeUpdate({ callback_query: { data: '' } }, context)).toBe('supervision');
  });

  it('agrees with the prefix the encoder actually emits', () => {
    expect(encodeCallback({ kind: 'refresh' }).startsWith(REMOTE_CONTROL_PREFIX)).toBe(true);
  });
});

describe('routeUpdate — messages', () => {
  function message(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { message: { chat: { id: -1 }, from: { id: 42 }, text: 'hello', ...over } };
  }

  it('claims text typed in a session topic', () => {
    expect(routeUpdate(message({ message_thread_id: 7 }), context)).toBe('remoteControl');
  });

  it('claims a slash command in General', () => {
    expect(routeUpdate(message({ text: '/sessions' }), context)).toBe('remoteControl');
  });

  it('claims a command with leading whitespace', () => {
    expect(routeUpdate(message({ text: '  /help' }), context)).toBe('remoteControl');
  });

  it('gives supervision a bare message in General', () => {
    // The existing channel already treats an unaddressed message as a possible decision reply.
    expect(routeUpdate(message(), context)).toBe('supervision');
  });

  it('gives supervision a reply to a live card, even inside a session topic', () => {
    // Without this the reply would be typed into the agent as a prompt instead of resolving the
    // decision it was answering.
    const update = message({
      message_thread_id: 7,
      reply_to_message: { message_id: 555 },
    });
    expect(routeUpdate(update, context)).toBe('supervision');
  });

  it('still claims a topic message replying to something that is not a card', () => {
    const update = message({ message_thread_id: 7, reply_to_message: { message_id: 999 } });
    expect(routeUpdate(update, context)).toBe('remoteControl');
  });

  it('gives supervision text in a thread that is not one of our topics', () => {
    expect(routeUpdate(message({ message_thread_id: 99 }), context)).toBe('supervision');
  });

  it('routes an update that is neither, so nothing is ever unowned', () => {
    expect(routeUpdate({ edited_message: {} }, context)).toBe('supervision');
    expect(routeUpdate({}, context)).toBe('supervision');
  });
});

describe('UpdateQueue', () => {
  it('drains what was pushed, in order', () => {
    const q = new UpdateQueue();
    q.push({ update_id: 1 });
    q.push({ update_id: 2 });
    expect(q.drain().map(u => u.update_id)).toEqual([1, 2]);
  });

  it('is empty after a drain, so an update is handed over exactly once', () => {
    const q = new UpdateQueue();
    q.push({ update_id: 1 });
    q.drain();
    expect(q.drain()).toEqual([]);
    expect(q.size).toBe(0);
  });

  it('drops the oldest rather than growing without bound', () => {
    // A consumer that stops draining must not be able to exhaust memory; supervision times out
    // safely on its own, so losing the oldest update is the cheaper failure.
    const q = new UpdateQueue(3);
    for (let i = 1; i <= 5; i++) { q.push({ update_id: i }); }
    expect(q.size).toBe(3);
    expect(q.drain().map(u => u.update_id)).toEqual([3, 4, 5]);
  });
});
