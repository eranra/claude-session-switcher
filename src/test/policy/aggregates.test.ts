/**
 * The cross-machine witness — issue #84.
 *
 * Four properties carry the whole design, and each has a test here that fails if the property is
 * removed:
 *
 *  1. **Counts from two hosts are never summed.** 11 + 1 is one developer's habit with a witness.
 *  2. **A host that fails the user row is not a witness**, even though it published a row.
 *  3. **An aggregate cannot make a clause enforceable.** The highest-stakes output in the system is
 *     still `status: proposed` and nothing else.
 *  4. **No excluded key can appear in a published aggregate** — asserted by walking every key at
 *     every depth of the payload, not by checking the fields we happened to think of.
 *
 * Every fixture is invented. No real path, no real hostname, no real project name.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AGGREGATE_FIELDS, AGGREGATE_VERSION, aggregatePath, buildAggregate, clearsUserRow, hostLabel,
  isHostLabel, publishAggregate, readAggregates, renderAggregate, witnessHostsFor,
  type AggregateRow, type HostAggregate,
} from '../../policy/aggregates';
import {
  THRESHOLDS, emptyShapes, shapeHash, tierFor, type ShapeStat, type ShapesFile, type Support,
} from '../../policy/mine';
import { NEVER_SHIPPED } from '../../cli/export';
import { propose } from '../../policy/pipeline';
import { statusOf } from '../../policy/propose';
import { isEnforceable, isMatched, rendersIntoPrompt } from '../../supervisor/learnedClauses';
import type { DecisionRecord } from '../../audit/trail';
import type { PluginSettings } from '../../hooks/settings';

// --------------------------------------------------------------------------- fixtures

const KEY = Buffer.from('a'.repeat(64), 'hex');

/** A shape's local counters, as the fold would have left them. */
function stat(over: Partial<ShapeStat> = {}): ShapeStat {
  const segment = over.segment ?? 'pnpm test';
  return {
    tool: 'Bash',
    segment,
    shape12: shapeHash('Bash', segment),
    support: 4,
    records: 4,
    sessions: ['s-1', 's-2', 's-3'],
    days: ['2026-08-20', '2026-08-22'],
    firstSeen: '2026-08-20T09:00:00.000Z',
    lastSeen: '2026-08-22T09:00:00.000Z',
    signals: { model: 4 },
    cwds: { '/w/api': 4 },
    noCall: 0,
    ...over,
  };
}

function shapesWith(...stats: ShapeStat[]): ShapesFile {
  const file = emptyShapes();
  for (const s of stats) { file.shapes[`${s.tool}|${s.segment}`] = s; }
  return file;
}

function row(over: Partial<AggregateRow> = {}): AggregateRow {
  return { shape12: shapeHash('Bash', 'pnpm test'), occurrences: 4, sessions: 3, days: 2, ...over };
}

function aggregate(host: string, ...rows: AggregateRow[]): HostAggregate {
  return { version: AGGREGATE_VERSION, host, generatedAt: '2026-09-04T10:00:00.000Z', shapes: rows };
}

function corpus(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ss-agg-'));
}

/** Support that clears the team row on this machine's own counts. */
function teamSupport(over: Partial<Support> = {}): Support {
  return { occurrences: 12, sessions: 8, days: 14, confinement: 1, cwd: '/w/api', ...over };
}

// --------------------------------------------------------------------------- property 1

describe('per-host counts are cleared, never summed', () => {
  it('11 occurrences here plus 1 there is not a team pattern', () => {
    const weak = aggregate('h-000000000002', row({ occurrences: 1, sessions: 1, days: 1 }));
    const witnesses = witnessHostsFor(row().shape12, [weak], ['h-000000000001']);
    expect(witnesses).toEqual([]);

    // 11 + 1 = 12 would clear the team occurrence bar if anything anywhere added them up.
    const chosen = tierFor(teamSupport({ occurrences: 11, sessions: 7, days: 13 }), false, {
      hasSlug: true, witnessHosts: witnesses.length,
    });
    expect(chosen.tier).not.toBe('team');
  });

  it('two hosts at 6 each do not add up to the team row', () => {
    const other = aggregate('h-000000000002', row({ occurrences: 6, sessions: 4, days: 3 }));
    const witnesses = witnessHostsFor(row().shape12, [other], ['h-000000000001']);
    // The other host *is* a witness — it cleared the user row on its own.
    expect(witnesses).toEqual(['h-000000000002']);
    // But this host's own 6 does not clear the team row, and nobody's counts are added to it.
    const chosen = tierFor(teamSupport({ occurrences: 6, sessions: 4, days: 3 }), false, {
      hasSlug: true, witnessHosts: witnesses.length,
    });
    expect(chosen.tier).not.toBe('team');
    expect(chosen.declinedTeam).toBeNull();
  });

  it('a proposing host that clears the team row plus one real witness reaches team', () => {
    const other = aggregate('h-000000000002', row({ occurrences: 3, sessions: 3, days: 2 }));
    const witnesses = witnessHostsFor(row().shape12, [other], ['h-000000000001']);
    const chosen = tierFor(teamSupport(), false, { hasSlug: true, witnessHosts: witnesses.length });
    expect(chosen.tier).toBe('team');
    expect(chosen.declinedTeam).toBeNull();
  });

  it('the same evidence with no witness is declined, and the run line says why', () => {
    const chosen = tierFor(teamSupport(), true, { hasSlug: true, witnessHosts: 0 });
    expect(chosen.tier).toBe('project');
    expect(chosen.declinedTeam).toBe('no cross-user evidence in a single-machine corpus');
  });

  it('a configured team with witnesses but no slug is declined for the slug, not the evidence', () => {
    const chosen = tierFor(teamSupport(), false, { hasSlug: false, witnessHosts: 1 });
    expect(chosen.tier).toBe('user');
    expect(chosen.declinedTeam).toContain('no team slug configured');
  });

  it('team tier is unreachable when the caller passes no team evidence at all', () => {
    expect(tierFor(teamSupport(), false).tier).toBe('user');
  });
});

// --------------------------------------------------------------------------- property 2

describe('a host that fails the user row is not a witness', () => {
  it('the bars are re-checked on read, not trusted from the file', () => {
    const bar = THRESHOLDS.user;
    expect(clearsUserRow(row({ occurrences: bar.occurrences - 1 }))).toBe(false);
    expect(clearsUserRow(row({ sessions: bar.sessions - 1 }))).toBe(false);
    expect(clearsUserRow(row({ days: bar.days - 1 }))).toBe(false);
    expect(clearsUserRow(row())).toBe(true);
  });

  it('a hand-edited row below the floor is ignored even though it is in the file', () => {
    const root = corpus();
    const forged = aggregate('h-liar', row({ occurrences: 99, sessions: 1, days: 1 }));
    fs.mkdirSync(path.dirname(aggregatePath(root, 'h-liar')), { recursive: true });
    fs.writeFileSync(aggregatePath(root, 'h-liar'), renderAggregate(forged), 'utf8');
    const { aggregates } = readAggregates(root);
    expect(aggregates).toHaveLength(1);
    expect(witnessHostsFor(row().shape12, aggregates, ['h-me'])).toEqual([]);
  });

  it('the witness test can only skip a bar the user row does not have', () => {
    // `clearsUserRow` compares three counts because a witness row carries no `cwd` data and so
    // cannot answer a confinement bar. If someone raises the user row's confinement, this fails and
    // forces that decision to be re-made instead of a bar being silently unchecked.
    expect(THRESHOLDS.user.confinement).toBe(0);
  });

  it('this machine never witnesses itself, under either of its own labels', () => {
    const mine = [aggregate('h-abc', row()), aggregate('my-laptop', row())];
    expect(witnessHostsFor(row().shape12, mine, ['h-abc', 'my-laptop'])).toEqual([]);
    // And the label pair is what the CLI would have published under, both ways round.
    expect(hostLabel('my-laptop.corp.example', KEY, true)).toBe('my-laptop');
    expect(hostLabel('my-laptop.corp.example', KEY, false)).toMatch(/^h-[0-9a-f]{12}$/);
  });

  it('a file whose host disagrees with its filename is refused and reported', () => {
    const root = corpus();
    const dir = path.dirname(aggregatePath(root, 'x'));
    fs.mkdirSync(dir, { recursive: true });
    // The forgery shape: a file named for one host, claiming to be another.
    fs.writeFileSync(path.join(dir, 'h-victim.json'),
      renderAggregate(aggregate('h-attacker', row())), 'utf8');
    const read = readAggregates(root);
    expect(read.aggregates).toEqual([]);
    expect(read.rejected).toEqual([
      { file: 'h-victim.json', why: 'declares host "h-attacker" but is named "h-victim"' },
    ]);
  });

  it('one file cannot be two witnesses, because the filename is the merge key', () => {
    const root = corpus();
    fs.mkdirSync(path.dirname(aggregatePath(root, 'x')), { recursive: true });
    fs.writeFileSync(aggregatePath(root, 'h-one'),
      renderAggregate(aggregate('h-one', row(), row())), 'utf8');
    const { aggregates } = readAggregates(root);
    expect(witnessHostsFor(row().shape12, aggregates, ['h-me'])).toEqual(['h-one']);
  });

  it('an unreadable, wrong-version or malformed file is reported rather than swallowed', () => {
    const root = corpus();
    const dir = path.dirname(aggregatePath(root, 'x'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'h-broken.json'), '{ not json', 'utf8');
    fs.writeFileSync(path.join(dir, 'h-old.json'),
      JSON.stringify({ version: 0, host: 'h-old', shapes: [] }), 'utf8');
    fs.writeFileSync(path.join(dir, 'h-rows.json'), JSON.stringify(
      { version: AGGREGATE_VERSION, host: 'h-rows', generatedAt: '', shapes: [{ shape12: 'nope' }] },
    ), 'utf8');
    const read = readAggregates(root);
    expect(read.rejected.map(r => r.file)).toEqual(['h-broken.json', 'h-old.json', 'h-rows.json']);
    expect(read.rejected[0].why).toBe('unreadable or not JSON');
    // The malformed row is dropped, and the host still counts for its remaining rows — which are
    // none, so it cannot witness anything.
    expect(witnessHostsFor(row().shape12, read.aggregates, ['h-me'])).toEqual([]);
  });

  it('a traversal in a filename is refused', () => {
    expect(isHostLabel('../../etc/passwd')).toBe(false);
    expect(isHostLabel('h-ab..cd')).toBe(false);
    expect(isHostLabel('h-abc123')).toBe(true);
  });
});

// --------------------------------------------------------------------------- property 4

describe('an aggregate carries counts, never inputs', () => {
  /** Every key at every depth of a payload. The assertion is over this, not over named fields. */
  const keysOf = (value: unknown, out: Set<string> = new Set()): Set<string> => {
    if (Array.isArray(value)) { for (const v of value) { keysOf(v, out); } return out; }
    if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
    }
    return out;
  };

  /** A local fold carrying every kind of thing that must not cross the boundary. */
  const sensitive = shapesWith(stat({
    segment: 'curl https://payments-internal.example/v2/customers/bigco',
    cwds: { '/Users/someone/work/acme-secret-migration': 9 },
    support: 9,
    sessions: ['s-1', 's-2', 's-3'],
    days: ['2026-08-20', '2026-08-21'],
  }));

  it('no excluded key appears anywhere in the payload, at any depth', () => {
    const built = buildAggregate(sensitive, 'h-abc', new Date('2026-09-04T10:00:00.000Z'));
    const keys = [...keysOf(built)];
    // The allow-list is the assertion: a field added to `ShapeStat` later is absent by default,
    // because the payload is built by naming what it keeps.
    for (const key of keys) { expect(AGGREGATE_FIELDS).toContain(key); }
    // And the observability export's own never-ship list, so the two cannot drift apart.
    //
    // `host` is the one entry that is deliberately not applied here, and the difference is the whole
    // reason this file exists: `export.ts` drops `host` because a decision record does not need it,
    // while a witness IS a host — one file per host is what makes "two developers" countable and
    // one commit auditable. So it is present, and pseudonymous by default (`hostLabel`).
    for (const banned of [...NEVER_SHIPPED.filter(k => k !== 'host'),
      'cwd', 'cwds', 'segment', 'tool', 'literal', 'variants', 'exemplars', 'signals', 'records',
      'firstSeen', 'lastSeen', 'evidence']) {
      expect(keys).not.toContain(banned);
    }
  });

  it('no value in the payload carries the command line, the cwd or the customer name', () => {
    const text = renderAggregate(
      buildAggregate(sensitive, 'h-abc', new Date('2026-09-04T10:00:00.000Z')));
    for (const secret of ['curl', 'payments-internal', 'bigco', 'customers', 'Users',
      'acme-secret-migration', 'someone']) {
      expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    // What it does carry: the verifiable hash of the shape, and three numbers.
    expect(text).toContain(shapeHash('Bash', 'curl https://payments-internal.example/v2/customers/bigco'));
  });

  it('the fingerprint is recomputable from a readable proposal, so a reviewer can check it', () => {
    const built = buildAggregate(shapesWith(stat()), 'h-abc', new Date());
    expect(built.shapes[0].shape12).toBe(shapeHash('Bash', 'pnpm test'));
  });

  it('only shapes that cleared the user row are published at all', () => {
    const built = buildAggregate(
      shapesWith(stat(), stat({ segment: 'git status', support: 1, sessions: ['s-1'], days: ['x'] })),
      'h-abc', new Date());
    expect(built.shapes.map(s => s.shape12)).toEqual([shapeHash('Bash', 'pnpm test')]);
  });

  it('a host label is a pseudonym by default and sanitised when raw', () => {
    expect(hostLabel('Devons-MacBook.corp.example', KEY, true)).toBe('devons-macbook');
    expect(hostLabel('Devons-MacBook.corp.example', KEY, false)).not.toContain('devons');
  });

  it('republishing unchanged counts is byte-identical, so the git diff is empty', () => {
    const a = renderAggregate(buildAggregate(shapesWith(stat()), 'h-abc',
      new Date('2026-09-04T10:00:00.000Z')));
    const b = renderAggregate(buildAggregate(shapesWith(stat()), 'h-abc',
      new Date('2026-09-04T10:00:00.000Z')));
    expect(a).toBe(b);
  });
});

// --------------------------------------------------------------------------- property 3

/**
 * The whole run, with a witness on disk. This is the one that matters most: a team clause binds
 * people who did not write it, so an aggregate file reaching all the way through the pipeline must
 * still produce something inert.
 */
describe('an aggregate cannot make a clause enforceable', () => {
  /** 14 allows over 8 sessions and 15 calendar days in one repo, one of them fail-closed first. */
  const WINDOW: DecisionRecord[] = (() => {
    const out: DecisionRecord[] = [];
    const base = (i: number, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
      ts: `2026-08-${String(10 + i).padStart(2, '0')}T09:0${i % 10}:00.000Z`,
      sessionId: `s-${i % 8}`,
      cwd: '/w/api',
      tool: 'Bash',
      inputSummary: 'pnpm verify',
      light: 'green',
      decision: 'allow',
      clause: null,
      actor: 'model',
      latencyMs: 2000,
      rewritten: false,
      rev: 'a91f3c2',
      call: { tool_name: 'Bash', input: { command: 'pnpm verify' } },
      ...over,
    });
    out.push(base(0, { decision: 'deny', light: null, actor: 'timeout', latencyMs: 8000 }));
    for (let i = 1; i <= 14; i += 1) { out.push(base(i)); }
    return out;
  })();

  function rig(witness: HostAggregate | null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-team-run-'));
    const root = corpus();
    const env = { SESSION_SITTER_DATA_DIR: dir } as NodeJS.ProcessEnv;
    fs.writeFileSync(path.join(dir, 'decisions.jsonl'),
      WINDOW.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    if (witness !== null) {
      fs.mkdirSync(path.dirname(aggregatePath(root, witness.host)), { recursive: true });
      fs.writeFileSync(aggregatePath(root, witness.host), renderAggregate(witness), 'utf8');
    }
    const settings = { user: 'devon', project: 'api', team: 'platform' } as unknown as PluginSettings;
    return { dir, root, env, settings };
  }

  const shape12 = shapeHash('Bash', 'pnpm verify');

  function go(witness: HostAggregate | null) {
    const r = rig(witness);
    const result = propose({
      settings: r.settings,
      corpusRoot: r.root,
      corpus: [],
      rev: 'a91f3c2',
      env: r.env,
      now: new Date('2026-09-04T18:00:00.000Z'),
      selfHosts: ['h-me', 'my-laptop'],
    });
    return { ...result, root: r.root };
  }

  it('a witness promotes the clause to team tier and it is still `status: proposed`', () => {
    const { line, written, root } = go(
      aggregate('h-other', row({ shape12, occurrences: 3, sessions: 3, days: 2 })));
    expect(line.aggregates).toEqual({ hosts: 1, rejected: [] });
    const team = line.proposals.clauses.filter(c => c.tier === 'team');
    expect(team).toHaveLength(1);
    expect(written[0]).toMatch(/^data\/knowledge\/teams\/platform\/learned\/.*\.md$/);

    const text = fs.readFileSync(path.join(root, written[0]), 'utf8');
    expect(text).toContain('status: proposed');
    // Not merely "contains proposed": the parsed status a loader would read, and the three
    // capability questions the ladder asks of it. An aggregate cannot move any of them.
    expect(statusOf(text)).toBe('proposed');
    expect(isEnforceable('proposed')).toBe(false);
    expect(rendersIntoPrompt('proposed')).toBe(false);
    expect(isMatched('proposed')).toBe(false);
    // And a reviewer can see where the second developer's evidence came from.
    expect(text).toContain('h-other');
    expect(text).toContain(shape12);
  });

  it('without the witness the identical evidence is a project clause, and says team was declined', () => {
    const { line, written } = go(null);
    expect(line.proposals.clauses.map(c => c.tier)).toEqual(['project']);
    expect(written[0]).toMatch(/^data\/knowledge\/projects\/api\//);
    expect(line.declinedPromotions).toEqual([
      { cluster: 'Bash|pnpm verify', to: 'team',
        why: 'no cross-user evidence in a single-machine corpus' },
    ]);
  });

  it('a witness below the user row leaves it a project clause and reports the shortfall', () => {
    const { line } = go(aggregate('h-other', row({ shape12, occurrences: 2, sessions: 1, days: 1 })));
    expect(line.proposals.clauses.map(c => c.tier)).toEqual(['project']);
    expect(line.aggregates.hosts).toBe(1);
    expect(line.declinedPromotions[0].why)
      .toBe('no cross-user evidence in a single-machine corpus');
  });

  it('a witness for a different shape does not witness this one', () => {
    const { line } = go(aggregate('h-other', row({ shape12: shapeHash('Bash', 'git status') })));
    expect(line.proposals.clauses.map(c => c.tier)).toEqual(['project']);
  });

  it('this machine\'s own published file cannot witness itself into team tier', () => {
    const { line } = go(aggregate('h-me', row({ shape12, occurrences: 40, sessions: 9, days: 20 })));
    expect(line.proposals.clauses.map(c => c.tier)).toEqual(['project']);
  });

  it('a run that cannot say who this machine is does not attempt team tier at all', () => {
    const r = rig(aggregate('h-other', row({ shape12, occurrences: 3, sessions: 3, days: 2 })));
    const { line } = propose({
      settings: r.settings, corpusRoot: r.root, corpus: [], rev: 'a91f3c2', env: r.env,
      now: new Date('2026-09-04T18:00:00.000Z'),
    });
    expect(line.proposals.clauses.map(c => c.tier)).toEqual(['project']);
    expect(line.aggregates).toEqual({ hosts: 0, rejected: [] });
  });
});

// --------------------------------------------------------------------------- the write boundary

describe('publishing writes one file, in one place, and runs no git', () => {
  it('writes data/aggregates/<host>.json and returns the corpus-relative path', () => {
    const root = corpus();
    const rel = publishAggregate(root, buildAggregate(shapesWith(stat()), 'h-abc', new Date()));
    expect(rel).toBe('data/aggregates/h-abc.json');
    expect(JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')).host).toBe('h-abc');
  });

  it('refuses a host label that would escape the aggregates directory', () => {
    const root = corpus();
    expect(() => publishAggregate(root, aggregate('../../knowledge/teams/x', row())))
      .toThrow(/unsafe host label/);
  });

  it('refuses to write outside the configured corpus root', () => {
    const root = corpus();
    const elsewhere = corpus();
    // A corpus root whose `data` is a symlink out of the tree is the escape this catches.
    fs.symlinkSync(elsewhere, path.join(root, 'data'));
    expect(() => publishAggregate(root, aggregate('h-abc', row())))
      .toThrow(/outside the configured corpus root/);
  });
});

// --------------------------------------------------------------------------- the CI guard

/**
 * `ci/check-aggregates.sh` runs in the *corpus* repo, so nothing in this repo's own CI would ever
 * execute it. It is exercised here against fixtures instead, or it rots — and a guard that has
 * rotted is the silence-that-reads-as-success shape, in its purest form.
 */
describe('ci/check-aggregates.sh', () => {
  const script = path.join(__dirname, '..', '..', '..', 'ci', 'check-aggregates.sh');
  const check = (root: string, base?: string): { code: number; out: string } => {
    const r = spawnSync('bash', [script, root, ...(base ? [base] : [])], { encoding: 'utf8' });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  };
  const write = (root: string, name: string, body: string): void => {
    fs.mkdirSync(path.join(root, 'data', 'aggregates'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'aggregates', name), body, 'utf8');
  };

  it('passes a corpus with one well-formed aggregate', () => {
    const root = corpus();
    write(root, 'h-abc.json', renderAggregate(aggregate('h-abc', row())));
    expect(check(root)).toEqual({ code: 0, out: 'aggregates: ok\n' });
  });

  it('fails when a file declares a host other than its own filename', () => {
    const root = corpus();
    write(root, 'h-victim.json', renderAggregate(aggregate('h-attacker', row())));
    const { code, out } = check(root);
    expect(code).toBe(1);
    expect(out).toContain("declares host 'h-attacker' but is named 'h-victim'");
  });

  it('fails when one commit range touches two hosts\' aggregates', () => {
    const root = corpus();
    const git = (...args: string[]): void => {
      const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
      if ((r.status ?? 1) !== 0) { throw new Error(`git ${args.join(' ')}: ${r.stderr}`); }
    };
    git('init', '-q');
    git('config', 'user.email', 'nobody@example.invalid');
    git('config', 'user.name', 'Fixture');
    write(root, 'h-one.json', renderAggregate(aggregate('h-one', row())));
    git('add', '-A');
    git('commit', '-qm', 'base');
    write(root, 'h-two.json', renderAggregate(aggregate('h-two', row())));
    write(root, 'h-three.json', renderAggregate(aggregate('h-three', row())));
    git('add', '-A');
    git('commit', '-qm', 'two at once');
    const { code, out } = check(root, 'HEAD~1');
    expect(code).toBe(1);
    expect(out).toContain('2 aggregate files changed in one range');
  });

  it('passes a range that touches one host\'s aggregate', () => {
    const root = corpus();
    const git = (...args: string[]): void => { spawnSync('git', ['-C', root, ...args]); };
    git('init', '-q');
    git('config', 'user.email', 'nobody@example.invalid');
    git('config', 'user.name', 'Fixture');
    write(root, 'h-one.json', renderAggregate(aggregate('h-one', row())));
    git('add', '-A');
    git('commit', '-qm', 'base');
    write(root, 'h-one.json', renderAggregate(aggregate('h-one', row(), row({ sessions: 5 }))));
    git('add', '-A');
    git('commit', '-qm', 'republish');
    expect(check(root, 'HEAD~1').code).toBe(0);
  });
});
