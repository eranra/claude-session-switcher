// GENERATED FILE — DO NOT EDIT.
// Compiled from src/cli/learn.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * `session-sitter learn` — sessions in, reviewed practices out.
 *
 * The command that closes the write path. It reads the decision trail, finds the calls that cost
 * somebody work because no written rule covered them, and writes one `status: proposed` clause file
 * per pattern that clears the support bars — for a human to accept, decline, or ignore, in a PR.
 *
 * **No model is called on this path, at all.** Every number in the output is counted or measured:
 * occurrences, distinct sessions, calendar days, and `replay.ts`'s blast radius over the real
 * decisions on disk. `session-sitter learn --json` reports `model.calls: 0` and a test asserts it.
 *
 *     session-sitter learn                 propose from the trail, write proposed clause files
 *     session-sitter learn --dry-run       everything except the writes
 *     session-sitter learn --accumulate    fold new records only (what `SessionEnd` runs)
 *     session-sitter learn --status        the last five run lines from `pipeline.jsonl`
 *     session-sitter learn --quiet         no output; the identical code path, for a scheduler
 *     session-sitter learn --publish       write this machine's aggregate for the team tier to merge
 *
 * `--publish` is the opt-in that makes team tier reachable at all, and it is deliberately the only
 * thing in this file that writes outside `learned/`. It writes counts — a shape hash and three
 * numbers per shape, no command line, no `cwd`, no prose — and it does **not** run git: the human
 * commits the file, so nothing this process does ships anything anywhere. See
 * `policy/aggregates.ts` for what crosses the boundary and what the one-file-per-host rule does and
 * does not prevent.
 *
 * Exit codes follow the rest of the CLI: 0 answered, 1 something it needed was missing or broke,
 * 2 the arguments were wrong — plus 2 when another `learn` holds the lock, which is a statement about
 * the run rather than about the arguments and is the one place the two overlap.
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
exports.instructionText = instructionText;
exports.run = run;
exports.selfHostLabels = selfHostLabels;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const args_1 = require("./args");
const export_1 = require("./export");
const aggregates_1 = require("../policy/aggregates");
const mine_1 = require("../policy/mine");
const settings_1 = require("../hooks/settings");
const permissionRequest_1 = require("../hooks/permissionRequest");
const trail_1 = require("../audit/trail");
const paths_1 = require("../hooks/paths");
const ablate_1 = require("../policy/ablate");
const citations_1 = require("../policy/citations");
const pipeline_1 = require("../policy/pipeline");
const FLAGS = {
    '--accumulate': 'boolean',
    '--publish': 'boolean',
    '--allow-host-names': 'boolean',
    '--dry-run': 'boolean',
    '--status': 'boolean',
    '--quiet': 'boolean',
    '--no-retire': 'boolean',
    '--json': 'boolean',
    '--help': 'boolean',
    '-h': 'boolean',
};
const USAGE = `session-sitter learn — propose practices from the decision trail

Usage:
  session-sitter learn [options]

Options:
  --accumulate   fold new records and stop (what the SessionEnd hook runs)
  --publish      write this machine's aggregate to <corpus>/data/aggregates/<host>.json
                 and stop. Opt-in, per developer: it is what lets another machine's
                 \`learn\` see that somebody else independently does the same thing, and
                 it is the only way a team-tier clause can ever be proposed.
                 Counts only — a shape hash and three numbers per shape. No command
                 line, no working directory, no prose. It does not run git; commit the
                 file yourself, in a PR your team reviews.
  --allow-host-names
                 publish the real short hostname instead of a per-machine pseudonym.
                 Off by default: a hostname identifies a person's laptop.
  --dry-run      run every gate and every replay, write no files
  --status       print the last five pipeline runs
  --no-retire    skip ablation, so no retirement is proposed
  --quiet        print nothing; same code path, for an unattended trigger
  --json         print the run line instead of the summary
  -h, --help     this

Everything it writes is \`status: proposed\` under the corpus's \`learned/\` directories, which is
inert: a proposed clause cannot decide, cannot be matched and cannot reach the prompt. A human
accepts it in a PR, or declines it — and a declined file is never re-proposed.
`;
/**
 * The repo instruction files already in the classifier's context on every call.
 *
 * A clause restating one of these is pure duplicated instruction against a budget the research says
 * collapses, so a candidate that does it is suppressed and counted. The line falls exactly where
 * first-party draws it for itself: `CLAUDE.md` and `.claude/rules/` are repo-resident, git-tracked,
 * human-authored and *already in the prompt*, so reading them is reading the policy we are adding to.
 * The per-project `memory/` directory under `~/.claude` is none of those, and is **never opened** —
 * not here, not anywhere on this path.
 */
function instructionText(cwd) {
    const parts = [];
    const add = (file) => {
        try {
            parts.push(fs.readFileSync(file, 'utf8'));
        }
        catch { /* absent is normal */ }
    };
    add(path.join(cwd, 'CLAUDE.md'));
    const rules = path.join(cwd, '.claude', 'rules');
    try {
        for (const name of fs.readdirSync(rules).sort()) {
            if (name.endsWith('.md')) {
                add(path.join(rules, name));
            }
        }
    }
    catch { /* no rules directory */ }
    return parts.length === 0 ? undefined : parts.join('\n');
}
async function run(argv, io) {
    const args = (0, args_1.parseFlags)(argv, FLAGS);
    if (args.positional.length > 0) {
        throw new args_1.CliError(`learn takes no arguments, got "${args.positional[0]}"`);
    }
    if ((0, args_1.flagBool)(args, '--help') || (0, args_1.flagBool)(args, '-h')) {
        io.out(USAGE);
        return 0;
    }
    const json = (0, args_1.flagBool)(args, '--json');
    const quiet = (0, args_1.flagBool)(args, '--quiet');
    const say = (text) => { if (!quiet) {
        io.out(`${text}\n`);
    } };
    if ((0, args_1.flagBool)(args, '--status')) {
        const runs = (0, pipeline_1.recentRuns)(5);
        if (json) {
            io.out(`${JSON.stringify(runs, null, 2)}\n`);
            return 0;
        }
        if (runs.length === 0) {
            say('session-sitter: `learn` has never run — no pipeline.jsonl yet');
            return 0;
        }
        for (const line of runs) {
            say(statusRow(line));
        }
        return 0;
    }
    if ((0, args_1.flagBool)(args, '--accumulate')) {
        const result = (0, pipeline_1.accumulate)('cli');
        if (json) {
            io.out(`${JSON.stringify(result.line, null, 2)}\n`);
            return 0;
        }
        say(result.nudge ?? result.line.headline);
        return result.line.exitReason === 'error' ? 1 : 0;
    }
    // Fold first, so `learn` never proposes from a stale aggregate. It is the same offset-driven fold
    // the hook runs, so a session that ended without its hook firing costs nothing here either.
    (0, pipeline_1.accumulate)('cli');
    const settings = (0, settings_1.loadSettings)();
    const corpusRoot = settings.supervisor.knowledgeLocalRepo;
    if (!corpusRoot) {
        throw new args_1.CliError('no corpus checkout configured: set KNOWLEDGE_LOCAL_REPO to the '
            + 'checkout containing `data/knowledge/`. Nothing can be proposed without somewhere to '
            + 'propose it', 1);
    }
    const raw = (0, args_1.flagBool)(args, '--allow-host-names');
    if ((0, args_1.flagBool)(args, '--publish')) {
        return publish(corpusRoot, raw, io, say, json);
    }
    const inputs = await (0, permissionRequest_1.loadPolicyInputs)(settings);
    const records = (0, trail_1.readJsonl)((0, paths_1.decisionsPath)());
    // Ablation measures against the corpus *as it is now*, not against what the trail recorded, and it
    // is the only thing that can say a clause has gone dead. Skippable because it is the slowest part
    // of the run and it proposes nothing that writes a file.
    const ablations = (0, args_1.flagBool)(args, '--no-retire') || records.length === 0
        ? []
        // `accumulate('cli')` above has just folded the citation counter, so this is the freshest lifetime
        // count available. Without it a clause that fired for months before the last rotation reads as
        // `insufficient-exposure` or `dead-weight?` instead of `deterrent`.
        : (0, ablate_1.ablateAll)(inputs.clauses, records, { citations: (0, citations_1.lifetimeCitations)() });
    const { line, written, exitCode } = (0, pipeline_1.propose)({
        settings,
        corpusRoot,
        corpus: inputs.clauses,
        rev: inputs.rev,
        trigger: 'cli',
        ablations,
        retire: !(0, args_1.flagBool)(args, '--no-retire'),
        instructionText: instructionText(process.cwd()),
        dryRun: (0, args_1.flagBool)(args, '--dry-run'),
        // Both labels this machine could have published under, so its own aggregate can never be
        // mistaken for another developer's — `--allow-host-names` must not be able to create a
        // self-witness by changing which name the file is under.
        selfHosts: selfHostLabels(),
    });
    if (json) {
        io.out(`${JSON.stringify(line, null, 2)}\n`);
        return exitCode;
    }
    for (const text of summarise(line, written, (0, args_1.flagBool)(args, '--dry-run'))) {
        say(text);
    }
    return exitCode;
}
/** Both labels this machine could have published under: pseudonymous, and raw under the opt-in. */
function selfHostLabels(env = process.env) {
    const host = os.hostname();
    const key = (0, export_1.hmacKey)(env);
    return [(0, aggregates_1.hostLabel)(host, key, false), (0, aggregates_1.hostLabel)(host, key, true)];
}
/**
 * `--publish`: this machine's counts into the corpus working tree, and the git commands printed for
 * the human to run.
 *
 * Printing the commands rather than running them is the whole safety property. Publishing is a claim
 * about the team that a person has to make; a process that pushed on its own would be silent egress
 * of derived work data, which is how tools get banned from a company.
 */
function publish(corpusRoot, raw, io, say, json) {
    const aggregate = (0, aggregates_1.buildAggregate)((0, mine_1.readShapes)(), (0, aggregates_1.hostLabel)(os.hostname(), (0, export_1.hmacKey)(), raw), io.now());
    const rel = (0, aggregates_1.publishAggregate)(corpusRoot, aggregate);
    if (json) {
        io.out(`${JSON.stringify({ file: rel, host: aggregate.host, shapes: aggregate.shapes.length }, null, 2)}\n`);
        return 0;
    }
    say(`wrote ${rel} — ${aggregate.shapes.length} shape(s) that cleared the user row on this `
        + `machine, as host ${aggregate.host}`);
    say('');
    say('Counts only: a shape hash and three numbers each. No command line, no working directory,');
    say('no prose. Nothing has been sent anywhere — review the diff, then commit it yourself:');
    say('');
    say(`    git -C ${corpusRoot} add ${rel}`);
    say(`    git -C ${corpusRoot} commit -m 'aggregates: ${aggregate.host}'`);
    say('');
    say('One commit touches one aggregate file: yours. `ci/check-aggregates.sh` checks that, which');
    say('catches a mistake and an audit trail, not a determined forger — a team clause still needs a');
    say('human to accept it.');
    return 0;
}
function statusRow(line) {
    return `${line.ts}  ${line.stage.padEnd(10)} ${line.exitReason.padEnd(28)} ${line.headline}`;
}
/** The report a human reads. Leads with what changed, then with why nothing else did. */
function summarise(line, written, dryRun) {
    const out = [line.headline, ''];
    if (line.exitReason === 'calibration-failed' || line.exitReason === 'error') {
        out.push(line.error ?? 'the run failed and did not say why, which is itself a bug');
        return out;
    }
    if (line.exitReason === 'lock-held') {
        return [line.headline];
    }
    if (line.proposals.clauses.length === 0) {
        out.push(`Nothing proposed: ${WHY[line.exitReason] ?? line.exitReason}.`);
    }
    for (const clause of line.proposals.clauses) {
        out.push(`+ ${clause.id}`);
        out.push(`    ${clause.tier}/${clause.scope} · ${clause.level} · ${clause.signal} · `
            + `support ${clause.support}`);
    }
    for (const file of written) {
        out.push(`    wrote ${file}`);
    }
    if (dryRun && line.proposals.clauses.length > 0) {
        out.push('    (dry run — nothing written)');
    }
    for (const r of line.proposals.retirements) {
        out.push(`− ${r.target} (${r.evidence_class}) — proposed for retirement, no file written`);
    }
    for (const m of line.proposals.merges) {
        out.push(`${m.proposed ? '=' : '?'} ${m.drop} — subsumed by ${m.keep} (${m.proof}), `
            + `${m.proposed ? 'proposed for retirement, no file written'
                : 'listed only: a safety clause is never disarmed by the pipeline'}`);
    }
    for (const r of line.proposals.redundancies) {
        out.push(`? ${r.target} — redundant with ${r.shadowed_by ?? 'another rung'}: narrow it or `
            + 'delete it');
    }
    const bits = [];
    if (line.clusters.belowFloor > 0) {
        bits.push(`${line.clusters.belowFloor} below the floor`);
    }
    if (line.suppressed.statusGuard > 0) {
        bits.push(`${line.suppressed.statusGuard} suppressed by a human's own decision`);
    }
    if (line.suppressed.alreadyInClaudeMd > 0) {
        bits.push(`${line.suppressed.alreadyInClaudeMd} already stated in a repo instruction file`);
    }
    if (line.suppressed.failedReplay > 0) {
        bits.push(`${line.suppressed.failedReplay} refused by replay`);
    }
    if (line.suppressed.proseOnly > 0) {
        bits.push(`${line.suppressed.proseOnly} with no derivable matcher`);
    }
    if (line.candidates.held > 0) {
        bits.push(`${line.candidates.held} held back by the per-run cap`);
    }
    if (bits.length > 0) {
        out.push('', `Shapes: ${bits.join(', ')}.`);
    }
    if (line.window.rotated) {
        out.push('The trail had rotated, so counts are scoped to the window that survives and earlier '
            + 'occurrences may exist.');
    }
    out.push('', `Every proposal is inert until a human accepts it. ${line.model.calls} model call(s).`);
    return out;
}
const WHY = {
    'no-input': 'nothing has been supervised yet, so there is no trail to mine',
    'no-shape-cleared-floor': 'no repeated pattern cleared the support bars',
    'all-candidates-failed-replay': 'every candidate would have reversed a settled decision',
    'all-candidates-suppressed': 'every candidate was suppressed',
    'caps-hit': 'the per-run cap was reached',
};
