import { describe, expect, it } from 'vitest';
import {
  MAX_CALLBACK_BYTES,
  callbackFits,
  classifyUpdate,
  decodeCallback,
  encodeCallback,
  isAuthorized,
  parseCommandWord,
  type AuthConfig,
  type Callback,
} from '../../telegram/intent';

const auth: AuthConfig = { chatId: '-100999', allowedUserIds: ['42'] };

function message(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    update_id: 1,
    message: {
      chat: { id: -100999 },
      from: { id: 42 },
      text: 'hello',
      ...over,
    },
  };
}

describe('isAuthorized', () => {
  it('authorises nobody when the list is empty', () => {
    // An empty allowlist meaning "everyone" would turn a half-finished setup into an open door
    // to every coding agent on the machine, and the failure would be silent.
    expect(isAuthorized('42', [])).toBe(false);
  });

  it('authorises a listed id and refuses an unlisted one', () => {
    expect(isAuthorized('42', ['42'])).toBe(true);
    expect(isAuthorized('43', ['42'])).toBe(false);
  });
});

describe('parseCommandWord', () => {
  it('reads a bare command', () => {
    expect(parseCommandWord('/sessions')).toBe('sessions');
  });

  it('strips the bot mention Telegram adds in groups', () => {
    expect(parseCommandWord('/sessions@my_sitter_bot')).toBe('sessions');
  });

  it('lower-cases and ignores arguments', () => {
    expect(parseCommandWord('/HELP me please')).toBe('help');
  });

  it('returns null for ordinary text', () => {
    expect(parseCommandWord('hello')).toBeNull();
    expect(parseCommandWord('  not / a command')).toBeNull();
  });
});

describe('classifyUpdate — refusals come first', () => {
  it('ignores a message from another chat', () => {
    const intent = classifyUpdate(message({ chat: { id: -1 } }), auth);
    expect(intent).toEqual({ kind: 'ignore', reason: 'different chat' });
  });

  it('refuses an unlisted sender and reports the id so it can be added', () => {
    const intent = classifyUpdate(message({ from: { id: 999 } }), auth);
    expect(intent).toEqual({ kind: 'unauthorized', userId: '999' });
  });

  it('refuses everyone when the allowlist is empty', () => {
    const intent = classifyUpdate(message(), { chatId: '-100999', allowedUserIds: [] });
    expect(intent.kind).toBe('unauthorized');
  });

  it('checks the chat before the sender, so a foreign chat is never attributed', () => {
    const intent = classifyUpdate(
      { update_id: 1, message: { chat: { id: -1 }, from: { id: 999 }, text: 'x' } }, auth);
    expect(intent.kind).toBe('ignore');
  });

  it('matches ids across the number/string boundary', () => {
    // Telegram ids are numeric on the wire but configured as strings. A mismatch here would be a
    // silent authorisation failure.
    const intent = classifyUpdate(message(), auth);
    expect(intent.kind).not.toBe('unauthorized');
  });

  it('ignores an update that is neither a message nor a tap', () => {
    expect(classifyUpdate({ update_id: 1, edited_message: {} }, auth).kind).toBe('ignore');
  });

  it('ignores a message with no sender', () => {
    const intent = classifyUpdate({ update_id: 1, message: { chat: { id: -100999 }, text: 'x' } }, auth);
    expect(intent).toEqual({ kind: 'ignore', reason: 'no sender' });
  });

  it('ignores a non-text message such as a photo', () => {
    const intent = classifyUpdate(message({ text: undefined }), auth);
    expect(intent.kind).toBe('ignore');
  });
});

describe('classifyUpdate — commands', () => {
  it.each([
    ['/sessions', 'listSessions'],
    ['/start', 'listSessions'],
    ['/help', 'help'],
    ['/who', 'who'],
    ['/new', 'newSessionMenu'],
  ])('routes %s', (text, kind) => {
    expect(classifyUpdate(message({ text }), auth).kind).toBe(kind);
  });

  it('ignores an unknown command instead of treating it as a prompt', () => {
    // Sending "/deploy" into an agent because it was not recognised would be a nasty surprise.
    const intent = classifyUpdate(message({ text: '/deploy', message_thread_id: 7 }), auth);
    expect(intent.kind).toBe('ignore');
  });
});

describe('classifyUpdate — free text', () => {
  it('routes text in a topic to that topic', () => {
    const intent = classifyUpdate(message({ text: 'run the tests', message_thread_id: 7 }), auth);
    expect(intent).toEqual({ kind: 'sendToTopic', threadId: 7, text: 'run the tests' });
  });

  it('trims the text', () => {
    const intent = classifyUpdate(message({ text: '  spaced  ', message_thread_id: 7 }), auth);
    expect(intent).toMatchObject({ text: 'spaced' });
  });

  it('refuses to guess a target for text sent to General', () => {
    // Picking "the most recent session" here is exactly the mistake that sends a prompt to the
    // wrong agent, so General text is reported as unroutable instead.
    const intent = classifyUpdate(message({ text: 'run the tests' }), auth);
    expect(intent).toEqual({ kind: 'unroutableText', text: 'run the tests' });
  });

  it('ignores whitespace-only text', () => {
    expect(classifyUpdate(message({ text: '   ', message_thread_id: 7 }), auth).kind).toBe('ignore');
  });
});

describe('classifyUpdate — button taps', () => {
  function tap(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      update_id: 2,
      callback_query: {
        id: 'cb1',
        from: { id: 42 },
        data: 'rc|refresh',
        message: { chat: { id: -100999 }, message_thread_id: 7 },
        ...over,
      },
    };
  }

  it('accepts an authorised tap and carries the thread', () => {
    expect(classifyUpdate(tap(), auth)).toEqual({
      kind: 'callback', data: 'rc|refresh', callbackId: 'cb1', threadId: 7,
    });
  });

  it('applies the same allowlist to taps as to messages', () => {
    // A button is as capable as typing, so it must not be a way around the allowlist.
    expect(classifyUpdate(tap({ from: { id: 999 } }), auth).kind).toBe('unauthorized');
  });

  it('rejects a tap from another chat', () => {
    expect(classifyUpdate(tap({ message: { chat: { id: -1 } } }), auth).kind).toBe('ignore');
  });

  it('reports a General tap as having no thread', () => {
    const intent = classifyUpdate(tap({ message: { chat: { id: -100999 } } }), auth);
    expect(intent).toMatchObject({ threadId: null });
  });
});

describe('callback payloads', () => {
  const all: Callback[] = [
    { kind: 'refresh' },
    { kind: 'newMenu' },
    { kind: 'history' },
    { kind: 'openSession', index: 7 },
    { kind: 'launch', index: 3, source: 'bob' },
    { kind: 'focus', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    { kind: 'transcript', sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    { kind: 'closeTopic', threadId: 12345 },
  ];

  it('round-trips every payload', () => {
    for (const cb of all) {
      expect(decodeCallback(encodeCallback(cb))).toEqual(cb);
    }
  });

  it('fits every payload in Telegram\'s 64-byte limit', () => {
    // An oversized payload does not error — the button simply does nothing when tapped.
    for (const cb of all) {
      expect(callbackFits(cb), `${encodeCallback(cb)} is too long`).toBe(true);
      expect(Buffer.byteLength(encodeCallback(cb))).toBeLessThanOrEqual(MAX_CALLBACK_BYTES);
    }
  });

  it('rejects a payload that is not ours', () => {
    expect(decodeCallback('something|else').kind).toBe('unknown');
    expect(decodeCallback('').kind).toBe('unknown');
  });

  it('rejects malformed arguments rather than acting on index NaN', () => {
    expect(decodeCallback('rc|open|abc').kind).toBe('unknown');
    expect(decodeCallback('rc|open|-1').kind).toBe('unknown');
    expect(decodeCallback('rc|launch|0|gemini').kind).toBe('unknown');
    expect(decodeCallback('rc|launch|x|bob').kind).toBe('unknown');
    expect(decodeCallback('rc|focus|').kind).toBe('unknown');
    expect(decodeCallback('rc|close|nope').kind).toBe('unknown');
  });
});
