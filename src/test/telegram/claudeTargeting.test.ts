/**
 * The targeted Claude injection, exercised without an IDE.
 *
 * The real path reaches Claude's live manager through the V8 inspector, which no test can do. But
 * the function that gets injected is just a string of JavaScript whose `this` is the manager — so a
 * fake manager can be built here and the function run against it with `new Function`. That covers
 * the part that actually decides *which session gets the message*, which is the part that must never
 * be wrong.
 */

import { describe, expect, it, vi } from 'vitest';

// ClaudeSender imports 'vscode' (and ClaudeInspector, which imports it too); stub it.
vi.mock('vscode', () => ({ window: {}, extensions: { getExtension: () => undefined } }));

import {
  buildClaudeUserMessage,
  buildTargetedInjectFn,
  describeSendStatus,
  sendLanded,
} from '../../agents/ClaudeSender';

/** Build a manager whose channels are keyed as Claude keys them, and run the injected function. */
function runInject(
  sessionId: string,
  text: string,
  channels: Array<{ id: string; sessionIdProp?: string; initSessionId?: string }>,
): { status: string; written: Record<string, string[]> } {
  const written: Record<string, string[]> = {};
  const map = new Map<string, unknown>();
  for (const spec of channels) {
    written[spec.id] = [];
    const channel: Record<string, unknown> = {
      query: {
        initConfig: spec.initSessionId !== undefined ? { sessionId: spec.initSessionId } : {},
        transport: { write: (line: string) => { written[spec.id].push(line); } },
      },
    };
    if (spec.sessionIdProp !== undefined) { channel.sessionId = spec.sessionIdProp; }
    map.set(spec.id, channel);
  }
  const manager = { allComms: new Map([['comm', { channels: map }]]) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(`return (${buildTargetedInjectFn(sessionId, text)});`)();
  return { status: fn.call(manager) as string, written };
}

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('buildClaudeUserMessage', () => {
  it('builds the envelope Claude Code writes to the CLI', () => {
    expect(buildClaudeUserMessage('hi')).toEqual({
      type: 'user',
      session_id: '',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      parent_tool_use_id: null,
    });
  });
});

describe('buildTargetedInjectFn — targeting', () => {
  it('writes to the channel whose map key is the session id', () => {
    const out = runInject(SID, 'hello', [{ id: SID }, { id: 'other' }]);
    expect(out.status).toBe('ok:matched');
    expect(out.written[SID]).toHaveLength(1);
    expect(out.written.other).toHaveLength(0);
  });

  it('writes to the channel carrying the session id as a property', () => {
    const out = runInject(SID, 'hello', [
      { id: 'c1', sessionIdProp: SID },
      { id: 'c2', sessionIdProp: 'someone-else' },
    ]);
    expect(out.status).toBe('ok:matched');
    expect(out.written.c1).toHaveLength(1);
    expect(out.written.c2).toHaveLength(0);
  });

  it('writes to the channel whose initConfig names the session', () => {
    const out = runInject(SID, 'hello', [
      { id: 'c1', initSessionId: 'someone-else' },
      { id: 'c2', initSessionId: SID },
    ]);
    expect(out.status).toBe('ok:matched');
    expect(out.written.c2).toHaveLength(1);
  });

  it('sends the message envelope, newline-terminated', () => {
    const out = runInject(SID, 'run the tests', [{ id: SID }]);
    const line = out.written[SID][0];
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.trim())).toMatchObject({
      type: 'user', message: { content: [{ type: 'text', text: 'run the tests' }] },
    });
  });
});

describe('buildTargetedInjectFn — refusing to guess', () => {
  it('refuses when several channels are open and none matches', () => {
    // This is the case that matters. Picking one would deliver the user's prompt to the wrong
    // agent, which then acts on it — worse than not sending at all.
    const out = runInject(SID, 'hello', [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]);
    expect(out.status).toBe('ambiguous:3');
    expect(Object.values(out.written).flat()).toHaveLength(0);
  });

  it('refuses when two channels both claim the session id', () => {
    const out = runInject(SID, 'hello', [
      { id: 'c1', sessionIdProp: SID },
      { id: 'c2', initSessionId: SID },
    ]);
    expect(out.status).toBe('ambiguous-match:2');
    expect(Object.values(out.written).flat()).toHaveLength(0);
  });

  it('falls back to the only open channel, where there is nothing to confuse', () => {
    const out = runInject(SID, 'hello', [{ id: 'unrelated' }]);
    expect(out.status).toBe('ok:sole');
    expect(out.written.unrelated).toHaveLength(1);
  });

  it('reports having no channel at all', () => {
    const out = runInject(SID, 'hello', []);
    expect(out.status).toBe('no-channel');
  });

  it('reports a channel with no writable transport', () => {
    const manager = {
      allComms: new Map([['comm', { channels: new Map([[SID, { query: {} }]]) }]]),
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(`return (${buildTargetedInjectFn(SID, 'x')});`)();
    expect(fn.call(manager)).toBe('no-transport');
  });

  it('survives a manager with no comms at all', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(`return (${buildTargetedInjectFn(SID, 'x')});`)();
    expect(fn.call({})).toBe('no-channel');
  });

  it('reports rather than throws when a channel property getter blows up', () => {
    const hostile = { query: { initConfig: {}, transport: { write: () => undefined } } };
    Object.defineProperty(hostile, 'boom', {
      enumerable: true, get() { throw new Error('nope'); },
    });
    const manager = {
      allComms: new Map([['comm', { channels: new Map([['c1', hostile]]) }]]),
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(`return (${buildTargetedInjectFn(SID, 'x')});`)();
    // The hostile property is skipped, so the sole-channel fallback still applies.
    expect(fn.call(manager)).toBe('ok:sole');
  });

  it('escapes a session id and text that contain quotes', () => {
    const out = runInject('a"b', 'say "hi"\nplease', [{ id: 'a"b' }]);
    expect(out.status).toBe('ok:matched');
    expect(JSON.parse(out.written['a"b'][0].trim())).toMatchObject({
      message: { content: [{ type: 'text', text: 'say "hi"\nplease' }] },
    });
  });
});

describe('sendLanded', () => {
  it('accepts only the ok statuses', () => {
    expect(sendLanded('ok')).toBe(true);
    expect(sendLanded('ok:matched')).toBe(true);
    expect(sendLanded('ok:sole')).toBe(true);
    expect(sendLanded('ambiguous:2')).toBe(false);
    expect(sendLanded('no-channel')).toBe(false);
    expect(sendLanded('err:boom')).toBe(false);
  });
});

describe('describeSendStatus', () => {
  it('says what to do next, not what the internal state was', () => {
    expect(describeSendStatus('no-channel')).toContain('Focus in IDE');
    expect(describeSendStatus('ambiguous:3')).toContain('3 Claude sessions');
    expect(describeSendStatus('ok:matched')).toBe('Sent to this session.');
  });

  it('still produces a sentence for a status it does not know', () => {
    expect(describeSendStatus('diag:gB-not-found')).toContain('Not sent');
  });
});
