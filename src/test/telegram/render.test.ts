import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_CHARS,
  MAX_TOPIC_NAME_CHARS,
  MAX_TURNS_PER_PASS,
  isEchoOfSent,
  planMirror,
  relativeAge,
  renderFleetList,
  renderHelp,
  renderTopicHeader,
  renderWho,
  statusIcon,
  topicName,
  truncate,
  truncate2,
} from '../../telegram/render';
import type { ClaudeSession, MessageExchange } from '../../SessionManager';
import { SESSION_STATUSES } from '../../sessionStatus';
import { deservesTopic } from '../../telegram/render';
import type { Ownership } from '../../telegram/ownership';

const NOW = new Date('2026-09-01T12:00:00Z').getTime();

function session(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    projectName: 'app',
    projectPath: '/work/app',
    title: 'fix the sort order',
    updatedAt: new Date(NOW - 120_000),
    status: 'approval',
    source: 'claude',
    ...over,
  };
}

const owned: Ownership = { pid: 100, basis: 'holds', workspace: '/work/app' };
const unowned: Ownership = { pid: null, basis: 'none', workspace: '' };

describe('statusIcon', () => {
  it('covers every status the codebase defines', () => {
    // A status added later must not silently render as the fallback glyph.
    for (const status of SESSION_STATUSES) {
      expect(statusIcon(status), status).toBeTruthy();
    }
  });

  it('gives each status a distinct icon', () => {
    // The icon leads every row and topic name, so two states sharing one would be unreadable —
    // `approval` needs a tap and `question` needs typing, and they must not look alike.
    const icons = new Set(SESSION_STATUSES.map(statusIcon));
    expect(icons.size).toBe(SESSION_STATUSES.length);
  });
});

describe('deservesTopic', () => {
  it('gives a topic to anything that needs you or is running', () => {
    expect(deservesTopic('approval')).toBe(true);
    expect(deservesTopic('question')).toBe(true);
    expect(deservesTopic('finished')).toBe(true);
    expect(deservesTopic('working')).toBe(true);
  });

  it('leaves the quiet states for on demand', () => {
    // Auto-creating a topic per historical session would put weeks of them in the sidebar.
    expect(deservesTopic('seen')).toBe(false);
    expect(deservesTopic('dormant')).toBe(false);
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 20)).toBe('short');
  });

  it('collapses runs of whitespace', () => {
    expect(truncate('a   b\n\nc', 20)).toBe('a b c');
  });

  it('never exceeds the limit', () => {
    expect(truncate('x'.repeat(100), 10).length).toBeLessThanOrEqual(10);
  });

  it('breaks on a word boundary when one is near the end', () => {
    expect(truncate('alpha beta gamma', 12)).toBe('alpha beta…');
  });

  it('cuts mid-word rather than losing most of the text', () => {
    // A single long word has no usable boundary; dropping it entirely would be worse.
    expect(truncate('supercalifragilistic', 10)).toBe('supercali…');
  });
});

describe('relativeAge', () => {
  it('reads as "now" for something very recent', () => {
    expect(relativeAge(new Date(NOW - 5_000), NOW)).toBe('now');
  });

  it('steps up through minutes, hours and days', () => {
    expect(relativeAge(new Date(NOW - 120_000), NOW)).toBe('2m');
    expect(relativeAge(new Date(NOW - 3 * 3600_000), NOW)).toBe('3h');
    expect(relativeAge(new Date(NOW - 3 * 86400_000), NOW)).toBe('3d');
  });

  it('does not produce a negative age for a clock skew', () => {
    expect(relativeAge(new Date(NOW + 60_000), NOW)).toBe('now');
  });
});

describe('topicName', () => {
  it('leads with the status icon so the topic list doubles as a status board', () => {
    expect(topicName(session())).toBe('🟠 claude · app / fix the sort order');
  });

  it('stays inside the Telegram topic name limit', () => {
    const long = session({ title: 'x'.repeat(400), projectName: 'y'.repeat(60) });
    expect(topicName(long).length).toBeLessThanOrEqual(MAX_TOPIC_NAME_CHARS);
  });

  it('keeps the workspace and truncates the title, so sessions stay distinguishable', () => {
    const name = topicName(session({ title: 'z'.repeat(200) }));
    expect(name).toContain('app');
    expect(name).toContain('claude');
  });

  it('survives a workspace name that alone fills the limit', () => {
    const name = topicName(session({ projectName: 'w'.repeat(200) }));
    expect(name.length).toBeLessThanOrEqual(MAX_TOPIC_NAME_CHARS);
  });
});

describe('renderFleetList', () => {
  it('says so plainly when there is nothing to show', () => {
    expect(renderFleetList([], 'desktop', NOW)).toContain('No sessions found.');
  });

  it('counts by what each session asks of you, not by state name', () => {
    // `approval` and `finished` both want something from you; `working` does not; `dormant` is
    // neither. The number worth reading at the top is "how many need me".
    const body = renderFleetList([
      { session: session({ sessionId: 'a', status: 'approval' }), owner: owned },
      { session: session({ sessionId: 'b', status: 'finished' }), owner: owned },
      { session: session({ sessionId: 'c', status: 'working' }), owner: owned },
      { session: session({ sessionId: 'd', status: 'dormant' }), owner: owned },
    ], 'desktop', NOW);
    expect(body).toContain('2 need you · 1 working · 4 total');
  });

  it('puts this machine first and marks it', () => {
    const body = renderFleetList([
      { session: session({ sessionId: 'a', peer: 'me@laptop2' }), owner: unowned },
      { session: session({ sessionId: 'b' }), owner: owned },
    ], 'desktop', NOW);
    expect(body.indexOf('desktop (this machine)')).toBeLessThan(body.indexOf('me@laptop2'));
  });

  it('orders rows by workspace and title, not by time', () => {
    // This message is edited in place, so a time ordering would reshuffle on every poll and be
    // unreadable. Rows must only move when a session appears or disappears.
    const body = renderFleetList([
      { session: session({ sessionId: 'a', projectName: 'zeta', updatedAt: new Date(NOW) }), owner: owned },
      { session: session({ sessionId: 'b', projectName: 'alpha', updatedAt: new Date(0) }), owner: owned },
    ], 'desktop', NOW);
    expect(body.indexOf('alpha')).toBeLessThan(body.indexOf('zeta'));
  });

  it('marks an unowned session read-only', () => {
    const body = renderFleetList([{ session: session(), owner: unowned }], 'desktop', NOW);
    expect(body).toContain('read-only');
  });

  it('does not mark an owned session read-only', () => {
    const body = renderFleetList([{ session: session(), owner: owned }], 'desktop', NOW);
    expect(body).not.toContain('read-only');
  });

  it('stays inside the Telegram message limit with many sessions', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({
      session: session({ sessionId: `s${i}`, title: `a rather long session title ${i}` }),
      owner: owned,
    }));
    expect(renderFleetList(many, 'desktop', NOW).length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });
});

describe('truncate2', () => {
  it('leaves a short body untouched, newlines included', () => {
    expect(truncate2('a\nb')).toBe('a\nb');
  });

  it('caps an oversized body and says it was cut', () => {
    const out = truncate2('x'.repeat(MAX_MESSAGE_CHARS + 500));
    expect(out.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(out).toContain('truncated');
  });
});

describe('renderTopicHeader', () => {
  it('tells the user they can type when the session is writable', () => {
    const body = renderTopicHeader(session(), owned, null);
    expect(body).toContain('Type here');
    expect(body).toContain('/work/app');
    expect(body).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('leads with the reason when it is not writable', () => {
    const body = renderTopicHeader(session({ source: 'codex' }), unowned, 'Codex is read-only.');
    expect(body).toContain('⚠ Codex is read-only.');
    expect(body).not.toContain('Type here');
  });

  it('names the owning window and how it claimed the session', () => {
    expect(renderTopicHeader(session(), owned, null)).toContain('pid 100');
    expect(renderTopicHeader(session(), { pid: 5, basis: 'workspace', workspace: '/w' }, null))
      .toContain('owns the workspace');
  });
});

describe('planMirror', () => {
  const turn = (text: string): MessageExchange => ({ role: 'user', text });

  it('posts nothing when there is nothing new', () => {
    expect(planMirror([turn('a')], 1)).toEqual({ messages: [], nextCursor: 1 });
  });

  it('posts each new turn', () => {
    const plan = planMirror([turn('a'), turn('b')], 0);
    expect(plan.messages).toHaveLength(2);
    expect(plan.nextCursor).toBe(2);
  });

  it('collapses a burst rather than flooding the group', () => {
    // Telegram tolerates roughly 20 messages a minute to one group. Posting a whole burst would
    // put every other topic minutes behind, so the overflow becomes one line.
    const turns = Array.from({ length: 30 }, (_, i) => turn(`t${i}`));
    const plan = planMirror(turns, 0);
    expect(plan.messages).toHaveLength(MAX_TURNS_PER_PASS + 1);
    expect(plan.messages[0]).toContain('26 earlier turns not shown');
    expect(plan.nextCursor).toBe(30);
  });

  it('keeps the most recent turns when it collapses', () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn(`t${i}`));
    const plan = planMirror(turns, 0);
    expect(plan.messages[plan.messages.length - 1]).toContain('t9');
  });

  it('advances past skipped turns so they are never replayed', () => {
    const turns = Array.from({ length: 30 }, (_, i) => turn(`t${i}`));
    const first = planMirror(turns, 0);
    expect(planMirror(turns, first.nextCursor).messages).toEqual([]);
  });

  it('recovers when the transcript is shorter than the cursor', () => {
    // A truncated or replaced transcript must not produce a negative slice.
    expect(planMirror([turn('a')], 5)).toEqual({ messages: [], nextCursor: 1 });
  });

  it('uses the singular for exactly one skipped turn', () => {
    const turns = Array.from({ length: MAX_TURNS_PER_PASS + 1 }, (_, i) => turn(`t${i}`));
    expect(planMirror(turns, 0).messages[0]).toContain('1 earlier turn not shown');
  });

  it('marks who said each turn', () => {
    const plan = planMirror([{ role: 'assistant', text: 'done' }], 0);
    expect(plan.messages[0]).toContain('🤖');
  });
});

describe('isEchoOfSent', () => {
  it('recognises a prompt this window just injected', () => {
    expect(isEchoOfSent('run the tests', ['run the tests'])).toBe(true);
  });

  it('ignores whitespace differences the transcript introduces', () => {
    expect(isEchoOfSent('run   the\ntests', ['run the tests'])).toBe(true);
  });

  it('does not match a different message', () => {
    expect(isEchoOfSent('run the tests', ['stop'])).toBe(false);
  });

  it('never matches on empty text', () => {
    expect(isEchoOfSent('   ', ['run the tests'])).toBe(false);
  });
});

describe('renderHelp and renderWho', () => {
  it('help states the write limits honestly', () => {
    const help = renderHelp();
    expect(help).toContain('Codex and Chat expose no message API');
    expect(help).toContain('/sessions');
  });

  it('who explains an unowned session instead of leaving it unexplained', () => {
    const body = renderWho([{ session: session(), owner: unowned }], 'desktop');
    expect(body).toContain('nobody — read-only');
  });

  it('who names the owning pid', () => {
    expect(renderWho([{ session: session(), owner: owned }], 'desktop')).toContain('pid 100');
  });

  it('who says so when there is nothing to show', () => {
    expect(renderWho([], 'desktop')).toBe('No sessions found.');
  });
});
