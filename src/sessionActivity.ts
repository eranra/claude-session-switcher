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
 * How long a `working` status alone keeps a Claude/Bob session in the worklist when no probe
 * reports it open.
 *
 * The fallback exists to survive a momentary probe failure (a WSL2 / inspector hiccup), so it only
 * needs to outlast the hiccup — not the session. Without a bound, one transcript abandoned
 * mid-turn sits in the worklist forever, because its status is read from a file that will never
 * change again.
 *
 * The two blocked-on-you states are exempt: a session waiting for your approval is not stale, it
 * is stuck, and moving it to History hides the one row you actually need to see.
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
 *  - **Bob / Claude** — their extension hosts hold the truth, and a report from one is
 *    authoritative at any age. A session whose status is a live signal (`working`, or blocked on
 *    you) also counts, so a session you are in still shows up when the probe is momentarily
 *    silent: `working` only while it is recent (`STALE_FALLBACK_WINDOW_MS`), blocked-on-you at any
 *    age.
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
  if (reportedOpen) { return true; }
  // Blocked on you: stuck, not stale. No age bound — it stays until you deal with it.
  if (isBlockedOnYou(session.status)) { return true; }
  // Anything else is a fallback, not a live signal, so it must not outlive its window.
  return isWorklistSignal(session.status)
    && session.updatedAt.getTime() >= inputs.nowMs - STALE_FALLBACK_WINDOW_MS;
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
