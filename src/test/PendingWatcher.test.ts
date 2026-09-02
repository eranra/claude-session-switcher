import { describe, expect, it, vi } from 'vitest';
import { PendingWatcher } from '../PendingWatcher';
import type { PendingApproval } from '../agents/BobApprover';

// What the row shows when a session is blocked depends entirely on this map being honest: present
// means certainly blocked, absent means unknown — never "certainly not blocked". These cases pin
// that asymmetry, because getting it backwards turns every cross-window approval prompt grey.

function pending(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    requestId: 'req-1', toolName: 'execute_command', argsText: '{}', permission: 'execute',
    hasCommandUse: true, taskId: 'task-1', ...over,
  };
}

function watcher(pendings: PendingApproval[] | Error, onChange = () => { /* no-op */ }) {
  const listAllPending = pendings instanceof Error
    ? vi.fn().mockRejectedValue(pendings)
    : vi.fn().mockResolvedValue(pendings);
  return { w: new PendingWatcher({ listAllPending }, () => { /* no log */ }, 5_000, onChange), listAllPending };
}

describe('PendingWatcher', () => {
  it('starts empty — nothing is claimed before the first read', () => {
    const { w } = watcher([]);
    expect(w.snapshot().size).toBe(0);
  });

  it('maps a pending tool call to its owning task', async () => {
    const { w } = watcher([pending()]);
    await w.poll();
    expect(w.snapshot().get('task-1')).toBe('approval');
  });

  it('maps a question tool to the question state, not approval', async () => {
    const { w } = watcher([pending({ toolName: 'ask_followup_question' })]);
    await w.poll();
    expect(w.snapshot().get('task-1')).toBe('question');
  });

  it('a question outranks an approval on the same task', async () => {
    const { w } = watcher([
      pending({ requestId: 'req-1', toolName: 'execute_command' }),
      pending({ requestId: 'req-2', toolName: 'ask_followup_question' }),
    ]);
    await w.poll();
    expect(w.snapshot().get('task-1')).toBe('question');
  });

  it('drops a pending with no task — it could not be attached to a row honestly', async () => {
    const { w } = watcher([pending({ taskId: '' })]);
    await w.poll();
    expect(w.snapshot().size).toBe(0);
  });

  it('a resolved approval leaves the map', async () => {
    const listAllPending = vi.fn()
      .mockResolvedValueOnce([pending()])
      .mockResolvedValueOnce([]);
    const w = new PendingWatcher({ listAllPending });
    await w.poll();
    expect(w.snapshot().size).toBe(1);
    await w.poll();
    expect(w.snapshot().size).toBe(0);
  });

  it('keeps the last good map when a read fails, rather than claiming nothing is blocked', async () => {
    const listAllPending = vi.fn()
      .mockResolvedValueOnce([pending()])
      .mockRejectedValueOnce(new Error('inspector unreachable'));
    const w = new PendingWatcher({ listAllPending }, () => { /* no log */ });
    await w.poll();
    await w.poll();
    expect(w.snapshot().get('task-1')).toBe('approval');
  });

  it('repaints only when the map actually changed', async () => {
    const onChange = vi.fn();
    const listAllPending = vi.fn().mockResolvedValue([pending()]);
    const w = new PendingWatcher({ listAllPending }, () => { /* no log */ }, 5_000, onChange);
    await w.poll();
    expect(onChange).toHaveBeenCalledTimes(1);
    await w.poll();
    expect(onChange).toHaveBeenCalledTimes(1); // same map — no second repaint
  });

  it('names every blocked session in the log, so a stale one can be found', async () => {
    // These are the only two states the worklist never ages out, so one stale entry pins a row at
    // the top of the list indefinitely. Before this, the map was invisible unless the read failed,
    // which made "why is this old task in my active list?" unanswerable from the log.
    const lines: string[] = [];
    const listAllPending = vi.fn().mockResolvedValue([
      pending({ taskId: 'task-1' }),
      pending({ taskId: 'task-2', toolName: 'ask_followup_question' }),
    ]);
    const w = new PendingWatcher({ listAllPending }, msg => lines.push(msg));
    await w.poll();
    expect(lines.join('\n')).toContain('task-1=approval');
    expect(lines.join('\n')).toContain('task-2=question');
  });

  it('says so when nothing is blocked, rather than going quiet', async () => {
    // Going from "two blocked" to silence would read as a failed poll. The clearing is the news.
    const lines: string[] = [];
    const listAllPending = vi.fn()
      .mockResolvedValueOnce([pending()])
      .mockResolvedValueOnce([]);
    const w = new PendingWatcher({ listAllPending }, msg => lines.push(msg));
    await w.poll();
    await w.poll();
    expect(lines.some(l => l.includes('no session is blocked'))).toBe(true);
  });

  it('does not repeat itself while the map holds still', async () => {
    const lines: string[] = [];
    const listAllPending = vi.fn().mockResolvedValue([pending()]);
    const w = new PendingWatcher({ listAllPending }, msg => lines.push(msg));
    await w.poll();
    await w.poll();
    expect(lines).toHaveLength(1);
  });

  it('does not overlap reads', async () => {
    let release = () => { /* replaced below */ };
    const gate = new Promise<PendingApproval[]>(resolve => { release = () => resolve([]); });
    const listAllPending = vi.fn().mockReturnValue(gate);
    const w = new PendingWatcher({ listAllPending });
    const first = w.poll();
    await w.poll(); // must return immediately rather than starting a second read
    expect(listAllPending).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});
