import { describe, expect, it } from 'vitest';
import {
  ABANDONED_TOOL_CALL_MS,
  PROMPT_WINDOW_MS,
  STREAMING_WINDOW_MS,
  TOOL_STALL_MS,
  UNREAD_MAX_AGE_MS,
  bobStatus,
  claudeStatusFromTail,
  isBlockedOnYou,
  isQuestionTool,
  isWorklistSignal,
  needsYou,
  pendingStatusForTool,
  resolveDisplayStatus,
  type JsonlRecord,
} from '../sessionStatus';

// Every rule the status dot depends on lives here, as a pure function, precisely so the six
// states can be pinned without a VS Code host, a transcript on disk, or a Bob database. The
// table in docs/STATUS-INDICATORS.md is the prose version of these cases — change one, change both.

const NOW = 1_800_000_000_000;

/** Classify a transcript tail whose last write was `quietMs` ago. */
function tail(records: JsonlRecord[], quietMs: number) {
  return claudeStatusFromTail(records, NOW - quietMs, NOW);
}

const userPrompt = (text = 'do the thing'): JsonlRecord => ({
  type: 'user', message: { content: [{ type: 'text', text }] },
});
const toolResultRecord = (): JsonlRecord => ({
  type: 'user', toolUseResult: { ok: true },
  message: { content: [{ type: 'tool_result', text: 'done' }] },
});
const assistantText = (text = 'here you go'): JsonlRecord => ({
  type: 'assistant', message: { content: [{ type: 'text', text }] },
});
const assistantToolUse = (name: string): JsonlRecord => ({
  type: 'assistant', message: { content: [{ type: 'tool_use', name }] },
});

describe('question tools', () => {
  it('recognises both agents’ question tools', () => {
    expect(isQuestionTool('AskUserQuestion')).toBe(true);
    expect(isQuestionTool('ask_followup_question')).toBe(true);
    expect(isQuestionTool('Bash')).toBe(false);
    expect(isQuestionTool(undefined)).toBe(false);
  });

  it('splits a pending tool into the two states it can mean', () => {
    expect(pendingStatusForTool('AskUserQuestion')).toBe('question');
    expect(pendingStatusForTool('Bash')).toBe('approval');
  });
});

describe('claudeStatusFromTail', () => {
  it('an empty tail with no recent write is dormant', () => {
    expect(tail([], STREAMING_WINDOW_MS + 1)).toBe('dormant');
  });

  it('a fresh user prompt is working — the agent is about to start', () => {
    expect(tail([userPrompt()], 1_000)).toBe('working');
  });

  it('a user prompt nobody ever answered goes dormant, it does not pulse forever', () => {
    expect(tail([userPrompt()], PROMPT_WINDOW_MS + 1)).toBe('dormant');
  });

  it('streaming assistant text is working', () => {
    expect(tail([userPrompt(), assistantText()], 1_000)).toBe('working');
  });

  it('assistant text that stopped being written is finished', () => {
    expect(tail([userPrompt(), assistantText()], STREAMING_WINDOW_MS + 1)).toBe('finished');
  });

  it('a tool call still writing is working', () => {
    expect(tail([assistantToolUse('Bash')], 1_000)).toBe('working');
  });

  it('a tool call that went quiet is an approval prompt, not a running tool', () => {
    expect(tail([assistantToolUse('Bash')], TOOL_STALL_MS + 1)).toBe('approval');
  });

  it('an unanswered question stays a question for as long as answering it is plausible', () => {
    expect(tail([assistantToolUse('AskUserQuestion')], 1_000)).toBe('question');
    expect(tail([assistantToolUse('AskUserQuestion')], 3 * 3600_000)).toBe('question');
    expect(tail([assistantToolUse('AskUserQuestion')], ABANDONED_TOOL_CALL_MS - 1_000))
      .toBe('question');
  });

  it('a tool call silent for a day is abandoned, not blocked on you', () => {
    // The bug this pins: `approval` and `question` are the two states the worklist never ages out,
    // so a session killed mid-tool-call sat at the top of the list forever — on the strength of a
    // file that will never be written again, with no process left to answer it. Observed in a real
    // registry as a 47-hour-old `approval` no window held.
    expect(tail([assistantToolUse('Edit')], ABANDONED_TOOL_CALL_MS + 1)).toBe('dormant');
    expect(tail([assistantToolUse('AskUserQuestion')], ABANDONED_TOOL_CALL_MS + 1)).toBe('dormant');
    expect(tail([{ type: 'tool_use', name: 'Bash' }], ABANDONED_TOOL_CALL_MS + 1)).toBe('dormant');
  });

  it('holds the blocked states right up to the boundary', () => {
    // The bound must not eat a prompt you left overnight; a day is the point, not an approximation.
    expect(tail([assistantToolUse('Edit')], ABANDONED_TOOL_CALL_MS - 1_000)).toBe('approval');
  });

  it('leaves a session its blocked state when a live signal still vouches for it', () => {
    // The bound only touches what the *file* claims. A live pending approval outranks it, so a
    // genuinely blocked session in an open window keeps its amber marker at any age.
    const abandoned = tail([assistantToolUse('Edit')], ABANDONED_TOOL_CALL_MS + 1);
    expect(resolveDisplayStatus(abandoned, {
      pending: 'approval',
      updatedAtMs: NOW - ABANDONED_TOOL_CALL_MS - 1,
      nowMs: NOW,
    })).toBe('approval');
  });

  it('a question among parallel tool calls wins — it needs typing, not a click', () => {
    const rec: JsonlRecord = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'AskUserQuestion' }],
      },
    };
    expect(tail([rec], TOOL_STALL_MS + 1)).toBe('question');
  });

  it('a returned tool result is working while fresh and dormant once abandoned', () => {
    expect(tail([assistantToolUse('Bash'), toolResultRecord()], 1_000)).toBe('working');
    expect(tail([assistantToolUse('Bash'), toolResultRecord()], TOOL_STALL_MS + 1)).toBe('dormant');
  });

  it('walks back past injected context to the real last turn', () => {
    const meta: JsonlRecord = { type: 'user', isMeta: true, message: { content: 'skill loaded' } };
    expect(tail([assistantText(), meta], STREAMING_WINDOW_MS + 1)).toBe('finished');
    expect(tail([assistantToolUse('Bash'), meta], TOOL_STALL_MS + 1)).toBe('approval');
  });

  it('an interrupt you typed ends the turn — it is not a pending tool call', () => {
    const interrupt: JsonlRecord = {
      type: 'user', message: { content: '[Request interrupted by user]' },
    };
    expect(tail([assistantToolUse('Bash'), interrupt], TOOL_STALL_MS + 1)).toBe('finished');
  });

  it('a tool result answers the call above it, so the call is not read as pending', () => {
    // The regression this pins: tool results arrive as user-type records. Skipping them reached
    // the tool_use they answered and reported a finished call as an approval prompt.
    const records = [assistantToolUse('Bash'), toolResultRecord()];
    expect(tail(records, TOOL_STALL_MS + 1)).not.toBe('approval');
  });

  it('session-end records mean finished no matter how quiet the file is', () => {
    expect(tail([assistantText(), { type: 'pr-link' }], 5 * 3600_000)).toBe('finished');
    expect(tail([assistantText(), { type: 'last-prompt' }], 5 * 3600_000)).toBe('finished');
  });

  it('ignores record types that say nothing about status', () => {
    const records: JsonlRecord[] = [
      assistantToolUse('AskUserQuestion'), { type: 'ai-title' }, { type: 'file-history-snapshot' },
    ];
    expect(tail(records, 1_000)).toBe('question');
  });
});

describe('bobStatus', () => {
  it('maps Bob’s running to working', () => {
    expect(bobStatus('running')).toBe('working');
  });

  it('maps Bob’s active — which means finished — to finished', () => {
    expect(bobStatus('active')).toBe('finished');
  });

  it('a live pending approval outranks whatever the row says', () => {
    expect(bobStatus('running', 'approval')).toBe('approval');
    expect(bobStatus('active', 'question')).toBe('question');
  });
});

describe('resolveDisplayStatus', () => {
  const base = { updatedAtMs: NOW - 1_000, nowMs: NOW };

  it('a live pending approval upgrades a session that looked busy', () => {
    expect(resolveDisplayStatus('working', { ...base, pending: 'approval' })).toBe('approval');
  });

  it('never demotes on a missing live signal — the probe only sees this window', () => {
    expect(resolveDisplayStatus('approval', base)).toBe('approval');
    expect(resolveDisplayStatus('question', base)).toBe('question');
  });

  it('finished becomes seen once you have opened it since it last changed', () => {
    expect(resolveDisplayStatus('finished', { ...base, lastViewedMs: NOW })).toBe('seen');
  });

  it('finished stays finished when your last look predates the change', () => {
    expect(resolveDisplayStatus('finished', { ...base, lastViewedMs: NOW - 60_000 })).toBe('finished');
  });

  it('an unread session older than a day stops shouting', () => {
    expect(resolveDisplayStatus('finished', { updatedAtMs: NOW - UNREAD_MAX_AGE_MS - 1, nowMs: NOW }))
      .toBe('dormant');
  });

  it('leaves the other states alone', () => {
    expect(resolveDisplayStatus('working', { ...base, lastViewedMs: NOW })).toBe('working');
    expect(resolveDisplayStatus('dormant', { ...base, lastViewedMs: NOW })).toBe('dormant');
  });
});

describe('status predicates', () => {
  it('blocked-on-you is exactly the two states your input unblocks', () => {
    expect(isBlockedOnYou('approval')).toBe(true);
    expect(isBlockedOnYou('question')).toBe(true);
    expect(isBlockedOnYou('finished')).toBe(false);
    expect(isBlockedOnYou('working')).toBe(false);
  });

  it('needs-you adds the unread result — the third reason to click', () => {
    expect(needsYou('finished')).toBe(true);
    expect(needsYou('seen')).toBe(false);
    expect(needsYou('dormant')).toBe(false);
  });

  it('the worklist keeps live states, never the quiet ones', () => {
    expect(isWorklistSignal('working')).toBe(true);
    expect(isWorklistSignal('approval')).toBe(true);
    expect(isWorklistSignal('question')).toBe(true);
    expect(isWorklistSignal('finished')).toBe(false);
    expect(isWorklistSignal('seen')).toBe(false);
    expect(isWorklistSignal('dormant')).toBe(false);
  });
});
