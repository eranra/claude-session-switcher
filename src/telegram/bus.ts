/**
 * The per-machine command bus between VS Code windows.
 *
 * ## What it is for
 *
 * Exactly one window per machine reads Telegram (see `lease.ts`), but the session a message is
 * aimed at usually belongs to a *different* window. The bus carries that command across.
 *
 * Commands are addressed by **session id, not by window**. The reader does not need a routing
 * table and never has to know which window holds what: it drops a file, and whichever window owns
 * that session picks it up. Ownership is computed independently by every window from the same
 * registry (`ownership.ts`), so they agree without talking.
 *
 * ## How a command is claimed
 *
 * `rename()` is the only atomic claim primitive available across unrelated processes on one
 * filesystem, so that is the whole protocol: a window that owns the session renames
 * `cmd/<id>.json` to `cmd/<id>.taken.<pid>`. Exactly one rename can succeed, so exactly one
 * window runs the command — no lock, no coordination, no window able to steal another's work.
 *
 * This is the same shape as `SupervisorOutbox`, deliberately: atomic write via a temp file plus
 * rename, `fs.watch` for immediate pickup, and an interval as the safety net for the platforms
 * where watch is unreliable.
 *
 * ## Why results are files too
 *
 * The window that applies a command is not the window that must report back to Telegram. So the
 * outcome is written to `res/<id>.json` and the reader posts it. A command that no window ever
 * claims simply has no result, and the reader turns that into a visible "no owner" message once
 * it expires — silence is never allowed to be the outcome.
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Root for all cross-window state, beside the existing `windows/` registry. */
export function busDir(homedir: string = os.homedir()): string {
  return path.join(homedir, '.claude', 'session-sitter', 'bus');
}
export function cmdDir(homedir?: string): string {
  return path.join(busDir(homedir), 'cmd');
}
export function resDir(homedir?: string): string {
  return path.join(busDir(homedir), 'res');
}
export function topicsDir(homedir?: string): string {
  return path.join(busDir(homedir), 'topics');
}
export function leasePath(homedir?: string): string {
  return path.join(busDir(homedir), 'telegram.lock');
}

/** How long a command may sit unclaimed before the reader reports it as having no owner. */
export const COMMAND_TTL_MS = 20_000;

export type CommandKind =
  /** Inject text into an existing session as a user message. */
  | 'sendText'
  /** Bring the session's window and panel to the front on its own machine. */
  | 'focus'
  /** Start a new session in this window's workspace. */
  | 'newSession';

export interface BusCommand {
  cmdId: string;
  kind: CommandKind;
  /** Target session. Empty for `newSession`, which is addressed by `targetPid` instead. */
  sessionId: string;
  /** Agent the target belongs to; decides which sender applies it. */
  source: 'claude' | 'bob' | 'codex' | 'chat';
  text: string;
  /** For `newSession`: the window that must run it. Ignored by other kinds. */
  targetPid?: number;
  /** Telegram thread the outcome should be reported into. */
  threadId: number;
  issuedAt: number;
}

export interface BusResult {
  cmdId: string;
  ok: boolean;
  /** A sentence fit to show a human. Never a bare error code. */
  detail: string;
  /** Set by `newSession` once the started session is identified. */
  sessionId?: string;
  threadId: number;
  pid: number;
  finishedAt: number;
}

export function newCommandId(): string {
  return `cmd-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

export function parseCommand(raw: string): BusCommand | null {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (typeof d.cmdId !== 'string' || typeof d.kind !== 'string') { return null; }
    if (typeof d.threadId !== 'number') { return null; }
    const source = d.source;
    if (source !== 'claude' && source !== 'bob' && source !== 'codex' && source !== 'chat') {
      return null;
    }
    return {
      cmdId: d.cmdId,
      kind: d.kind as CommandKind,
      sessionId: typeof d.sessionId === 'string' ? d.sessionId : '',
      source,
      text: typeof d.text === 'string' ? d.text : '',
      targetPid: typeof d.targetPid === 'number' ? d.targetPid : undefined,
      threadId: d.threadId,
      issuedAt: typeof d.issuedAt === 'number' ? d.issuedAt : 0,
    };
  } catch {
    return null;
  }
}

export function parseResult(raw: string): BusResult | null {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (typeof d.cmdId !== 'string' || typeof d.ok !== 'boolean') { return null; }
    return {
      cmdId: d.cmdId,
      ok: d.ok,
      detail: typeof d.detail === 'string' ? d.detail : '',
      sessionId: typeof d.sessionId === 'string' ? d.sessionId : undefined,
      threadId: typeof d.threadId === 'number' ? d.threadId : 0,
      pid: typeof d.pid === 'number' ? d.pid : 0,
      finishedAt: typeof d.finishedAt === 'number' ? d.finishedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Write `data` to `target` atomically, so a reader never sees a half-written file. */
async function writeAtomic(target: string, data: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.promises.writeFile(tmp, data, 'utf8');
  await fs.promises.rename(tmp, target);
}

/** Publish a command for whichever window owns its session. */
export async function postCommand(cmd: BusCommand, homedir?: string): Promise<void> {
  await writeAtomic(path.join(cmdDir(homedir), `${cmd.cmdId}.json`), JSON.stringify(cmd, null, 2));
}

/** Publish the outcome of a command, for the reader to report into Telegram. */
export async function postResult(result: BusResult, homedir?: string): Promise<void> {
  await writeAtomic(
    path.join(resDir(homedir), `${result.cmdId}.json`), JSON.stringify(result, null, 2));
}

/** Every unclaimed command currently on the bus, oldest first. */
export async function readPendingCommands(homedir?: string): Promise<BusCommand[]> {
  const dir = cmdDir(homedir);
  let files: string[];
  try {
    files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.json') && !f.includes('.tmp-'));
  } catch {
    return [];
  }
  const out: BusCommand[] = [];
  for (const file of files.sort()) {
    try {
      const cmd = parseCommand(await fs.promises.readFile(path.join(dir, file), 'utf8'));
      if (cmd !== null) { out.push(cmd); }
    } catch { /* vanished mid-read — another window claimed it */ }
  }
  return out.sort((a, b) => a.issuedAt - b.issuedAt);
}

/**
 * Try to take ownership of a command by renaming it aside.
 *
 * The rename IS the lock: it fails for every window but one. A false return means another window
 * already has it, which is a normal outcome and not an error.
 */
export async function claimCommand(
  cmdId: string, pid: number, homedir?: string,
): Promise<boolean> {
  const from = path.join(cmdDir(homedir), `${cmdId}.json`);
  const to = path.join(cmdDir(homedir), `${cmdId}.taken.${pid}`);
  try {
    await fs.promises.rename(from, to);
    return true;
  } catch {
    return false;
  }
}

/** Drain finished results, deleting each as it is taken so it is reported exactly once. */
export async function takeResults(homedir?: string): Promise<BusResult[]> {
  const dir = resDir(homedir);
  let files: string[];
  try {
    files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.json') && !f.includes('.tmp-'));
  } catch {
    return [];
  }
  const out: BusResult[] = [];
  for (const file of files.sort()) {
    const full = path.join(dir, file);
    try {
      const result = parseResult(await fs.promises.readFile(full, 'utf8'));
      if (result !== null) { out.push(result); }
      await fs.promises.unlink(full);
    } catch { /* already taken */ }
  }
  return out;
}

/**
 * Commands issued before `now - COMMAND_TTL_MS` that are still unclaimed.
 *
 * These are the ones no window owns. The caller reports them and removes them, so an
 * unroutable message produces a visible answer rather than nothing at all.
 */
export function expiredCommands(pending: BusCommand[], now: number): BusCommand[] {
  return pending.filter(c => now - c.issuedAt > COMMAND_TTL_MS);
}

/** Remove a command file outright — used for expiry, after it has been reported. */
export async function dropCommand(cmdId: string, homedir?: string): Promise<void> {
  try { await fs.promises.unlink(path.join(cmdDir(homedir), `${cmdId}.json`)); } catch { /* gone */ }
}

/**
 * Delete claimed-but-abandoned command files and stale results.
 *
 * A window that dies mid-apply leaves a `.taken.<pid>` behind. Nothing retries it — a half-sent
 * prompt must not be replayed hours later into a session that has moved on — so cleanup only
 * stops the directory growing without bound.
 */
export async function sweep(olderThanMs: number, now: number, homedir?: string): Promise<number> {
  let removed = 0;
  for (const dir of [cmdDir(homedir), resDir(homedir)]) {
    let files: string[];
    try { files = await fs.promises.readdir(dir); } catch { continue; }
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        const stat = await fs.promises.stat(full);
        if (now - stat.mtimeMs > olderThanMs) {
          await fs.promises.unlink(full);
          removed++;
        }
      } catch { /* ignore */ }
    }
  }
  return removed;
}
