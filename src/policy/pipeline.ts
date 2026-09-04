/**
 * The run, and the artifact for the run that produced nothing.
 *
 * ## Why `pipeline.jsonl` exists at all
 *
 * A fail-closed run that correctly produced nothing leaves no proposal, no commit and no trace — and
 * is therefore indistinguishable from a run that never happened, from a crashed run, and from a hook
 * that has been silently broken for three weeks. So one JSON line is written **always**: last thing
 * every run does, on success, on emptiness and on failure. Every key is present and every array is
 * `[]` rather than absent, so a reader never has to distinguish "no retirements" from "this version
 * did not report retirements".
 *
 * `exitReason` is a closed enum and **a zero is never unexplained**. `calibration-failed` and `error`
 * mean *the pipeline is broken*; every other value means *the pipeline had nothing to say*. Telling
 * those two apart from the outside is precisely what this file is for. `no-input` is kept apart from
 * the rest because "you have never run a supervised session" and "18k records, nothing above the
 * bar" demand different next actions from a human.
 *
 * ## Fail closed
 *
 * A half-finished run produces no policy change, and not by transaction — by the merged status
 * semantics. Every write is `status: proposed`, `isEnforceable` is `accepted` and nothing else, so
 * there is no state in which a partial run has changed policy and nothing to roll back. The lock,
 * the atomic fold and the deterministic ids are about *not duplicating work*, not about safety.
 *
 * Spec: `11-mine-v2.md` §6.1 (concurrency), §7 (resumability), §9 (the run line).
 */

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DecisionRecord, appendJsonl, readJsonl } from '../audit/trail';
import { EXEMPT_TOOLS } from '../hooks/permissionRequest';
import { dataDir, decisionsPath } from '../hooks/paths';
import { PluginSettings } from '../hooks/settings';
import { STALE_LOCK_MS } from '../supervisor/store';
import { AblationReport } from './ablate';
import { HostAggregate, readAggregates, witnessHostsFor } from './aggregates';
import { foldCitations, writeCitations } from './citations';
import {
  BarDistance, Cluster, FoldResult, Lane, Signal, clusterWindow, fold, nudge, pipelineDir,
  supportOf, tierFor, writeShapes,
} from './mine';
import {
  Candidate, EMISSION_RULE, MAX_ADDITIONS, MergeFinding, Refusal, RefusalReason, RetirementPlan,
  findSubsumptions, gate, planRetirements, renderClause, writeClause,
} from './propose';
import { CEILING_PER_TIER } from './ablate';
import {
  ReplayDiff, autoReject, calibrate, candidateClause, replayWindow, verdictSourceOf,
} from './replay';
import { Clause } from './practices';

// --------------------------------------------------------------------------- the run line

export type Stage = 'accumulate' | 'propose';
export type Trigger = 'session-end' | 'cli' | 'launchd';

/** Closed enum. A zero is never unexplained. */
export type ExitReason =
  | 'ok'
  | 'no-new-records'
  | 'no-shape-cleared-floor'
  | 'all-candidates-failed-replay'
  | 'calibration-failed'
  | 'all-candidates-suppressed'
  | 'ceiling-held'
  | 'lock-held'
  | 'caps-hit'
  | 'no-input'
  | 'error';

export interface RunLine {
  v: 1;
  ts: string;
  runId: string;
  stage: Stage;
  trigger: Trigger;
  rev: string | null;
  emissionRule: number;
  corpusRoot: string;
  window: {
    files: string[];
    scanned: number;
    new: number;
    firstTs: string | null;
    lastTs: string | null;
    spanDays: number;
    rotated: boolean;
    unstamped: number;
    noCall: number;
    mixedRev: number;
    exempt: number;
  };
  signals: Record<Signal | 'allow', number>;
  shapes: { total: number; new: number; crossedFloor: number };
  clusters: { total: number; belowFloor: number; contradicted: number };
  candidates: {
    considered: number; proposed: number; overwritten: number;
    merged: number; retired: number; held: number;
  };
  suppressed: {
    statusGuard: number; alreadyInClaudeMd: number; failedReplay: number; proseOnly: number;
  };
  refusals: Refusal[];
  replay: {
    n: number; changed: number; reversals: number; human_reversals: number; advisory: number;
    unreplayable: number; calibrated: boolean;
  };
  ceiling: { tier: string; rendered: number; ceiling: number; outcome: string }[];
  /**
   * The cross-machine witnesses this run could see. `hosts` counts validated aggregate files;
   * `rejected` names every file that was refused and why — a `host` field disagreeing with its own
   * filename is what a forged or mis-copied aggregate looks like, and it must not be silent.
   */
  aggregates: { hosts: number; rejected: { file: string; why: string }[] };
  declinedPromotions: { cluster: string; to: string; why: string }[];
  proposals: {
    clauses: {
      id: string; tier: string; scope: string; level: string; signal: string; support: number;
    }[];
    merges: MergeFinding[];
    retirements: RetirementPlan['retirements'];
    redundancies: RetirementPlan['redundancies'];
    listings: RetirementPlan['listings'];
  };
  /** Asserted zero on the default path. There is no code path in this module that raises it. */
  model: { calls: number };
  durationMs: number;
  exitReason: ExitReason;
  error: string | null;
  /** Every below-floor shape's distance from every bar, so a climbing shape is visible early. */
  belowFloor: { cluster: string; distances: BarDistance[] }[];
  /** The line a human reads. Not part of the funnel; kept so `--status` needs no re-derivation. */
  headline: string;
}

export function pipelinePath(env?: NodeJS.ProcessEnv): string {
  return path.join(dataDir(env), 'pipeline.jsonl');
}

/** `20260903T184107-2f9c` — sortable, and unique enough for a per-run working directory. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

/** Append the run line. Bounded by `trail.ts`'s own rotation — 4 MiB, one generation, no new machinery. */
export function appendRunLine(line: RunLine, env?: NodeJS.ProcessEnv): void {
  appendJsonl(pipelinePath(env), line);
}

function emptyLine(stage: Stage, trigger: Trigger, now: Date): RunLine {
  return {
    v: 1,
    ts: now.toISOString(),
    runId: newRunId(now),
    stage,
    trigger,
    rev: null,
    emissionRule: EMISSION_RULE,
    corpusRoot: '',
    window: {
      files: [], scanned: 0, new: 0, firstTs: null, lastTs: null, spanDays: 0,
      rotated: false, unstamped: 0, noCall: 0, mixedRev: 0, exempt: 0,
    },
    signals: { timeout: 0, gap: 0, model: 0, repeat: 0, allow: 0 },
    shapes: { total: 0, new: 0, crossedFloor: 0 },
    clusters: { total: 0, belowFloor: 0, contradicted: 0 },
    candidates: { considered: 0, proposed: 0, overwritten: 0, merged: 0, retired: 0, held: 0 },
    suppressed: { statusGuard: 0, alreadyInClaudeMd: 0, failedReplay: 0, proseOnly: 0 },
    refusals: [],
    replay: {
      n: 0, changed: 0, reversals: 0, human_reversals: 0, advisory: 0, unreplayable: 0,
      calibrated: true,
    },
    ceiling: [],
    aggregates: { hosts: 0, rejected: [] },
    declinedPromotions: [],
    proposals: { clauses: [], merges: [], retirements: [], redundancies: [], listings: [] },
    model: { calls: 0 },
    durationMs: 0,
    exitReason: 'ok',
    error: null,
    belowFloor: [],
    headline: '',
  };
}

// --------------------------------------------------------------------------- the lock (§6.1)

/**
 * One lock for the whole pipeline, taken as an atomic `mkdir`.
 *
 * `mkdirSync` on an existing directory fails with `EEXIST` on every platform this runs on, which is
 * the check-and-create in one syscall that a lock needs. A pid file inside it makes a dead owner's
 * lock recoverable, reusing `store.ts`'s `STALE_LOCK_MS` rather than inventing a second staleness
 * number.
 *
 * ponytail: one global lock, not one per verb. Upgrade path if a second verb ever needs to run
 * concurrently with `learn`: two reserved ids, same mechanism.
 */
export const LOCK_ID = 'pipeline';

function lockDir(env?: NodeJS.ProcessEnv): string {
  return path.join(pipelineDir(env), `${LOCK_ID}.lock`);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) { return false; }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';   // exists, another user
  }
}

export function acquireLock(env?: NodeJS.ProcessEnv): (() => void) | null {
  const dir = lockDir(env);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const owner = path.join(dir, 'owner');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      return () => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') { throw err; }
    }
    // Held. Take it over only when the owner is demonstrably gone, or the lock is older than the
    // staleness window — the property that made `flock` the right choice, without the syscall.
    let stale = true;
    try {
      const held = JSON.parse(fs.readFileSync(owner, 'utf8')) as { pid: number; at: number };
      stale = !pidAlive(held.pid) || Date.now() - held.at > STALE_LOCK_MS;
    } catch {
      // No owner file: a crash between mkdir and write. Treat it as stale.
    }
    if (!stale) { return null; }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { return null; }
  }
  return null;
}

// --------------------------------------------------------------------------- Stage A

export interface AccumulateResult {
  line: RunLine;
  /** The one line to print, or null when nothing crossed a bar. */
  nudge: string | null;
  fold: FoldResult | null;
}

/**
 * Stage A: fold everything after the committed offset.
 *
 * Takes the lock and, if it is held, **exits 0 immediately and silently** — the other holder is
 * folding the same append-only file and will pick up these bytes too. Three sessions ending at once
 * means one fold and two no-ops, which is the correct behaviour rather than a degradation.
 */
export function accumulate(
  trigger: Trigger = 'session-end', env?: NodeJS.ProcessEnv, now: Date = new Date(),
): AccumulateResult {
  const started = Date.now();
  const line = emptyLine('accumulate', trigger, now);
  const release = acquireLock(env);
  if (release === null) {
    line.exitReason = 'lock-held';
    line.durationMs = Date.now() - started;
    line.headline = 'another fold holds the lock; these bytes will be folded by it';
    appendRunLine(line, env);
    return { line, nudge: null, fold: null };
  }
  try {
    const result = fold(env, now);
    const { shapes } = result;
    line.window.files = result.files;
    line.window.new = result.folded;
    line.window.scanned = shapes.counters.folded;
    line.window.rotated = result.files.includes('decisions.jsonl.1');
    line.shapes = {
      total: Object.keys(shapes.shapes).length,
      new: result.newShapes,
      crossedFloor: result.crossedFloor.length,
    };
    for (const stat of Object.values(shapes.shapes)) {
      for (const [signal, count] of Object.entries(stat.signals)) {
        line.signals[signal as Signal] = (line.signals[signal as Signal] ?? 0) + count;
      }
      line.signals.allow += stat.support;
      line.window.noCall += stat.noCall;
    }
    // Written whenever the fold ran, not only when it counted something: the offset may have moved
    // past a rotation with no new records behind it, and losing that would re-read the file forever.
    writeShapes(result.shapes, env);
    // The durable citation counter, folded in the same pass and under the same lock. Its own file and
    // its own offsets, because `shapes.json` is rebuildable derived data and a lifetime count is not
    // — see `citations.ts`. Written whenever the fold ran, for the same reason `shapes.json` is.
    const cited = foldCitations(env, now);
    writeCitations(cited.citations, env);
    line.exitReason = result.folded === 0 ? 'no-new-records' : 'ok';
    line.durationMs = Date.now() - started;
    const nudged = nudge(result.crossedFloor);
    line.headline = nudged
      ?? `folded ${result.folded} record(s); nothing crossed the support floor`;
    appendRunLine(line, env);
    return { line, nudge: nudged, fold: result };
  } catch (err) {
    line.exitReason = 'error';
    line.error = `accumulate: ${err instanceof Error ? err.message : String(err)}`;
    line.durationMs = Date.now() - started;
    line.headline = line.error;
    appendRunLine(line, env);
    return { line, nudge: null, fold: null };
  } finally {
    release();
  }
}

// --------------------------------------------------------------------------- Stage B

export interface ProposeOptions {
  settings: PluginSettings;
  corpusRoot: string;
  /** Only `accepted` clauses — the set the deterministic ladder actually consults. */
  corpus: Clause[];
  rev: string | null;
  trigger?: Trigger;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Ablation reports, when retirement is being proposed this run. */
  ablations?: readonly AblationReport[];
  /**
   * False when `--no-retire` asked for no retirement at all. It gates the *static* subsumption pass
   * as well as ablation, because a subsumption finding is a retirement proposal — cheap to compute
   * and still a retirement, so the flag would otherwise mean two different things.
   */
  retire?: boolean;
  /** `CLAUDE.md` + `.claude/rules/**`, concatenated. Absent means the dedupe cannot run. */
  instructionText?: string;
  /** Skip the writes. `learn --dry-run`. */
  dryRun?: boolean;
  /**
   * Every label this machine could have published under (`aggregates.ts`'s `hostLabel`, pseudonym and
   * raw). Supplied by the caller, because the pseudonym needs the per-machine export key and this
   * module has no business holding one.
   *
   * **Absent means no team tier is attempted at all.** A run that cannot say who it is cannot tell
   * this machine's own published aggregate apart from another developer's, and mistaking one for the
   * other is precisely the failure the per-host rule exists to prevent. Fail closed: the shape is
   * still proposed at project or user tier, and the run line says team was declined and why.
   */
  selfHosts?: readonly string[];
}

export interface ProposeResult {
  line: RunLine;
  written: string[];
  exitCode: number;
}

/**
 * Stage B: cluster the window, gate, replay, write.
 *
 * `calibrate()` runs **first and once**. If it fails, every other number in the run is meaningless,
 * so nothing is proposed and the line says `calibration-failed`. Running it once rather than once per
 * candidate is the only deviation from `replayCandidate`'s all-in-one shape, and it is worth it: the
 * calibration is a statement about the *window*, not about a candidate.
 */
export function propose(opts: ProposeOptions): ProposeResult {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const env = opts.env;
  const line = emptyLine('propose', opts.trigger ?? 'cli', now);
  line.rev = opts.rev;
  line.corpusRoot = opts.corpusRoot;
  const written: string[] = [];

  const release = acquireLock(env);
  if (release === null) {
    line.exitReason = 'lock-held';
    line.durationMs = Date.now() - started;
    line.headline = 'another `learn` is running — nothing was proposed';
    appendRunLine(line, env);
    return { line, written, exitCode: 2 };
  }

  try {
    const records = readJsonl<DecisionRecord>(decisionsPath(env));
    describeWindow(line, records, env);
    if (records.length === 0) {
      return finish(line, written, 'no-input', started, release, env,
        'no decisions on disk — nothing has been supervised yet');
    }

    const calibration = calibrate(records, opts.corpus, { window: records.length });
    line.replay.calibrated = calibration.ok;
    if (!calibration.ok) {
      line.error = calibration.message;
      return finish(line, written, 'calibration-failed', started, release, env,
        'calibration failed — no number in this run can be trusted, so nothing was proposed');
    }

    const usable = records.filter(r => !EXEMPT_TOOLS.has(r.tool));
    const clusters = clusterWindow(usable);
    line.clusters.total = clusters.length;
    line.clusters.contradicted = clusters.filter(c => c.contradictedBy !== null).length;

    // Two lanes, two support sets, one clustering pass each (§4.7). The shapes are identical — every
    // record lands in every shape it touches either way — so `clusters.total` is the same number for
    // both and is not double-counted; what differs is which records count as *evidence*.
    // The published witnesses, read once for the whole run. A refused file is *reported*, not
    // swallowed: a witness that silently stopped counting and a witness that was never there are
    // otherwise the same observation, and a `host` field that disagrees with its filename is the
    // shape a forged or mis-copied aggregate takes.
    const aggregates = opts.selfHosts === undefined
      ? { aggregates: [], rejected: [] }
      : readAggregates(opts.corpusRoot);
    line.aggregates = { hosts: aggregates.aggregates.length, rejected: aggregates.rejected };

    const greenLane = collectCandidates(clusters, line, opts, 'green', aggregates.aggregates);
    // A green already says "this is allowed"; a yellow on the same shape would say "ask about it"
    // in the same run, which is a corpus contradicting itself in one commit. The green wins: it is
    // the lane with the stronger evidence bar (an `allow` on every supporting record).
    const claimed = new Set(greenLane.map(c => c.cluster));
    const gapLane = collectCandidates(
      clusterWindow(usable, 'gap').filter(c => !claimed.has(c.key)), line, opts, 'gap',
      aggregates.aggregates);
    const candidates = [...greenLane, ...gapLane];
    line.candidates.considered = candidates.length;

    const admitted = validate(candidates, records, opts.corpus, line);
    const capped = admitted.slice(0, MAX_ADDITIONS);
    line.candidates.held = admitted.length - capped.length;

    const today = now.toISOString().slice(0, 10);
    for (const candidate of capped) {
      const body = renderClause(candidate, today);
      if (opts.dryRun) {
        line.proposals.clauses.push(summarise(candidate));
        line.candidates.proposed += 1;
        continue;
      }
      const { outcome, file } = writeClause(opts.corpusRoot, candidate, body);
      if (outcome === 'status-guard') {
        line.suppressed.statusGuard += 1;
        continue;
      }
      written.push(file);
      line.proposals.clauses.push(summarise(candidate));
      if (outcome === 'overwritten') { line.candidates.overwritten += 1; } else {
        line.candidates.proposed += 1;
      }
    }

    // §8.1 — the ~25-rendered-clause ceiling does not bind this pipeline, and the reason is a
    // dependency on another module rather than an invariant of the schema. `renderedCount` counts only
    // clauses with no patterns, and gate E9 means every mined clause has one, so the answer is always
    // `admit`. Reported anyway, because the day someone simplifies the selector into an unfiltered
    // bundle this number starts moving and nothing else in the system complains.
    for (const tier of ['learned-green', 'learned-red'] as const) {
      line.ceiling.push({
        tier, rendered: 0, ceiling: CEILING_PER_TIER, outcome: 'admit',
      });
    }

    // §8.3 — static, over the corpus rather than the window, so it holds on a corpus that has never
    // been exercised and is not weakened by the trail rotating. It writes no file and no
    // `supersedes`: see the merge section of `propose.ts` for why the consolidation is expressed as a
    // retirement of the subsumed clause rather than as a new clause declaring what it replaces.
    if (opts.retire !== false) {
      line.proposals.merges = findSubsumptions(opts.corpus);
      line.candidates.merged = line.proposals.merges.filter(m => m.proposed).length;
    }

    if (opts.ablations && opts.ablations.length > 0) {
      const plan = planRetirements(opts.ablations, line.window.rotated);
      line.proposals.retirements = plan.retirements;
      line.proposals.redundancies = plan.redundancies;
      line.proposals.listings = plan.listings;
      line.candidates.retired = plan.retirements.length;
    }

    return finish(line, written, exitReasonFor(line, capped.length, admitted.length),
      started, release, env);
  } catch (err) {
    line.error = `propose: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
    return finish(line, written, 'error', started, release, env, line.error);
  }
}

function summarise(c: Candidate): RunLine['proposals']['clauses'][number] {
  return {
    id: c.id, tier: c.tier, scope: c.scope, level: c.level, signal: c.signal,
    support: c.support.occurrences,
  };
}

function finish(
  line: RunLine, written: string[], reason: ExitReason, started: number,
  release: () => void, env: NodeJS.ProcessEnv | undefined, headline?: string,
): ProposeResult {
  line.exitReason = reason;
  line.durationMs = Date.now() - started;
  line.headline = headline ?? headlineFor(line);
  appendRunLine(line, env);
  release();
  return { line, written, exitCode: reason === 'error' ? 1 : 0 };
}

/**
 * The arithmetic every run report opens with. Rendered, not total, because rendered is the number
 * that hurts — and for this pipeline it is always zero, which is the point of gate E9.
 */
export function headlineFor(line: RunLine): string {
  const added = line.candidates.proposed + line.candidates.overwritten;
  const retired = line.candidates.retired;
  const merged = line.candidates.merged;
  // Merge is the only case where the pipeline proposes a net reduction, so it is the only one whose
  // arithmetic has to be stated: each finding retires one subsumed clause and adds nothing.
  return `clauses: +${added} −${retired} merge ${merged} `
    + `= net ${added - retired - merged}  (${line.proposals.clauses.length} proposal(s), `
    + `${line.clusters.belowFloor} shape(s) below the floor)`;
}

/**
 * `ok` iff the run produced something a reviewer can act on.
 *
 * `11-mine-v2.md` §12.22 asks for "`proposed: 0` always carries a non-`ok` exitReason", and §11.4's
 * own worked re-run contradicts it: an idempotent re-run refreshes an existing `proposed` file and
 * reports `proposed: 0, overwritten: 1` while calling the reason `no-shape-cleared-floor` — which is
 * false, since a shape plainly did clear it. Resolved in the honest direction: an overwrite and a
 * retirement are both output, so the invariant asserted here and in the tests is that
 * **`proposed + overwritten + retired + merged === 0` implies a non-`ok` reason.** A run whose only
 * output is a merge finding has something a reviewer can act on, and reporting that as
 * `no-shape-cleared-floor` would be the same silence-reads-as-success bug in the other direction.
 */
export function exitReasonFor(line: RunLine, capped: number, admitted: number): ExitReason {
  const output = line.candidates.proposed + line.candidates.overwritten + line.candidates.retired
    + line.candidates.merged;
  if (output > 0) { return admitted > capped ? 'caps-hit' : 'ok'; }
  if (line.candidates.considered === 0) { return 'no-shape-cleared-floor'; }
  if (line.suppressed.failedReplay > 0 && admitted === 0) { return 'all-candidates-failed-replay'; }
  if (line.suppressed.statusGuard > 0 || line.suppressed.alreadyInClaudeMd > 0) {
    return 'all-candidates-suppressed';
  }
  return 'no-shape-cleared-floor';
}

// --------------------------------------------------------------------------- the window buckets

function describeWindow(line: RunLine, records: DecisionRecord[], env?: NodeJS.ProcessEnv): void {
  const base = decisionsPath(env);
  line.window.files = [`${base}.1`, base]
    .filter(f => fs.existsSync(f))
    .map(f => path.basename(f));
  line.window.rotated = line.window.files.includes('decisions.jsonl.1');
  line.window.scanned = records.length;
  line.window.new = records.length;
  const times = records.map(r => r.ts).filter(t => typeof t === 'string').sort();
  line.window.firstTs = times[0] ?? null;
  line.window.lastTs = times[times.length - 1] ?? null;
  line.window.spanDays = new Set(times.map(t => t.slice(0, 10))).size;
  for (const r of records) {
    // Three completeness buckets, kept apart. `rev` absent is countable for repetition and never
    // usable for before/after comparison — `trail.ts` states that as an instruction. `call` absent
    // is countable and never emittable. `rev` present but stale is *reported, not gated*: gating on
    // rev equality would empty the window on every corpus edit, which is every accepted proposal.
    if (r.rev === undefined || r.rev === null) { line.window.unstamped += 1; }
    else if (line.rev !== null && r.rev !== line.rev) { line.window.mixedRev += 1; }
    if (!r.call) { line.window.noCall += 1; }
    if (EXEMPT_TOOLS.has(r.tool)) { line.window.exempt += 1; }
  }
}

// --------------------------------------------------------------------------- gating and validation

function collectCandidates(
  clusters: readonly Cluster[], line: RunLine, opts: ProposeOptions, lane: Lane = 'green',
  published: readonly HostAggregate[] = [],
): Candidate[] {
  const out: Candidate[] = [];
  // Refusals a human could still write the rule for by hand — the shape is real, the machine just has
  // nothing safe to emit about it. `path-symlinked` is deliberately NOT here: that cluster is refused
  // because the tree it describes is not the tree it looks like, which is not advice to hand a human.
  const proseOnly = new Set<RefusalReason>(
    ['no-matcher-shape', 'prefix-too-short', 'path-below-floor']);
  // A caller that did not say who this machine is gets no aggregates at all — see
  // `ProposeOptions.selfHosts` for why that is the fail-closed answer.
  const selfHosts = opts.selfHosts ?? null;
  for (const cluster of clusters) {
    const support = supportOf(cluster);
    const witnesses = selfHosts === null
      ? []
      : witnessHostsFor(cluster.shape12, published, selfHosts);
    const { tier, distances, declinedTeam } = tierFor(support, Boolean(opts.settings.project), {
      hasSlug: Boolean(opts.settings.team),
      witnessHosts: witnesses.length,
    });
    if (tier === null) {
      line.clusters.belowFloor += 1;
      line.belowFloor.push({ cluster: cluster.key, distances });
    }
    const result = gate(cluster, support, tier, declinedTeam, {
      lane,
      projectSlug: opts.settings.project,
      userSlug: opts.settings.user ?? '',
      teamSlug: opts.settings.team,
      witnessHosts: witnesses,
      windowRotated: line.window.rotated,
      instructionText: opts.instructionText,
    });
    if (result.declinedTeam !== null) {
      line.declinedPromotions.push({
        cluster: cluster.key, to: 'team', why: result.declinedTeam,
      });
    }
    if (result.refusal !== null) {
      if (result.refusal.why !== 'below-floor') { line.refusals.push(result.refusal); }
      if (proseOnly.has(result.refusal.why)) { line.suppressed.proseOnly += 1; }
      continue;
    }
    if (result.alreadyStated) {
      line.suppressed.alreadyInClaudeMd += 1;
      continue;
    }
    out.push(result.candidate!);
  }
  return out;
}

/**
 * Replay is the breadth authority, not a multiplier.
 *
 * There is no `10×` breadth guess anywhere: `reversals` is a measurement. A green candidate is
 * rejected if it would flip a decision a **human or a written clause** already settled;
 * model-sourced changes are reported as advisory and can never auto-reject, because a
 * non-deterministic original verdict falsifies nothing.
 *
 * Unreplayable records are held out of `n` by `replayWindow`, never counted as unchanged — counting
 * them as unchanged understates blast radius — and a candidate whose own support is
 * majority-unreplayable is not proposed at all.
 */
function validate(
  candidates: readonly Candidate[], records: DecisionRecord[], corpus: Clause[], line: RunLine,
): Candidate[] {
  const admitted: Candidate[] = [];
  for (const candidate of candidates) {
    // A candidate whose own support is majority-unreplayable is not proposed at all. Gate E1 already
    // refuses any `call`-less supporting record, so this can only fire on a support set that shrank
    // between the fold and the read — a rotation mid-run — and refusing is the honest answer to that.
    if (candidate.evidence.length * 2 < candidate.support.occurrences) {
      line.suppressed.failedReplay += 1;
      line.refusals.push({
        cluster: candidate.cluster, why: 'majority-unreplayable',
        detail: `${candidate.evidence.length} of ${candidate.support.occurrences} re-evaluable`,
      });
      continue;
    }

    const diff: ReplayDiff = replayWindow(
      records, [...corpus, candidateClause(candidate)], candidate,
      { window: records.length },
    );
    accumulateReplay(line, diff);

    const settled = diff.changes.filter(c => {
      const source = verdictSourceOf(c.record);
      return c.reversal && (source === 'human' || source === 'clause');
    });
    const rejection = autoReject(candidate, diff);
    if (settled.length > 0 || rejection !== null) {
      line.suppressed.failedReplay += 1;
      line.refusals.push({
        cluster: candidate.cluster,
        why: 'failed-replay',
        detail: rejection
          ? `${rejection.code} ${rejection.message}`
          : `would reverse ${settled.length} settled decision(s)`,
      });
      continue;
    }
    admitted.push(candidate);
  }
  // Deterministic order: the strongest evidence first, then by id so a re-run caps the same set.
  return admitted.sort((a, b) =>
    b.support.occurrences - a.support.occurrences || a.id.localeCompare(b.id));
}

function accumulateReplay(line: RunLine, diff: ReplayDiff): void {
  line.replay.n = Math.max(line.replay.n, diff.n);
  line.replay.changed += diff.changed;
  line.replay.reversals += diff.reversals;
  line.replay.human_reversals += diff.human_reversals;
  line.replay.advisory += diff.advisory;
  line.replay.unreplayable = Math.max(line.replay.unreplayable, diff.unreplayable);
}

// --------------------------------------------------------------------------- reading the last runs

/** The newest `count` run lines, newest first. `learn --status`'s whole implementation. */
export function recentRuns(count = 5, env?: NodeJS.ProcessEnv): RunLine[] {
  return readJsonl<RunLine>(pipelinePath(env)).slice(-count).reverse();
}

/**
 * `last learn 14d ago`, or null. Printed on any `session-sitter` invocation, because the honest risk
 * with an explicit verb is that nobody runs it.
 */
export function stalenessLine(now: Date = new Date(), env?: NodeJS.ProcessEnv): string | null {
  const runs = readJsonl<RunLine>(pipelinePath(env));
  const last = [...runs].reverse().find(r => r.stage === 'propose');
  if (last === undefined) {
    return runs.length === 0
      ? null
      : 'session-sitter: `learn` has never run — proposals are waiting in the fold';
  }
  const days = Math.floor((now.getTime() - new Date(last.ts).getTime()) / 86_400_000);
  return days >= 7 ? `session-sitter: last \`learn\` ${days}d ago` : null;
}

/** Stable digest of a run line, for a test that wants "identical run, identical report". */
export function runFingerprint(line: RunLine): string {
  // The clock and the scratch path are environment, not evidence: two runs over the same records in
  // two different directories must fingerprint identically or the digest measures the harness.
  const { ts, runId, durationMs, headline, corpusRoot, ...rest } = line;
  void ts; void runId; void durationMs; void headline; void corpusRoot;
  return createHash('sha256').update(JSON.stringify(rest), 'utf8').digest('hex').slice(0, 16);
}

