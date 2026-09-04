// GENERATED FILE — DO NOT EDIT.
// Compiled from src/policy/propose.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Stage B — propose. Turn a cluster over the support floor into one `status: proposed` clause file.
 *
 * This is where all the judgement in the pipeline lives, and it is still judgement without a model:
 * nine gates, a literal derived by `prefixOf`, an anchored matcher, and `replay.ts`'s measured
 * blast radius. Zero tokens on the default path, and `pipeline.test.ts` asserts `model.calls === 0`.
 *
 * ## The output contract, whole
 *
 * `data/knowledge/<teams|projects|users>/<slug>/learned/<id>.md` at `status: proposed`, **and nothing
 * else.** `assertWritable` enforces it and throws, and a throw means the run writes nothing. A
 * `proposed` clause is inert by construction — `isEnforceable` is `status === 'accepted'` and nothing
 * else, and so is `rendersIntoPrompt` — so a run killed halfway through writing five files leaves
 * five inert files and no state to roll back. That is stronger than any transaction.
 *
 * ## Suppression is the filesystem
 *
 * The writer refuses to overwrite any file whose parsed `status` is not `proposed`. A `declined` file
 * is permanent suppression, an `accepted` one is add-only, a `retired` one stays retired. There is no
 * `suppressed.json`, no dedupe index and no callback from the governance step to keep in sync,
 * because the corpus already records the fact and a second source of truth for it would drift.
 *
 * That only works because ids are **dateless**: `<kind>-<slug>-<shape12>`, content-derived, with
 * `learned_at` carrying the date. A date in the filename moves the moment another matching call
 * lands, so a human declining a candidate today would see it re-proposed tomorrow under a new name —
 * a governance failure that looks exactly like normal operation.
 *
 * ## Why the emitted matcher cannot widen past its evidence
 *
 *  1. **No left slack.** The match begins at the first character of the `command` *value*: the anchor
 *     is `"command"\s*:\s*"` immediately followed by the literal. `rm -rf / # pnpm test` does not
 *     match — which is the failure a bare substring has, and why E5 forbids one.
 *  2. **No right slack.** `(?=[\s"\\])` ends the literal on a word boundary, so `git s` cannot
 *     license `git shove-everything`.
 *  3. **No compound slack, twice over.** The support set never contained the other segment (§4.1),
 *     *and* at runtime `constituentsOf` decomposes a compound and evaluates each constituent against
 *     its own `constituentHaystack`, so `git status && rm -rf /` is tested as two separate inputs and
 *     the matcher matches only the first.
 *  4. **Matched set ⊆ evidence-sharing set.** The literal is a token prefix of every supporting
 *     segment (E4), so the only direction it is wider than the evidence is "more arguments to the
 *     same subcommand" — the generalisation the product exists to provide.
 *  5. **It degrades closed downstream.** Because the matcher is a `/…/` regex,
 *     `generalisedPermission` returns null for it, so an accepted mined clause never becomes a
 *     persisted Claude Code `Bash(x:*)` rule in anyone's settings file behind their back.
 *
 * The anchor is inside the JSON rather than at `^` deliberately: the haystack is `haystackFor`
 * output and its key order is the caller's, because `constituentHaystack` does `{...toolInput,
 * command}` and preserves it — so `^Bash \{"command":"` is not guaranteed and `"command"\s*:\s*"` is.
 *
 * Spec: `11-mine-v2.md` §4.3 (the gates), §4.5 (non-widening), §7.3 (ids and suppression), §8.2
 * (retirement writes no file), §8.3 (merge — see the merge section below for what of it survived).
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MERGE_NON_WIDENING = exports.MAX_MERGES = exports.PATH_NEVER_WIDEN = exports.NEVER_WIDEN = exports.MAX_RETIREMENTS = exports.MAX_ADDITIONS = exports.EMISSION_RULE = void 0;
exports.escapesCwd = escapesCwd;
exports.neverWidenAxis = neverWidenAxis;
exports.commonLiteral = commonLiteral;
exports.commandMatcher = commandMatcher;
exports.pathNeverWidenAxis = pathNeverWidenAxis;
exports.commonPathLiteral = commonPathLiteral;
exports.pathMatcher = pathMatcher;
exports.symlinkEscape = symlinkEscape;
exports.slugOf = slugOf;
exports.candidateId = candidateId;
exports.gate = gate;
exports.renderClause = renderClause;
exports.writeClause = writeClause;
exports.statusOf = statusOf;
exports.planRetirements = planRetirements;
exports.subsumesMatcher = subsumesMatcher;
exports.subsumesClause = subsumesClause;
exports.findSubsumptions = findSubsumptions;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const learnedClauses_1 = require("../supervisor/learnedClauses");
const ablate_1 = require("./ablate");
const mine_1 = require("./mine");
const generalise_1 = require("./generalise");
const practices_1 = require("./practices");
// --------------------------------------------------------------------------- the emission rule
/**
 * The version of the rules below, recorded in the run line and in the clause body — and deliberately
 * **not** in the id hash.
 *
 * An earlier draft put a `schema:1` tag inside the hash. It bought rule-version separation and cost
 * suppression permanence: bump the tag and every `declined` file stops blocking its candidate.
 * Permanence is worth more, so the version informs a reader without moving a filename.
 */
exports.EMISSION_RULE = 2;
/** Reviewer-fatigue caps, not runtime caps. A run proposing 40 clauses gets ignored. */
exports.MAX_ADDITIONS = 5;
exports.MAX_RETIREMENTS = 10;
// --------------------------------------------------------------------------- E8, the never-widen list
/**
 * Axes a candidate is **dropped** on, never narrowed onto.
 *
 * Each entry is a predicate over one segment, and the name is what the run line reports. Ordered so
 * the reported axis is the most specific one that applies.
 *
 * `pipe-to-interpreter` is expressed as "the segment *is* an interpreter": `splitShellCommand`
 * already splits on `|`, so a pipe into `sh` arrives here as its own `sh` segment. Testing for the
 * pipe character would test a string this stage never sees.
 */
exports.NEVER_WIDEN = [
    { axis: 'redirect', hit: s => /(^|[^0-9<>&])(>>?|<)(?![(])/.test(stripQuoted(s)) },
    { axis: 'privilege', hit: s => /\b(sudo|doas|su|pkexec|chown|chgrp)\b/i.test(s) },
    { axis: 'egress', hit: s => /\b(curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|telnet)\b/i.test(s) },
    { axis: 'rm', hit: s => /^\s*rm\b/i.test(s) },
    { axis: 'chmod', hit: s => /\b(chmod|chflags|setfacl)\b/i.test(s) },
    { axis: 'force-push', hit: s => /\bgit\b[\s\S]*\bpush\b[\s\S]*(--force|--delete|-f\b)/i.test(s) },
    { axis: 'hard-reset', hit: s => /\bgit\b[\s\S]*\b(reset\s+--hard|clean\s+-[a-z]*f)/i.test(s) },
    { axis: 'pipe-to-interpreter', hit: s => INTERPRETERS.has(argv0Of(s)) },
    { axis: 'corpus-path', hit: s => /(data\/knowledge|\/corpus(\/|\b))/.test(s) },
    { axis: 'traversal', hit: s => /(^|[\s=:"'])\.\.\//.test(s) },
];
const INTERPRETERS = new Set([
    'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'node', 'python', 'python3', 'perl', 'ruby', 'php',
    'osascript', 'eval', 'source', 'env',
]);
function argv0Of(segment) {
    return (segment.trim().split(/\s+/)[0] ?? '').toLowerCase();
}
/** Blank out quoted spans so a `>` inside a commit message is not read as a redirect. */
function stripQuoted(segment) {
    return segment.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}
/**
 * An absolute path in the segment that is not under `cwd`.
 *
 * Separate from {@link NEVER_WIDEN} because it needs the cluster's own `cwd` to answer, and folding a
 * parameter into that table would make every other entry carry an argument it does not use.
 */
function escapesCwd(segment, cwd) {
    for (const token of stripQuoted(segment).split(/[\s=]+/)) {
        const clean = token.replace(/^["']|["']$/g, '');
        if (!clean.startsWith('/')) {
            continue;
        }
        if (cwd && (clean === cwd || clean.startsWith(`${cwd}/`))) {
            continue;
        }
        return clean;
    }
    return null;
}
/** The first never-widen axis this support set touches, or null. */
function neverWidenAxis(segments, cwd) {
    for (const segment of segments) {
        for (const rule of exports.NEVER_WIDEN) {
            if (rule.hit(segment)) {
                return rule.axis;
            }
        }
        const outside = escapesCwd(segment, cwd);
        if (outside !== null) {
            return `out-of-cwd:${outside}`;
        }
    }
    return null;
}
// --------------------------------------------------------------------------- E4, the literal
/**
 * The longest common word-boundary token prefix of every supporting segment, ≥ 2 tokens.
 *
 * Two steps, and the second is the one that matters: take the token-wise longest common prefix, then
 * shrink a token at a time until `prefixOf(candidate, segment) !== null` for **every** supporting
 * segment. `prefixOf` is the *acceptance test*, not the generator — its word-boundary anchor is what
 * stops `git s` licensing `git shove-everything`, and it is already the function that decides which
 * Claude Code prefix rule a clause licenses, so there is one definition of "is a safe prefix of".
 *
 * A one-token prefix is a whole tool (`git`, `npm`, `rm`) and is never what anyone meant, so
 * shrinking below two tokens refuses instead of returning.
 */
function commonLiteral(segments) {
    if (segments.length === 0) {
        return null;
    }
    const tokenised = segments.map(s => s.trim().split(/\s+/).filter(t => t.length > 0));
    let tokens = tokenised[0];
    for (const other of tokenised.slice(1)) {
        let i = 0;
        while (i < tokens.length && i < other.length && tokens[i] === other[i]) {
            i += 1;
        }
        tokens = tokens.slice(0, i);
    }
    while (tokens.length >= 2) {
        const candidate = tokens.join(' ');
        if (segments.every(s => (0, generalise_1.prefixOf)(candidate, s) !== null)) {
            return candidate;
        }
        tokens = tokens.slice(0, -1);
    }
    return null;
}
// --------------------------------------------------------------------------- E5, the matcher
/**
 * The anchored matcher for a command literal, as it is written on the `Match:` line.
 *
 * Wrapped in backticks because `splitPatterns` lifts backticked patterns out before splitting on
 * commas, so a literal containing a comma survives. `escapeForMatcher` is `substringMatcher`'s own
 * escaping, so the literal is escaped exactly the way a hand-written matcher's would be.
 */
function commandMatcher(literal) {
    return `/"command"\\s*:\\s*"${(0, practices_1.escapeForMatcher)(literal)}(?=[\\s"\\\\])/`;
}
// --------------------------------------------------------------------------- the directory lane
/**
 * Axes a **path** candidate is dropped on. Deliberately not {@link NEVER_WIDEN}, and deliberately
 * short.
 *
 * Running the shell axes over a path would be nonsense in both directions: `egress` fires on a file
 * called `ssh-notes.md`, `chmod` on `docs/chmod.md`, and `rm` requires the string to *start* with
 * `rm`, which no relative directory does. A table of predicates over a different kind of string is
 * not a table that transfers.
 *
 * Two entries, and both are reachable — the test constructs a real cluster for each. Three axes that
 * would look right here are absent because nothing can trigger them, which is the unreachable-rule
 * failure this design's own test invariants exist to catch:
 *
 *  - **`traversal`.** `normalisedPath` runs `path.resolve`, so a `..` is collapsed before this ever
 *    sees it, and a `..` that leaves `cwd` has no shape at all.
 *  - **`out-of-cwd`.** Same: `canonicalPathSegment` returns `''` for a path outside `cwd`, so such a
 *    cluster refuses as `no-matcher-shape` before an axis is consulted.
 *  - **A secrets axis** for `.env`, `id_rsa`, `credentials` and friends. `tiers.ts`'s `DESTRUCTIVE`
 *    table already matches those against a haystack that contains `file_path`, so rung 1 returns RED
 *    and the record is a `deny`. A `deny` is neither green support (E3b) nor gap support
 *    (`decision === 'none'`), so no such record can reach a support set. `.env` is covered; an axis
 *    for it would be a branch no test could honestly trigger.
 */
exports.PATH_NEVER_WIDEN = [
    { axis: 'corpus-path', hit: d => /(^|\/)(data\/knowledge|corpus)(\/|$)/.test(d) },
    { axis: 'dot-root', hit: d => d.startsWith('.') },
];
/**
 * The first path never-widen axis this directory set touches, or null.
 *
 * Takes directories **relative to `cwd`**, which is what makes `dot-root` mean what it says: `.git`
 * at the repository root is tooling, config or another agent's state and a learned blanket allow over
 * it is not something six writes should buy, whereas `src/.generated` is inside a tree the evidence
 * is genuinely about.
 */
function pathNeverWidenAxis(relativeDirs) {
    for (const dir of relativeDirs) {
        for (const rule of exports.PATH_NEVER_WIDEN) {
            if (rule.hit(dir)) {
                return rule.axis;
            }
        }
    }
    return null;
}
/**
 * The longest common **segment** prefix of every supporting file's directory, at least
 * {@link PATH_FLOOR_SEGMENTS} segments below `cwd`. Absolute, or null.
 *
 * The path analogue of {@link commonLiteral}, and every difference is forced:
 *
 *  1. **Segments, not characters.** A character-wise common prefix of `infra/production/a.tf` and
 *     `infra/prod/b.tf` is `infra/prod`, a directory neither file is in. That is precisely how a
 *     clause comes to govern a sibling tree, so the fold is over `split('/')`.
 *  2. **The basename is dropped.** A file is not a directory prefix, so the common prefix is taken
 *     over `path.dirname` — one supporting file yields its own directory, not itself.
 *  3. **The floor refuses; it does not narrow.** Shrinking a shell prefix makes it *wider*, so E4
 *     shrinks until every segment accepts it and then stops at two tokens. Here the prefix is
 *     already the widest thing on offer and shrinking is the unsafe direction, so there is nothing
 *     to shrink towards: below the floor it returns null. Same shape as E8 — dropped, not narrowed.
 *  4. **Outside `cwd` is null, never a common ancestor.** Two records in two repos share `/w`, and
 *     proposing `/w` is the widening this whole gate exists to refuse.
 *  5. **No whitespace.** `escapeForMatcher` loosens a run of whitespace to `\s+` — right for a
 *     command, where `npm  test` is the same command, and wrong for a path, where `a b` and `a  b`
 *     are two directories. Refusing a whitespace literal makes the loosening a no-op by construction
 *     and keeps one escaper for the whole system, which `practices.ts` asks for by name.
 */
function commonPathLiteral(paths, cwd) {
    if (paths.length === 0 || cwd === null || !path.isAbsolute(cwd)) {
        return null;
    }
    const root = path.resolve(cwd);
    let common = null;
    for (const p of paths) {
        // No separate `isAbsolute(p)` guard: a relative path resolves against the *miner's* cwd, which is
        // never under the session's `root`, so the `..` test below already refuses it. Proven by mutation
        // — removing such a guard failed no test, which is why it is not here.
        const rel = path.relative(root, path.dirname(path.resolve(p)));
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return null;
        }
        const segments = rel === '' ? [] : rel.split(path.sep);
        if (common === null) {
            common = segments;
            continue;
        }
        let i = 0;
        while (i < common.length && i < segments.length && common[i] === segments[i]) {
            i += 1;
        }
        common = common.slice(0, i);
    }
    if (common === null || common.length < mine_1.PATH_FLOOR_SEGMENTS) {
        return null;
    }
    const literal = path.join(root, ...common);
    if (/\s/.test(literal)) {
        return null;
    }
    return literal;
}
/**
 * The anchored matcher for a directory literal, as it is written on the `Match:` line.
 *
 * Two properties, and each answers a question the shell lane answered differently:
 *
 *  - **No left slack**, the same way {@link commandMatcher} has none: the literal begins at the first
 *    character of the path *value*, so the anchor is `"<key>"\s*:\s*"` immediately followed by it. A
 *    bare substring would match a vendored `.../vendor/w/api/infra/prod/db.tf` in another tree.
 *  - **A segment boundary, which is not a word boundary.** The lookahead is exactly `/`, so
 *    `infra/prod` cannot reach `infra/production-notes/` or `infra/prod.bak/`. `(?=[\s"\\])` — the
 *    shell lane's boundary — says nothing at all about `/` and would have matched every one of them.
 *    Requiring the `/` also means the directory entry itself is not a file under the directory.
 *
 * `key` is the tool's own path argument (`file_path`, or `notebook_path` for `NotebookEdit`), so a
 * matcher never matches a path a different tool happens to send under a different key. And because
 * the anchor names the key, a `Write`'s `content` — which `haystackFor` includes for a red clause —
 * cannot satisfy it by merely mentioning the directory.
 */
function pathMatcher(dir, key) {
    return `/"${key}"\\s*:\\s*"${(0, practices_1.escapeForMatcher)(dir)}(?=\\/)/`;
}
/**
 * The written path, when it does not resolve to where it says it is. Null when it does.
 *
 * The matcher is **textual**: it matches the string in the tool input, never the file that string
 * reaches. So a directory inside the tree that is a symlink out of it makes a learned green
 * bypassable by construction — `Write` to `<repo>/infra/prod/x` matches, and the bytes land wherever
 * `prod` points. There is nothing a regex over the tool input can do about that, so such a cluster is
 * refused and no clause is written for it.
 *
 * The comparison is of **relative positions**, not absolute strings, and that is load-bearing rather
 * than fussy: on macOS `/tmp` is a symlink to `/private/tmp`, so an absolute-string comparison would
 * refuse every candidate whose session ran under a temporary directory. `realpathOf` is
 * `learnedClauses.ts`'s own — the function `assertWritable` resolves with, including its
 * deepest-existing-ancestor recursion for a file that does not exist yet — because two definitions of
 * "where does this path really go" is the disagreement that makes a write boundary porous.
 *
 * This check runs at mining time, on the machine that owns the trail. It is **not** a filesystem
 * guard on the emitted clause: a symlink created after the clause is accepted is not caught by it,
 * and `assertWritable` remains the only filesystem boundary in the system.
 */
function symlinkEscape(absPath, cwd) {
    let resolved;
    let resolvedRoot;
    try {
        resolved = (0, learnedClauses_1.realpathOf)(path.resolve(absPath));
        resolvedRoot = (0, learnedClauses_1.realpathOf)(path.resolve(cwd));
    }
    catch {
        return absPath; // a symlink loop; `realpathOf` refuses to chase it further
    }
    return path.relative(path.resolve(cwd), path.resolve(absPath))
        === path.relative(resolvedRoot, resolved)
        ? null
        : absPath;
}
/** A human-scannable slug from the canonical segment — the same string the hash is taken over. */
function slugOf(segment, tool) {
    const base = (segment || tool).toLowerCase().replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '').slice(0, 40);
    return base || 'shape';
}
/** `<kind>-<slug>-<shape12>`. Dateless — see the module header for why that is load-bearing. */
function candidateId(kind, slug, shape12) {
    const id = `${kind}-${slug}-${shape12}`;
    if (!(0, learnedClauses_1.isSafeId)(id)) {
        throw new Error(`derived an unsafe clause id: ${JSON.stringify(id)}`);
    }
    return id;
}
/**
 * Run every gate over one cluster. A failure refuses the **whole cluster** and writes nothing.
 *
 * The level follows the lane, and the two the lanes cannot produce are the interesting ones:
 *
 *  - **`green`, from the fail-closed / classifier-decided lane.** A widening: it asks for a
 *    permission, and it goes to the full widening bar.
 *  - **`yellow` with no fix, from the gap lane** (§4.7). A narrowing: its whole effect is to withhold
 *    an allow a *learned* green would have granted and send the call to a human
 *    (`permissionRequest.ts`'s `withholdingYellow`). It licenses nothing even if accepted carelessly.
 *  - **Never red or orange**, because proposing a safety clause from the *absence* of one manufactures
 *    a deny from silence. `orange` additionally has no rung and does not load (`checkFix`'s sibling
 *    check in `parseLearnedClause`).
 *  - **Never a yellow with a `fix`.** §4.7 routes `rewritten: true` records here, and the lane is
 *    deliberately not built. Two independent reasons, either one sufficient: (1) the only rewrite a
 *    learned clause may legally carry is one `applyCorrection` already performs (F2, `checkFix`) —
 *    and `applyCorrection` runs at ladder rung 2, *before* any clause is consulted, so such a clause
 *    can never change a decision; it is inert by construction, not by accident. (2) Every command
 *    the shipped correction table rewrites is on the E8 never-widen list — `git push --force` hits
 *    `force-push`, `chmod 777` hits `chmod`, and `--force-with-lease` still contains `--force` so
 *    the rewritten form hits it too. Making the lane reachable means repealing E8 for exactly the
 *    axes E8 exists for. Neither is worth doing; see the PR body.
 */
function gate(cluster, support, tier, declinedTeam, opts) {
    const refuse = (why, detail) => ({
        candidate: null, refusal: { cluster: cluster.key, why, detail }, declinedTeam,
        alreadyStated: false,
    });
    const lane = opts.lane ?? 'green';
    // E3a — an unconfident split refuses the whole cluster, not just the record. Per-record skipping
    // would let a cluster be assembled while silently dropping the one line we could not parse.
    if (cluster.unconfident) {
        return refuse('unconfident-split');
    }
    // E2 — one tool, and a known shape. Two lanes now have one: a shell tool shaped by
    // `canonicalSegment`, and a path-carrying write tool shaped by `canonicalPathSegment` (§4.3). Every
    // other tool still refuses here and is reported.
    const isPath = generalise_1.PATH_TOOLS.has(cluster.tool);
    if (!isPath && !mine_1.SHELL_TOOLS.has(cluster.tool)) {
        return refuse('no-matcher-shape', cluster.tool);
    }
    if (cluster.segment === '') {
        return refuse('no-matcher-shape', cluster.tool);
    }
    if (tier === null) {
        return refuse('below-floor');
    }
    // E1 — `call` present on every supporting record. No `inputSummary` derivation, ever: it is a
    // 300-char display string, and `replay.ts` deleted exactly that fallback and says why.
    if (cluster.noCall > 0) {
        return refuse('no-call', `${cluster.noCall} record(s)`);
    }
    if (cluster.support.length === 0) {
        return refuse('below-floor');
    }
    // E6 — a written red deny on this shape refuses a green candidate. A fail-closed deny is not a
    // contradiction; it is the gap itself.
    if (cluster.contradictedBy !== null) {
        return refuse('contradicted', cluster.contradictedBy);
    }
    // E7 — no widening across a light boundary. Rejected outright, not softened.
    if (cluster.lights.length > 1) {
        return refuse('mixed-light', cluster.lights.join('/'));
    }
    // The gap that justifies asking for a permission at all: a record where policy did not reach the
    // call. Without one there is nothing for the clause to close, and `replay.ts`'s INERT finding
    // would reject it anyway — refusing here says so in the ledger instead of in a replay report.
    //
    // The gap lane skips it because it cannot fail it: its support set *is* the `decision: 'none'`
    // records, so a non-empty support set is a non-empty gap. Running the check anyway would be a
    // branch that can only ever be true, which is the kind of thing that reads as a real guard later.
    if (lane === 'green'
        && cluster.failClosed === 0 && cluster.gaps === 0 && cluster.modelDecided === 0) {
        return refuse('no-gap');
    }
    // E8 and E4, per lane. The two lanes ask the same two questions of different kinds of string, and
    // the answers do not transfer — see {@link PATH_NEVER_WIDEN} and {@link commonPathLiteral}.
    let literal;
    let matchers;
    if (isPath) {
        const root = support.cwd;
        if (root === null) {
            return refuse('no-matcher-shape', cluster.tool);
        }
        // Resolution before generalisation. A path that does not resolve to where it was written makes a
        // *textual* matcher bypassable by construction, so the cluster is refused rather than narrowed.
        for (const p of cluster.segments) {
            if (symlinkEscape(p, root) !== null) {
                return refuse('path-symlinked', p);
            }
        }
        const axis = pathNeverWidenAxis(cluster.segments.map(p => path.relative(root, path.dirname(p))));
        if (axis !== null) {
            return refuse('never-widen', axis);
        }
        // No second check on the literal itself: it is a common prefix of every supporting path, so a
        // symlinked literal is a symlinked *every* path and the loop above has already refused. Proven by
        // mutation — adding such a check failed no test, which is the whole reason it is not here.
        literal = commonPathLiteral(cluster.segments, root);
        if (literal === null) {
            return refuse('path-below-floor', `< ${mine_1.PATH_FLOOR_SEGMENTS} segments`);
        }
        matchers = [pathMatcher(literal, generalise_1.PATH_TOOLS.get(cluster.tool))];
    }
    else {
        const axis = neverWidenAxis(cluster.segments, support.cwd);
        if (axis !== null) {
            return refuse('never-widen', axis);
        }
        // E4 — the literal, and E9 by construction: no literal, no `Match:`, no candidate.
        literal = commonLiteral(cluster.segments);
        if (literal === null) {
            return refuse('prefix-too-short');
        }
        matchers = [commandMatcher(literal)];
    }
    // The kind is part of the id, so a shape that clears the floor in both lanes gets two distinct,
    // dateless ids and one lane's `declined` file cannot suppress the other's candidate.
    const kind = lane === 'gap' ? 'gap-ask' : 'green-repeat';
    const slug = slugOf(cluster.segment, cluster.tool);
    const scope = tier === 'team'
        ? (opts.teamSlug ?? '')
        : tier === 'project' ? (opts.projectSlug ?? '') : opts.userSlug;
    if (!scope) {
        return refuse('below-floor', 'no slug configured for the chosen tier');
    }
    const times = cluster.support.map(r => r.ts).sort();
    return {
        candidate: {
            id: candidateId(kind, slug, cluster.shape12),
            tool: cluster.tool,
            kind,
            slug,
            shape12: cluster.shape12,
            level: lane === 'gap' ? 'yellow' : 'green',
            // Stated rather than left undefined: `directionOf` reads it, and a gap-lane yellow is a
            // narrowing precisely *because* there is no fix. The value is the load-bearing part.
            hasFix: false,
            tier,
            scope,
            title: titleFor(literal, lane, isPath),
            match: matchers,
            literal,
            cluster: cluster.key,
            signal: cluster.signal,
            support,
            evidence: (0, mine_1.evidenceIds)(cluster),
            variants: [...cluster.segments].sort(),
            failClosed: cluster.failClosed,
            failClosedLatencyMs: cluster.failClosedLatencyMs,
            modelDecided: cluster.modelDecided,
            modelLatencyMs: cluster.modelLatencyMs,
            firstSeen: times[0] ?? '',
            lastSeen: times[times.length - 1] ?? '',
            contradictions: 0,
            windowRotated: opts.windowRotated,
            // Only meaningful at team tier, and named at every tier so a reader of a user-tier clause can
            // see that the answer is "none" rather than "not recorded".
            witnessHosts: tier === 'team' ? [...(opts.witnessHosts ?? [])] : [],
        },
        refusal: null,
        declinedTeam,
        // §10.4 — `CLAUDE.md` and `.claude/rules/**` are already in the classifier's context on every
        // call, so a clause restating one of them is pure duplicated instruction against a budget the
        // research says collapses. ponytail: the dedupe is lexical, which catches `Match:`-shaped
        // restatements — the case that matters. A semantic pass belongs to the LLM tier, not here.
        alreadyStated: opts.instructionText !== undefined
            && opts.instructionText.toLowerCase().includes(literal.toLowerCase()),
    };
}
function titleFor(literal, lane, isPath = false) {
    const what = isPath ? `writes under \`${literal}/\`` : `\`${literal}\``;
    return lane === 'gap'
        ? `Ask a human about ${what} rather than letting a learned green settle it`
        : `Allow ${what} without a classifier round-trip`;
}
// --------------------------------------------------------------------------- rendering
/**
 * The clause file, whole.
 *
 * Two shapes here are forced by `learnedClauses.ts`'s own grammar rather than chosen:
 *
 *  - `learned_from.decisions` is an **inline** list. The restricted frontmatter grammar rejects block
 *    lists by name ("block lists are not supported: write `key: [a, b]` on one line"), and
 *    `11-mine-v2.md` §11.3's worked example writes one — so the example as printed does not parse.
 *  - nothing writes `status:` anything but `proposed`, `weight`, `origin`, `confidence`, `expires`,
 *    `learned_from.sessions`, `adopted_at`, `retired_*` or `displaces`. `origin` in particular is
 *    assigned from the path the loader read, and writing it is itself an error finding.
 */
function renderClause(candidate, today) {
    const bar = (n) => `${(n / 1000).toFixed(1)}s`;
    const front = [
        '---',
        `id: ${candidate.id}`,
        'status: proposed',
        `level: ${candidate.level}`,
        'evidence: EXTRACTED',
        `support: ${candidate.support.occurrences}`,
        `contradictions: ${candidate.contradictions}`,
        `learned_at: ${today}`,
        'learned_from:',
        `  decisions: [${candidate.evidence.join(', ')}]`,
        '---',
        '',
    ];
    const table = [
        `### Intention: ${candidate.title}`,
        '',
        '| Field | Value |',
        '| --- | --- |',
        `| id | ${candidate.id} |`,
        `| level | ${candidate.level} |`,
        `| scope | ${TIER_DIR[candidate.tier]}/${candidate.scope} |`,
        `| added | ${today} |`,
        `| tags | learned, ${candidate.signal}, ${candidate.level === 'yellow' ? 'gap' : 'latency'} |`,
        '',
        `Match: \`${candidate.match[0]}\``,
        '',
    ];
    // The rationale is template-generated and no model is involved. It clears
    // `RATIONALE_MIN_CHARS` (80) by an order of magnitude, which is the point: a clause whose *why* is
    // gone cannot be deleted without risking a regression, and that is how a corpus becomes permanent.
    const isGap = candidate.level === 'yellow';
    const prose = [
        `Observed ${candidate.support.occurrences} times across ${candidate.support.sessions} `
            + `session(s) between ${candidate.firstSeen.slice(0, 10)} and `
            + `${candidate.lastSeen.slice(0, 10)}, `
            + (isGap
                ? 'and on every one of them this layer returned no verdict at all — no clause matched, so '
                    + 'nothing judged the call in either direction.'
                : 'always allowed, never contradicted by a written rule.'),
    ];
    if (isGap) {
        prose.push('This clause does not permit anything and cannot. A yellow with no fix sits above the '
            + 'learned green rung and below the learned red one, so the only thing it can do to a decision '
            + 'is withhold an allow a *learned* green would have granted and send the call to a human. It '
            + 'can never take away a permission a human wrote, and it can never turn a denial into an '
            + 'allow. Accepting it wrongly costs a prompt that should not have appeared; deleting it undoes '
            + 'that completely.');
    }
    if (candidate.failClosed > 0 && !isGap) {
        prose.push(`${candidate.failClosed} call(s) on this shape were denied fail-closed because no `
            + `clause covered them, costing ${bar(candidate.failClosedLatencyMs)} before the developer `
            + 'retried.');
    }
    if (candidate.modelDecided > 0 && !isGap) {
        prose.push(`${candidate.modelDecided} were decided by the classifier at `
            + `${bar(candidate.modelLatencyMs)} of model time that a written clause makes free.`);
    }
    prose.push(`Observed variants: ${candidate.variants.map(v => `\`${v}\``).join(', ')}.`);
    // A team clause binds people who did not write it, so the one thing a reviewer cannot be left to
    // guess is where the second developer's evidence came from. The counts above are this host's; the
    // witnesses are named by their published label, and what each of them published is a hash of this
    // clause's shape and three counts — no command line from any other machine is quoted here or
    // anywhere else, because none crossed the boundary.
    if (candidate.tier === 'team') {
        prose.push(`Witnessed independently on ${candidate.witnessHosts.length} other host(s) `
            + `(${candidate.witnessHosts.join(', ')}), each of which cleared the whole user row on its own `
            + `counts for shape \`${candidate.shape12}\`. Per-host counts are never summed: this host's `
            + `${candidate.support.occurrences} occurrences clear the team row by themselves, and the `
            + 'witnesses answer a different question — whether anyone else does this too. Recompute '
            + '`sha256("<tool>\\0<segment>")[0..12]` over the shape above to check a witness row refers to '
            + 'this clause.');
    }
    if (generalise_1.PATH_TOOLS.has(candidate.tool)) {
        prose.push('The matcher is anchored at the start of the '
            + `\`${generalise_1.PATH_TOOLS.get(candidate.tool)}\` value and requires a \`/\` immediately after the `
            + `directory, so it ${isGap ? 'covers' : 'licenses'} files under it and cannot reach a sibling `
            + 'whose name merely starts the same way — `infra/prod` does not match '
            + '`infra/production-notes/`. It is at least '
            + `${mine_1.PATH_FLOOR_SEGMENTS} path segments below the working directory, because a shorter prefix `
            + 'is a *wider* rule and a single top-level directory is the whole tree.');
        prose.push('This is a **textual guard, not a filesystem one.** It matches the path string the '
            + 'tool was asked to write, never the file that string resolves to. A directory inside the tree '
            + 'that is a symlink out of it defeats it, and one created after this clause was accepted is '
            + 'not visible to it at all. `assertWritable` in `src/supervisor/learnedClauses.ts` is the only '
            + 'filesystem boundary in this system; this clause is not a substitute for it and must not be '
            + 'read as one. What the miner did check is that every path in the evidence resolved to where '
            + 'it was written at the time it was mined.');
    }
    else {
        prose.push('The matcher is anchored at the start of the command value and ends on a word '
            + `boundary, so it ${isGap ? 'covers' : 'licenses'} arguments to this command and nothing `
            + 'else; a compound line is decomposed into its constituents before matching, so it cannot '
            + 'reach a second command on the same line.');
    }
    prose.push('Counts are scoped to the decision-trail window, which rotates at 4 MiB keeping one '
        + `generation${candidate.windowRotated ? ' and had rotated when this was mined' : ''}, so `
        + 'earlier occurrences may exist and are not counted here.');
    prose.push(`Proposed by the deterministic miner, emission rule ${exports.EMISSION_RULE}. No model was `
        + 'consulted; support is historical evidence, not consent.');
    return [...front, ...table, wrap(prose.join(' ')), ''].join('\n');
}
const TIER_DIR = { team: 'teams', project: 'projects', user: 'users' };
/** Hard-wrap prose at 98 columns so a clause file reads in a terminal and diffs line by line. */
function wrap(text, width = 98) {
    const out = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
        if (line === '') {
            line = word;
            continue;
        }
        if (line.length + 1 + word.length > width) {
            out.push(line);
            line = word;
            continue;
        }
        line += ` ${word}`;
    }
    if (line !== '') {
        out.push(line);
    }
    return out.join('\n');
}
/**
 * Write one clause file, or refuse to.
 *
 * Three properties, in the order they matter:
 *
 *  1. **`assertWritable` first, and it throws.** A throw means the run writes nothing at all, which
 *     is what makes a partial proposal impossible rather than merely unlikely.
 *  2. **The status guard is the whole suppression mechanism.** An existing file whose parsed status
 *     is not `proposed` is never overwritten. A file that cannot be parsed at all is also never
 *     overwritten: we cannot confirm it is `proposed`, and fail-closed means refusing.
 *  3. **tmp + fsync + rename**, so no reader ever sees a half-parsed clause.
 *
 * Overwriting an existing `proposed` file with a re-derived candidate is the normal, correct path.
 * Support counts *are* refreshed by it, because the file is rewritten wholesale from the current
 * fold and its `proposed` status keeps it inert either way. A clause's `weight` is the thing that
 * must never move after accept, and this pipeline never writes one.
 */
function writeClause(corpusRoot, candidate, body) {
    const rel = (0, learnedClauses_1.learnedClausePath)(candidate.tier, candidate.scope, candidate.id);
    const target = path.join(corpusRoot, ...rel.split('/'));
    (0, learnedClauses_1.assertWritable)(corpusRoot, target, candidate.id);
    let existed = false;
    try {
        const current = fs.readFileSync(target, 'utf8');
        existed = true;
        if (statusOf(current) !== 'proposed') {
            return { outcome: 'status-guard', file: rel };
        }
    }
    catch (err) {
        const code = err.code;
        // `ENOTDIR` means some *parent* of the target is not a directory, so there is no clause file here
        // and there never was one: a broken corpus root has to surface as an error rather than as a
        // suppression, which would read like a human had declined something.
        //
        // Anything else — a file we can see and cannot read — is refused. We cannot confirm it is
        // `proposed`, and overwriting a `declined` file would release a permanent suppression.
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
            return { outcome: 'status-guard', file: rel };
        }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeSync(fd, body);
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    return { outcome: existed ? 'overwritten' : 'written', file: rel };
}
/**
 * The `status` of an existing clause file, as the loader would read it, or null.
 *
 * Reuses `parseFrontmatter` rather than a regex so that the writer and the loader cannot disagree
 * about what a file's status is — a disagreement here would silently release a suppression.
 */
function statusOf(text) {
    const { frontmatter } = (0, learnedClauses_1.parseFrontmatter)(text, '(existing)');
    const raw = frontmatter?.scalars.status ?? null;
    return raw !== null && learnedClauses_1.CLAUSE_STATUSES.includes(raw) ? raw : null;
}
/**
 * Turn ablation reports into retirement proposals.
 *
 * **A retirement writes no clause file at all.** The permitted output is `learned/<id>.md` at
 * `status: proposed`, and a retirement file would be a clause that is not a clause — no `Match:`,
 * nothing to enforce, and `status: retired` is outside the permitted set. It also changes no policy
 * until a human acts, so it belongs entirely in the run record. This asymmetry with merge is
 * deliberate; do not "fix" it into a file write.
 *
 * ## The condition is one comparison, and it is not the obvious boolean
 *
 * `evidence_class === 'retire'`, never `AblationReport.retirement_candidate`. That field is
 * `changed === 0 && !isSafetyLevel(level)` (`ablate.ts:400`), which is **broader**: a *shadowed*
 * green has `retirement_candidate: true` and `evidence_class: 'shadowed'`, and `ablateAll` iterates
 * that broader set. Keying off the boolean would propose bare retirement for exactly the clauses
 * `SHADOWED_NOTE` says to narrow instead.
 *
 * And it needs no level check of its own, because `classify` partitions the enum **by level**:
 * `retire` is reachable only for a green or a yellow, and `dead-weight?` only for a red or an orange.
 * The enum already enforces "never auto-propose retiring a red"; `RED_NOT_PROPOSED` stays as defence
 * in depth and as the line a reviewer reads, not as the mechanism.
 */
function planRetirements(reports, windowRotated) {
    const plan = { retirements: [], redundancies: [], listings: [] };
    for (const report of reports) {
        switch (report.evidence_class) {
            case 'retire':
                plan.retirements.push({
                    target: report.clause_id,
                    tier: report.tier,
                    level: report.level,
                    evidence_class: report.evidence_class,
                    evidence: report.evidence,
                    // Every green retirement carries this verbatim: the grant may already be persisted in
                    // Claude Code's own settings, where our hook is never consulted, so retiring the clause
                    // does not retire the grant.
                    note: report.level === 'green'
                        ? `${ablate_1.GREEN_PERSISTENCE_NOTE}`
                        : (report.note ?? ''),
                    windowRotated,
                });
                break;
            case 'shadowed':
                plan.redundancies.push({
                    target: report.clause_id,
                    tier: report.tier,
                    level: report.level,
                    shadowed_by: report.shadowed_by ?? null,
                    note: `${ablate_1.SHADOWED_NOTE}${report.level === 'red' || report.level === 'orange'
                        ? ` ${ablate_1.RED_NOT_PROPOSED}` : ''}`,
                });
                break;
            case 'dead-weight?':
            case 'deterrent':
            case 'insufficient-exposure':
                plan.listings.push({
                    target: report.clause_id,
                    level: report.level,
                    evidence_class: report.evidence_class,
                    why: `${report.evidence} ${ablate_1.RED_NOT_PROPOSED}`,
                });
                break;
            default:
                break; // `in-service`: nothing to decide
        }
    }
    plan.retirements = plan.retirements.slice(0, exports.MAX_RETIREMENTS);
    return plan;
}
/** Reviewer-fatigue cap, the same kind as {@link MAX_RETIREMENTS}. */
exports.MAX_MERGES = 10;
exports.MERGE_NON_WIDENING = 'The kept clause\'s matched set is a proven superset of the dropped clause\'s, at the same level '
    + 'and in the same tier, so the pair decides exactly what the kept clause alone decides: retiring '
    + 'the dropped clause removes no verdict. Containment is proved on the pattern text — substring '
    + 'containment, or the token prefix of the anchored command form this pipeline emits — and never '
    + 'by a regex prover, so a pair whose relationship cannot be proved is reported as nothing at all '
    + 'rather than as a merge.';
/** The literal parts of {@link commandMatcher}'s output, so this module can read back its own shape. */
const ANCHOR_HEAD = '"command"\\s*:\\s*"';
const ANCHOR_TAIL = '(?=[\\s"\\\\])';
/**
 * What a matcher is, for containment purposes — or null when nothing can be proved about it.
 *
 * `anywhere` is a plain substring matcher: it matches anywhere in the haystack. `command` is the
 * anchored form this module emits, recognised by *parsing back its own literal parts* rather than by
 * proving anything about a general regex. Any other regex is unprovable and returns null, which is
 * the whole reason a containment prover is safe to have here at all.
 *
 * The comparison string is `escapeForMatcher`'s output in both cases, so one substring test serves
 * both: it is a per-character homomorphism with whitespace runs collapsed to `\s+`, and `\s+` matches
 * a prefix or a suffix of a longer run, so an alignment found in the escaped text is an alignment
 * that holds in every string the pattern matches. Lower-cased because `compileMatcher` forces `i`
 * onto every matcher it builds, substring and regex alike.
 */
function shapeOf(m) {
    if (!m.isRegex) {
        const esc = (0, practices_1.escapeForMatcher)(m.raw).toLowerCase();
        return esc === '' ? null : { kind: 'anywhere', esc };
    }
    if (!m.raw.startsWith(ANCHOR_HEAD) || !m.raw.endsWith(ANCHOR_TAIL)) {
        return null;
    }
    const esc = m.raw.slice(ANCHOR_HEAD.length, m.raw.length - ANCHOR_TAIL.length).toLowerCase();
    return esc === '' ? null : { kind: 'command', esc };
}
/** `L(a) ⊇ L(b)`, proved, or null. */
function subsumesMatcher(a, b) {
    const sa = shapeOf(a);
    const sb = shapeOf(b);
    if (sa === null || sb === null) {
        return null;
    }
    if (sa.kind === 'anywhere') {
        // A substring found anywhere in the haystack, so it is enough that it occurs inside the other
        // pattern's text — including inside an anchored matcher's command literal.
        return sb.esc.includes(sa.esc) ? (sa.esc === sb.esc ? 'identical' : 'substring') : null;
    }
    // An anchored matcher constrains the *start* of the command value, so it cannot subsume a matcher
    // that is free to match anywhere.
    if (sb.kind !== 'command') {
        return null;
    }
    if (sa.esc === sb.esc) {
        return 'identical';
    }
    // A longer command prefix matches strictly fewer commands — but only when the extra text starts on
    // a token boundary. `np` does not subsume `npm test`: nothing after `np` in `npm` is whitespace,
    // so the shorter matcher's own lookahead refuses the very command the longer one accepts.
    const rest = sb.esc.startsWith(sa.esc) ? sb.esc.slice(sa.esc.length) : '';
    return rest.startsWith('\\s+') ? 'command-prefix' : null;
}
/**
 * `L(a) ⊇ L(b)` over whole clauses: every one of `b`'s patterns is subsumed by one of `a`'s.
 *
 * A clause with no patterns is refused on both sides. Vacuous truth is the failure mode here — "every
 * pattern of `b` is covered" is trivially true of a prose clause, and a prose clause matches nothing,
 * so treating it as subsumed would propose retiring text on the strength of it having no matchers.
 */
function subsumesClause(a, b) {
    if (a.patterns.length === 0 || b.patterns.length === 0) {
        return null;
    }
    const proofs = [];
    for (const pb of b.patterns) {
        let best = null;
        for (const pa of a.patterns) {
            const proof = subsumesMatcher(pa, pb);
            if (proof !== null) {
                best = proof;
                break;
            }
        }
        if (best === null) {
            return null;
        }
        proofs.push(best);
    }
    if (proofs.every(p => p === 'identical') && a.patterns.length === b.patterns.length) {
        return 'identical';
    }
    return proofs.includes('command-prefix') ? 'command-prefix' : 'substring';
}
/**
 * Every provable same-level, same-tier containment in the corpus, at most one finding per dropped
 * clause.
 *
 * Two properties are what keep the findings from forming the state #60 refuses to compile:
 *
 *  - **At most one finding names any clause as `drop`.** Otherwise a reviewer is asked to retire the
 *    same clause three times, once per clause that covers it.
 *  - **Mutual containment is broken by id, keeping the lower.** Two clauses whose patterns say the
 *    same thing each subsume the other, and emitting both directions is a two-cycle: accept both and
 *    the rule disappears entirely, which is the annihilation `supersessionCycles` exists to refuse.
 *    Across the *kinds* of proof mutual containment cannot arise — an anchored matcher never subsumes
 *    a free substring — so this only ever fires on genuinely equal languages.
 */
function findSubsumptions(corpus) {
    const ordered = [...corpus].sort((a, b) => a.clauseId.localeCompare(b.clauseId));
    const out = [];
    const dropped = new Set();
    for (const drop of ordered) {
        // Only a machine's clause is ever dropped. `Clause.origin` absent means `human` and that default
        // is the safe one — everything `parsePractices` reads is a human's `bottom-line.md`.
        if ((drop.origin ?? 'human') !== 'learned') {
            continue;
        }
        if (drop.level === null) {
            continue;
        }
        for (const keep of ordered) {
            if (keep.clauseId === drop.clauseId || dropped.has(drop.clauseId)) {
                continue;
            }
            // Same level is what makes containment sufficient (see the section above), same tier is what
            // makes "both are loaded together" true.
            if (keep.level !== drop.level || keep.tier !== drop.tier) {
                continue;
            }
            const proof = subsumesClause(keep, drop);
            if (proof === null) {
                continue;
            }
            // Equal languages: keep the lower id, so the pair yields one finding rather than a two-cycle.
            if (subsumesClause(drop, keep) !== null
                && keep.clauseId.localeCompare(drop.clauseId) > 0) {
                continue;
            }
            const proposed = !(0, ablate_1.isSafetyLevel)(drop.level);
            out.push({
                keep: keep.clauseId,
                drop: drop.clauseId,
                tier: drop.tier,
                level: drop.level,
                proof,
                proposed,
                note: proposed ? exports.MERGE_NON_WIDENING : `${exports.MERGE_NON_WIDENING} ${ablate_1.RED_NOT_PROPOSED}`,
            });
            dropped.add(drop.clauseId);
        }
    }
    return out.slice(0, exports.MAX_MERGES);
}
