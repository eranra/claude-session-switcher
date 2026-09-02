/**
 * Ownership targeting: the exact route from a session id to its channel.
 *
 * `claudeTargeting.test.ts` covers the string-search route — the one that asks every channel whether
 * it carries the session id. It never does, so a window with two Claude sessions open always refused
 * to send. This file covers the route that replaces the guessing with object identity.
 *
 * Claude's manager holds two links:
 *
 * - `sessionPanels: Map<sessionId, WebviewPanel>` — self-pruning, and one panel holds exactly one
 *   session at a time (setting a session on a panel deletes that panel's previous entry).
 * - `sessionStates: Map<sessionId, {info, author}>` — `author` is the surface that reported the
 *   session: the `WebviewPanel` for a tab, the comm object itself for the sidebar. Claude uses the
 *   same identity to prune its own state when a surface is disposed.
 *
 * And a comm stores the panel it hosts as `panelTab` (`undefined` for the sidebar comm). Chaining
 * those gives sessionId → surface → comm → that comm's channel.
 *
 * The real path reaches the live manager through the V8 inspector, which no test can do. But the
 * injected code is a string of JavaScript whose `this` is the manager, so a fake manager of the same
 * shape can be built here and the function run against it. `panel` below is an opaque token standing
 * in for a WebviewPanel — identity is the only thing about it that matters, which is the point.
 */

import { describe, expect, it, vi } from 'vitest';

// ClaudeSender imports 'vscode' (and ClaudeInspector, which imports it too); stub it.
vi.mock('vscode', () => ({ window: {}, extensions: { getExtension: () => undefined } }));

import {
  buildResolutionProbeFn,
  buildTargetedInjectFn,
  describeSendStatus,
  sendLanded,
} from '../../agents/ClaudeSender';

interface FakeCommSpec {
  /** Channels this comm holds, in map order. */
  channels: Array<{ id: string; sessionIdProp?: string; initSessionId?: string }>;
  /** Name of the panel this comm hosts. Omitted = the sidebar comm (`panelTab` undefined). */
  panel?: string;
}

interface FakeManagerSpec {
  comms: FakeCommSpec[];
  /** sessionId → panel name, as Claude's `sessionPanels` holds it. */
  sessionPanels?: Record<string, string>;
  /** sessionId → author, either `{ panel: name }` or `{ comm: index into comms }`. */
  sessionStates?: Record<string, { panel?: string; comm?: number }>;
}

function runOwned(
  spec: FakeManagerSpec, sessionId: string, text = 'hello',
): { status: string; written: Record<string, string[]> } {
  const written: Record<string, string[]> = {};
  const panels = new Map<string, object>();
  const panelFor = (name: string): object => {
    if (!panels.has(name)) { panels.set(name, { panelName: name }); }
    return panels.get(name)!;
  };

  const comms = spec.comms.map(commSpec => {
    const map = new Map<string, unknown>();
    for (const ch of commSpec.channels) {
      written[ch.id] = [];
      const channel: Record<string, unknown> = {
        query: {
          initConfig: ch.initSessionId !== undefined ? { sessionId: ch.initSessionId } : {},
          transport: { write: (line: string) => { written[ch.id].push(line); } },
        },
      };
      if (ch.sessionIdProp !== undefined) { channel.sessionId = ch.sessionIdProp; }
      map.set(ch.id, channel);
    }
    return {
      channels: map,
      panelTab: commSpec.panel === undefined ? undefined : panelFor(commSpec.panel),
    };
  });

  const sessionPanels = new Map<string, object>();
  for (const [sid, panelName] of Object.entries(spec.sessionPanels ?? {})) {
    sessionPanels.set(sid, panelFor(panelName));
  }
  const sessionStates = new Map<string, { info: unknown; author: unknown }>();
  for (const [sid, author] of Object.entries(spec.sessionStates ?? {})) {
    sessionStates.set(sid, {
      info: { sessionId: sid, state: 'idle' },
      author: author.panel !== undefined ? panelFor(author.panel) : comms[author.comm!],
    });
  }

  const manager = { allComms: new Set(comms), sessionPanels, sessionStates };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(`return (${buildTargetedInjectFn(sessionId, text)});`)();
  return { status: fn.call(manager) as string, written };
}

/** A channel whose transport records nothing — for channels a test only needs to exist. */
function inertChannel(): Record<string, unknown> {
  return { query: { initConfig: {}, transport: { write: () => undefined } } };
}

/** Run the injected function against a hand-built manager (shapes the spec helper cannot express). */
function runRaw(manager: object, sessionId: string, text = 'hi'): string {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(`return (${buildTargetedInjectFn(sessionId, text)});`)();
  return fn.call(manager) as string;
}

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = 'ffffffff-1111-2222-3333-444444444444';

describe('buildTargetedInjectFn — ownership route', () => {
  it('sends to the right tab when a window has two Claude panels open', () => {
    // The reported failure. Two tabs, two comms, one channel each, and no channel carries the
    // session id anywhere — so the string search found nothing and the send was refused.
    const out = runOwned({
      comms: [
        { panel: 'tabA', channels: [{ id: 'chan-a' }] },
        { panel: 'tabB', channels: [{ id: 'chan-b' }] },
      ],
      sessionPanels: { [SID]: 'tabB', [OTHER]: 'tabA' },
    }, SID);
    expect(out.status).toBe('ok:owner');
    expect(out.written['chan-b']).toHaveLength(1);
    expect(out.written['chan-a']).toHaveLength(0);
  });

  it('follows the author when the panel map has no entry, as for a sidebar session', () => {
    const out = runOwned({
      comms: [
        { channels: [{ id: 'sidebar' }] },
        { panel: 'tabA', channels: [{ id: 'chan-a' }] },
      ],
      sessionStates: { [SID]: { comm: 0 }, [OTHER]: { panel: 'tabA' } },
    }, SID);
    expect(out.status).toBe('ok:owner');
    expect(out.written.sidebar).toHaveLength(1);
    expect(out.written['chan-a']).toHaveLength(0);
  });

  it('follows an author that is a panel, when sessionPanels has been pruned', () => {
    const out = runOwned({
      comms: [
        { panel: 'tabA', channels: [{ id: 'a1' }] },
        { panel: 'tabB', channels: [{ id: 'b1' }] },
      ],
      sessionStates: { [SID]: { panel: 'tabB' } },
    }, SID);
    expect(out.status).toBe('ok:owner');
    expect(out.written.b1).toHaveLength(1);
  });

  it('refuses when one surface authored several sessions, because only one is live', () => {
    // sessionStates accumulates. A sidebar that has shown two sessions has two entries with the
    // same author, and nothing in the manager says which of them its live channel belongs to.
    const out = runOwned({
      comms: [
        { channels: [{ id: 'sidebar' }] },
        { panel: 'tabA', channels: [{ id: 'chan-a' }] },
      ],
      sessionStates: { [SID]: { comm: 0 }, [OTHER]: { comm: 0 } },
    }, SID);
    expect(out.status).toBe('ambiguous:2');
    expect(Object.values(out.written).flat()).toHaveLength(0);
  });

  it('narrows to the owning comm, then matches by id inside it', () => {
    const out = runOwned({
      comms: [
        { panel: 'tabA', channels: [{ id: 'a1' }, { id: 'a2', sessionIdProp: SID }] },
        { panel: 'tabB', channels: [{ id: 'b1', sessionIdProp: SID }] },
      ],
      sessionPanels: { [SID]: 'tabA' },
    }, SID);
    // Two channels claim the id window-wide, which alone would be 'ambiguous-match:2'. Ownership
    // rules tabB out entirely, so the match inside tabA is unambiguous.
    expect(out.status).toBe('ok:matched');
    expect(out.written.a2).toHaveLength(1);
    expect(out.written.b1).toHaveLength(0);
  });

  it('refuses when the owning comm holds several channels and none matches', () => {
    const out = runOwned({
      comms: [
        { panel: 'tabA', channels: [{ id: 'a1' }, { id: 'a2' }] },
        { panel: 'tabB', channels: [{ id: 'b1' }] },
      ],
      sessionPanels: { [SID]: 'tabA' },
    }, SID);
    expect(out.status).toBe('ambiguous:2');
    expect(Object.values(out.written).flat()).toHaveLength(0);
  });

  it('finds the comm even if Claude renames the field holding its panel', () => {
    // The link is object identity, not the name `panelTab`, so a rename in a future Claude build is
    // survivable: any own property of the comm that IS the owning surface identifies that comm.
    const panel = { panelName: 'tabA' };
    const written: string[] = [];
    const commA = {
      hostSurface: panel,   // deliberately not `panelTab`
      channels: new Map([['chan-a', {
        query: { initConfig: {}, transport: { write: (l: string) => { written.push(l); } } },
      }]]),
    };
    const commB = { channels: new Map([['chan-b', inertChannel()]]) };
    const manager = {
      allComms: new Set([commA, commB]),
      sessionPanels: new Map([[SID, panel]]),
      sessionStates: new Map(),
    };
    expect(runRaw(manager, SID)).toBe('ok:owner');
    expect(written).toHaveLength(1);
  });

  it('falls back to the old behaviour when no ownership link exists', () => {
    const out = runOwned({
      comms: [
        { panel: 'tabA', channels: [{ id: 'a1' }] },
        { panel: 'tabB', channels: [{ id: 'b1' }] },
      ],
    }, SID);
    expect(out.status).toBe('ambiguous:2');
    expect(Object.values(out.written).flat()).toHaveLength(0);
  });

  it('refuses the ownership route when two comms claim one panel', () => {
    // Claude never builds this, but a stale or unexpected shape must not be allowed to pick a tab.
    const panel = { panelName: 'tabA' };
    const manager = {
      allComms: new Set([
        { panelTab: panel, channels: new Map([['a1', inertChannel()]]) },
        { panelTab: panel, channels: new Map([['a2', inertChannel()]]) },
      ]),
      sessionPanels: new Map([[SID, panel]]),
      sessionStates: new Map(),
    };
    expect(runRaw(manager, SID)).toBe('ambiguous:2');
  });

  it('refuses the ownership route when two sessions share one panel entry', () => {
    const panel = { panelName: 'tabA' };
    const manager = {
      allComms: new Set([
        { panelTab: panel, channels: new Map([['a1', inertChannel()]]) },
        { channels: new Map([['s1', inertChannel()]]) },
      ]),
      sessionPanels: new Map([[SID, panel], [OTHER, panel]]),
      sessionStates: new Map(),
    };
    expect(runRaw(manager, SID)).toBe('ambiguous:2');
  });

  it('reports no writable transport on the owned channel rather than sending elsewhere', () => {
    const panel = { panelName: 'tabA' };
    const manager = {
      allComms: new Set([
        { panelTab: panel, channels: new Map([['a1', { query: {} }]]) },
        { channels: new Map([['s1', inertChannel()]]) },
      ]),
      sessionPanels: new Map([[SID, panel]]),
      sessionStates: new Map(),
    };
    expect(runRaw(manager, SID)).toBe('no-transport');
  });

  it('ignores an owning comm that has no channel of its own', () => {
    // A panel whose Claude is still launching has a comm but no channel yet. Narrowing to an empty
    // set would strand the send; the window-wide view still applies.
    const panel = { panelName: 'tabA' };
    const written: string[] = [];
    const manager = {
      allComms: new Set([
        { panelTab: panel, channels: new Map() },
        {
          channels: new Map([['s1', {
            query: { initConfig: {}, transport: { write: (l: string) => { written.push(l); } } },
          }]]),
        },
      ]),
      sessionPanels: new Map([[SID, panel]]),
      sessionStates: new Map(),
    };
    expect(runRaw(manager, SID)).toBe('ok:sole');
    expect(written).toHaveLength(1);
  });

  it('survives a manager with no ownership maps at all', () => {
    const out = runOwned({ comms: [{ channels: [{ id: 'only' }] }] }, SID);
    expect(out.status).toBe('ok:sole');
  });

  it('reports rather than throws when the ownership maps are hostile', () => {
    const manager = {
      allComms: new Set([{ channels: new Map([['s1', inertChannel()]]) }]),
      get sessionPanels(): never { throw new Error('nope'); },
      sessionStates: new Map(),
    };
    // The route is skipped, not fatal: the window still has exactly one channel.
    expect(runRaw(manager, SID)).toBe('ok:sole');
  });
});

describe('ownership statuses, reported', () => {
  it('counts ok:owner as landed and says it plainly', () => {
    expect(sendLanded('ok:owner')).toBe(true);
    expect(describeSendStatus('ok:owner')).toBe('Sent to this session.');
  });
});

describe('buildResolutionProbeFn', () => {
  /** Build the same two-tab manager the ownership test uses, and probe it. */
  function probe(manager: object): {
    commCount: number;
    comms: Array<{ channelIds: string[]; hasPanelTab: boolean; objectProps: string[] }>;
    sessions: Array<{ sessionId: string; verdict: string; inPanels: boolean; authorKind: string }>;
  } {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(`return (${buildResolutionProbeFn()});`)();
    return JSON.parse(fn.call(manager) as string);
  }

  function twoTabManager(): { manager: object; written: string[] } {
    const written: string[] = [];
    const tabA = { panelName: 'tabA' };
    const tabB = { panelName: 'tabB' };
    const chan = (): Record<string, unknown> => ({
      query: { initConfig: {}, transport: { write: (l: string) => { written.push(l); } } },
    });
    return {
      written,
      manager: {
        allComms: new Set([
          { panelTab: tabA, channels: new Map([['chan-a', chan()]]) },
          { panelTab: tabB, channels: new Map([['chan-b', chan()]]) },
        ]),
        sessionPanels: new Map([[SID, tabB], [OTHER, tabA]]),
        sessionStates: new Map([
          [SID, { info: {}, author: tabB }],
          [OTHER, { info: {}, author: tabA }],
        ]),
      },
    };
  }

  it('reports the channel each session would resolve to, and by which route', () => {
    const { manager } = twoTabManager();
    const out = probe(manager);
    expect(out.commCount).toBe(2);
    const rows = Object.fromEntries(out.sessions.map(s => [s.sessionId, s.verdict]));
    expect(rows[SID]).toBe('would-send:owner → channel chan-b');
    expect(rows[OTHER]).toBe('would-send:owner → channel chan-a');
  });

  it('writes nothing — it is a probe', () => {
    const { manager, written } = twoTabManager();
    probe(manager);
    expect(written).toHaveLength(0);
  });

  it('names the fields the ownership route depends on, so a rename is visible', () => {
    const { manager } = twoTabManager();
    const out = probe(manager);
    expect(out.comms.every(c => c.hasPanelTab)).toBe(true);
    expect(out.comms[0].objectProps).toContain('panelTab');
    expect(out.sessions.every(s => s.inPanels && s.authorKind === 'surface')).toBe(true);
  });

  it('reports a refusal as a refusal, with the reason', () => {
    const out = probe({
      allComms: new Set([
        { channels: new Map([['s1', inertChannel()]]) },
        { channels: new Map([['s2', inertChannel()]]) },
      ]),
      sessionPanels: new Map(),
      sessionStates: new Map([
        [SID, { info: {}, author: null }],
        [OTHER, { info: {}, author: null }],
      ]),
    });
    expect(out.sessions.map(s => s.verdict)).toEqual(['refused:ambiguous:2', 'refused:ambiguous:2']);
  });

  it('survives a manager it does not understand', () => {
    const out = probe({});
    expect(out.commCount).toBe(0);
    expect(out.sessions).toEqual([]);
  });
});
