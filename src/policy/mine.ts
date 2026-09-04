/**
 * Stage A — accumulate. Fold new decision records into one aggregate, exercising zero judgement.
 *
 * This is the half of `learn` that is safe to run fifty times a day: ~80 ms, no model, no clause
 * written, nothing to review. It exists so that the half which *does* exercise judgement can be
 * explicit and attended (`session-sitter learn`) without that choice costing any data.
 *
 * ## Offset-driven, not event-driven — the load-bearing detail
 *
 * `SessionEnd` is not guaranteed to fire. A `kill -9`, a crashed terminal, a flat battery: the hook
 * never runs. So Stage A never means "analyse the session that just ended". It means **fold
 * everything in `decisions.jsonl` after the committed offset**. The trigger is a hint that new bytes
 * exist; the offset is the truth, and a missed trigger costs nothing because the next one picks up
 * both sessions' records.
 *
 * ## One file, so there is no two-phase problem
 *
 * The offset and the counts live in the *same* file, `pipeline/shapes.json`, written tmp + rename.
 * Two files — an append-only aggregate plus a separate offset — have a crash window between the two
 * commits, and recovering from it needs per-record dedupe keys and an unbounded seen-set. One rename
 * makes the whole fold atomic: either the offset advanced and the counts moved, or neither did.
 *
 * Rotation is caught by `tailSha`: the trail rotates at 4 MiB keeping one generation, so a stored
 * offset can outlive the bytes it pointed at. A tail-hash mismatch forces a full re-read of that
 * file rather than a silently wrong offset.
 *
 * ## What the fold is for, and what it is not for
 *
 * The persisted counters are the **lossless** part: they survive trail rotation, so they are what
 * the support floor and the nudge are measured against, and they are what makes "not running
 * `learn` costs delay, never data" true.
 *
 * They are deliberately *not* the evidence a clause is emitted from. Emission re-derives its support
 * set from the records it can still read and re-evaluate (`src/policy/propose.ts`), because gate E1
 * requires `call` on every supporting record and a rotated-out record cannot satisfy any gate. The
 * counters say a shape is worth looking at; the window says what may be written about it. Where the
 * two disagree the window wins, and `window.rotated` in the run line is what makes that honest.
 *
 * ## The shape
 *
 * Each *segment* of a command line is its own shape (§4.1), so `git status && rm -rf /` contributes
 * one event to the `git status` shape and one to the `rm` shape. The `rm` therefore cannot be
 * licensed by a `git status` clause — not because a guardrail caught it, but because it was never in
 * that clause's support set to begin with.
 *
 * Spec: `11-mine-v2.md` §2 (two stages), §4.1–4.2 (segments and the cluster key), §5 (thresholds),
 * §7.1 (one atomic file).
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DecisionRecord } from '../audit/trail';
import { dataDir, decisionsPath } from '../hooks/paths';
import { PATH_TOOLS, normalisedPath } from './generalise';
import { citedClauseId, recordId } from './replay';
import { splitShellCommand } from './shell';

// --------------------------------------------------------------------------- shapes and clusters

/** Tools whose input is a command line. Mirrors `permissionRequest.ts`'s `SHELL_TOOLS`. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'execute_command']);

/**
 * The canonical segment: `argv0` plus the subcommand, lowercased.
 *
 * Two tokens, and the number is the whole judgement in this function. One token is a whole tool
 * (`git`, `npm`, `rm`) and clusters everything it can do into one rule; three starts splitting on
 * arguments, so `pnpm test --filter core` and `pnpm test --filter cli` stop being the same shape.
 * The subcommand is where the rule actually lives: `git status` and `git push` are different rules.
 *
 * A second token that is a flag is not a subcommand, so `rm -rf dist` shapes as `rm` — which is on
 * the never-widen list anyway, and shaping it wider than it is would be the wrong direction.
 *
 * The wider literal a clause is finally written with is *not* this: it is the longest common token
 * prefix of the real supporting segments (gate E4), which can be longer than two tokens.
 */
export function canonicalSegment(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(t => t.length > 0);
  if (tokens.length === 0) { return ''; }
  const argv0 = tokens[0].toLowerCase();
  const sub = tokens[1];
  return sub !== undefined && !sub.startsWith('-') ? `${argv0} ${sub.toLowerCase()}` : argv0;
}

/** How many path segments below the recorded `cwd` a directory literal must be. See {@link canonicalPathSegment}. */
export const PATH_FLOOR_SEGMENTS = 2;

/**
 * The canonical *directory* segment for a path-carrying tool: the first {@link PATH_FLOOR_SEGMENTS}
 * segments of the file's directory, relative to `cwd`.
 *
 * The exact analogue of {@link canonicalSegment}, and the number is the same for the same reason.
 * There, one token is a whole tool (`git`, `npm`) and clusters everything it can do into one rule;
 * here, one segment is a whole top-level tree (`src`, `docs`, `infra`) and does the same. The rule
 * people actually mean lives one level down — `infra/prod`, not `infra` — which is where the
 * subcommand lives in the shell lane too.
 *
 * **The direction of the analogy is what inverts.** For a command, a *longer* argument list is the
 * widening; for a path a *shorter* prefix is, and a directory rule's natural form is a prefix. So the
 * shape is capped at the floor rather than grown from it, and going shallower than the floor is the
 * unsafe direction — `propose.ts`'s `commonPathLiteral` refuses it rather than falling back to it.
 *
 * `''` — no shape at all — for a path with no usable relative directory: outside `cwd`, at the `cwd`
 * root, or with no `cwd` to be relative to. A shallower-than-floor directory does get a shape, so the
 * floor refusal is visible in the run ledger as a named cluster rather than lumped in with the
 * unshapeable.
 */
export function canonicalPathSegment(absPath: string, cwd: string | null): string {
  if (cwd === null || !path.isAbsolute(cwd) || !path.isAbsolute(absPath)) { return ''; }
  const root = path.resolve(cwd);
  const rel = path.relative(root, path.dirname(path.resolve(absPath)));
  // `path.relative` answers `..`-prefixed for a sibling and `''` for the root itself. Both mean there
  // is no directory under `cwd` to key on. A bare-string `startsWith` would have said `/w/apifoo` is
  // under `/w/api`; `path.relative` cannot make that mistake, which is why it is the test.
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) { return ''; }
  return rel.split(path.sep).slice(0, PATH_FLOOR_SEGMENTS).join('/');
}

/**
 * The shape one raw segment folds into, for any tool. The single definition of "which cluster".
 *
 * Three call sites read it (the fold, the fold's before/after floor comparison, and the window
 * clustering) and they must agree exactly or a shape is counted under one key and emitted under
 * another.
 */
export function shapeSegment(record: DecisionRecord, raw: string): string {
  if (SHELL_TOOLS.has(record.tool)) { return canonicalSegment(raw); }
  if (PATH_TOOLS.has(record.tool)) { return canonicalPathSegment(raw, record.cwd ?? null); }
  return '';
}

/**
 * The 12 hex that names a shape, and half of every clause id.
 *
 * **Hash then slice, never slice the input.** The tuple's *prefix* is near-identical across almost
 * every candidate (`Bash\0git …`, `Bash\0npm …`), so slicing the input would collide for essentially
 * everything — the same lesson `recordStem`/`shortId` learned about agent session ids sharing long
 * prefixes. 12 hex over sha256 rather than 8 over sha1: a larger space at no cost, and
 * `createHash('sha256')` is already in the trail.
 */
export function shapeHash(tool: string, segment: string): string {
  return createHash('sha256').update(`${tool}\0${segment}`, 'utf8').digest('hex').slice(0, 12);
}

/** `signal | tool | shape` — the cluster's identity, and the string the run line reports. */
export function clusterKey(signal: Signal, tool: string, segment: string): string {
  return `${signal}|${tool}|${segment}`;
}

/**
 * What made a shape interesting. Ordered strongest-first, because a shape carries several at once
 * and the run line reports one label for it.
 *
 *  - `timeout` — the hook fell closed, or observe mode returned nothing. **Cost a developer work.**
 *  - `gap` — a call no written clause reached. Same hole, no cost paid yet.
 *  - `model` — the classifier paid for a decision policy could have made for free.
 *  - `repeat` — a written clause already decides it. Nothing to propose.
 */
export type Signal = 'timeout' | 'gap' | 'model' | 'repeat';

export const SIGNALS: readonly Signal[] = ['timeout', 'gap', 'model', 'repeat'];

/** One segment of one record, after normalisation. `confident: false` means we do not know what ran. */
export interface Segmented {
  segments: string[];
  confident: boolean;
}

/**
 * The segments a record contributes.
 *
 * A shell call is split by `splitShellCommand`. An **unconfident** split does not vanish: the raw
 * line is kept as one pseudo-segment so it still lands in a cluster and can refuse it (gate E3a).
 * Dropping it instead would let a cluster be assembled while silently discarding the one line we
 * could not parse — and the unparseable line is the one most likely to be the dangerous one.
 *
 * A non-shell call has one segment, the empty string: the shape is the tool name alone, which is the
 * only thing stable about it.
 */
export function segmentsOf(record: DecisionRecord): Segmented {
  if (PATH_TOOLS.has(record.tool)) {
    // The *normalised* path, so a record that wrote `infra/prod/db.tf` and one that wrote
    // `/w/api/infra/prod/db.tf` are one segment rather than two. `inputSummary` is deliberately not a
    // fallback: it is a 300-char display string, and E1 refuses a `call`-less record anyway.
    const resolved = normalisedPath(record.tool, record.call?.input ?? null, record.cwd ?? null);
    return { segments: [resolved ?? ''], confident: true };
  }
  if (!SHELL_TOOLS.has(record.tool)) { return { segments: [''], confident: true }; }
  const raw = record.call?.input?.command;
  const command = typeof raw === 'string' ? raw : record.inputSummary;
  if (typeof command !== 'string' || command.trim() === '') {
    return { segments: [''], confident: true };
  }
  const split = splitShellCommand(command);
  return split.confident
    ? { segments: split.commands, confident: true }
    : { segments: [command.trim()], confident: false };
}

/**
 * Does this record license a green support event for its segments? Gate E3b.
 *
 * An `allow` is necessary and not sufficient, and the second condition is the one that is easy to
 * miss. **A corrected call was allowed as a different command than the one recorded.** The hook
 * stores `recordedCall(toolName, input.tool_input)` — the input *as asked* — while
 * `decision.updatedInput` carries the rewrite that was actually approved, so a record with
 * `rewritten: true` says `git push --force` was allowed when what ran was `--force-with-lease`.
 * Counting it as support would mine a green clause for the dangerous form out of evidence that the
 * lane refused it.
 *
 * Both correction rules that exist today (`force-push-to-lease`, `chmod-777-to-755`) happen to be on
 * E8's never-widen list, so this closes a hole that is latent rather than live — but the correction
 * lane exists to grow, and the third rule is not going to arrive with a matching E8 axis. Checking
 * `rewritten` fixes it once, here, for every rule that will ever be added.
 *
 * **These records stay dropped, and the blocker is no longer the one the previous note named.** A
 * learned yellow now loads and has a rung, which lit up the gap lane — and the gap lane is fed by
 * `decision: 'none'`, not by these. §4.7 wants a `rewritten` record to become a yellow carrying a
 * `fix`, and that lane is refused on its own merits rather than for want of a level:
 *
 *  - The only rewrite a learned clause may legally carry is one `applyCorrection` already performs
 *    (F2, `learnedClauses.ts`'s `checkFix`) — and `applyCorrection` is ladder rung 2, which runs
 *    *before any clause is consulted*. A clause restating it can never change a decision. Inert by
 *    construction, and the argument does not weaken as the correction table grows: it is F2 that
 *    binds, not the table's contents.
 *  - Today E8 blocks them as well, per the paragraph above. That half does expire; the first does not.
 *
 * The two strings a rewrite candidate would need *are* separable here, which is worth recording
 * because conflating them is the whole hazard: `record.call` is the call **as asked** (the matcher's
 * input) and the rewrite is recoverable only by re-running `applyCorrection` on it (the `fix`). The
 * record never stores the rewritten command, so the two cannot be mistaken for one another. The lane
 * is not blocked for want of evidence — it is refused because its output would do nothing.
 */
export function isGreenSupport(record: DecisionRecord): boolean {
  return record.decision === 'allow' && !record.rewritten;
}

/** Which signal a record carries. `clause !== null` means a written rule already reached it. */
export function signalOf(record: DecisionRecord): Signal {
  if (record.clause !== null && record.clause !== undefined) { return 'repeat'; }
  if (record.actor === 'timeout') { return 'timeout'; }
  if (record.decision === 'none') { return 'gap'; }
  if (record.actor === 'model') { return 'model'; }
  return 'repeat';
}

// --------------------------------------------------------------------------- the persisted fold

/**
 * Per-shape counters. Everything here is a union or a sum, so folding is associative and a re-read
 * of the same bytes cannot double-count as long as the offset is honoured.
 *
 * ponytail: `sessions` and `days` are capped lists rather than exact sets. The largest bar any tier
 * asks for is 8 sessions and 14 days, so a cap of {@link DISTINCT_CAP} answers every question the
 * thresholds can pose while bounding the file. Upgrade path if a bar ever exceeds the cap: raise the
 * cap, not the structure.
 */
export interface ShapeStat {
  tool: string;
  segment: string;
  shape12: string;
  /** Records whose `decision` is `allow` — a green support event (gate E3b). */
  support: number;
  /** Every record on this shape, allow or not. */
  records: number;
  sessions: string[];
  /** Distinct `YYYY-MM-DD`. A calendar boundary is the one thing session churn cannot game. */
  days: string[];
  firstSeen: string;
  lastSeen: string;
  signals: Record<string, number>;
  cwds: Record<string, number>;
  /** Records with no `call`: countable for repetition, never usable for emission (§3.3). */
  noCall: number;
}

/** How many distinct sessions or days one shape tracks. See {@link ShapeStat}. */
export const DISTINCT_CAP = 32;

export interface SourceState {
  size: number;
  mtimeMs: number;
  /** sha256 of the {@link TAIL_BYTES} ending at `offset`. Catches an offset that outlived its file. */
  tailSha: string;
  offset: number;
}

/** Enough bytes that two different files cannot plausibly agree, few enough to read on every fold. */
export const TAIL_BYTES = 4096;

export const SHAPES_VERSION = 1;

export interface ShapesFile {
  version: number;
  sources: Record<string, SourceState>;
  shapes: Record<string, ShapeStat>;
  counters: {
    /** Records folded across every run. Not a window number — this one only ever grows. */
    folded: number;
    /** Runs that folded at least one record. */
    folds: number;
    lastFoldAt: string | null;
  };
}

export function pipelineDir(env?: NodeJS.ProcessEnv): string {
  return path.join(dataDir(env), 'pipeline');
}

export function shapesPath(env?: NodeJS.ProcessEnv): string {
  return path.join(pipelineDir(env), 'shapes.json');
}

export function emptyShapes(): ShapesFile {
  return {
    version: SHAPES_VERSION,
    sources: {},
    shapes: {},
    counters: { folded: 0, folds: 0, lastFoldAt: null },
  };
}

/**
 * Read the aggregate, or a fresh empty one.
 *
 * A file from a different `version` is discarded rather than migrated: it is derived data, a full
 * re-read rebuilds it from the trail, and a half-understood migration of the numbers the support
 * floor is measured against is the kind of quiet wrongness this pipeline exists to avoid.
 */
export function readShapes(env?: NodeJS.ProcessEnv): ShapesFile {
  let parsed: ShapesFile;
  try {
    parsed = JSON.parse(fs.readFileSync(shapesPath(env), 'utf8')) as ShapesFile;
  } catch {
    return emptyShapes();
  }
  if (parsed?.version !== SHAPES_VERSION || typeof parsed.shapes !== 'object') {
    return emptyShapes();
  }
  return {
    version: parsed.version,
    sources: parsed.sources ?? {},
    shapes: parsed.shapes ?? {},
    counters: parsed.counters ?? { folded: 0, folds: 0, lastFoldAt: null },
  };
}

/** One rename, so the offset and the counts commit together or not at all (§7.1). */
export function writeShapes(shapes: ShapesFile, env?: NodeJS.ProcessEnv): void {
  const dir = pipelineDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const target = shapesPath(env);
  const tmp = path.join(dir, `.shapes.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, `${JSON.stringify(shapes, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

// --------------------------------------------------------------------------- reading new bytes

/** The tail hash for an offset, or `''` when there is nothing behind it yet. */
export function tailShaAt(file: string, offset: number): string {
  if (offset <= 0) { return ''; }
  const from = Math.max(0, offset - TAIL_BYTES);
  const length = offset - from;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, length, from);
  } finally {
    fs.closeSync(fd);
  }
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

export interface NewBytes {
  /** Complete lines only. A partial trailing line is left for the next fold. */
  lines: string[];
  /** The offset to commit: just past the last complete line. */
  offset: number;
  size: number;
  mtimeMs: number;
  /** True when the stored offset did not survive verification and the file was re-read whole. */
  reread: boolean;
}

/**
 * Everything after the committed offset, as complete lines.
 *
 * A partial trailing line is never consumed. An appender writes one line per `appendFileSync`, so a
 * torn write is possible in principle and consuming half a record would fold a broken one and then
 * skip the rest of it forever. Leaving the partial line costs one fold's latency and nothing else.
 */
export function readNewBytes(file: string, prior: SourceState | undefined): NewBytes | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  let start = prior?.offset ?? 0;
  let reread = false;
  if (start > 0) {
    // Either the file was rotated out from under the offset, or it was truncated. Both mean the
    // offset points at bytes that are not the bytes it was taken over.
    if (start > stat.size || tailShaAt(file, start) !== prior?.tailSha) {
      start = 0;
      reread = true;
    }
  }
  if (start === stat.size) {
    return { lines: [], offset: start, size: stat.size, mtimeMs: stat.mtimeMs, reread };
  }

  const length = stat.size - start;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString('utf8');
  const lastBreak = text.lastIndexOf('\n');
  if (lastBreak < 0) {
    return { lines: [], offset: start, size: stat.size, mtimeMs: stat.mtimeMs, reread };
  }
  return {
    lines: text.slice(0, lastBreak).split('\n').filter(l => l.trim().length > 0),
    offset: start + Buffer.byteLength(text.slice(0, lastBreak + 1), 'utf8'),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    reread,
  };
}

// --------------------------------------------------------------------------- the fold

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function addDistinct(list: string[], value: string): void {
  if (value === '' || list.includes(value) || list.length >= DISTINCT_CAP) { return; }
  list.push(value);
}

/**
 * Fold one record's segments into the aggregate. Pure counting — no judgement, no thresholds.
 *
 * Returns the shape keys it touched, so the caller can ask "did *these* cross the floor" instead of
 * rescanning every shape after every record.
 */
export function foldRecord(
  shapes: Record<string, ShapeStat>, record: DecisionRecord,
): string[] {
  const touched: string[] = [];
  const { segments } = segmentsOf(record);
  const day = record.ts.slice(0, 10);
  const signal = signalOf(record);
  for (const raw of segments) {
    const segment = shapeSegment(record, raw);
    const key = `${record.tool}|${segment}`;
    const stat = shapes[key] ?? (shapes[key] = {
      tool: record.tool,
      segment,
      shape12: shapeHash(record.tool, segment),
      support: 0,
      records: 0,
      sessions: [],
      days: [],
      firstSeen: record.ts,
      lastSeen: record.ts,
      signals: {},
      cwds: {},
      noCall: 0,
    });
    if (!touched.includes(key)) { touched.push(key); }
    stat.records += 1;
    // Gate E3b, applied at fold time so the number the floor reads is already the green support
    // count: the runtime combines constituents with deny-wins, so an `allow` on a compound line
    // means every constituent was allowed. A segment inside a denied compound was never approved.
    if (isGreenSupport(record)) { stat.support += 1; }
    addDistinct(stat.sessions, record.sessionId);
    addDistinct(stat.days, day);
    if (record.ts < stat.firstSeen) { stat.firstSeen = record.ts; }
    if (record.ts > stat.lastSeen) { stat.lastSeen = record.ts; }
    bump(stat.signals, signal);
    if (record.cwd) { bump(stat.cwds, record.cwd); }
    if (!record.call) { stat.noCall += 1; }
  }
  return touched;
}

export interface FoldResult {
  /** New records folded across every source file. */
  folded: number;
  /** Shapes that did not exist before this fold. */
  newShapes: number;
  /** Shapes that crossed the user support floor *during* this fold. The nudge's numerator. */
  crossedFloor: { key: string; signal: Signal }[];
  /** Source files whose stored offset failed verification, so the file was re-read whole. */
  reread: string[];
  shapes: ShapesFile;
  files: string[];
}

/**
 * Fold everything after the committed offset, across the trail and its rotated generation.
 *
 * `.1` is folded first so records arrive in roughly chronological order; nothing depends on the
 * order, because every counter is a union or a sum, but a `firstSeen` that walks backwards is
 * confusing to read in a file a human is meant to be able to open.
 */
export function fold(env?: NodeJS.ProcessEnv, now: Date = new Date()): FoldResult {
  const shapes = readShapes(env);
  const knownBefore = new Set(Object.keys(shapes.shapes));
  const base = decisionsPath(env);
  const files = [`${base}.1`, base];
  const result: FoldResult = {
    folded: 0, newShapes: 0, crossedFloor: [], reread: [], shapes, files: [],
  };

  for (const file of files) {
    const prior = shapes.sources[path.basename(file)];
    const next = readNewBytes(file, prior);
    if (next === null) { continue; }
    result.files.push(path.basename(file));
    if (next.reread) {
      result.reread.push(path.basename(file));
      // The offset was not the offset it claimed to be, so the counts derived through it are not
      // trustworthy either. Rebuilding the whole aggregate is the only honest answer, and it is
      // cheap: the trail keeps one 4 MiB generation.
      shapes.shapes = {};
      for (const other of Object.keys(shapes.sources)) { shapes.sources[other].offset = 0; }
    }
    for (const line of next.lines) {
      let record: DecisionRecord;
      try {
        record = JSON.parse(line) as DecisionRecord;
      } catch {
        continue;                       // a torn line from a crashed writer; the trail's own rule
      }
      if (typeof record?.ts !== 'string' || typeof record.tool !== 'string') { continue; }
      const before = new Map(segmentsOf(record).segments.map(raw => {
        const key = `${record.tool}|${shapeSegment(record, raw)}`;
        const stat = shapes.shapes[key];
        return [key, stat !== undefined && clearsFloor(stat)];
      }));
      const touched = foldRecord(shapes.shapes, record);
      result.folded += 1;
      for (const key of touched) {
        if (before.get(key) === true) { continue; }
        if (!clearsFloor(shapes.shapes[key])) { continue; }
        result.crossedFloor.push({ key, signal: labelSignal(shapes.shapes[key].signals) });
      }
    }
    shapes.sources[path.basename(file)] = {
      size: next.size, mtimeMs: next.mtimeMs, offset: next.offset,
      tailSha: next.offset > 0 ? tailShaAt(file, next.offset) : '',
    };
  }

  if (result.reread.length > 0) {
    // A full re-read replaces the aggregate, so the lifetime counter has to be replaced with it
    // rather than added to — otherwise it reports the same records twice and stops meaning anything.
    shapes.counters.folded = result.folded;
  } else {
    shapes.counters.folded += result.folded;
  }
  if (result.folded > 0) {
    shapes.counters.folds += 1;
    shapes.counters.lastFoldAt = now.toISOString();
  }
  result.newShapes = Object.keys(shapes.shapes)
    .filter(key => !knownBefore.has(key)).length;
  return result;
}

/** The strongest signal a shape carries — the one label the nudge and the run line print. */
export function labelSignal(signals: Record<string, number>): Signal {
  for (const signal of SIGNALS) {
    if ((signals[signal] ?? 0) > 0) { return signal; }
  }
  return 'repeat';
}

// --------------------------------------------------------------------------- the thresholds (§5)

/**
 * The promotion bars. Every number is window-scoped, and `window.rotated` in the run line is what
 * makes that honest.
 *
 * ponytail: all of them in one block, and the run ledger records every shape's distance from every
 * bar, so after a month of ledgers they can be set from data. They are **reasoned, not measured**;
 * do not let that become a reason to ship them adaptive — an adaptive threshold is a threshold
 * nobody can review.
 *
 * The justifications that are not obvious from the number:
 *
 *  - **3 occurrences, not 2.** Two is routinely the *same* command re-run after a fail-closed
 *    denial — the trail records the retry as a second identical-shape record — so a bar of 2 turns
 *    every frustration into a rule.
 *  - **3 sessions, and it is the load-bearing bar.** One active developer clears any record floor
 *    before lunch on `git status`; records do not discriminate, sessions do. And 3 rather than 2
 *    because a Claude Code session splits on `--resume`, on a crash, and on a context compaction, so
 *    two sessions is routinely one interrupted piece of work.
 *  - **2 days.** Session churn is unbounded within an afternoon; a calendar boundary is the one
 *    thing it cannot game.
 *  - **7 days at project.** One full working week: the pattern survived a weekend and a context
 *    switch away and back. A better justification than any occurrence count.
 *  - **90% confinement, not 100%.** One stray record from another repo must not sink a genuine
 *    project pattern, and 90% still means the shape is overwhelmingly about one project.
 *
 * There is no red row. `team` is here for the run line's `declinedPromotions` and is unreachable
 * from one machine (§5.3), and red/orange are never proposed at all (§4.7) — so a halved red bar
 * would be a threshold no code path can reach, which is exactly the unreachable-rule failure the
 * test invariants exist to catch.
 */
export const THRESHOLDS = {
  user: { occurrences: 3, sessions: 3, days: 2, confinement: 0 },
  project: { occurrences: 8, sessions: 5, days: 7, confinement: 0.9 },
  team: { occurrences: 12, sessions: 8, days: 14, confinement: 0.9, hosts: 2 },
} as const;

export type PromotionTier = 'user' | 'project' | 'team';

/** The evidence a bar is measured against. Both stages produce it; only the source differs. */
export interface Support {
  occurrences: number;
  sessions: number;
  days: number;
  /** Fraction of support under the single most common `cwd`. */
  confinement: number;
  /** The `cwd` that fraction is about, or null when there is no support at all. */
  cwd: string | null;
}

/** Distance from every bar, negative when short. What makes a climbing shape visible before it lands. */
export interface BarDistance {
  tier: PromotionTier;
  occurrences: number;
  sessions: number;
  days: number;
  confinement: number;
  clears: boolean;
}

export function distanceFrom(tier: PromotionTier, support: Support): BarDistance {
  const bar = THRESHOLDS[tier];
  const d: BarDistance = {
    tier,
    occurrences: support.occurrences - bar.occurrences,
    sessions: support.sessions - bar.sessions,
    days: support.days - bar.days,
    confinement: support.confinement - bar.confinement,
    clears: false,
  };
  d.clears = d.occurrences >= 0 && d.sessions >= 0 && d.days >= 0 && d.confinement >= 0;
  return d;
}

/** Does this shape clear the cheapest bar in the system? The nudge's and `belowFloor`'s question. */
export function clearsFloor(stat: ShapeStat): boolean {
  return distanceFrom('user', supportOfStat(stat)).clears;
}

/** A persisted shape's support, as the bars measure it. */
export function supportOfStat(stat: ShapeStat): Support {
  const counts = Object.entries(stat.cwds).sort((a, b) => b[1] - a[1]);
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  return {
    occurrences: stat.support,
    sessions: stat.sessions.length,
    days: stat.days.length,
    confinement: total === 0 ? 0 : (counts[0]?.[1] ?? 0) / total,
    cwd: counts[0]?.[0] ?? null,
  };
}

/**
 * The tier a candidate is proposed at, chosen by **scope** and then gated on that scope's bars.
 *
 * Narrowest wins, and demote rather than drop: a pattern clearing team bars but confined to one
 * project is a *project* clause, and a pattern that misses the project bars is written at `user`
 * rather than thrown away. Erring low is right because the tiers are not symmetric — a user-tier
 * `proposed` clause is the cheapest false positive in the system, while a wrong project clause is
 * read and cited by people who never saw the evidence.
 *
 * `team` is returned **only** when the caller supplies cross-host evidence, because `DecisionRecord`
 * has no user field and one `dataDir` is one machine and one user: from a single laptop "two
 * developers agreed" is not a measurable proposition at any threshold. `aggregates.ts` is the only
 * thing that makes it measurable, and it does so by counting *hosts that each independently cleared
 * the whole user row* — never by summing anyone's counts. With no aggregates published,
 * `team.witnessHosts` is 0, this function behaves exactly as it did before, and the caller records a
 * `declinedPromotions` entry so the ceiling stays visible rather than mysterious.
 *
 * Team is checked **first**, which is not a break with "narrowest wins": the team row is strictly
 * higher than the project row on every count (12 > 8, 8 > 5, 14 > 7, identical confinement) *and*
 * adds a bar no single machine can reach. A shape that clears it is not promoted on weaker evidence —
 * it is written at the tier its evidence actually came from. What team tier does **not** get is any
 * shortcut around the widening asymmetry: what it produces is a `status: proposed` file like every
 * other tier, and no aggregate can change that.
 */
export interface TeamEvidence {
  /** True when a team slug is configured. Without one there is no scope directory to write into. */
  hasSlug: boolean;
  /** Other hosts whose published row independently cleared the whole `user` row. Never a sum. */
  witnessHosts: number;
}

const NO_TEAM: TeamEvidence = { hasSlug: false, witnessHosts: 0 };

export function tierFor(
  support: Support, hasProjectSlug: boolean, team: TeamEvidence = NO_TEAM,
): {
  tier: 'user' | 'project' | 'team' | null;
  distances: BarDistance[];
  /** Why team was not chosen, when its counts were there for the taking. Null when it was not close. */
  declinedTeam: string | null;
} {
  const user = distanceFrom('user', support);
  const project = distanceFrom('project', support);
  const teamBar = distanceFrom('team', support);
  const distances = [user, project, teamBar];

  // The proposing host counts as one witness: clearing the team row implies clearing every bar the
  // user row has, so its own witness test is satisfied by construction rather than by assumption.
  const wanted = THRESHOLDS.team.hosts;
  const hosts = team.witnessHosts + 1;
  const enough = hosts >= wanted;
  if (teamBar.clears && team.hasSlug && enough) {
    return { tier: 'team', distances, declinedTeam: null };
  }

  // Recorded whenever the *counts* were there: a candidate held back only by a missing second host is
  // the case a reader most needs named, and `hosts` is the one bar no single-machine trail can speak
  // to at all. Which prerequisite was missing is reported, because "declined" with no reason makes a
  // misconfigured team slug look identical to a genuinely solo corpus.
  let declinedTeam: string | null = null;
  if (teamBar.occurrences >= 0 && teamBar.sessions >= 0 && teamBar.days >= 0) {
    if (!enough) {
      declinedTeam = team.witnessHosts === 0
        ? 'no cross-user evidence in a single-machine corpus'
        : `only ${hosts} of ${wanted} hosts independently cleared the user row`;
    } else if (!team.hasSlug) {
      declinedTeam = 'no team slug configured, so there is no team scope to write into';
    } else {
      declinedTeam = 'the team row needs 90% confinement to one working directory';
    }
  }

  if (hasProjectSlug && project.clears) { return { tier: 'project', distances, declinedTeam }; }
  if (user.clears) { return { tier: 'user', distances, declinedTeam }; }
  return { tier: null, distances, declinedTeam };
}

// --------------------------------------------------------------------------- the nudge (§6)

/**
 * The one line printed at `SessionEnd`, at the moment the developer has just stopped working and
 * has their terminal back. Null when nothing crossed, because a hook that prints on every session
 * close is a hook people turn off.
 */
export function nudge(crossed: readonly { signal: Signal }[]): string | null {
  if (crossed.length === 0) { return null; }
  const counts = new Map<Signal, number>();
  for (const c of crossed) { counts.set(c.signal, (counts.get(c.signal) ?? 0) + 1); }
  const parts = SIGNALS.filter(s => counts.has(s)).map(s => `${counts.get(s)} ${LABEL[s]}`);
  return `session-sitter: ${crossed.length} shape${crossed.length === 1 ? '' : 's'} crossed the `
    + `support floor (${parts.join(', ')}). Run \`session-sitter learn\`.`;
}

const LABEL: Record<Signal, string> = {
  timeout: 'fail-closed', gap: 'gap', model: 'classifier-decided', repeat: 'repeat',
};

// --------------------------------------------------------------------------- window clustering (§4)

/**
 * A cluster: one shape, and every record in the readable window that lands on it.
 *
 * This is what emission is derived from, and it is deliberately rebuilt from records rather than
 * read from `shapes.json` — see the module header. It carries the whole record objects because every
 * gate needs something different from them: E1 the `call`, E6 the citation, E7 the `light`.
 */
export interface Cluster {
  key: string;
  tool: string;
  segment: string;
  shape12: string;
  signal: Signal;
  /** Records whose `decision` is `allow`: the green support set (E3b). */
  support: DecisionRecord[];
  /** Every record on this shape. */
  all: DecisionRecord[];
  /** Distinct supporting segments, in first-seen order. E4's input. */
  segments: string[];
  /** True when any record on this shape could not be split with certainty (E3a). */
  unconfident: boolean;
  /** Supporting records with no `call` (E1). */
  noCall: number;
  /** Distinct `light` values across the support set (E7). */
  lights: string[];
  /** A written red clause denied this shape in the window (E6). */
  contradictedBy: string | null;
  /** Fail-closed records: the gap that justifies a green, and its latency cost. */
  failClosed: number;
  gaps: number;
  modelDecided: number;
  modelLatencyMs: number;
  failClosedLatencyMs: number;
}

/**
 * Which lane a window is being clustered for.
 *
 * **A lane name, deliberately not a predicate.** An earlier revision of this took
 * `(record) => boolean`, which made every call site a place the green lane's `!rewritten` requirement
 * could be dropped by accident — a caller passing `r => r.decision === 'allow'` would look correct
 * and silently reopen the hole {@link isGreenSupport} exists to close. A lane name cannot express
 * that: every predicate lives in {@link SUPPORT}, next to the argument for it, and a third lane has
 * to be added here rather than at the call site.
 */
export type Lane = 'green' | 'gap';

/**
 * What counts as *support* per lane. The one place either answer is defined.
 *
 * The green lane is {@link isGreenSupport} — E3b's `allow` plus the `!rewritten` half, both of whose
 * arguments are about *licensing a command*. Neither transfers to the gap lane, which is why that
 * gets its own entry rather than a relaxation of this one: its support is `decision === 'none'`, the
 * calls policy never reached. Those records license nothing — the clause mined from them is a
 * narrowing that can only withhold an allow — so requiring an `allow` would be requiring the one
 * thing that, by definition, never happened.
 *
 * The gap lane keys on `decision`, never on `actor`, for the same reason {@link signalOf} does: a
 * sixth actor value (`correction`) arrived while this was written and a seventh will arrive later.
 *
 * It carries no `!rewritten` check because that state cannot exist, verified at both writers rather
 * than assumed: `rewritten` is `verdict.decision.updatedInput !== undefined`
 * (`permissionRequest.ts:863`), `updatedInput` is set only by the correction branch, and that branch
 * returns `behavior: 'allow'` — while the two sites that write `decision: 'none'` (an exempt tool
 * and observe mode, `:736` and `:802`) both hardcode `rewritten: false`. A corrected call is
 * therefore excluded from this lane by its `decision`, which is the check that would have to be
 * wrong for the guard to be needed.
 */
const SUPPORT: Record<Lane, (record: DecisionRecord) => boolean> = {
  green: isGreenSupport,
  gap: r => r.decision === 'none',
};

/**
 * Cluster a window of records by shape.
 *
 * `lane` selects what counts as support (see {@link SUPPORT}). Everything derived from *every* record
 * on the shape — the signal, `contradictedBy`, the fail-closed and gap counters, E3a's `unconfident`
 * — is unaffected by it; only `support`, `segments`, `noCall` and `lights` follow the lane, which is
 * exactly the set the emission gates read as "the evidence".
 *
 * The `signal` label is derived from the records rather than being part of the key. `11-mine-v2.md`
 * gives two readings of this — §4.2 makes the signal part of the cluster key, while §11.2's own
 * worked `shapes.json` keys by shape and carries the signals as counters inside it, and §11.3 then
 * assembles one candidate from a support set that mixes a fail-closed record with five
 * classifier-decided ones. The worked example is followed here: partitioning by signal would split
 * exactly the evidence §11.3 combines, and would have refused the doc's own example clause. §3.2's
 * requirement is still met — a `none` is never folded into a `deny`; the two are counted separately
 * and a `deny` reaches a green candidate only as a contradiction (E6).
 */
export function clusterWindow(
  records: readonly DecisionRecord[], lane: Lane = 'green',
): Cluster[] {
  const out = new Map<string, Cluster>();
  for (const record of records) {
    const { segments, confident } = segmentsOf(record);
    for (const raw of segments) {
      const segment = shapeSegment(record, raw);
      const key = `${record.tool}|${segment}`;
      const cluster = out.get(key) ?? {
        key,
        tool: record.tool,
        segment,
        shape12: shapeHash(record.tool, segment),
        signal: 'repeat' as Signal,
        support: [], all: [], segments: [],
        unconfident: false, noCall: 0, lights: [], contradictedBy: null,
        failClosed: 0, gaps: 0, modelDecided: 0, modelLatencyMs: 0, failClosedLatencyMs: 0,
      };
      out.set(key, cluster);
      cluster.all.push(record);
      if (!confident) { cluster.unconfident = true; }
      const signal = signalOf(record);
      if (SIGNALS.indexOf(signal) < SIGNALS.indexOf(cluster.signal)) { cluster.signal = signal; }
      if (signal === 'timeout') {
        cluster.failClosed += 1;
        cluster.failClosedLatencyMs += record.latencyMs ?? 0;
      }
      if (signal === 'gap') { cluster.gaps += 1; }
      if (signal === 'model') {
        cluster.modelDecided += 1;
        cluster.modelLatencyMs += record.latencyMs ?? 0;
      }
      // E6: a *written red* deny contradicts a green candidate. A fail-closed deny does not — it
      // means "nothing said this was safe", which is the gap the candidate exists to close.
      if (record.decision === 'deny' && record.clause) {
        cluster.contradictedBy = citedClauseId(record.clause) ?? record.clause;
      }
      if (!SUPPORT[lane](record)) { continue; }
      cluster.support.push(record);
      if (!record.call) { cluster.noCall += 1; }
      if (record.light && !cluster.lights.includes(record.light)) {
        cluster.lights.push(record.light);
      }
      if (!cluster.segments.includes(raw)) { cluster.segments.push(raw); }
    }
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** A cluster's support, as the bars measure it. Same shape as {@link supportOfStat}, live records. */
export function supportOf(cluster: Cluster): Support {
  const cwds = new Map<string, number>();
  const sessions = new Set<string>();
  const days = new Set<string>();
  for (const r of cluster.support) {
    sessions.add(r.sessionId);
    days.add(r.ts.slice(0, 10));
    if (r.cwd) { cwds.set(r.cwd, (cwds.get(r.cwd) ?? 0) + 1); }
  }
  const ranked = [...cwds].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = [...cwds.values()].reduce((a, b) => a + b, 0);
  return {
    occurrences: cluster.support.length,
    sessions: sessions.size,
    days: days.size,
    confinement: total === 0 ? 0 : (ranked[0]?.[1] ?? 0) / total,
    cwd: ranked[0]?.[0] ?? null,
  };
}

/** The record ids a clause cites as its evidence, oldest first, capped so the file stays readable. */
export function evidenceIds(cluster: Cluster, cap = 12): string[] {
  return [...cluster.support]
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(0, cap)
    .map(recordId);
}
