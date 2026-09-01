import type { BobApprover, PendingApproval } from './agents/BobApprover';
import { pendingStatusForTool } from './sessionStatus';

/** How often the pending-approval map is refreshed. Matches the AutoResponder's approval tick. */
const DEFAULT_POLL_MS = 5_000;

/**
 * Keeps a session-id → blocked-state map fresh, so a row can show *why* a session is stuck.
 *
 * This exists because the two things that know a session is blocked are in different places. The
 * transcript on disk only lets us *infer* it — an unanswered tool call plus a file that stopped
 * being written. The agent's extension host actually knows, but only for sessions in its own
 * window, and only in memory. So the panel uses the inference as its floor and this watcher as an
 * upgrade: what it reports is certain, what it omits proves nothing.
 *
 * Bob only, deliberately. Bob's pending approvals carry the owning task id, which *is* the session
 * id. Claude's carry a comms channel id instead, and the channel-to-session mapping is not
 * available — the same gap that stops `AutoResponder` honouring `sessionPattern` for Claude rules.
 * Feeding Claude's pendings in here keyed by channel would attach one session's prompt to another,
 * which is worse than inferring. A Claude session's blocked state comes from its transcript.
 */
export class PendingWatcher {
  private _pending = new Map<string, 'approval' | 'question'>();
  private _timer: ReturnType<typeof setInterval> | undefined;
  private _polling = false;

  private onChange: () => void = () => { /* no-op */ };

  constructor(
    private readonly approver: Pick<BobApprover, 'listAllPending'>,
    private readonly log: (msg: string) => void = () => { /* no-op */ },
    private readonly pollMs = DEFAULT_POLL_MS,
    onChange?: () => void,
  ) {
    if (onChange) { this.onChange = onChange; }
  }

  /**
   * What to call when the map changes, so the panel repaints on the tick a prompt appears instead
   * of on the next session scan. A setter because the watcher has to exist before the view
   * provider it notifies — the provider reads the watcher's snapshot.
   */
  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  /** The current map. Read on every repaint, so it must be cheap and never throw. */
  snapshot(): ReadonlyMap<string, 'approval' | 'question'> {
    return this._pending;
  }

  start(): void {
    if (this._timer) { return; }
    void this.poll();
    this._timer = setInterval(() => { void this.poll(); }, this.pollMs);
  }

  /**
   * Read the live pendings once and rebuild the map.
   *
   * A failed read leaves the previous map in place rather than clearing it. Clearing would turn a
   * momentary inspector hiccup into "nothing is blocked", which is the exact false negative the
   * design refuses to draw.
   */
  async poll(): Promise<void> {
    if (this._polling) { return; }
    this._polling = true;
    try {
      let pending: PendingApproval[];
      try {
        pending = await this.approver.listAllPending();
      } catch (err) {
        this.log(`pending watcher: listAllPending failed: ${String(err)}`);
        return;
      }

      const next = new Map<string, 'approval' | 'question'>();
      for (const p of pending) {
        if (!p.taskId) { continue; }
        const state = pendingStatusForTool(p.toolName);
        // A question outranks an approval when a task somehow has both: it is the one that needs
        // you to type something, so it is the one worth naming on the row.
        if (state === 'question' || !next.has(p.taskId)) { next.set(p.taskId, state); }
      }

      const changed = next.size !== this._pending.size
        || [...next].some(([id, state]) => this._pending.get(id) !== state);
      this._pending = next;
      if (changed) { this.onChange(); }
    } finally {
      this._polling = false;
    }
  }

  dispose(): void {
    if (this._timer) { clearInterval(this._timer); }
    this._timer = undefined;
  }
}
