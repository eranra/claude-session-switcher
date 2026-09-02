/**
 * What makes a session *active*, and therefore part of the worklist rather than History.
 *
 * This rule used to live inside `SessionSitterViewProvider`, where only the panel could reach it.
 * That was fine while the panel was the only surface. It stopped being fine once Telegram became a
 * second one: the panel showed a tight worklist while Telegram showed every session it had ever
 * seen, so the two disagreed about the same fleet and the Telegram list was unusable.
 *
 * So the rule lives here, as pure functions, and both surfaces call it. Not "kept in sync" — there
 * is one rule, and there is nothing to keep in sync.
 *
 * Free of `vscode`, of the filesystem, and of its own clock: every live signal arrives as an
 * argument. That is what makes each branch below testable, and it is the same reasoning as
 * `sessionStatus.ts`, which this file sits directly on top of.
 */

import type { ClaudeSession } from './SessionManager';
import { isBlockedOnYou, isWorklistSignal } from './sessionStatus';

/**
 * Sources that expose no live-process signal at all — there is no extension host to ask.
 *
 * For those, recency is the only honest proxy for "you are working in this right now".
 */
export const PROBELESS_SOURCES: ReadonlySet<string> = new Set(['codex', 'chat']);

/** How long a probeless session counts as active after its last change. */
export const DEFAULT_PROBELESS_ACTIVE_WINDOW_MINUTES = 120;

/**
 * How long a Claude/Bob session stays in the worklist on something short of live proof of work.
 *
 * It bounds two different weak signals, both measured from the session's last change:
 *
 *  - a `working` status with **no** probe report. Covers a momentary probe failure (a WSL2 /
 *    inspector hiccup), so it only needs to outlast the hiccup — not the session. Without a bound,
 *    one transcript abandoned mid-turn sits in the worklist forever, because its status is read
 *    from a file that will never be written again.
 *  - a probe report on a session that is **not** working. A window reporting a tab open proves the
 *    tab exists, not that anything is happening in it. On a remote IDE the two come apart badly:
 *    the server-side extension host outlives the client window it belonged to, so it stays alive
 *    by `process.kill` and keeps refreshing its registry entry with the tabs that were open when
 *    you disconnected. A finished session sat at the top of the worklist for hours that way.
 *
 * The two blocked-on-you states are exempt from both: a session waiting for your approval is not
 * stale, it is stuck, and moving it to History hides the one row you actually need to see.
 */
export const STALE_FALLBACK_WINDOW_MS = 120 * 60_000;

/** The live signals the rule is evaluated against. Supplied by the caller, never read from here. */
export interface ActivityInputs {
  /** Claude session ids reported open by any live window, this machine's and its peers'. */
  claudeOpenIds: ReadonlySet<string>;
  /** Bob task ids reported open by any live window. */
  bobOpenIds: ReadonlySet<string>;
  /** How long a probeless source stays active after its last change. */
  probelessWindowMs: number;
  nowMs: number;
}

/**
 * Is this session one the user can act on right now?
 *
 * How that is decided depends on what the source can actually tell us:
 *
 *  - **Bob / Claude** — their extension hosts hold the truth, but only about which tabs are open,
 *    which is not the same question. So the two signals back each other up rather than either one
 *    deciding alone: `working` counts if a probe reports it open **or** it is recent, anything else
 *    needs both, and blocked-on-you counts at any age with no probe at all. See
 *    `STALE_FALLBACK_WINDOW_MS` for what each half is covering for.
 *  - **Codex / VS Code Chat** — no extension host, no liveness signal of any kind. Recency is the
 *    only honest proxy, so they count as active while updated inside `probelessWindowMs`.
 *
 * The status passed in must already be the **display** status — the raw one with a live pending
 * approval folded in and `finished` split by whether you have read it. Feeding the raw status here
 * would make the worklist disagree with the row it renders.
 */
export function isActiveSession(session: ClaudeSession, inputs: ActivityInputs): boolean {
  if (PROBELESS_SOURCES.has(session.source)) {
    return session.updatedAt.getTime() >= inputs.nowMs - inputs.probelessWindowMs;
  }
  const reportedOpen = session.source === 'bob'
    ? inputs.bobOpenIds.has(session.sessionId)
    : inputs.claudeOpenIds.has(session.sessionId);
  // Blocked on you: stuck, not stale. No age bound — it stays until you deal with it.
  if (isBlockedOnYou(session.status)) { return true; }
  const recent = session.updatedAt.getTime() >= inputs.nowMs - STALE_FALLBACK_WINDOW_MS;
  // Work in progress: a probe report settles it at any age, and recency covers a probe gap.
  if (isWorklistSignal(session.status)) { return reportedOpen || recent; }
  // Finished and read: an open tab alone is not a reason to keep asking for you.
  return reportedOpen && recent;
}

/** The worklist and History, split by `isActiveSession`. Input order is preserved in both. */
export function partitionByActivity<T extends ClaudeSession>(
  sessions: readonly T[], inputs: ActivityInputs,
): { active: T[]; history: T[] } {
  const active: T[] = [];
  const history: T[] = [];
  for (const session of sessions) {
    (isActiveSession(session, inputs) ? active : history).push(session);
  }
  return { active, history };
}
