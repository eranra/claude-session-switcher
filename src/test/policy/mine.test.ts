/**
 * Stage A invariants — `11-mine-v2.md` §12.2, §12.5, §12.7, §12.8 and §12.10.
 *
 * The ones that carry weight here are the counting bars, because they are the whole difference
 * between a pipeline that proposes what somebody actually does and one that proposes what they did on
 * Tuesday. §12.7 (50 records in one session do not reach a 3-session bar) and §12.8 (5 records over 2
 * sessions on one calendar day do not clear the user bar) each fail if one line of `supportOf` goes.
 *
 * Every fixture is invented. No real path, no real project name.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { DecisionRecord } from '../../audit/trail';
import {
  DISTINCT_CAP,
  THRESHOLDS,
  canonicalSegment,
  clusterWindow,
  distanceFrom,
  emptyShapes,
  evidenceIds,
  fold,
  foldRecord,
  isGreenSupport,
  labelSignal,
  nudge,
  readNewBytes,
  readShapes,
  segmentsOf,
  shapeHash,
  shapesPath,
  signalOf,
  supportOf,
  supportOfStat,
  tierFor,
  writeShapes,
} from '../../policy/mine';

// --------------------------------------------------------------------------- fixtures

let seq = 0;

const record = (over: Partial<DecisionRecord> = {}): DecisionRecord => {
  seq += 1;
  const command = (over.call?.input?.command as string | undefined) ?? 'pnpm test';
  return {
    ts: '2026-08-25T09:00:00.000Z',
    sessionId: `s-${seq}`,
    cwd: '/w/api',
    tool: 'Bash',
    inputSummary: command,
    light: 'green',
    decision: 'allow',
    clause: null,
    actor: 'model',
    latencyMs: 2000,
    rewritten: false,
    rev: 'a91f3c2',
    call: { tool_name: 'Bash', input: { command } },
    ...over,
  };
};

const bash = (command: string, over: Partial<DecisionRecord> = {}): DecisionRecord =>
  record({ ...over, call: { tool_name: 'Bash', input: { command } }, inputSummary: command });

function scratch(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-mine-'));
  return { dir, env: { SESSION_SITTER_DATA_DIR: dir } as NodeJS.ProcessEnv };
}

function writeTrail(env: NodeJS.ProcessEnv, records: DecisionRecord[], suffix = ''): string {
  const file = path.join(env.SESSION_SITTER_DATA_DIR!, `decisions.jsonl${suffix}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

// --------------------------------------------------------------------------- normalisation

describe('the canonical segment', () => {
  it('is argv0 plus the subcommand, so a subcommand is its own rule', () => {
    expect(canonicalSegment('git status')).toBe('git status');
    expect(canonicalSegment('git push --force origin main')).toBe('git push');
    expect(canonicalSegment('pnpm test --filter core')).toBe('pnpm test');
    expect(canonicalSegment('PNPM Test')).toBe('pnpm test');
  });

  it('does not read a flag as a subcommand', () => {
    expect(canonicalSegment('rm -rf dist')).toBe('rm');
    expect(canonicalSegment('ls')).toBe('ls');
  });

  it('hashes then slices, so near-identical inputs do not collide', () => {
    const a = shapeHash('Bash', 'pnpm test');
    const b = shapeHash('Bash', 'pnpm build');
    expect(a).toHaveLength(12);
    expect(a).not.toBe(b);
    // Slicing the *input* is what would collide: the tuple prefix is near-identical across almost
    // every candidate, and this pair agrees on its first ten characters.
    expect('Bash\0pnpm test'.slice(0, 10)).toBe('Bash\0pnpm build'.slice(0, 10));
  });

  it('is stable across runs, which is what makes the id dateless', () => {
    expect(shapeHash('Bash', 'pnpm test')).toBe(shapeHash('Bash', 'pnpm test'));
  });
});

describe('segmentation (§4.1)', () => {
  it('splits a compound so each half is its own shape', () => {
    const { segments, confident } = segmentsOf(bash('git status && rm -rf /'));
    expect(confident).toBe(true);
    expect(segments).toEqual(['git status', 'rm -rf /']);
  });

  it('keeps an unparseable line as one segment rather than dropping it', () => {
    const { segments, confident } = segmentsOf(bash("echo 'unbalanced"));
    expect(confident).toBe(false);
    expect(segments).toHaveLength(1);
  });

  it('gives a non-shell tool one shape, the tool name', () => {
    const { segments } = segmentsOf(record({ tool: 'Write', call: null }));
    expect(segments).toEqual(['']);
  });
});

describe('the signal', () => {
  it('separates a fail-closed deny from a gap and from a repeat', () => {
    expect(signalOf(record({ actor: 'timeout', decision: 'deny', clause: null }))).toBe('timeout');
    expect(signalOf(record({ decision: 'none', clause: null, actor: 'deterministic' }))).toBe('gap');
    expect(signalOf(record({ actor: 'model' }))).toBe('model');
    expect(signalOf(record({ clause: 'practices §a' }))).toBe('repeat');
  });

  it('never reads a written clause as a gap, whatever the decision was', () => {
    expect(signalOf(record({ decision: 'none', clause: 'practices §a' }))).toBe('repeat');
  });

  it('labels a shape by its strongest signal', () => {
    expect(labelSignal({ model: 5, timeout: 1 })).toBe('timeout');
    expect(labelSignal({ model: 5 })).toBe('model');
    expect(labelSignal({})).toBe('repeat');
  });

  it('reads a correction-lane record as a repeat, at both of its outcomes', () => {
    // Both `actor: 'correction'` returns cite a clause, so neither is ever a gap. Pinned because the
    // actor arrived in the record after this module did, and an unrecognised actor falling through to
    // the gap lane would mine a permission out of a denial.
    expect(signalOf(record({
      actor: 'correction', decision: 'allow', light: 'yellow', rewritten: true,
      clause: 'built-in §force-push-to-lease',
    }))).toBe('repeat');
    expect(signalOf(record({
      actor: 'correction', decision: 'deny', light: 'red', clause: 'practices §team-git-002',
    }))).toBe('repeat');
  });
});

// --------------------------------------------------------------------------- E3b and the rewrite lane

describe('E3b — what earns a green support event', () => {
  const corrected = (command: string, over: Partial<DecisionRecord> = {}) =>
    bash(command, {
      decision: 'allow', light: 'yellow', actor: 'correction', rewritten: true,
      clause: 'built-in §force-push-to-lease', ...over,
    });

  it('a corrected allow earns none — it was allowed as a different command', () => {
    // The hook records `input.tool_input` (the call *as asked*) while `decision.updatedInput` carries
    // the rewrite that was actually approved. So this record says `--force` was allowed when what ran
    // was `--force-with-lease`, and counting it would mine a green for the form the lane refused.
    expect(isGreenSupport(corrected('git push --force origin main'))).toBe(false);
    const cluster = clusterWindow([
      corrected('git push --force origin main', { sessionId: 's-a', ts: '2026-08-25T09:00:00.000Z' }),
      corrected('git push --force origin dev', { sessionId: 's-b', ts: '2026-08-27T09:00:00.000Z' }),
      corrected('git push --force origin x', { sessionId: 's-c', ts: '2026-09-01T09:00:00.000Z' }),
    ])[0];
    expect(cluster.all).toHaveLength(3);
    expect(cluster.support).toHaveLength(0);
    expect(cluster.segments).toEqual([]);
    // Three sessions across three days, and it still clears no bar, because the bars measure support.
    expect(distanceFrom('user', supportOf(cluster)).clears).toBe(false);
    expect(tierFor(supportOf(cluster), false).tier).toBeNull();
  });

  it('the persisted fold agrees with the live cluster about it', () => {
    const shapes = emptyShapes();
    foldRecord(shapes.shapes, corrected('git push --force origin main'));
    const stat = Object.values(shapes.shapes)[0];
    expect(stat.records).toBe(1);
    expect(stat.support).toBe(0);
  });

  it('an ordinary allow still earns one', () => {
    expect(isGreenSupport(bash('pnpm test'))).toBe(true);
    expect(isGreenSupport(bash('pnpm test', { decision: 'deny' }))).toBe(false);
    expect(isGreenSupport(bash('pnpm test', { decision: 'none' }))).toBe(false);
  });

  it('earns nothing in the GAP lane either — neither lane will take a corrected call', () => {
    // The green half above was proved before the gap lane existed. `clusterWindow` now selects a lane,
    // so the same record has a second support set that could have taken it, and the answer has to be
    // checked rather than inherited: a corrected call is `decision: 'allow'`, and the gap lane's
    // support is `decision === 'none'`, so it is excluded by the field the lane keys on.
    const records = [
      corrected('git push --force origin main', { sessionId: 's-a', ts: '2026-08-25T09:00:00.000Z' }),
      corrected('git push --force origin dev', { sessionId: 's-b', ts: '2026-08-27T09:00:00.000Z' }),
      corrected('git push --force origin x', { sessionId: 's-c', ts: '2026-09-01T09:00:00.000Z' }),
    ];
    for (const lane of ['green', 'gap'] as const) {
      const cluster = clusterWindow(records, lane)[0];
      expect(cluster.all, lane).toHaveLength(3);
      expect(cluster.support, lane).toHaveLength(0);
      expect(cluster.segments, lane).toEqual([]);
      expect(tierFor(supportOf(cluster), false).tier, lane).toBeNull();
    }
    // And the reverse: the gap lane does take an uncorrected `none`, so the assertion above is about
    // `rewritten` and the `allow`, not about the lane being empty for everything.
    const gap = bash('pnpm lint', { decision: 'none', light: null, actor: 'timeout' });
    expect(clusterWindow([gap], 'gap')[0].support).toHaveLength(1);
    expect(clusterWindow([gap], 'green')[0].support).toHaveLength(0);
  });

  it('a corrected call cannot be a gap record at all, which is why no guard is needed', () => {
    // `rewritten` is `verdict.decision.updatedInput !== undefined`, `updatedInput` is set only by the
    // correction branch, and that branch returns `behavior: 'allow'` — so `rewritten` with
    // `decision: 'none'` is unreachable through the hook. Pinned as the *reason* the gap lane carries
    // no `!rewritten` check: if this ever becomes constructible, that omission becomes a hole.
    // Constructed by hand here precisely because the hook cannot produce it.
    const impossible = bash('git push --force origin main', {
      decision: 'none', rewritten: true, actor: 'correction',
    });
    expect(isGreenSupport(impossible)).toBe(false);
    // Were it ever recorded, the clause mined from it is still a fix-less narrowing: a matcher for the
    // call as asked and no rewrite, because `gate` never emits a `fix`. So there is nothing to license.
    expect(clusterWindow([impossible], 'gap')[0].support).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------- §12.5 compound safety

describe('compound safety (§12.5), against the literal string', () => {
  const COMPOUND = 'git status && rm -rf /';

  it('gives neither segment a green support event when the record was denied', () => {
    const clusters = clusterWindow([
      bash(COMPOUND, { decision: 'deny', light: 'red', clause: 'practices §team-fs-004' }),
    ]);
    expect(clusters.map(c => c.segment).sort()).toEqual(['git status', 'rm']);
    for (const cluster of clusters) {
      expect(cluster.support).toHaveLength(0);
    }
  });

  it('puts the rm in its own cluster, so no git-status clause can ever cover it', () => {
    const clusters = clusterWindow([
      bash(COMPOUND, { decision: 'allow' }),
      bash('git status', { decision: 'allow' }),
    ]);
    const gitStatus = clusters.find(c => c.segment === 'git status')!;
    const rm = clusters.find(c => c.segment === 'rm')!;
    // The `git status` cluster's evidence is the git-status segments and nothing else. The `rm` is
    // not in it — not filtered out of it, never in it.
    expect(gitStatus.segments.every(s => s.startsWith('git status'))).toBe(true);
    expect(rm.segments).toEqual(['rm -rf /']);
  });
});

describe('E3a — an unconfident split refuses the whole cluster (§12.6)', () => {
  it('marks the cluster, not just the record', () => {
    const clusters = clusterWindow([
      bash('npm test'),
      bash('npm test'),
      bash("npm test 'unbalanced"),
    ]);
    const cluster = clusters.find(c => c.unconfident);
    expect(cluster).toBeDefined();
    // Two perfectly good records are in the same cluster, and the flag refuses all of it.
    expect(cluster!.support.length).toBeGreaterThan(1);
  });
});

// --------------------------------------------------------------------------- the bars

describe('the promotion bars (§5)', () => {
  it('50 records in one session do not reach the 3-session bar (§12.7)', () => {
    const many = Array.from({ length: 50 }, () =>
      bash('pnpm test', { sessionId: 's-one', ts: '2026-08-25T09:00:00.000Z' }));
    const cluster = clusterWindow(many)[0];
    const support = supportOf(cluster);
    expect(support.occurrences).toBe(50);
    expect(support.sessions).toBe(1);
    expect(distanceFrom('user', support).clears).toBe(false);
    expect(tierFor(support, false).tier).toBeNull();
  });

  it('5 records over 2 sessions on one calendar day do not clear the user bar (§12.8)', () => {
    const churn = [
      bash('pnpm test', { sessionId: 's-a', ts: '2026-08-25T09:00:00.000Z' }),
      bash('pnpm test', { sessionId: 's-a', ts: '2026-08-25T10:00:00.000Z' }),
      bash('pnpm test', { sessionId: 's-a', ts: '2026-08-25T11:00:00.000Z' }),
      bash('pnpm test', { sessionId: 's-b', ts: '2026-08-25T14:00:00.000Z' }),
      bash('pnpm test', { sessionId: 's-b', ts: '2026-08-25T15:00:00.000Z' }),
    ];
    const support = supportOf(clusterWindow(churn)[0]);
    expect(support.sessions).toBe(2);
    expect(support.days).toBe(1);
    expect(distanceFrom('user', support).clears).toBe(false);
  });

  it('clears the user bar on 3 sessions across 2 days', () => {
    const good = [
      bash('pnpm test', { sessionId: 's-a', ts: '2026-08-25T09:00:00.000Z' }),
      bash('pnpm test --filter core', { sessionId: 's-b', ts: '2026-08-27T09:00:00.000Z' }),
      bash('pnpm test --watch', { sessionId: 's-c', ts: '2026-09-01T09:00:00.000Z' }),
    ];
    const support = supportOf(clusterWindow(good)[0]);
    expect(distanceFrom('user', support).clears).toBe(true);
    expect(tierFor(support, false).tier).toBe('user');
  });

  it('never proposes team from one machine, and records why instead (§5.3, §12.9)', () => {
    // Support clearing every team bar, on one machine. There is no `user` field on a
    // `DecisionRecord`, so "two developers agreed" is not a measurable proposition at any threshold
    // from a single laptop — only a published aggregate from another host can make it one, and this
    // call passes none. See `aggregates.test.ts` for the case where one exists.
    const heavy = Array.from({ length: 20 }, (_, i) =>
      bash('pnpm test', {
        sessionId: `s-${i % 10}`,
        ts: `2026-08-${String((i % 20) + 5).padStart(2, '0')}T09:00:00.000Z`,
      }));
    const support = supportOf(clusterWindow(heavy)[0]);
    expect(distanceFrom('team', support).clears).toBe(true);
    const chosen = tierFor(support, true);
    expect(chosen.tier).toBe('project');
    expect(chosen.declinedTeam).toBe('no cross-user evidence in a single-machine corpus');
  });

  it('demotes to user rather than dropping when the project bars are missed (§5.2)', () => {
    const support = {
      occurrences: 7, sessions: 4, days: 3, confinement: 1, cwd: '/w/api',
    };
    expect(distanceFrom('project', support).clears).toBe(false);
    expect(tierFor(support, true).tier).toBe('user');
  });

  it('sends a cwd-straddling pattern to user, not project', () => {
    const straddle = [
      ...Array.from({ length: 5 }, (_, i) => bash('pnpm test', {
        sessionId: `s-${i}`, cwd: '/w/api', ts: `2026-08-0${i + 1}T09:00:00.000Z`,
      })),
      ...Array.from({ length: 5 }, (_, i) => bash('pnpm test', {
        sessionId: `s-x${i}`, cwd: '/w/web', ts: `2026-08-1${i}T09:00:00.000Z`,
      })),
    ];
    const support = supportOf(clusterWindow(straddle)[0]);
    expect(support.confinement).toBeLessThan(THRESHOLDS.project.confinement);
    expect(tierFor(support, true).tier).toBe('user');
  });

  it('tolerates one stray record from another repo (90%, not 100%)', () => {
    const support = { occurrences: 10, sessions: 6, days: 8, confinement: 0.9, cwd: '/w/api' };
    expect(tierFor(support, true).tier).toBe('project');
  });
});

// --------------------------------------------------------------------------- §12.2 atomic fold

describe('the fold (§7.1, §12.2)', () => {
  it('advances the offset only past complete lines', () => {
    const { env } = scratch();
    const file = writeTrail(env, [bash('pnpm test')]);
    fs.appendFileSync(file, '{"ts":"2026-09-01T00:00', 'utf8');   // a torn write
    const first = readNewBytes(file, undefined)!;
    expect(first.lines).toHaveLength(1);
    // The offset stops at the last newline, so the partial record is folded next time — whole.
    expect(first.offset).toBeLessThan(first.size);
  });

  it('folds nothing twice: a second fold over unchanged bytes is a no-op', () => {
    const { env } = scratch();
    writeTrail(env, [bash('pnpm test'), bash('pnpm test')]);
    const first = fold(env);
    expect(first.folded).toBe(2);
    writeShapes(first.shapes, env);
    const second = fold(env);
    expect(second.folded).toBe(0);
    const shape = Object.values(second.shapes.shapes)[0];
    expect(shape.records).toBe(2);
  });

  it('commits the offset and the counts together, or neither', () => {
    const { env } = scratch();
    writeTrail(env, [bash('pnpm test')]);
    const result = fold(env);
    writeShapes(result.shapes, env);
    const onDisk = readShapes(env);
    // One file, one rename: the offset that was committed is the offset the counts were taken over.
    expect(onDisk.sources['decisions.jsonl'].offset).toBe(
      result.shapes.sources['decisions.jsonl'].offset);
    expect(Object.values(onDisk.shapes)[0].records).toBe(1);
  });

  it('re-reads whole when the stored offset outlived its file', () => {
    const { env } = scratch();
    writeTrail(env, [bash('pnpm test'), bash('pnpm test'), bash('pnpm test')]);
    const first = fold(env);
    writeShapes(first.shapes, env);
    // Rotation: the same path, entirely different bytes, and a size that happens to be larger.
    writeTrail(env, Array.from({ length: 6 }, () => bash('npm run build')));
    const second = fold(env);
    expect(second.reread).toContain('decisions.jsonl');
    expect(Object.keys(second.shapes.shapes)).toEqual(['Bash|npm run']);
    expect(second.shapes.shapes['Bash|npm run'].records).toBe(6);
  });

  it('never observes a half-written shapes.json', () => {
    const { env, dir } = scratch();
    const shapes = emptyShapes();
    foldRecord(shapes.shapes, bash('pnpm test'));
    writeShapes(shapes, env);
    expect(fs.readdirSync(path.join(dir, 'pipeline')).filter(n => n.includes('tmp'))).toEqual([]);
    expect(() => JSON.parse(fs.readFileSync(shapesPath(env), 'utf8'))).not.toThrow();
  });

  it('discards an aggregate from a different version rather than migrating it', () => {
    const { env } = scratch();
    fs.mkdirSync(path.dirname(shapesPath(env)), { recursive: true });
    fs.writeFileSync(shapesPath(env), JSON.stringify({ version: 99, shapes: { x: {} } }), 'utf8');
    expect(readShapes(env).shapes).toEqual({});
  });

  it('bounds the distinct sets it tracks', () => {
    const shapes = emptyShapes();
    for (let i = 0; i < DISTINCT_CAP + 10; i++) {
      foldRecord(shapes.shapes, bash('pnpm test', { sessionId: `s-${i}` }));
    }
    const stat = shapes.shapes['Bash|pnpm test'];
    expect(stat.sessions).toHaveLength(DISTINCT_CAP);
    expect(stat.records).toBe(DISTINCT_CAP + 10);       // the sum stays exact
  });

  it('folds the rotated generation as well as the live one', () => {
    const { env } = scratch();
    writeTrail(env, [bash('pnpm test')], '.1');
    writeTrail(env, [bash('pnpm test')]);
    const result = fold(env);
    expect(result.files).toEqual(['decisions.jsonl.1', 'decisions.jsonl']);
    expect(result.folded).toBe(2);
  });

  it('counts a persisted shape the same way a live cluster counts it', () => {
    const records = [
      bash('pnpm test', { sessionId: 's-a', ts: '2026-08-25T09:00:00.000Z' }),
      bash('pnpm test', { sessionId: 's-b', ts: '2026-08-27T09:00:00.000Z' }),
      bash('pnpm test', { sessionId: 's-c', ts: '2026-09-01T09:00:00.000Z' }),
    ];
    const shapes = emptyShapes();
    for (const r of records) { foldRecord(shapes.shapes, r); }
    const folded = supportOfStat(shapes.shapes['Bash|pnpm test']);
    const live = supportOf(clusterWindow(records)[0]);
    expect(folded).toEqual(live);
  });
});

describe('the nudge (§6)', () => {
  it('says nothing when nothing crossed', () => {
    expect(nudge([])).toBeNull();
  });

  it('names what crossed and what to run', () => {
    const line = nudge([{ signal: 'timeout' }, { signal: 'gap' }, { signal: 'gap' }])!;
    expect(line).toContain('3 shapes crossed the support floor');
    expect(line).toContain('1 fail-closed');
    expect(line).toContain('2 gap');
    expect(line).toContain('session-sitter learn');
  });
});

describe('evidence ids', () => {
  it('are oldest-first and capped, so the clause file stays readable', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      bash('pnpm test', { ts: `2026-08-${String(i + 1).padStart(2, '0')}T09:00:00.000Z` }));
    const ids = evidenceIds(clusterWindow(many)[0]);
    expect(ids).toHaveLength(12);
    expect(ids[0]).toContain('2026-08-01');
  });
});
