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
