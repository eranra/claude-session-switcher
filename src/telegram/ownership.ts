/**
 * Which VS Code window is responsible for a session.
 *
 * The rule the whole remote-control feature rests on: **one window owns a session, and only its
 * owner may write to it.** Everything else — routing a Telegram message, starting a session,
 * refusing to guess — is a consequence.
 *
 * ## Why not match on workspace path alone
 *
 * The obvious rule ("the window whose workspace is the session's cwd") is wrong in cases this
 * repository creates on purpose:
 *
 *  - A worktree session's cwd is `<repo>/.claude/worktrees/<name>` — a *subdirectory* of the
 *    window's workspace, so equality misses it.
 *  - Two windows can be open on the same folder, and both would claim.
 *  - A history session's workspace may have no window open at all.
 *
 * So the claim is decided in three tiers, strongest first:
 *
 *  1. **Holds it.** The window's live agent state lists this session (`openClaudeSessionIds`,
 *     `openBobTaskIds` in the window registry). Exact, no heuristics, and it is what makes a
 *     write land in the right place.
 *  2. **Longest workspace prefix.** No window holds it, so the window whose workspace folder is
 *     the longest prefix of the session's `projectPath` claims it. Covers idle and history
 *     sessions. Ties break on lowest pid so every window computes the same answer.
 *  3. **Nobody.** The session is read-only. This is reported, never silently swallowed.
 *
 * Every function here is pure — the registry is passed in — so the rule is unit-testable without
 * a live IDE, which the inspector-based write paths never are.
 */

import type { ClaudeSession } from '../SessionManager';
import type { WindowEntry } from '../WindowRegistry';

/** How a window came to own a session. Surfaced in the UI, because it changes what is possible. */
export type OwnershipBasis = 'holds' | 'workspace' | 'none';

export interface Ownership {
  /** Owning window's pid, or null when no window claims the session. */
  pid: number | null;
  basis: OwnershipBasis;
  /** The owning window's first workspace folder, for display. Empty when unowned. */
  workspace: string;
}

export const UNOWNED: Ownership = { pid: null, basis: 'none', workspace: '' };

/** Session ids a window holds live, across every agent it hosts. */
export function heldSessionIds(entry: WindowEntry): Set<string> {
  return new Set([
    ...(entry.openClaudeSessionIds ?? []),
    ...(entry.openBobTaskIds ?? []),
  ]);
}

/**
 * True when `folder` contains `target` — the same path, or a parent directory of it.
 *
 * The separator check is what stops `/work/app` from claiming a session in `/work/app-legacy`.
 * Trailing separators are trimmed so a folder recorded as `/work/app/` behaves identically.
 */
export function pathContains(folder: string, target: string): boolean {
  const f = folder.replace(/[/\\]+$/, '');
  if (!f) { return false; }
  if (target === f) { return true; }
  return target.startsWith(f) && (target[f.length] === '/' || target[f.length] === '\\');
}

/** Length of the longest workspace folder of `entry` that contains `target`, or -1 for none. */
function prefixScore(entry: WindowEntry, target: string): number {
  let best = -1;
  for (const folder of entry.workspaceFolders) {
    if (pathContains(folder, target)) {
      const len = folder.replace(/[/\\]+$/, '').length;
      if (len > best) { best = len; }
    }
  }
  return best;
}

/**
 * Resolve the owner of one session against a snapshot of live windows.
 *
 * A session on another machine is never owned by a local window: `peer` set means the session
 * lives elsewhere, and only that machine's own windows can act on it.
 */
export function resolveOwner(session: ClaudeSession, windows: WindowEntry[]): Ownership {
  if (session.peer) { return UNOWNED; }

  // Tier 1 — a window that actually holds the session. Lowest pid wins if (unusually) two do.
  const holders = windows
    .filter(w => heldSessionIds(w).has(session.sessionId))
    .sort((a, b) => a.pid - b.pid);
  if (holders.length > 0) {
    return { pid: holders[0].pid, basis: 'holds', workspace: holders[0].workspaceFolders[0] ?? '' };
  }

  // Tier 2 — longest containing workspace folder; lowest pid breaks a tie.
  let best: WindowEntry | undefined;
  let bestScore = -1;
  for (const w of windows) {
    const score = prefixScore(w, session.projectPath);
    if (score < 0) { continue; }
    if (score > bestScore || (score === bestScore && best !== undefined && w.pid < best.pid)) {
      best = w;
      bestScore = score;
    }
  }
  if (best !== undefined) {
    return { pid: best.pid, basis: 'workspace', workspace: best.workspaceFolders[0] ?? '' };
  }

  // Tier 3 — read-only.
  return UNOWNED;
}

/** Resolve owners for many sessions in one pass. Keyed by session id. */
export function resolveOwners(
  sessions: ClaudeSession[], windows: WindowEntry[],
): Map<string, Ownership> {
  return new Map(sessions.map(s => [s.sessionId, resolveOwner(s, windows)]));
}

/** True when this window (by pid) is the one responsible for the session. */
export function ownedByThisWindow(
  session: ClaudeSession, windows: WindowEntry[], pid: number,
): boolean {
  return resolveOwner(session, windows).pid === pid;
}

/**
 * Whether a session can be written to at all, before any agent-specific check.
 *
 * Codex and VS Code Chat expose no way to inject a message, so they are read-only however they
 * are owned. Reported up front rather than discovered as a failed send.
 */
export function isWritableSource(source: ClaudeSession['source']): boolean {
  return source === 'bob' || source === 'claude';
}

/** Why a session cannot be written to, or null when it can. A user-facing sentence. */
export function writeBlockedReason(session: ClaudeSession, owner: Ownership): string | null {
  if (session.peer) {
    return `This session runs on ${session.peer}. Configure a bot on that machine to control it.`;
  }
  if (!isWritableSource(session.source)) {
    const name = session.source === 'codex' ? 'Codex' : 'VS Code Chat';
    return `${name} has no message API, so this session is read-only.`;
  }
  if (owner.pid === null) {
    return 'No open window is responsible for this session, so nothing can write to it.';
  }
  return null;
}
