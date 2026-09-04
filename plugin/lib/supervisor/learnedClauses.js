// GENERATED FILE — DO NOT EDIT.
// Compiled from src/supervisor/learnedClauses.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * Learned clauses — the machine lane of the knowledge corpus, and the loader half of the schema.
 *
 * A learned clause is one file:
 *
 *     data/knowledge/<teams|projects|users>/<slug>/learned/<id>.md
 *
 * with a restricted frontmatter block carrying provenance, and a body that is a *verbatim*
 * `bottom-line.md` entry. That split is the whole design:
 *
 *   - the body is parsed by `parseBottomLine`, unchanged, so there is exactly one definition of
 *     what an entry is and what a citation looks like. The frontmatter carries only what the body
 *     cannot express;
 *   - `origin` is assigned from the *path the loader read*, never from a field. A machine writes
 *     the file, so it can write any field value it likes — but it cannot write the directory the
 *     loader chose to walk. An `origin:` key in a learned file lands in `extra`, is ignored, and is
 *     reported by name, because writing it means somebody thought it would work;
 *   - `bottom-line.md` is untouched. Nothing here parses it, moves it, or re-validates it. An
 *     absent `learned/` directory reads as zero clauses, via the same rule that makes a missing
 *     tier file a non-error (`knowledge.ts:14`).
 *
 * The loader is also where the corpus finally gets *validation*. Today `parseBottomLine` cannot
 * fail — every field is `meta.x ?? null` — so a malformed entry becomes a silently wrong one: a
 * `level: PURPLE` rule the author believed was red is simply unenforced. For clauses under
 * `learned/` that is not acceptable, because a cron job writes them and no human reads every one.
 * So every malformed input here produces a *named finding*, and a file with an `error` finding is
 * skipped rather than loaded wrong — the rest of the tier, and every other tier, still loads.
 *
 * Design spec: `10-schema.md` §1.4 (body reuse), §2 (fields and consumers), §2.5 (rationale),
 * §3.2 (authorship is the path), §3.3 (the ladder), §3.3.2 (the write boundary), §4.4 (retirement).
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
exports.LADDER_RUNGS = exports.RATIONALE_MIN_CHARS = exports.CLAUSE_STATUSES = void 0;
exports.hasErrors = hasErrors;
exports.isEnforceable = isEnforceable;
exports.isMatched = isMatched;
exports.rendersIntoPrompt = rendersIntoPrompt;
exports.parseFrontmatter = parseFrontmatter;
exports.didYouMean = didYouMean;
exports.rationaleOf = rationaleOf;
exports.parseLearnedClause = parseLearnedClause;
exports.learnedDir = learnedDir;
exports.learnedClausePath = learnedClausePath;
exports.isSafeId = isSafeId;
exports.readLearnedDir = readLearnedDir;
exports.assertWritable = assertWritable;
exports.assertAggregateWritable = assertAggregateWritable;
exports.realpathOf = realpathOf;
exports.compareLadder = compareLadder;
exports.sortByLadder = sortByLadder;
exports.onRung = onRung;
exports.decideByLadder = decideByLadder;
exports.auditVerdicts = auditVerdicts;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const knowledge_1 = require("./knowledge");
const corrections_1 = require("../policy/corrections");
/** The canonical vocabulary. Exported so a test can pin it — it has drifted apart once already. */
exports.CLAUSE_STATUSES = [
    'proposed', 'audit', 'accepted', 'declined', 'superseded', 'retired',
];
const RETIRED_REASONS = ['ablation', 'displacement', 'manual'];
const CLAUSE_WEIGHTS = ['high', 'medium', 'low'];
const EVIDENCE_TAGS = ['EXTRACTED', 'INFERRED', 'AMBIGUOUS'];
const CLAUSE_LEVELS = ['red', 'orange', 'yellow', 'green'];
function hasErrors(findings) {
    return findings.some(f => f.severity === 'error');
}
// --------------------------------------------------------------------------- status semantics
/**
 * Enforceable: the clause can decide. Only `accepted`, and that is the point — a proposal must
 * never be able to affect a decision, so the check is a whitelist of one, not a blacklist that a
 * new status could quietly fall through.
 */
function isEnforceable(status) {
    return status === 'accepted';
}
/**
 * Matched deterministically. `audit` is here and nowhere else: a clause in a trial is loaded,
 * matched, and its would-be verdict recorded, while contributing *nothing* to the outcome
 * (Kyverno's `failureAction: Audit`).
 */
function isMatched(status) {
    return status === 'accepted' || status === 'audit';
}
/**
 * Rendered into the classifier's prompt. `accepted` only — deliberately excluding `audit`, because
 * a clause the model can read influences the outcome, which is the opposite of audit. An audit
 * trial therefore costs zero prompt tokens and cannot break the cached prefix.
 *
 * Corollary, worth stating because it is a real state: a prose-only clause (no `Match:` line) in
 * `audit` is *inert* — not rendered because it is not accepted, not matchable because it has no
 * pattern. The same clause at `accepted` is advisory.
 */
function rendersIntoPrompt(status) {
    return status === 'accepted';
}
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/;
/**
 * Parse the restricted frontmatter subset. Returns null (with findings) rather than throwing, so
 * a caller collecting problems across a whole directory reports all of them in one pass.
 */
function parseFrontmatter(text, file) {
    const findings = [];
    const err = (line, message) => {
        findings.push({ severity: 'error', file, line, message });
    };
    const lines = text.split('\n');
    if (lines[0]?.trim() !== '---') {
        err(1, 'a learned clause must open with a `---` frontmatter fence');
        return { frontmatter: null, findings };
    }
    let close = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') {
            close = i;
            break;
        }
    }
    if (close === -1) {
        err(1, 'unterminated frontmatter: no closing `---`');
        return { frontmatter: null, findings };
    }
    const fm = {
        scalars: {}, lists: {},
        nested: { scalars: {}, lists: {} },
        lines: {},
        body: lines.slice(close + 1).join('\n'),
    };
    /** The one nested block, once we are inside it, and whether we have already had one. */
    let nestedKey = null;
    let nestedBlocks = 0;
    for (let i = 1; i < close; i++) {
        const raw = lines[i];
        const lineNo = i + 1;
        if (raw.trim() === '') {
            continue;
        }
        if (raw.startsWith('#')) {
            continue;
        }
        if (raw.includes('\t')) {
            err(lineNo, 'tab in frontmatter: indent with two spaces');
            continue;
        }
        const indent = raw.length - raw.replace(/^ +/, '').length;
        const content = raw.slice(indent);
        if (content.startsWith('#')) {
            err(lineNo, '`#` starts a comment only at the start of a line');
            continue;
        }
        if (content.startsWith('- ') || content === '-') {
            err(lineNo, 'block lists are not supported: write `key: [a, b]` on one line');
            continue;
        }
        if (content.startsWith('"') || content.startsWith('\'')) {
            err(lineNo, 'quoted keys are not supported');
            continue;
        }
        const m = KEY_RE.exec(content);
        if (!m) {
            err(lineNo, `not a \`key: value\` line: ${JSON.stringify(content.slice(0, 60))}`);
            continue;
        }
        const key = m[1];
        const rest = m[2].trim();
        if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
            err(lineNo, `multi-line scalars (\`${rest}\`) are not supported: keep the value on one line`);
            continue;
        }
        if (rest.startsWith('&') || rest.startsWith('*')) {
            err(lineNo, 'anchors and aliases are not supported');
            continue;
        }
        if (indent === 0) {
            nestedKey = null;
        }
        else if (indent === 2 && nestedKey !== null) {
            // a child of the nested block — handled below
        }
        else if (indent === 2) {
            err(lineNo, `indented \`${key}\` has no parent block`);
            continue;
        }
        else {
            err(lineNo, `unexpected indent of ${indent} spaces: nested keys are indented exactly two`);
            continue;
        }
        const target = indent === 0 ? fm : fm.nested;
        const scope = indent === 0 ? '' : `${nestedKey}.`;
        if (`${scope}${key}` in fm.lines) {
            err(lineNo, `duplicate key \`${key}\``);
            continue;
        }
        fm.lines[`${scope}${key}`] = lineNo;
        if (rest === '') {
            if (indent !== 0) {
                err(lineNo, `\`${key}\` has no value`);
                continue;
            }
            // An empty top-level value opens the one nested block.
            if (nestedBlocks > 0) {
                err(lineNo, `\`${key}\`: only one nested block is supported`);
                continue;
            }
            if (key !== 'learned_from') {
                err(lineNo, `\`${key}\` has no value (the one nested block is \`learned_from\`)`);
                continue;
            }
            nestedBlocks++;
            nestedKey = key;
            continue;
        }
        if (rest.startsWith('[')) {
            if (!rest.endsWith(']')) {
                err(lineNo, `\`${key}\`: an inline list must close its \`]\` on the same line`);
                continue;
            }
            target.lists[key] = rest.slice(1, -1).split(',').map(s => s.trim()).filter(s => s.length > 0);
        }
        else if (rest.endsWith(']')) {
            err(lineNo, `\`${key}\`: an inline list must open with \`[\``);
        }
        else {
            target.scalars[key] = rest;
        }
    }
    return { frontmatter: findings.some(f => f.severity === 'error') ? null : fm, findings };
}
// --------------------------------------------------------------------------- clause parse
/** Every key the schema knows. Anything else is preserved in `extra` and reported by name. */
const KNOWN_KEYS = new Set([
    'id', 'status', 'level', 'evidence', 'support', 'contradictions', 'weight',
    'learned_at', 'adopted_at', 'expires', 'supersedes', 'displaces',
    'fix_from', 'fix_to', 'learned_from',
    'retired_at', 'retired_reason', 'retired_by',
]);
/** The two known keys that must be an inline list. Every other known key is a scalar. */
const LIST_KEYS = new Set(['supersedes', 'displaces']);
/**
 * Typo suggestions worth making, because a typo'd name is indistinguishable from no name. Takes
 * the candidate set so a caller with its own vocabulary — `compile.ts` matching a `supersedes`
 * against the clause ids in the corpus — reuses this instead of growing a second one.
 */
function didYouMean(key, candidates = KNOWN_KEYS) {
    for (const known of candidates) {
        if (known === key) {
            continue;
        }
        // One transposition, substitution, insertion or deletion apart is worth suggesting.
        if (nearlyEqual(key, known)) {
            return known;
        }
    }
    return null;
}
/**
 * One edit apart: a substitution, an insertion, a deletion, or a transposition. The last one is
 * why this is not a plain edit distance — `levle` for `level` is the typo people actually make,
 * and it is two substitutions away, so a Levenshtein-1 check would miss exactly the case that
 * matters (a typo'd field is indistinguishable from an absent one).
 */
function nearlyEqual(a, b) {
    if (Math.abs(a.length - b.length) > 1) {
        return false;
    }
    let i = 0;
    let j = 0;
    let budget = 1;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            i++;
            j++;
            continue;
        }
        if (budget-- === 0) {
            return false;
        }
        if (a.length !== b.length) {
            if (a.length > b.length) {
                i++;
            }
            else {
                j++;
            }
        }
        else if (a[i] === b[j + 1] && a[i + 1] === b[j]) {
            i += 2;
            j += 2; // transposition
        }
        else {
            i++;
            j++; // substitution
        }
    }
    return budget >= 0;
}
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The rationale: the body prose with the title and any `Match:` lines removed. */
function rationaleOf(entry) {
    return entry.text
        .split('\n')
        .filter(l => !/^\s*Match:/i.test(l.trim()))
        .join('\n')
        .trim();
}
/**
 * The floor a rationale has to clear.
 *
 * ponytail: 80 chars is a floor against an empty or title-restating body, not a quality gate.
 * Judging whether a reason is *good* is the reviewer's job and cannot be automated here.
 * Upgrade path if the floor is gamed: require the body to survive a title-similarity check.
 */
exports.RATIONALE_MIN_CHARS = 80;
/**
 * The four rules a `fix` on a learned clause must satisfy (F1–F4).
 *
 * A `fix` is the largest grant in the schema: it does not permit a call, it *changes what runs*, and
 * the agent believes it ran what it asked for. Everything else here is a permission; this is an edit.
 * So the bar is not "a bit more evidence than a green" — it is a different shape of bar, and three of
 * the four rules have no analogue on any other level.
 *
 *  - **F1 — a `fix` belongs to `level: yellow` and nowhere else.** `directionOf` reads a yellow's fix
 *    as the thing that flips it from narrowing to widening (`replay.ts:229`), so on any other level
 *    the field has no direction and no consumer: a `fix` on a red or a green would be carried into
 *    the artifact and the selector and silently never applied.
 *
 *  - **F2 — the rewrite must be one the shipped correction table already performs.** The check is a
 *    *call into the real correction lane*: `applyCorrection('Bash', { command: from })` must return
 *    exactly `to`. This is the structural answer to "a machine must not author a rewrite nobody
 *    reviewed" — the set of rewrites a learned clause may carry is, by construction, exactly the set
 *    of rewrites in `CORRECTION_RULES`, which is hand-written, hand-reviewed, and covered by
 *    `corrections.test.ts`. A miner, a tampered file or a hand edit cannot widen that set without
 *    editing reviewed TypeScript, which is a different review with different owners.
 *
 *  - **F3 — a fix-carrying clause may not be `accepted`.** Nothing in the runtime applies a clause
 *    `fix`: `applyCorrection` reads its own table, and `permissionRequest.ts` never consults
 *    `clause.fix`. An `accepted` fix-carrying clause would therefore be matched and never applied —
 *    exactly the silently-unenforced state that keeps `orange` out of the level enum. `audit` is the
 *    highest status it can reach, which is also the whole review asymmetry: a learned green becomes
 *    enforceable by a human flipping one word, and a learned rewrite cannot become enforceable at
 *    all until the rewrite consumer ships with its own review.
 *
 *  - **F4 — at `audit`, the evidence must be extracted and uncontradicted.** A trial that puts a
 *    rewrite in front of live traffic may not rest on an *inferred* derivation, and may not run on a
 *    shape something has already decided the other way. `contradictions` must be written out: absent
 *    reads as 0 everywhere else in this file, and the optimistic default is not good enough here.
 */
function checkFix(fix, level, status, evidenceRaw, contradictionsRaw, err, at) {
    if (level !== 'yellow') {
        err(at('fix_from'), `F1: a \`fix\` is only meaningful on \`level: yellow\` (this clause is `
            + `\`${level ?? 'prose'}\`). A fix decides a yellow's direction and has no consumer on any `
            + 'other level, so it would be carried into the artifact and never applied');
    }
    const reproduced = (0, corrections_1.applyCorrection)('Bash', { command: fix.from });
    if (reproduced === null || reproduced.updatedInput.command !== fix.to) {
        err(at('fix_to'), `F2: this rewrite is not one the correction table performs. `
            + `\`${fix.from}\` -> \`${reproduced === null ? '(no rule matched)'
                : String(reproduced.updatedInput.command)}\`, not \`${fix.to}\`. A learned clause may only `
            + 'carry a rewrite that `src/policy/corrections.ts` already produces, so no machine and no '
            + 'hand edit can introduce a rewrite that was never reviewed as one');
    }
    if (status === 'accepted') {
        err(at('status'), 'F3: a clause carrying a `fix` may not be `accepted` — nothing in the runtime '
            + 'applies a clause `fix`, so an accepted one would be matched and never applied. `audit` is '
            + 'the highest status a rewrite can reach until the rewrite consumer ships');
    }
    if (status === 'audit') {
        if (evidenceRaw !== 'EXTRACTED') {
            err(at('evidence'), `F4: a rewrite may only be trialled on extracted evidence, not `
                + `\`${evidenceRaw ?? 'none'}\` — an inferred derivation is not a basis for editing `
                + 'somebody\'s command line');
        }
        if (contradictionsRaw !== '0') {
            err(at('contradictions'), `F4: a rewrite trial requires \`contradictions: 0\` written out `
                + `(this says \`${contradictionsRaw ?? 'nothing'}\`). Absent reads as 0 everywhere else in `
                + 'this schema, and the optimistic default is not good enough for a clause that edits a call');
        }
    }
}
/**
 * Parse one learned clause file.
 *
 * `sourceFile` is the repo-relative path, and it is authoritative: `origin` comes from it, and the
 * `id` must equal its basename so that the citable id and the path can never disagree.
 */
function parseLearnedClause(text, tier, sourceFile) {
    const { frontmatter, findings } = parseFrontmatter(text, sourceFile);
    const err = (line, message) => {
        findings.push({ severity: 'error', file: sourceFile, line, message });
    };
    const warn = (line, message) => {
        findings.push({ severity: 'warn', file: sourceFile, line, message });
    };
    if (!frontmatter) {
        return { clause: null, findings };
    }
    const at = (key) => frontmatter.lines[key] ?? null;
    const scalar = (key) => frontmatter.scalars[key] ?? null;
    const list = (key) => frontmatter.lists[key] ?? [];
    // ---- shape: a known key given in the wrong form (`supersedes: old`, `status: [accepted]`) has
    // `scalar()`/`list()` read it as absent, so without this it would be silently dropped instead of
    // failing loud — the one thing this frontmatter grammar exists not to do.
    for (const key of Object.keys(frontmatter.lists)) {
        if (KNOWN_KEYS.has(key) && !LIST_KEYS.has(key)) {
            err(at(key), `\`${key}\` must be a scalar (\`${key}: value\`), not a list`);
        }
    }
    for (const key of Object.keys(frontmatter.scalars)) {
        if (LIST_KEYS.has(key)) {
            err(at(key), `\`${key}\` must be an inline list (\`${key}: [a, b]\`), not a scalar`);
        }
    }
    // ---- body first: no heading means there is no clause at all.
    const entries = (0, knowledge_1.parseBottomLine)(frontmatter.body, tier, sourceFile);
    if (entries.length === 0) {
        err(null, 'no clause body: expected a `### Belief|Desire|Intention: <title>` heading');
        return { clause: null, findings };
    }
    if (entries.length > 1) {
        err(null, `${entries.length} entries in one file: a learned clause is one clause per file`);
    }
    const entry = entries[0];
    // ---- id, and its agreement with the filename
    const base = path.posix.basename(sourceFile).replace(/\.md$/, '');
    const id = scalar('id');
    if (id === null) {
        err(at('id'), 'missing `id`: a learned clause with no id cannot be cited or superseded');
    }
    else if (id !== base) {
        err(at('id'), `\`id: ${id}\` disagrees with the filename \`${base}.md\``);
    }
    // ---- status
    const statusRaw = scalar('status');
    let status = 'proposed';
    if (statusRaw === null) {
        // Defaulting to `proposed` would be friendlier and wrong: a missing status must never be the
        // one that ships. So it is an error — and the value it takes meanwhile is the inert one.
        err(at('status'), 'missing `status`: a learned clause must say whether it has been accepted');
    }
    else if (!exports.CLAUSE_STATUSES.includes(statusRaw)) {
        err(at('status'), `unknown \`status: ${statusRaw}\` (expected one of ${exports.CLAUSE_STATUSES.join(', ')})`);
    }
    else {
        status = statusRaw;
    }
    // ---- level. An unrecognised level normalizes to null *and* is an error: silently unenforcing
    // a rule its author believed was red is the failure this validation exists to stop.
    const levelRaw = scalar('level')?.trim().toLowerCase() ?? null;
    let level = null;
    if (levelRaw !== null && levelRaw !== '') {
        if (!CLAUSE_LEVELS.includes(levelRaw)) {
            err(at('level'), `unknown \`level: ${levelRaw}\` (expected red, orange, yellow or green)`);
        }
        else if (levelRaw === 'orange') {
            // `orange` still has no rung, and the reason is the same one that used to exclude `yellow`:
            // an accepted clause that matches and can never be selected is silently unenforced, which is
            // indistinguishable from an unrecognised level. `yellow` now has rung 4 (see
            // {@link LADDER_RUNGS}); `orange` does not, and inventing one would mean inventing a runtime
            // meaning for it that no code has.
            err(at('level'), `\`level: ${levelRaw}\` is not enforceable for a learned clause `
                + '(the ladder has red, yellow and green rungs — not orange)');
        }
        else {
            level = levelRaw;
        }
    }
    const learnedFrom = {
        sessions: frontmatter.nested.lists.sessions ?? [],
        decisions: frontmatter.nested.lists.decisions ?? [],
    };
    for (const key of [...Object.keys(frontmatter.nested.lists), ...Object.keys(frontmatter.nested.scalars)]) {
        if (key !== 'sessions' && key !== 'decisions') {
            warn(at(`learned_from.${key}`), `unknown \`learned_from.${key}\` — the block carries `
                + '`sessions` and `decisions`');
        }
    }
    const hasEvidenceTrail = learnedFrom.sessions.length > 0 || learnedFrom.decisions.length > 0;
    // ---- evidence, required exactly when there is an extraction to describe.
    //
    // `evidence` says how a *machine* derived the clause, so it is required whenever `learned_from`
    // names sources — and forbidden when it does not. A hand-parked clause had no extraction, so no
    // enum value is truthful for it, and demanding one would make the field lie in exactly the case a
    // reviewer most needs to trust it.
    const evidenceRaw = scalar('evidence');
    let evidence = null;
    if (evidenceRaw !== null && !EVIDENCE_TAGS.includes(evidenceRaw)) {
        err(at('evidence'), `unknown \`evidence: ${evidenceRaw}\` (expected ${EVIDENCE_TAGS.join(', ')})`);
    }
    else if (evidenceRaw !== null && !hasEvidenceTrail) {
        err(at('evidence'), `\`evidence: ${evidenceRaw}\` with no \`learned_from\` sources: evidence `
            + 'describes an extraction, and there is none to describe');
    }
    else if (evidenceRaw === null && hasEvidenceTrail) {
        err(at('learned_from'), 'missing `evidence`: a clause with `learned_from` sources must say how '
            + `it was derived (${EVIDENCE_TAGS.join(', ')})`);
    }
    else if (evidenceRaw !== null) {
        evidence = evidenceRaw;
    }
    const count = (key) => {
        const raw = scalar(key);
        if (raw === null) {
            return 0;
        }
        if (!/^\d+$/.test(raw)) {
            err(at(key), `\`${key}: ${raw}\` is not a whole number`);
            return 0;
        }
        return Number(raw);
    };
    const support = count('support');
    const contradictions = count('contradictions');
    const weightRaw = scalar('weight');
    let weight = 'low';
    if (weightRaw !== null) {
        if (CLAUSE_WEIGHTS.includes(weightRaw)) {
            weight = weightRaw;
        }
        else {
            err(at('weight'), `unknown \`weight: ${weightRaw}\` (expected ${CLAUSE_WEIGHTS.join(', ')})`);
        }
    }
    if (scalar('contradictions') === null) {
        // A missing count is the *optimistic* reading, so it is worth saying out loud.
        warn(null, 'no `contradictions` count — absent reads as 0, which is the optimistic assumption');
    }
    const date = (key) => {
        const raw = scalar(key);
        if (raw === null) {
            return null;
        }
        if (!ISO_DATE_RE.test(raw)) {
            err(at(key), `\`${key}: ${raw}\` is not an ISO date (YYYY-MM-DD)`);
            return null;
        }
        return raw;
    };
    // ---- fix: both or neither. One without the other is a rewrite lane that cannot rewrite.
    const fixFrom = scalar('fix_from');
    const fixTo = scalar('fix_to');
    let fix = null;
    if (fixFrom !== null && fixTo !== null) {
        fix = { from: fixFrom, to: fixTo };
    }
    else if (fixFrom !== null || fixTo !== null) {
        err(at(fixFrom === null ? 'fix_to' : 'fix_from'), '`fix_from` and `fix_to` are both-or-neither: one without the other cannot rewrite anything');
    }
    if (fix !== null) {
        checkFix(fix, level, status, evidenceRaw, scalar('contradictions'), err, at);
    }
    // ---- retirement: three fields set together, and only together (§4.4).
    const retiredAt = date('retired_at');
    const retiredByRaw = scalar('retired_by');
    const retiredReasonRaw = scalar('retired_reason');
    let retiredReason = null;
    if (retiredReasonRaw !== null) {
        if (RETIRED_REASONS.includes(retiredReasonRaw)) {
            retiredReason = retiredReasonRaw;
        }
        else {
            err(at('retired_reason'), `unknown \`retired_reason: ${retiredReasonRaw}\` (expected ${RETIRED_REASONS.join(', ')})`);
        }
    }
    if (status === 'retired') {
        if (retiredReason === null && retiredReasonRaw === null) {
            err(at('status'), '`status: retired` requires `retired_reason` — '
                + '"why did this rule go away" is precisely what the corpus must not lose');
        }
        if ((retiredReason === 'ablation' || retiredReason === 'displacement') && retiredByRaw === null) {
            err(at('retired_reason'), `\`retired_reason: ${retiredReason}\` requires \`retired_by\` naming what justified it`);
        }
        if (retiredAt === null && scalar('retired_at') === null) {
            // Warn here, error at the compile: the split follows the one already settled for a malformed
            // file — a load keeps the rest of the tier, and the compile is what refuses to emit an
            // artifact. TODO (`policy compile`): make this an error there.
            warn(null, '`status: retired` with no `retired_at` — the retirement is absent from churn reporting');
        }
    }
    else if (retiredReasonRaw !== null || retiredByRaw !== null || retiredAt !== null) {
        err(at('retired_reason') ?? at('retired_by') ?? at('retired_at'), `retirement fields are set but \`status\` is \`${status}\``);
    }
    // ---- the rationale. Mandatory, for every clause under `learned/`, machine-proposed or not.
    const rationale = rationaleOf(entry);
    if (rationale.length < exports.RATIONALE_MIN_CHARS) {
        err(null, `no rationale: ${rationale.length} characters of prose, ${exports.RATIONALE_MIN_CHARS} required. `
            + 'A clause whose *why* is gone cannot be deleted without risking a regression, which is how '
            + 'a corpus becomes permanent');
    }
    // ---- unknown keys: preserved, never dropped, and named.
    const extra = {};
    for (const [key, value] of Object.entries(frontmatter.scalars)) {
        if (KNOWN_KEYS.has(key)) {
            continue;
        }
        extra[key] = value;
        if (key === 'origin') {
            // Not a load failure — the clause loads, as `learned`, from the path. But writing the key
            // means somebody believed a file could declare its own authorship, so say so by name.
            err(at('origin'), '`origin` is not a field: it is assigned from the path the loader read. '
                + `This clause is \`learned\` because it lives under \`learned/\`, whatever \`origin: ${value}\` says`);
        }
        else {
            const near = didYouMean(key);
            warn(at(key), `unknown field \`${key}\`${near === null ? '' : ` — did you mean \`${near}\`?`}`);
        }
    }
    for (const [key, value] of Object.entries(frontmatter.lists)) {
        if (!KNOWN_KEYS.has(key)) {
            extra[key] = `[${value.join(', ')}]`;
            const near = didYouMean(key);
            warn(at(key), `unknown field \`${key}\`${near === null ? '' : ` — did you mean \`${near}\`?`}`);
        }
    }
    // ---- the hand-parked case. Keyed on an empty `learned_from` (no sessions, no decisions), *not*
    // on the body: parking a clause under `learned/` to give it lower precedence is legitimate, so
    // it can only ever be an info.
    if (!hasEvidenceTrail) {
        findings.push({
            severity: 'info', file: sourceFile, line: at('learned_from'),
            message: 'no `learned_from` evidence — a hand-written clause belongs in `bottom-line.md`, '
                + 'where it outranks machine-proposed clauses',
        });
    }
    const clause = {
        id: id ?? base,
        status,
        level,
        evidence,
        support,
        contradictions,
        weight,
        learnedAt: date('learned_at'),
        adoptedAt: date('adopted_at'),
        expires: date('expires'),
        supersedes: list('supersedes'),
        displaces: list('displaces'),
        fix,
        learnedFrom,
        retiredAt,
        retiredReason,
        retiredBy: retiredByRaw,
        extra,
        entry,
        rationale,
        origin: 'learned',
        tier,
        sourceFile,
    };
    return { clause, findings };
}
// --------------------------------------------------------------------------- the walk
const TIER_DIR = { team: 'teams', project: 'projects', user: 'users' };
/** In-repo directory holding one tier's learned clauses. */
function learnedDir(tier, slug) {
    return path.posix.join('data', 'knowledge', TIER_DIR[tier], slug, 'learned');
}
/**
 * The one function in the pipeline that produces a write path (§3.3.2). Everything that writes a
 * learned clause routes through it, so the path and the citable id cannot drift apart.
 */
function learnedClausePath(tier, slug, id) {
    if (!isSafeId(id)) {
        throw new Error(`unsafe clause id: ${JSON.stringify(id)}`);
    }
    return path.posix.join(learnedDir(tier, slug), `${id}.md`);
}
/** An id is a slug: it becomes a filename, so it may not carry path syntax. */
function isSafeId(id) {
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes('..') && !id.endsWith('.');
}
/**
 * Read one tier's `learned/` directory.
 *
 * An absent directory reads as zero clauses and no findings — the same rule that makes a missing
 * `bottom-line.md` a non-error. Files are walked in sorted order so the result is deterministic,
 * and only `*.md` is read.
 *
 * This reads a real directory, so it works against a local checkout. `fetchBdiFiles`'s git-URL path
 * fetches three named files into a temp clone it then deletes, and there is no directory left to
 * walk — TODO: the clone path needs a directory listing before learned clauses can load from a
 * remote corpus. Deliberately not built here: `10-schema.md` §5 makes the compiled artifact the
 * thing the runtime loads, and the compile runs where the checkout is.
 */
function readLearnedDir(corpusRoot, tier, slug) {
    const dir = learnedDir(tier, slug);
    const result = { clauses: [], findings: [], dir, exists: false };
    if (!slug) {
        return result;
    }
    const full = path.join(corpusRoot, ...dir.split('/'));
    let names;
    try {
        names = fs.readdirSync(full).filter(n => n.endsWith('.md')).sort();
    }
    catch (e) {
        // Absent is a non-error (see above). Anything else — a permission error, an IO error, a
        // `learned/` that exists but is not a directory — must not degrade into an empty policy the
        // same way an unreadable individual file (below) must not: it is a named error, not a skip.
        if (e.code === 'ENOENT') {
            return result;
        }
        result.findings.push({ severity: 'error', file: dir, line: null, message: `unreadable: ${String(e)}` });
        return result;
    }
    result.exists = true;
    for (const name of names) {
        const rel = path.posix.join(dir, name);
        let text;
        try {
            text = fs.readFileSync(path.join(full, name), 'utf8');
        }
        catch (e) {
            // A file we can see but cannot read is an error, never a skip: a configured-but-unreadable
            // policy source must not degrade into an empty policy.
            result.findings.push({ severity: 'error', file: rel, line: null, message: `unreadable: ${String(e)}` });
            continue;
        }
        const parsed = parseLearnedClause(text, tier, rel);
        result.findings.push(...parsed.findings);
        // A malformed file is skipped and named; every other clause in the tier still loads. Failing
        // the whole tier would remove the *other* reds too, which is worse than losing the broken file
        // — and the compile refuses to emit an artifact while any error stands, so nothing ships half
        // a corpus.
        if (parsed.clause && !hasErrors(parsed.findings)) {
            result.clauses.push(parsed.clause);
        }
    }
    return result;
}
// --------------------------------------------------------------------------- the write boundary
/**
 * Refuse anything the pipeline is not allowed to write. Called on every write, no exceptions.
 *
 * The trust model rests on the path carrying the authority (§3.2), so the write surface is an
 * enforced invariant rather than a convention. Four losses, each a real way the invariant could go:
 *
 *   1. a target that is not under a `learned/` directory of `<corpusRoot>/data/knowledge/*&#47;*` —
 *      in particular `bottom-line.md`, which would let a machine claim human authorship;
 *   2. a filename that is not `<id>.md`, which would let the path and the citation disagree;
 *   3. a traversal or symlink escape — the check runs on the fully resolved real path, not the
 *      string, so a `learned/` symlinked out of the corpus is caught;
 *   4. a corpus root other than the configured one, because the default knowledge repo is a tree
 *      the supervised agent can write.
 *
 * It throws, and a throw means the run writes nothing. A partial proposal is worse than none.
 */
function assertWritable(corpusRoot, target, id) {
    const refuse = (why) => {
        throw new Error(`refusing to write ${JSON.stringify(target)}: ${why}`);
    };
    if (!isSafeId(id)) {
        refuse(`unsafe clause id ${JSON.stringify(id)}`);
    }
    const root = realpathOf(path.resolve(corpusRoot));
    const resolved = realpathOf(path.resolve(target));
    const rel = path.relative(root, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        refuse(`it resolves to ${JSON.stringify(resolved)}, outside the configured corpus root `
            + `${JSON.stringify(root)}`);
    }
    const parts = rel.split(path.sep);
    // data / knowledge / <teams|projects|users> / <slug> / learned / <id>.md
    if (parts.length !== 6
        || parts[0] !== 'data' || parts[1] !== 'knowledge'
        || !Object.values(TIER_DIR).includes(parts[2])
        || parts[3] === '' || parts[4] !== 'learned') {
        refuse('only `data/knowledge/<teams|projects|users>/<slug>/learned/<id>.md` is writable');
    }
    if (parts[5] !== `${id}.md`) {
        refuse(`the filename must be \`${id}.md\`, so the path can never disagree with the citable id`);
    }
}
/**
 * The other thing the pipeline may write: this machine's own cross-machine aggregate, and only its
 * own (`policy/aggregates.ts`).
 *
 * Same three losses as {@link assertWritable}, checked the same way and for the same reason — the
 * path carries the authority, so it is an enforced invariant rather than a convention. The fourth
 * check is the one specific to this file: **the filename must be `<host>.json` for the host label
 * being published.** That is what makes "one host, one file" a property of the write rather than a
 * habit of the caller, and it is what a reviewer and `ci/check-aggregates.sh` both rely on to know
 * whose counts they are reading. It does not authenticate anybody: see that module's header.
 */
function assertAggregateWritable(corpusRoot, target, host) {
    const refuse = (why) => {
        throw new Error(`refusing to write ${JSON.stringify(target)}: ${why}`);
    };
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(host) || host.includes('..') || host.length > 64) {
        refuse(`unsafe host label ${JSON.stringify(host)}`);
    }
    const root = realpathOf(path.resolve(corpusRoot));
    const resolved = realpathOf(path.resolve(target));
    const rel = path.relative(root, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        refuse(`it resolves to ${JSON.stringify(resolved)}, outside the configured corpus root `
            + `${JSON.stringify(root)}`);
    }
    const parts = rel.split(path.sep);
    // data / aggregates / <host>.json
    if (parts.length !== 3 || parts[0] !== 'data' || parts[1] !== 'aggregates') {
        refuse('only `data/aggregates/<host>.json` is writable');
    }
    if (parts[2] !== `${host}.json`) {
        refuse(`the filename must be \`${host}.json\`, so one host can only ever write one file`);
    }
}
/**
 * Resolve symlinks as far as the path exists, then re-append the part that does not.
 *
 * A target file that does not exist yet is the *normal* case for a write, so `realpathSync` on the
 * whole path would always throw. Resolving the deepest existing ancestor — and following a
 * *dangling* symlink by hand, because `realpathSync` refuses one — is what makes a `learned/`
 * or a target file symlinked outside the corpus detectable before the write instead of after it.
 */
function realpathOf(p, depth = 0) {
    try {
        return fs.realpathSync(p);
    }
    catch { /* some component does not exist yet */ }
    // A symlink loop: refuse to chase it further. Returning the unresolved path here would hand
    // `assertWritable` a path it has not actually resolved, which is exactly the write-boundary
    // bypass this function exists to prevent.
    if (depth > 8) {
        throw new Error(`symlink loop resolving ${JSON.stringify(p)}`);
    }
    // The recursive call below must sit OUTSIDE this try: it would otherwise catch the depth>8
    // throw from a deeper frame and mistake it for "not there at all", swallowing the loop refusal.
    let link = null;
    try {
        if (fs.lstatSync(p).isSymbolicLink()) {
            link = fs.readlinkSync(p);
        }
    }
    catch { /* not there at all, so nothing to follow */ }
    if (link !== null) {
        return realpathOf(path.resolve(path.dirname(p), link), depth + 1);
    }
    const parent = path.dirname(p);
    if (parent === p) {
        return p;
    }
    return path.join(realpathOf(parent, depth), path.basename(p));
}
const ORIGIN_RANK = { human: 0, learned: 1 };
const LEVEL_RANK = { red: 0, green: 1, orange: 2, yellow: 3 };
/**
 * The total order the ladder evaluates in: `(origin, level, tier, id)`.
 *
 * `origin` outranks `level`, and that is the one surprising thing in this file, so it is defended
 * here as well as in the spec: **a machine proposal never overrides a human's explicit practice,
 * in either direction.** Not to permit what a human forbade, and not to forbid what a human
 * permitted. The alternative — a learned red beating a human green — means one bad extraction
 * halts a team's work overnight, citing a clause nobody wrote, with no human in the loop at the
 * moment it happens. The failure it prevents has a human remedy that already exists: if the human
 * green is wrong, a human changes it, in a PR, with a diff.
 *
 * It is not fail-open. A learned red still fires on every call no *human* clause covers, which is
 * the overwhelming majority, and the engine's built-in destructive-action table is untouched. And
 * within one origin the pessimistic ordering holds: red precedes green, because a matcher has to
 * break the tie somehow and safety is the only defensible way.
 *
 * Tier is narrower-first (user > project > team), then id, so the order is total: two clauses
 * identical but for their id have a stable, documented winner.
 *
 * This is the *reporting* order and the tie-break **within** a rung; {@link LADDER_RUNGS} is the
 * selection order, and the two differ for `yellow` — `LEVEL_RANK` sorts it last while its rung sits
 * between red and green. That is harmless because `decideByLadder` iterates rungs outermost, so this
 * comparator only ever orders clauses that are already on the same rung.
 */
function compareLadder(a, b) {
    return (ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin])
        || ((LEVEL_RANK[a.level ?? ''] ?? 9) - (LEVEL_RANK[b.level ?? ''] ?? 9))
        || ((knowledge_1.TIER_PRECEDENCE[b.tier] ?? 0) - (knowledge_1.TIER_PRECEDENCE[a.tier] ?? 0))
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function sortByLadder(clauses) {
    return [...clauses].sort(compareLadder);
}
/**
 * Which rung a clause sits on, in evaluation order. `human red` → `learned green`.
 *
 * `origin` still leads, unchanged and for the unchanged reason: a machine proposal never overrides a
 * human's explicit practice in either direction (see {@link compareLadder}).
 *
 * **Where the yellow rung went, and why.** A yellow is two clauses wearing one level: with a `fix`
 * it is a *widening* and without one a *narrowing* (`directionOf`, `replay.ts:229`). Putting both on
 * one rung would place a rewrite and its opposite at the same authority, so they are separated by
 * the `hasFix` discriminator and only the narrowing one has a rung:
 *
 *  - **learned yellow with no fix sits above learned green** (rung 4, before rung 5). Its whole
 *    effect is to *withhold* an allow a learned green would have granted and send the call to a
 *    human, so it has to be reached before the clause it withholds or it can never fire. Above a
 *    learned green and below a learned red is the only position where it is both reachable and
 *    incapable of licensing anything: it cannot outrank a human clause (origin leads), it cannot
 *    turn a red into an allow (red is rung 3), and the worst it can do is add friction, which is
 *    reversible and visible.
 *
 *  - **learned yellow *with* a fix has no rung, deliberately.** A rewrite is the largest grant in
 *    the system — it silently changes what runs — so its rung would have to be the *last* one, after
 *    every other authority has passed. But no rung is the honest answer today: nothing in the
 *    runtime applies a clause `fix` (`applyCorrection` reads its own table), so a rung here would be
 *    a rung `decideByLadder` could select onto and then do nothing with. That is the same
 *    silently-unenforced failure that keeps `orange` out of the level enum, which is why F3
 *    (`checkFix`) refuses `status: accepted` for a fix-carrying clause instead. When a rewrite
 *    consumer ships, its rung goes at the end of this list — `{ origin: 'learned', level: 'yellow',
 *    hasFix: true }` — and F3 is what must be relaxed, in the same reviewed change.
 *
 * A *human* yellow has no rung either. That is pre-existing and out of scope here: the human lane's
 * yellow is served by the correction lane (`permissionRequest.ts` rung 2) and by the classifier, and
 * giving it a rung is a change to human-authored policy semantics, not to the machine lane.
 */
exports.LADDER_RUNGS = [
    { origin: 'human', level: 'red' },
    { origin: 'human', level: 'green' },
    { origin: 'learned', level: 'red' },
    { origin: 'learned', level: 'yellow', hasFix: false },
    { origin: 'learned', level: 'green' },
];
/** Whether a clause sits on this rung. The `hasFix` half is what separates the two yellows. */
function onRung(clause, rung) {
    return clause.origin === rung.origin
        && clause.level === rung.level
        && (rung.hasFix === undefined || (clause.fix != null) === rung.hasFix);
}
/**
 * Walk the four rungs and return the first clause that decides, or null.
 *
 * `matches` is injected because pattern matching belongs to the clause matcher, not here.
 *
 * TODO: `src/policy/practices.ts`'s `findMatchingClause` (unmerged) is the intended `matches`, and
 * `src/hooks/permissionRequest.ts`'s `decideOne` is the intended caller — this replaces rungs 3
 * and 4 of that ladder with four. Both live on branches this module's base does not have.
 */
function decideByLadder(clauses, matches) {
    // Only an enforceable clause may decide. `audit` is matched (see `auditVerdicts`) but cannot
    // change the outcome, and a `proposed`, `rejected`, `superseded`, `retired` or `deprecated`
    // clause is not consulted at all.
    const live = sortByLadder(clauses.filter(c => isEnforceable(c.status)));
    for (const rung of exports.LADDER_RUNGS) {
        for (const clause of live) {
            if (onRung(clause, rung) && matches(clause)) {
                return { clause, level: rung.level };
            }
        }
    }
    return null;
}
/**
 * The would-be verdicts of every `audit` clause that matched.
 *
 * Recorded on the decision, and that is all: the decision is made exactly as if these clauses were
 * absent. A candidate red in audit lets the call proceed — the status quo, so no new risk — and a
 * candidate green in audit changes nothing either. What it produces is a log of what the clause
 * *would* have done on live traffic, which is the only honest way to earn a promotion.
 */
function auditVerdicts(clauses, matches) {
    return sortByLadder(clauses.filter(c => c.status === 'audit'))
        .filter(c => matches(c))
        .map(c => ({ clause: c, wouldBeLevel: c.level }));
}
