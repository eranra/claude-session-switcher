/**
 * What a session's status marker means, and every rule that decides it.
 *
 * There used to be three states — active / waiting / idle — and they were computed inline in
 * `SessionManager`. Three was too few in the wrong place: a session paused on a permission prompt
 * looked identical to one busily running tools (a spinning green ring), which is exactly backwards,
 * because that is the one state where nothing happens until you act. And "idle" meant both "the
 * agent finished, your turn" and "we have no way to tell", so it could not be trusted either way.
 *
 * So the vocabulary now answers one question — *whose turn is it, and why* — and lives here as
 * pure functions: no `vscode`, no filesystem, no clock of its own. Time always arrives as an
 * argument. That is what lets all six states be unit-tested, and it keeps the rules in one file
 * instead of spread across the manager, the view provider and the exporter.
 *
 * The prose version of this file, for users, is `docs/STATUS-INDICATORS.md`. They must agree.
 */

/**
 * The six states a session row can be in.
 *
 * Ordered here the way urgency runs, most urgent first — `STATUS_RANK` in `sessionSort.ts` is the
 * sortable form of the same order.
 */
export type SessionStatus =
  /** Paused on a permission prompt. Your yes/no is the only thing that unblocks it. */
  | 'approval'
  /** Asked you a question. Needs an answer typed, not a click. */
  | 'question'
  /** Done, and you have not opened it since it last changed. */
  | 'finished'
  /** Generating a reply or running a tool. Nothing for you to do. */
  | 'working'
  /** Done, and you have looked at it. */
  | 'seen'
  /** Nothing is happening, or there is no signal to tell us either way. */
  | 'dormant';

/** Every state, in urgency order. Iterate this rather than re-listing the union. */
export const SESSION_STATUSES: readonly SessionStatus[] =
  ['approval', 'question', 'finished', 'working', 'seen', 'dormant'];

// ── The four time windows every rule is built from ─────────────────────────────
//
// A transcript is an append-only log: the only liveness signal it carries is how long ago it was
// last written. Each window below is "quiet for longer than this means something different
// happened", and each is deliberately separate, because the three cases tolerate very different
// silences.

/** Assistant text still arriving. Token streaming writes far more often than this. */
export const STREAMING_WINDOW_MS = 30_000;

/**
 * A user prompt with no reply yet. Longer than the streaming window because the agent may be
 * thinking, queued behind another turn, or reconnecting — but bounded, so a transcript that ends
 * on a prompt nobody ever answered eventually goes quiet instead of pulsing for weeks.
 */
export const PROMPT_WINDOW_MS = 120_000;

/**
 * An unfinished tool call. A tool that is genuinely executing keeps the transcript moving; one
 * sitting on a permission prompt writes nothing at all. That difference is the only way to tell
 * "running" from "blocked on you" from the file alone — the live probe, when it can see the
 * session, is authoritative and does not need this.
 */
export const TOOL_STALL_MS = 45_000;

/**
 * How long an unopened result stays loud. A day-old finished session is history, not a task, and
 * marking it `finished` forever would leave History full of rows demanding attention.
 */
export const UNREAD_MAX_AGE_MS = 24 * 3600_000;

/**
 * When an unanswered tool call stops meaning "waiting for you" and starts meaning "abandoned".
 *
 * A transcript cannot tell those two apart on its own — both look like a tool call with nothing
 * written after it. `TOOL_STALL_MS` separates "running" from "blocked"; this separates "blocked"
 * from "the process that was blocked is gone".
 *
 * The bound has to exist. `approval` and `question` are the two states the worklist filter never
 * ages out (`isBlockedOnYou`) — deliberately, because a session waiting on you is stuck rather than
 * stale. Without an upper bound here, one session killed mid-tool-call is `approval` **forever**:
 * it sits at the top of the worklist for weeks, on the strength of a file that will never be
 * written again, and there is nothing you can do to clear it because there is no process left to
 * answer.
 *
 * A day, matching `UNREAD_MAX_AGE_MS`, for the same reason: after that long, silence is evidence
 * of abandonment rather than of patience. Nothing is lost by being wrong here — a session whose
 * window is genuinely still open stays in the worklist through the live probe, which does not
 * consult the status at all, and Bob's live pending approvals still upgrade it through
 * `resolveDisplayStatus`. What the bound removes is only the case where *no* live signal agrees
 * with the file, which is exactly the case where the file is the one lying.
 */
export const ABANDONED_TOOL_CALL_MS = 24 * 3600_000;

// ── Question tools ────────────────────────────────────────────────────────────

/**
 * The tools that ask the user something rather than doing something.
 *
 * The distinction is not cosmetic: an approval takes a click, a question takes typing, and the
 * supervisor must never resolve a question through the approval emitter (that consumes the request
 * and the agent reports that you answered nothing). `SessionExporter` classifies pending actions
 * with the same predicate, so the two can never drift apart.
 */
const QUESTION_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ask_followup_question']);

export function isQuestionTool(toolName: string | undefined | null): boolean {
  return !!toolName && QUESTION_TOOLS.has(toolName);
}

/** Which blocked state a pending tool call means. */
export function pendingStatusForTool(toolName: string | undefined | null): 'approval' | 'question' {
  return isQuestionTool(toolName) ? 'question' : 'approval';
}

// ── Claude: classifying a transcript tail ─────────────────────────────────────

export interface ContentBlock {
  type?: string;
  text?: string;
  name?: string; // tool_use blocks carry the tool's name
}

export interface JsonlRecord {
  type?: string;
  cwd?: string;
  aiTitle?: string;     // present in ai-title records written by Claude Code
  name?: string;        // bare tool_use records carry the tool name at the top level
  timestamp?: string;
  isMeta?: boolean;     // injected context (skill loads, scheduled prompts), not user typing
  toolUseResult?: unknown; // present on the user-type records that carry tool results
  message?: {
    content?: string | ContentBlock[];
  };
}

// Synthetic text Claude Code writes into a user-type record when you interrupt it. A marker,
// not a prompt: a session whose transcript ends on one is finished, not awaiting a reply.
const INTERRUPT_MARKERS: ReadonlySet<string> = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);

/** The plain text of a record's message, joining text blocks. */
export function recordText(record: JsonlRecord): string {
  const content = record.message?.content;
  if (typeof content === 'string') { return content.trim(); }
  if (!Array.isArray(content)) { return ''; }
  return content
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('')
    .trim();
}

/**
 * Does this record carry a tool's result back to the agent?
 *
 * Claude Code writes tool results as **user-type** records — that is the shape, however odd it
 * reads — carrying `toolUseResult` and a `tool_result` block. Mistaking one for a typed prompt
 * pins a finished session in the worklist for weeks; skipping past one entirely is worse, because
 * the walk then reaches the tool call it answered and reports a completed call as still pending.
 */
export function carriesToolResult(record: JsonlRecord): boolean {
  if (record.type === 'tool_result') { return true; }
  if (record.toolUseResult !== undefined) { return true; }
  const content = record.message?.content;
  return Array.isArray(content) && content.some(b => b?.type === 'tool_result');
}

/** Synthetic text Claude Code writes as a user record when you interrupt it — a marker, not a prompt. */
export function isInterruptMarker(record: JsonlRecord): boolean {
  return INTERRUPT_MARKERS.has(recordText(record));
}

/** The names of the tool calls a record asks for, or `[]` if it asks for none. */
function toolNames(record: JsonlRecord): string[] {
  const content = record.message?.content;
  const fromBlocks = Array.isArray(content)
    ? content.filter(b => b?.type === 'tool_use').map(b => b.name ?? '')
    : [];
  if (fromBlocks.length) { return fromBlocks; }
  return record.type === 'tool_use' ? [record.name ?? ''] : [];
}

/**
 * An unfinished tool call: running while the file still moves, blocked on you once it stops, and
 * abandoned once it has been silent for a day.
 *
 * The last step is checked first because it outranks the others: an abandoned call is not a
 * question you have failed to answer, whatever tool asked it.
 */
function toolCallStatus(names: readonly string[], quietMs: number): SessionStatus {
  if (quietMs >= ABANDONED_TOOL_CALL_MS) { return 'dormant'; }
  if (names.some(isQuestionTool)) { return 'question'; }
  return quietMs >= TOOL_STALL_MS ? 'approval' : 'working';
}

/**
 * Classify a Claude session from the tail of its transcript.
 *
 * `records` are the parsed records of the tail in file order; the walk runs backward from the end,
 * because the newest record that says anything about status is the one that decides. Records that
 * say nothing (`ai-title`, `file-history-snapshot`, injected context) are skipped rather than
 * treated as an answer — that skipping is most of what makes the result trustworthy.
 *
 * Walking backward also settles unfinished tool calls for free: the first tool-shaped record found
 * is either a result (so the call it belongs to came back) or a call (so nothing has answered it).
 */
export function claudeStatusFromTail(
  records: readonly JsonlRecord[], updatedAtMs: number, nowMs: number,
): SessionStatus {
  const quietMs = Math.max(0, nowMs - updatedAtMs);

  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];

    if (carriesToolResult(record)) {
      // The last call came back and nothing was written after it. Either the agent is mid-turn, or
      // the turn was abandoned right there.
      return quietMs < TOOL_STALL_MS ? 'working' : 'dormant';
    }

    if (record.type === 'user') {
      // Injected context — skill loads, scheduled prompts — is scenery, not a turn. Keep walking.
      if (record.isMeta === true) { continue; }
      // You stopped the agent yourself. The turn ended there; nothing is pending.
      if (isInterruptMarker(record)) { return 'finished'; }
      // A real typed prompt: your turn is done, the agent's has not started yet.
      return quietMs < PROMPT_WINDOW_MS ? 'working' : 'dormant';
    }

    if (record.type === 'tool_use') {
      return toolCallStatus(toolNames(record), quietMs);
    }

    // Terminal records, written when Claude Code closes a session out.
    if (record.type === 'pr-link' || record.type === 'last-prompt') { return 'finished'; }

    if (record.type === 'assistant') {
      const names = toolNames(record);
      if (names.length) { return toolCallStatus(names, quietMs); }
      // Pure text: still streaming, or the answer you have not read yet.
      return quietMs < STREAMING_WINDOW_MS ? 'working' : 'finished';
    }
  }

  // Nothing in the tail was conclusive. A file being written to right now is still activity;
  // anything else we simply cannot claim to know.
  return quietMs < STREAMING_WINDOW_MS ? 'working' : 'dormant';
}

// ── Bob: classifying a task row ───────────────────────────────────────────────

/**
 * Classify a Bob task from its `tasks.status` column, plus a live pending approval when one is
 * known.
 *
 * Bob's own vocabulary is the trap here: its `'running'` means actively processing, but its
 * `'active'` means the task *finished* and is sitting in the sidebar. So the column alone can only
 * ever separate working from finished — the pending approval is what distinguishes "working" from
 * "waiting for you", and it lives in Bob's memory, not its database.
 */
export function bobStatus(
  dbStatus: string, pending?: 'approval' | 'question',
): SessionStatus {
  if (pending) { return pending; }
  return dbStatus === 'running' ? 'working' : 'finished';
}

// ── The display state: live signals and what you have already read ────────────

export interface DisplayStatusInput {
  /** A pending approval or question read live from the agent's host, if one is known. */
  pending?: 'approval' | 'question';
  /** When the session last changed. */
  updatedAtMs: number;
  /** When you last opened it, if ever. */
  lastViewedMs?: number;
  nowMs: number;
}

/**
 * Turn the state derived from a file or a database row into the state actually shown.
 *
 * Two adjustments, and one deliberate non-adjustment:
 *
 *  - A live pending approval or question **upgrades** whatever we inferred. The live read comes
 *    from the agent's extension host, which knows for certain.
 *  - A missing live signal never **downgrades** anything. The probe can only see the sessions in
 *    its own window, so "no pending approval reported" does not mean "no pending approval" — it
 *    routinely means the session is open in a different window. Treating silence as proof would
 *    turn every cross-window approval grey, which is the failure this design exists to fix.
 *  - `finished` splits on whether you have looked since, and stops shouting once it is a day old.
 */
export function resolveDisplayStatus(
  base: SessionStatus, input: DisplayStatusInput,
): SessionStatus {
  if (input.pending) { return input.pending; }
  if (base !== 'finished') { return base; }
  if (input.lastViewedMs !== undefined && input.lastViewedMs >= input.updatedAtMs) { return 'seen'; }
  if (input.nowMs - input.updatedAtMs > UNREAD_MAX_AGE_MS) { return 'dormant'; }
  return 'finished';
}

// ── Predicates the rest of the extension asks about a state ───────────────────
//
// Written as exhaustive `Record<SessionStatus, boolean>` maps on purpose. A seventh state would
// then fail to compile here instead of silently falling through a comparison somewhere — and a
// status the worklist filter does not recognise is how sessions get quietly hidden in History.

const BLOCKED_ON_YOU: Record<SessionStatus, boolean> = {
  approval: true, question: true, finished: false, working: false, seen: false, dormant: false,
};

const NEEDS_YOU: Record<SessionStatus, boolean> = {
  approval: true, question: true, finished: true, working: false, seen: false, dormant: false,
};

const WORKLIST_SIGNAL: Record<SessionStatus, boolean> = {
  approval: true, question: true, finished: false, working: true, seen: false, dormant: false,
};

/** Nothing moves until you act. These never age out of the worklist. */
export function isBlockedOnYou(status: SessionStatus): boolean {
  return BLOCKED_ON_YOU[status] ?? false;
}

/** There is a reason to click this row: it is blocked on you, or it has a result you have not read. */
export function needsYou(status: SessionStatus): boolean {
  return NEEDS_YOU[status] ?? false;
}

/** Does this state, on its own, argue the session belongs in the live worklist? */
export function isWorklistSignal(status: SessionStatus): boolean {
  return WORKLIST_SIGNAL[status] ?? false;
}
