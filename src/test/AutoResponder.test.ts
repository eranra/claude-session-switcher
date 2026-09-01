import { describe, it, expect, vi } from 'vitest';

// AutoResponder.ts imports 'vscode' at module load; stub it.
vi.mock('vscode', () => ({ window: { createOutputChannel: vi.fn() } }));

import { matchRule, messageKey, globToRegExp, matchApprovalRule, ruleAppliesToSession } from '../AutoResponder';
import type { AutoRespondRule } from '../agents/BobSender';
import type { MessageExchange } from '../SessionManager';
import type { PendingApproval } from '../agents/BobApprover';
import type { RuleDecision } from '../supervisor/ruleDecisions';

const rules: AutoRespondRule[] = [
  { matchPattern: 'Do you want to continue', response: 'yes' },
  { matchPattern: 'Proceed\\?', response: 'y' },
];

describe('matchRule', () => {
  it('matches a plain substring pattern', () => {
    expect((matchRule('Do you want to continue?', rules))?.response).toBe('yes');
  });
  it('matches a regex pattern', () => {
    expect((matchRule('Proceed?', rules))?.response).toBe('y');
  });
  it('returns undefined when nothing matches', () => {
    expect(matchRule('All done.', rules)).toBeUndefined();
  });
  it('ignores an invalid regex without throwing', () => {
    expect(matchRule('anything', [{ matchPattern: '(', response: 'x' }])).toBeUndefined();
  });
  it('skips approval rules (no matchPattern) so they never match text', () => {
    const mixed: AutoRespondRule[] = [{ toolPattern: '*', decision: 'reject' }];
    expect(matchRule('any assistant text', mixed)).toBeUndefined();
  });
});

describe('globToRegExp', () => {
  it('* matches any run of characters, anchored', () => {
    expect(globToRegExp('read_*').test('read_file')).toBe(true);
    expect(globToRegExp('read_*').test('xread_file')).toBe(false);
  });
  it('| separates alternatives', () => {
    const re = globToRegExp('read_*|list_*');
    expect(re.test('read_file')).toBe(true);
    expect(re.test('list_files')).toBe(true);
    expect(re.test('execute_command')).toBe(false);
  });
  it('bare * matches anything', () => {
    expect(globToRegExp('*').test('execute_command')).toBe(true);
  });
  it('literal tool name matches exactly', () => {
    expect(globToRegExp('execute_command').test('execute_command')).toBe(true);
    expect(globToRegExp('execute_command').test('execute_command_x')).toBe(false);
  });
});

function pending(toolName: string, argsText = '{}', hasCommandUse = false): PendingApproval {
  return { requestId: 'r1', toolName, argsText, permission: 'read', hasCommandUse, taskId: 's' };
}

describe('ruleAppliesToSession', () => {
  it('applies to all sessions when no sessionPattern', () => {
    expect(ruleAppliesToSession({ matchPattern: 'x', response: 'y' }, '/home/me/proj')).toBe(true);
  });
  it('applies only when the regex matches the project path', () => {
    const rule = { toolPattern: 'read_*', decision: 'approveOnce' as const, sessionPattern: 'acme/web-app' };
    expect(ruleAppliesToSession(rule, '/home/me/acme/web-app')).toBe(true);
    expect(ruleAppliesToSession(rule, '/home/me/other-project')).toBe(false);
  });
  it('does not apply a scoped rule when projectPath is unknown', () => {
    expect(ruleAppliesToSession({ matchPattern: 'x', response: 'y', sessionPattern: 'foo' }, undefined)).toBe(false);
  });
  it('unscoped rule still applies when projectPath is unknown', () => {
    expect(ruleAppliesToSession({ matchPattern: 'x', response: 'y' }, undefined)).toBe(true);
  });
  it('does not throw on an invalid regex (rule simply does not apply)', () => {
    expect(ruleAppliesToSession({ matchPattern: 'x', response: 'y', sessionPattern: '(' }, '/any')).toBe(false);
  });
});

describe('matchApprovalRule', () => {
  const arules: AutoRespondRule[] = [
    { toolPattern: 'read_*|list_*|glob', decision: 'approveForTask' },
    { toolPattern: 'execute_command', argumentPattern: 'git (status|diff)', decision: 'approveOnce' },
    { toolPattern: '*', decision: 'reject' },
  ];

  it('matches by glob on tool name, first-match-wins', () => {
    expect(matchApprovalRule(pending('glob'), arules)?.decision).toBe('approveForTask');
  });
  it('narrows by argumentPattern regex', () => {
    expect(matchApprovalRule(pending('execute_command', '{"command":"git status"}'), arules)?.decision).toBe('approveOnce');
  });
  it('falls through to the catch-all when argumentPattern does not match', () => {
    expect(matchApprovalRule(pending('execute_command', '{"command":"rm -rf /"}'), arules)?.decision).toBe('reject');
  });
  it('ignores text rules and invalid globs without throwing', () => {
    const mixed: AutoRespondRule[] = [
      { matchPattern: 'continue', response: 'yes' },
      { toolPattern: 'glob', decision: 'approveOnce' },
    ];
    expect(matchApprovalRule(pending('glob'), mixed)?.decision).toBe('approveOnce');
  });
  it('returns undefined when no approval rule matches', () => {
    expect(matchApprovalRule(pending('glob'), [{ toolPattern: 'write_*', decision: 'reject' }])).toBeUndefined();
  });
});

describe('messageKey', () => {
  it('uses the timestamp when present', () => {
    const ex: MessageExchange = { role: 'assistant', text: 'hi', timestamp: '2026-07-14T10:00:00Z' };
    expect(messageKey(ex)).toBe('2026-07-14T10:00:00Z');
  });
  it('falls back to the text when no timestamp', () => {
    expect(messageKey({ role: 'assistant', text: 'hi' })).toBe('hi');
  });
});

import { AutoResponder } from '../AutoResponder';
import type { BobSender } from '../agents/BobSender';
import type { BobApprover } from '../agents/BobApprover';
import type { ClaudeSession } from '../SessionManager';

function bobSession(id: string, status: ClaudeSession['status'] = 'seen', projectPath = '/p'): ClaudeSession {
  return { sessionId: id, projectName: 'p', projectPath, title: 't',
    updatedAt: new Date(), status, source: 'bob' };
}

class FakeSender implements BobSender {
  public calls: Array<{ taskId: string; text: string }> = [];
  public fail = false;
  async isAvailable() { return true; }
  async send(taskId: string, text: string) {
    if (this.fail) { throw new Error('send failed'); }
    this.calls.push({ taskId, text });
  }
}

class FakeApprover implements BobApprover {
  public pending: PendingApproval[] = [];
  public calls: Array<{ requestId: string; payload: Record<string, unknown> }> = [];
  public installHookCalls = 0;
  async installHook(): Promise<string> { this.installHookCalls++; return 'hooked:1'; }
  async listAllPending() { return this.pending; }
  public failResolve = false;
  async resolve(requestId: string, payload: Record<string, unknown>): Promise<string> {
    if (this.failResolve) { throw new Error('resolve failed'); }
    this.calls.push({ requestId, payload });
    return 'ok';
  }
}

function pendingApproval(requestId: string, toolName: string, hasCommandUse = false, argsText = '{}'): PendingApproval {
  return { requestId, toolName, argsText, permission: 'read', hasCommandUse, taskId: 's' };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeManager(exchanges: Record<string, any[]>) {
  return {
    onDidChangeSessions: () => ({ dispose() {} }),
    getSessions: () => [] as ClaudeSession[],
    getRecentExchanges: async (id: string) => exchanges[id] ?? [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('AutoResponder dedup', () => {
  const rules = [{ matchPattern: 'continue', response: 'yes' }];

  it('fires once on a matching assistant message', async () => {
    const ex = { assistant: [{ role: 'assistant', text: 'please continue', timestamp: 'T1' }] };
    const sender = new FakeSender();
    const r = new AutoResponder(fakeManager(ex), sender, () => rules, () => {});
    await r.evaluateSession(bobSession('assistant'));
    expect(sender.calls).toEqual([{ taskId: 'assistant', text: 'yes' }]);
  });

  it('does not re-fire for the same message key', async () => {
    const ex = { s: [{ role: 'assistant', text: 'continue', timestamp: 'T1' }] };
    const sender = new FakeSender();
    const r = new AutoResponder(fakeManager(ex), sender, () => rules, () => {});
    await r.evaluateSession(bobSession('s'));
    await r.evaluateSession(bobSession('s'));
    expect(sender.calls.length).toBe(1);
  });

  it('does not fire when the latest message is from the user', async () => {
    const ex = { s: [{ role: 'assistant', text: 'continue', timestamp: 'T1' }, { role: 'user', text: 'ok', timestamp: 'T2' }] };
    const sender = new FakeSender();
    const r = new AutoResponder(fakeManager(ex), sender, () => rules, () => {});
    await r.evaluateSession(bobSession('s'));
    expect(sender.calls.length).toBe(0);
  });

  it('re-arms after a newer user message, then a new matching assistant message', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: Record<string, any[]> = { s: [{ role: 'assistant', text: 'continue', timestamp: 'T1' }] };
    const sender = new FakeSender();
    const r = new AutoResponder(fakeManager(store), sender, () => rules, () => {});
    await r.evaluateSession(bobSession('s'));            // fires on T1
    store.s = [{ role: 'user', text: 'ok', timestamp: 'T2' }]; // user replied
    await r.evaluateSession(bobSession('s'));            // no assistant tail → no fire
    store.s = [{ role: 'assistant', text: 'continue again', timestamp: 'T3' }];
    await r.evaluateSession(bobSession('s'));            // new key → fires
    expect(sender.calls.length).toBe(2);
  });
});

describe('AutoResponder approvals', () => {
  const rules: AutoRespondRule[] = [
    { toolPattern: 'read_*|glob', decision: 'approveForTask' },
    { toolPattern: 'execute_command', decision: 'reject' },
  ];

  function make(approver: FakeApprover, ruleset: AutoRespondRule[] = rules) {
    return new AutoResponder(fakeManager({}), new FakeSender(), () => ruleset, () => {}, approver);
  }

  it('resolves a matching pending approval with the right payload', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'glob')];
    await make(approver).sweepApprovals();
    expect(approver.calls).toEqual([{ requestId: 'r1', payload: { allowOnce: true, groupApproved: true } }]);
  });

  it('rejects a matching tool', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'execute_command', true)];
    await make(approver).sweepApprovals();
    expect(approver.calls[0].payload).toEqual({ allowOnce: false });
  });

  it('does nothing when no rule matches', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'write_to_file')];
    await make(approver).sweepApprovals();
    expect(approver.calls.length).toBe(0);
  });

  it('resolves each request once (dedup by requestId)', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'glob')];
    const r = make(approver);
    await r.sweepApprovals();
    await r.sweepApprovals(); // same requestId still pending
    expect(approver.calls.length).toBe(1);
  });

  it('re-arms once a resolved request leaves the pending set', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'glob')];
    const r = make(approver);
    await r.sweepApprovals();                          // resolves r1
    approver.pending = [];                             // r1 gone
    await r.sweepApprovals();                          // prunes r1 from dedup set
    approver.pending = [pendingApproval('r2', 'glob')];// a new request
    await r.sweepApprovals();                          // resolves r2
    expect(approver.calls.map(c => c.requestId)).toEqual(['r1', 'r2']);
  });

  it('applies rules in config order (first match wins)', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'glob')];
    const ordered: AutoRespondRule[] = [
      { toolPattern: '*', decision: 'reject' },              // catch-all first → wins
      { toolPattern: 'glob', decision: 'approveOnce' },
    ];
    await make(approver, ordered).sweepApprovals();
    expect(approver.calls[0].payload).toEqual({ allowOnce: false });
  });
});

describe('AutoResponder supervision handoff (onUnhandledPending)', () => {
  const rules: AutoRespondRule[] = [{ toolPattern: 'read_*|glob', decision: 'approveForTask' }];

  function make(approver: FakeApprover, onUnhandled: (p: PendingApproval) => void, prune?: (ids: Set<string>) => void) {
    return new AutoResponder(fakeManager({}), new FakeSender(), () => rules, () => {}, approver, onUnhandled, prune);
  }

  it('hands an UNHANDLED pending to the supervisor (no matching rule)', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'execute_command', true, '{"command":"git push --force"}')];
    const handed: string[] = [];
    await make(approver, (p) => handed.push(p.requestId)).sweepApprovals();
    expect(handed).toEqual(['r1']);
    expect(approver.calls.length).toBe(0); // not auto-approved
  });

  it('does NOT hand off a pending that an auto-approve rule handles', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'glob')];
    const handed: string[] = [];
    await make(approver, (p) => handed.push(p.requestId)).sweepApprovals();
    expect(handed).toEqual([]);           // read auto-approved → never reaches the supervisor
    expect(approver.calls.length).toBe(1);
  });

  it('sweeps for handoff even when there are no auto-approve rules', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'write_to_file')];
    const handed: string[] = [];
    const r = new AutoResponder(fakeManager({}), new FakeSender(), () => [], () => {}, approver, (p) => handed.push(p.requestId));
    await r.sweepApprovals();
    expect(handed).toEqual(['r1']);
  });

  it('passes the still-pending ids to prune so the trigger can re-arm', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'write_to_file'), pendingApproval('r2', 'glob')];
    let pruned: Set<string> | undefined;
    await make(approver, () => {}, (ids) => { pruned = ids; }).sweepApprovals();
    expect([...(pruned ?? [])].sort()).toEqual(['r1', 'r2']);
  });
});

describe('AutoResponder session-scoped rules', () => {
  function managerWithSessions(sessions: ClaudeSession[]) {
    return {
      onDidChangeSessions: () => ({ dispose() {} }),
      getSessions: () => sessions,
      getRecentExchanges: async () => [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }
  function bobSess(id: string, projectPath: string): ClaudeSession {
    return { sessionId: id, projectName: 'p', projectPath, title: 't', updatedAt: new Date(), status: 'working', source: 'bob' };
  }

  it('approval rule scoped by sessionPattern fires only on the matching project', async () => {
    const rules: AutoRespondRule[] = [{ sessionPattern: 'acme/web-app', toolPattern: 'glob', decision: 'approveOnce' }];

    const noMatch = new FakeApprover();
    noMatch.pending = [pendingApproval('r1', 'glob')]; // taskId 's'
    await new AutoResponder(managerWithSessions([bobSess('s', '/home/me/other')]), new FakeSender(), () => rules, () => {}, noMatch).sweepApprovals();
    expect(noMatch.calls.length).toBe(0);

    const match = new FakeApprover();
    match.pending = [pendingApproval('r1', 'glob')];
    await new AutoResponder(managerWithSessions([bobSess('s', '/home/me/acme/web-app')]), new FakeSender(), () => rules, () => {}, match).sweepApprovals();
    expect(match.calls.length).toBe(1);
  });

  it('text rule scoped by sessionPattern fires only on the matching project', async () => {
    const rules: AutoRespondRule[] = [{ sessionPattern: 'session-sitter', matchPattern: 'continue', response: 'yes' }];
    const ex = { s: [{ role: 'assistant', text: 'please continue', timestamp: 'T1' }] };
    const sender = new FakeSender();
    const r = new AutoResponder(fakeManager(ex), sender, () => rules, () => {});
    await r.evaluateSession(bobSession('s', 'seen', '/home/me/other'));   // no match → no fire
    expect(sender.calls.length).toBe(0);
    await r.evaluateSession(bobSession('s', 'seen', '/home/me/session-sitter/x')); // match → fires
    expect(sender.calls.length).toBe(1);
  });
});

function claudeSession(id: string, status: ClaudeSession['status'] = 'seen', projectPath = '/p'): ClaudeSession {
  return { sessionId: id, projectName: 'p', projectPath, title: 't', updatedAt: new Date(), status, source: 'claude' };
}

describe('AutoResponder source routing', () => {
  const claudeRules: AutoRespondRule[] = [{ matchPattern: 'continue', response: 'yes', source: 'claude' }];

  it('routes a claude session to the claude sender, not the bob sender', async () => {
    const ex = { c: [{ role: 'assistant', text: 'please continue', timestamp: 'T1' }] };
    const bob = new FakeSender(); const claude = new FakeSender();
    const r = new AutoResponder(fakeManager(ex), bob, () => claudeRules, () => {}, undefined, undefined, undefined, claude);
    await r.evaluateSession(claudeSession('c'));
    expect(claude.calls).toEqual([{ taskId: 'c', text: 'yes' }]);
    expect(bob.calls).toEqual([]);
  });

  it('does not fire a claude-source rule on a bob session', async () => {
    const ex = { s: [{ role: 'assistant', text: 'please continue', timestamp: 'T1' }] };
    const bob = new FakeSender(); const claude = new FakeSender();
    const r = new AutoResponder(fakeManager(ex), bob, () => claudeRules, () => {}, undefined, undefined, undefined, claude);
    await r.evaluateSession(bobSession('s'));
    expect(bob.calls).toEqual([]);
    expect(claude.calls).toEqual([]);
  });

  it('does not fire a bob-source (default) rule on a claude session', async () => {
    const ex = { c: [{ role: 'assistant', text: 'please continue', timestamp: 'T1' }] };
    const bob = new FakeSender(); const claude = new FakeSender();
    const bobRules: AutoRespondRule[] = [{ matchPattern: 'continue', response: 'yes' }]; // source defaults to 'bob'
    const r = new AutoResponder(fakeManager(ex), bob, () => bobRules, () => {}, undefined, undefined, undefined, claude);
    await r.evaluateSession(claudeSession('c'));
    expect(claude.calls).toEqual([]);
    expect(bob.calls).toEqual([]);
  });

  it('no-ops a claude session when no claude sender is configured', async () => {
    const ex = { c: [{ role: 'assistant', text: 'please continue', timestamp: 'T1' }] };
    const bob = new FakeSender();
    const r = new AutoResponder(fakeManager(ex), bob, () => claudeRules, () => {}); // no claudeSender
    await r.evaluateSession(claudeSession('c'));
    expect(bob.calls).toEqual([]);
  });
});

describe('AutoResponder Claude approvals (sweepClaudeApprovals)', () => {
  // 10th positional arg is claudeApprover; use FakeApprover (implements BobApprover).
  function makeClaude(approver: FakeApprover, ruleset: AutoRespondRule[]) {
    return new AutoResponder(
      fakeManager({}), new FakeSender(), () => ruleset, () => {},
      undefined, undefined, undefined, new FakeSender(), approver,
    );
  }

  it('resolves a matching Claude prompt with the allow payload (echoing inputs)', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'Bash', false, '{"command":"ls"}')];
    const rules: AutoRespondRule[] = [{ toolPattern: 'Bash', decision: 'approveOnce', source: 'claude' }];
    await makeClaude(approver, rules).sweepClaudeApprovals();
    expect(approver.calls).toEqual([{ requestId: 'r1', payload: { result: { behavior: 'allow', updatedInput: { command: 'ls' } } } }]);
  });

  it('rejects a matching Claude prompt with the deny payload', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'Bash', false, '{"command":"rm -rf /"}')];
    const rules: AutoRespondRule[] = [{ toolPattern: 'Bash', decision: 'reject', source: 'claude' }];
    await makeClaude(approver, rules).sweepClaudeApprovals();
    expect(approver.calls[0].payload).toEqual({ result: { behavior: 'deny', message: 'Denied by the session supervisor' } });
  });

  it('ignores bob-source approval rules (only claude-source apply)', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'Bash')];
    const rules: AutoRespondRule[] = [{ toolPattern: 'Bash', decision: 'approveOnce' }]; // defaults to bob
    await makeClaude(approver, rules).sweepClaudeApprovals();
    expect(approver.calls.length).toBe(0);
  });

  it('skips claude approval rules scoped by sessionPattern (channel↔session unmapped)', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'Bash')];
    const rules: AutoRespondRule[] = [{ toolPattern: 'Bash', decision: 'approveOnce', source: 'claude', sessionPattern: 'x' }];
    await makeClaude(approver, rules).sweepClaudeApprovals();
    expect(approver.calls.length).toBe(0);
  });

  it('dedups by requestId (resolves each once)', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'Bash')];
    const rules: AutoRespondRule[] = [{ toolPattern: 'Bash', decision: 'approveOnce', source: 'claude' }];
    const r = makeClaude(approver, rules);
    await r.sweepClaudeApprovals();
    await r.sweepClaudeApprovals();
    expect(approver.calls.length).toBe(1);
  });

  it('leaves an unmatched Claude prompt for the user', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'Write')];
    const rules: AutoRespondRule[] = [{ toolPattern: 'Bash', decision: 'approveOnce', source: 'claude' }];
    await makeClaude(approver, rules).sweepClaudeApprovals();
    expect(approver.calls.length).toBe(0);
  });

  it('routes AskUserQuestion to the supervisor handoff, never auto-allows it', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'AskUserQuestion', false, '{"questions":[]}')];
    const handed: string[] = [];
    // A permissive '*' rule would normally allow anything — it must NOT apply to a question.
    const rules: AutoRespondRule[] = [{ toolPattern: '*', decision: 'approveOnce', source: 'claude' }];
    const r = new AutoResponder(
      fakeManager({}), new FakeSender(), () => rules, () => {},
      undefined, undefined, undefined, new FakeSender(), approver,
      (p) => handed.push(p.toolName),
    );
    await r.sweepClaudeApprovals();
    expect(approver.calls.length).toBe(0);      // never allow/deny
    expect(handed).toEqual(['AskUserQuestion']); // handed to the supervisor instead
  });
  it('re-installs the capture hook every sweep (covers comms opened after activation)', async () => {
    const approver = new FakeApprover();
    const rules: AutoRespondRule[] = [{ toolPattern: 'Bash', decision: 'approveOnce', source: 'claude' }];
    const r = makeClaude(approver, rules);
    await r.sweepClaudeApprovals();
    await r.sweepClaudeApprovals();
    expect(approver.installHookCalls).toBe(2); // once per sweep, not once at start()
  });

  it('hands an uncaptured prompt (empty toolName) to the supervisor, never auto-allowing it', async () => {
    const approver = new FakeApprover();
    // Metadata was missed by the send-hook → toolName is ''. A '*' rule must NOT allow it.
    approver.pending = [pendingApproval('r1', '', false, '{}')];
    const handed: string[] = [];
    const rules: AutoRespondRule[] = [{ toolPattern: '*', decision: 'approveOnce', source: 'claude' }];
    const r = new AutoResponder(
      fakeManager({}), new FakeSender(), () => rules, () => {},
      undefined, undefined, undefined, new FakeSender(), approver,
      (p) => handed.push(p.requestId),
    );
    await r.sweepClaudeApprovals();
    expect(approver.calls.length).toBe(0); // never allow/deny an unknown request
    expect(handed).toEqual(['r1']);        // handed to the supervisor instead
  });
});

// Every deterministic rule decision is reported so the panel's activity feed and Telegram show
// ALL of Session Sitter's interventions, not only the ones the supervisor AI took. A decision is
// reported only once it actually reached the agent.
describe('AutoResponder rule reporting (onRuleDecision)', () => {
  const approvalRules: AutoRespondRule[] = [
    { toolPattern: 'read_*|glob', decision: 'approveForTask', argumentPattern: 'src/' },
    { toolPattern: 'execute_command', decision: 'reject' },
  ];

  /** AutoResponder with only the reporter wired (every other collaborator left out). */
  function withReporter(
    seen: RuleDecision[],
    opts: {
      ruleset?: AutoRespondRule[];
      approver?: FakeApprover;
      claudeApprover?: FakeApprover;
      sender?: FakeSender;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exchanges?: Record<string, any[]>;
      onUnhandled?: (p: PendingApproval) => void;
      log?: (m: string) => void;
      report?: (d: RuleDecision) => void;
    } = {},
  ): AutoResponder {
    return new AutoResponder(
      fakeManager(opts.exchanges ?? {}),
      opts.sender ?? new FakeSender(),
      () => opts.ruleset ?? approvalRules,
      opts.log ?? (() => {}),
      opts.approver,
      opts.onUnhandled,
      undefined,
      undefined,
      opts.claudeApprover,
      undefined,
      undefined,
      opts.report ?? ((d) => seen.push(d)),
    );
  }

  it('reports an auto-approved prompt so it lands in the feed and on Telegram', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'glob', false, '{"pattern":"src/**"}')];
    const seen: RuleDecision[] = [];
    await withReporter(seen, { approver }).sweepApprovals();
    expect(approver.calls.length).toBe(1);
    expect(seen).toEqual([{
      sessionId: 's',
      source: 'bob',
      kind: 'approval',
      pattern: 'read_*|glob',
      argumentPattern: 'src/',
      decision: 'approveForTask',
      toolName: 'glob',
      argsText: '{"pattern":"src/**"}',
      requestId: 'r1',
    }]);
  });

  it('reports an auto-rejected prompt too', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'execute_command', true)];
    const seen: RuleDecision[] = [];
    await withReporter(seen, { approver }).sweepApprovals();
    expect(seen.map(d => d.decision)).toEqual(['reject']);
  });

  it('does NOT report a prompt that fell through to the supervisor', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'write_to_file')];
    const seen: RuleDecision[] = [];
    const handed: string[] = [];
    await withReporter(seen, {
      approver, onUnhandled: (p) => handed.push(p.requestId),
    }).sweepApprovals();
    expect(handed).toEqual(['r1']); // the supervisor writes that record itself
    expect(seen).toEqual([]);
  });

  it('does not report when the approval could not be resolved', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'glob', false, '{"pattern":"src/**"}')];
    approver.failResolve = true;
    const seen: RuleDecision[] = [];
    await withReporter(seen, { approver }).sweepApprovals();
    expect(seen).toEqual([]); // nothing changed in the agent, so there is nothing to report
  });

  it('reports a Claude auto-approval with source claude', async () => {
    const claudeApprover = new FakeApprover();
    claudeApprover.pending = [pendingApproval('r1', 'Read', false, '{"file_path":"src/a.ts"}')];
    const seen: RuleDecision[] = [];
    const ruleset: AutoRespondRule[] = [
      { toolPattern: 'Read|Glob', decision: 'approveOnce', source: 'claude' },
    ];
    await withReporter(seen, { claudeApprover, ruleset }).sweepClaudeApprovals();
    expect(seen.map(d => [d.source, d.toolName, d.decision]))
      .toEqual([['claude', 'Read', 'approveOnce']]);
  });

  it('reports a text auto-reply after it is sent', async () => {
    const seen: RuleDecision[] = [];
    const r = withReporter(seen, {
      ruleset: rules,
      exchanges: { s: [{ role: 'assistant', text: 'Do you want to continue?', timestamp: 'T1' }] },
    });
    await r.evaluateSession(bobSession('s'));
    expect(seen).toEqual([{
      sessionId: 's', source: 'bob', kind: 'text',
      pattern: 'Do you want to continue', response: 'yes',
    }]);
  });

  it('does not report a text reply the sender failed to deliver', async () => {
    const sender = new FakeSender();
    sender.fail = true;
    const seen: RuleDecision[] = [];
    const r = withReporter(seen, {
      ruleset: rules,
      sender,
      exchanges: { s: [{ role: 'assistant', text: 'Do you want to continue?', timestamp: 'T1' }] },
    });
    await r.evaluateSession(bobSession('s'));
    expect(seen).toEqual([]);
  });

  it('a throwing reporter never breaks a text auto-reply either', async () => {
    const sender = new FakeSender();
    const logs: string[] = [];
    const r = withReporter([], {
      ruleset: rules,
      sender,
      log: (m) => logs.push(m),
      exchanges: { s: [{ role: 'assistant', text: 'Do you want to continue?', timestamp: 'T1' }] },
      report: () => { throw new Error('reporter exploded'); },
    });
    await r.evaluateSession(bobSession('s'));
    expect(sender.calls).toEqual([{ taskId: 's', text: 'yes' }]); // the reply still went out
    expect(logs.join('\n')).toContain('rule decision report failed');
    expect(logs.join('\n')).not.toContain('send failed'); // not misreported as a send failure
  });

  it('a throwing reporter never breaks the sweep', async () => {
    const approver = new FakeApprover();
    approver.pending = [pendingApproval('r1', 'glob', false, '{"pattern":"src/**"}')];
    const logs: string[] = [];
    const r = withReporter([], {
      approver,
      log: (m) => logs.push(m),
      report: () => { throw new Error('reporter exploded'); },
    });
    await r.sweepApprovals();
    expect(approver.calls.length).toBe(1); // the decision still reached the agent
    expect(logs.join('\n')).toContain('rule decision report failed');
  });
});
