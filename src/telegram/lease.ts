/**
 * The lease that elects exactly one Telegram *reader* per machine.
 *
 * ## Why this exists
 *
 * A bot token has one update stream, and `getUpdates` consumes it destructively. Two windows
 * polling the same bot do not each get a copy — each update goes to whichever asked first, so
 * replies are split at random and the shared offset file advances past updates a window never
 * saw. That is a live defect today: every window with `autoSupervise` on and a state dir polls.
 *
 * Writing has no such constraint (`sendMessage` is not exclusive), so this lease covers reading
 * **only**. Every window still posts its own sessions' messages directly, which is what keeps
 * per-window responsibility intact.
 *
 * ## Why a file lease rather than a lock
 *
 * A window can die without unlocking — crash, SIGKILL, a laptop lid. So holding is expressed as
 * "wrote recently", not "holds a handle": the entry carries a pid and an expiry, the holder
 * renews well inside that window, and any window may take over once it has expired. Liveness is
 * cross-checked with `kill(pid, 0)` so a dead holder is displaced immediately rather than after
 * the timeout.
 *
 * Acquisition uses `mkdir`-style exclusivity — `writeFile` with the `wx` flag, which fails if the
 * file exists — so two windows racing cannot both believe they won. Takeover of an expired lease
 * unlinks first and then races the same way, and the winner is confirmed by reading the file back
 * and comparing pids. That read-back is what makes the race safe without any lock primitive.
 */

import * as fs from 'fs';
import * as path from 'path';

/** How long a written lease stays valid. A holder that stops renewing is displaced after this. */
export const LEASE_TTL_MS = 30_000;
/** How often the holder renews. Comfortably inside the TTL so a slow poll never drops it. */
export const LEASE_RENEW_MS = 10_000;

export interface LeaseRecord {
  pid: number;
  /** Epoch ms after which any window may take this lease. */
  expiresAt: number;
  /** For logging only — which host wrote it. */
  host: string;
}

export function parseLease(raw: string): LeaseRecord | null {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (typeof d.pid !== 'number' || typeof d.expiresAt !== 'number') { return null; }
    return { pid: d.pid, expiresAt: d.expiresAt, host: typeof d.host === 'string' ? d.host : '' };
  } catch {
    return null;
  }
}

/**
 * True when `lease` no longer blocks a takeover: absent, past its expiry, or held by a pid that
 * is gone. A dead holder is displaced at once — waiting out the TTL would leave the machine with
 * no reader for up to 30 seconds after a crash.
 */
export function leaseIsFree(
  lease: LeaseRecord | null, now: number, isAlive: (pid: number) => boolean,
): boolean {
  if (lease === null) { return true; }
  if (lease.expiresAt <= now) { return true; }
  return !isAlive(lease.pid);
}

export interface ReaderLeaseOptions {
  /** Full path of the lease file. */
  leasePath: string;
  /** This window's pid — the identity that holds the lease. */
  pid: number;
  host?: string;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  log?: (msg: string) => void;
}

/**
 * A renewable claim on "this window reads Telegram for this machine".
 *
 * `tryAcquire()` is safe to call on every tick: it renews when already held, takes over a free
 * lease, and returns false when another live window holds it. Callers poll Telegram only while
 * it returns true, so a handover needs no signalling — the new holder simply starts and the old
 * one simply stops.
 */
export class ReaderLease {
  private readonly leasePath: string;
  private readonly pid: number;
  private readonly host: string;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly log: (msg: string) => void;
  private held = false;

  constructor(opts: ReaderLeaseOptions) {
    this.leasePath = opts.leasePath;
    this.pid = opts.pid;
    this.host = opts.host ?? '';
    this.now = opts.now ?? (() => Date.now());
    this.isAlive = opts.isAlive ?? ((pid: number) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    this.log = opts.log ?? (() => { /* silent */ });
  }

  /** Whether this window believed it held the lease as of the last `tryAcquire`. */
  get isHolder(): boolean {
    return this.held;
  }

  private async read(): Promise<LeaseRecord | null> {
    try {
      return parseLease(await fs.promises.readFile(this.leasePath, 'utf8'));
    } catch {
      return null;
    }
  }

  private record(): LeaseRecord {
    return { pid: this.pid, expiresAt: this.now() + LEASE_TTL_MS, host: this.host };
  }

  /**
   * Write the lease with `wx` so an existing file makes it fail, then read back and confirm the
   * pid is ours. The read-back is the actual arbitration: two windows can both pass the
   * emptiness check, but only one write survives, and the loser sees the winner's pid.
   */
  private async claim(): Promise<boolean> {
    try {
      await fs.promises.mkdir(path.dirname(this.leasePath), { recursive: true });
      await fs.promises.writeFile(this.leasePath, JSON.stringify(this.record()), { flag: 'wx' });
    } catch {
      // Somebody else created it first (or the directory is unwritable).
      const winner = await this.read();
      return winner !== null && winner.pid === this.pid;
    }
    const confirmed = await this.read();
    return confirmed !== null && confirmed.pid === this.pid;
  }

  /**
   * Acquire, renew, or decline. Returns true when this window should be reading Telegram.
   *
   * A failure to write during renewal drops the claim rather than assuming it holds: continuing
   * to poll on an expired lease is exactly the double-reader case this class exists to prevent.
   */
  async tryAcquire(): Promise<boolean> {
    const current = await this.read();

    if (current !== null && current.pid === this.pid) {
      try {
        await fs.promises.writeFile(this.leasePath, JSON.stringify(this.record()), 'utf8');
        this.held = true;
      } catch (err) {
        this.held = false;
        this.log(`telegram lease: renewal failed, dropping claim: ${String(err)}`);
      }
      return this.held;
    }

    if (!leaseIsFree(current, this.now(), this.isAlive)) {
      if (this.held) { this.log(`telegram lease: lost to pid ${current?.pid}`); }
      this.held = false;
      return false;
    }

    // Free but present means an expired or dead holder — clear it, then race for it.
    if (current !== null) {
      try { await fs.promises.unlink(this.leasePath); } catch { /* another window got there */ }
    }
    this.held = await this.claim();
    if (this.held) { this.log(`telegram lease: acquired by pid ${this.pid}`); }
    return this.held;
  }

  /** Give up the lease so another window can take over at once. Best-effort. */
  async release(): Promise<void> {
    if (!this.held) { return; }
    this.held = false;
    const current = await this.read();
    if (current !== null && current.pid !== this.pid) { return; } // not ours any more
    try { await fs.promises.unlink(this.leasePath); } catch { /* already gone */ }
  }
}
