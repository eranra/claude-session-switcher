import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Both AutoResponder and SupervisorOutbox pull in modules that import 'vscode' at load.
vi.mock('vscode', () => ({ window: { createOutputChannel: vi.fn() }, extensions: { getExtension: vi.fn() } }));

import { AutoResponder } from '../AutoResponder';
import { SupervisorOutbox } from '../SupervisorOutbox';
import type { BobSender } from '../agents/BobSender';
import type { AutoRespondRule } from '../agents/BobSender';
import type { BobApprover, PendingApproval } from '../agents/BobApprover';
import type { ClaudeSession } from '../SessionManager';

// Coordination: PR #58 (auto-approve) and PR #56 (supervision outbox) now run side-by-side
// in the extension, sharing one BobSender. These tests prove they cooperate — both fire in
// the same tick, over the same sender/approver, without dropping each other's work.

class FakeSender implements BobSender {
  public sent: Array<{ taskId: string; text: string }> = [];
  async isAvailable() { return true; }
  async send(taskId: string, text: string) { this.sent.push({ taskId, text }); }
}

class FakeApprover implements BobApprover {
  public pending: PendingApproval[] = [];
  public calls: Array<{ requestId: string; payload: Record<string, unknown> }> = [];
  async listAllPending() { return this.pending; }
  async resolve(requestId: string, payload: Record<string, unknown>): Promise<string> { this.calls.push({ requestId, payload }); return 'ok'; }
}

function session(id: string, projectPath: string): ClaudeSession {
  return { sessionId: id, projectName: 'p', projectPath, title: 't', updatedAt: new Date(), status: 'working', source: 'bob' };
}

function managerWith(sessions: ClaudeSession[]) {
  return {
    onDidChangeSessions: () => ({ dispose() { /* noop */ } }),
    getSessions: () => sessions,
    getRecentExchanges: async () => [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function pending(requestId: string, toolName: string): PendingApproval {
  return { requestId, toolName, argsText: '{}', permission: 'read', hasCommandUse: false, taskId: 's' };
}

function writeDelivery(dir: string, d: object): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${(d as { deliveryId: string }).deliveryId}.json`), JSON.stringify(d), 'utf8');
}

describe('coexistence: auto-approve + supervision outbox share one BobSender', () => {
  let tmp: string;
  let outboxDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-'));
    outboxDir = path.join(tmp, 'outbox');
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('both fire in the same tick without interfering', async () => {
    const sharedSender = new FakeSender();
    const approver = new FakeApprover();
    approver.pending = [pending('r1', 'glob')];
    const rules: AutoRespondRule[] = [{ toolPattern: 'glob', decision: 'approveOnce' }];

    const autoResponder = new AutoResponder(
      managerWith([session('s', '/home/me/proj')]), sharedSender, () => rules, () => { /* noop */ }, approver,
    );
    const outbox = new SupervisorOutbox(outboxDir, sharedSender, () => { /* noop */ });
    writeDelivery(outboxDir, {
      deliveryId: 'd1', sessionId: 's', source: 'bob',
      text: '[Session Supervisor] Hold — awaiting the human on the migration.', kind: 'orange_hold',
    });

    // Run concurrently, as the two independent 5s timers would.
    await Promise.all([autoResponder.sweepApprovals(), outbox.poll()]);

    // Auto-approve resolved its prompt (via the approver, not the sender).
    expect(approver.calls).toEqual([{ requestId: 'r1', payload: { allowOnce: true } }]);
    // Supervision guidance injected via the SHARED sender — and nothing else on it.
    expect(sharedSender.sent).toEqual([
      { taskId: 's', text: '[Session Supervisor] Hold — awaiting the human on the migration.' },
    ]);
  });

  it('re-running both is idempotent — neither re-fires', async () => {
    const sharedSender = new FakeSender();
    const approver = new FakeApprover();
    approver.pending = [pending('r1', 'glob')];
    const rules: AutoRespondRule[] = [{ toolPattern: 'glob', decision: 'approveOnce' }];
    const autoResponder = new AutoResponder(
      managerWith([session('s', '/p')]), sharedSender, () => rules, () => { /* noop */ }, approver,
    );
    const outbox = new SupervisorOutbox(outboxDir, sharedSender, () => { /* noop */ });
    writeDelivery(outboxDir, { deliveryId: 'd1', sessionId: 's', source: 'bob', text: 'x', kind: 'g' });

    await Promise.all([autoResponder.sweepApprovals(), outbox.poll()]);
    await Promise.all([autoResponder.sweepApprovals(), outbox.poll()]);

    expect(approver.calls.length).toBe(1);   // requestId dedup
    expect(sharedSender.sent.length).toBe(1); // delivery moved to done/
  });

  it('a supervision text send and an approval resolve do not cross-talk', async () => {
    // Approval targets the approver; guidance targets the sender — disjoint sinks.
    const sharedSender = new FakeSender();
    const approver = new FakeApprover();
    approver.pending = [pending('r1', 'execute_command')];
    const rules: AutoRespondRule[] = [{ toolPattern: 'execute_command', decision: 'reject' }];
    const autoResponder = new AutoResponder(
      managerWith([session('s', '/p')]), sharedSender, () => rules, () => { /* noop */ }, approver,
    );
    const outbox = new SupervisorOutbox(outboxDir, sharedSender, () => { /* noop */ });
    writeDelivery(outboxDir, { deliveryId: 'd9', sessionId: 's', source: 'bob', text: 'guidance', kind: 'g' });

    await Promise.all([outbox.poll(), autoResponder.sweepApprovals()]);

    expect(approver.calls[0].payload).toEqual({ allowOnce: false }); // reject
    expect(sharedSender.sent).toEqual([{ taskId: 's', text: 'guidance' }]);
  });

  it('a supervisor reject_approval delivery (#56) resolves via the shared approver', async () => {
    // #56 prompt-time interception: the supervisor writes a reject_approval delivery carrying
    // a requestId; the outbox resolves it through the same approver #58 uses.
    const sharedSender = new FakeSender();
    const approver = new FakeApprover();
    const outbox = new SupervisorOutbox(outboxDir, sharedSender, () => { /* noop */ }, approver);
    writeDelivery(outboxDir, {
      deliveryId: 'd-reject', sessionId: 's', source: 'bob',
      text: '[Session Supervisor] BLOCKED (red): direct push to main',
      kind: 'reject_approval', requestId: 'req-1', channel: 'approval',
    });
    await outbox.poll();
    expect(approver.calls).toEqual([{ requestId: 'req-1', payload: { allowOnce: false } }]);
    expect(sharedSender.sent).toHaveLength(0); // did NOT use the message channel
  });
});
