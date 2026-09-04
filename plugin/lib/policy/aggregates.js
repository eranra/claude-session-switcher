// GENERATED FILE — DO NOT EDIT.
// Compiled from src/policy/aggregates.ts by scripts/build-plugin-lib.js (`make plugin`).
// Edit the TypeScript source and re-run `make plugin`; CI fails if this tree is stale.
"use strict";
/**
 * The cross-machine witness: how a team-tier clause becomes proposable, and exactly what crosses
 * the machine boundary to make it so.
 *
 * ## The problem this closes
 *
 * `DecisionRecord` has no `user` field, because one `dataDir` is one machine and one user by
 * construction (`hooks/paths.ts`). So "two developers independently hit this" is not a measurable
 * proposition from a single laptop, at any threshold — which is why `tierFor` could never return
 * `team`, and why the tier that binds people who did not write it was the one tier no evidence
 * could reach. That is a structural limit, not a bar set too high, so the fix has to add a *source*
 * of cross-user evidence rather than lower a number.
 *
 * The source is an **opt-in per-host aggregate**, committed to the corpus by a human running
 * `session-sitter learn --publish`. Team-tier mining is then a merge over the committed aggregates.
 *
 * ## Property 1 — per-host counts are cleared, never summed
 *
 * 11 occurrences on one host plus 1 on another is one developer's habit with a witness. So there is
 * no addition anywhere in this module: {@link witnessHostsFor} asks each host's row whether it
 * *independently* clears the whole `user` row (≥3 occurrences, ≥3 distinct sessions, ≥2 calendar
 * days) and counts hosts, not events. The team bars then apply on top, to the proposing host's own
 * locally-measured support — see `mine.ts`'s `tierFor`. The result is strictly stronger than any
 * summed floor: every witnessing host has cleared the user row on its own, and the proposer has
 * cleared 12/8/14 plus 90 % confinement on its own.
 *
 * The bars are re-checked **on read**, not trusted from the file. {@link buildAggregate} only ever
 * writes rows that clear, so a row that does not clear is either hand-edited or from a future
 * version — and in both cases the honest answer is that it is not a witness.
 *
 * ## Property 2 — a fingerprint and a count is the whole payload
 *
 * This crosses a machine boundary, so the observability projection rule applies (15-observability-v2
 * §5): **drop keys, never blank them.** The payload is built by naming the four keys a row keeps, so
 * every other key is *absent* from the bytes rather than present-and-empty. Nothing derived from a
 * human's own text — `ask`, `note`, `inputSummary`, `original_input`, `session_name`, assessment
 * prose — has any path into this file, and neither does `cwd`, which carries a home directory and a
 * repo name. Masking would not help: `redactSecrets` matches credential *shapes* and cannot know
 * that a URL names a customer.
 *
 * ### The fingerprint question, answered explicitly
 *
 * A hash of the shape is not a leak; the *normalised command* is one. `canonicalSegment` is only
 * two tokens (`git push`), but its second token is any word that does not start with `-` — so
 * `curl https://payments-internal.example/v2/customers/BigCo` canonicalises with the URL still
 * attached. `export.ts`'s `toolShape` filters exactly that with `BARE_WORD`; a naive aggregate
 * would ship it. So a witness row carries **`shape12` only** — `sha256(tool \0 segment)[0..12]`,
 * the same 12 hex that already names every clause id.
 *
 * But a pure hash cannot be read by a human, and the whole point is that a human reviews the
 * proposal. The resolution is an asymmetry between the two roles a host plays:
 *
 *  - The **proposing** host contributes the human-readable shape, in the clause file it writes —
 *    which is its own two-token shape, about its own work, committed by its own operator, and no
 *    more than a project-tier proposal from the same host already puts in the corpus today.
 *  - **Witnessing** hosts contribute `shape12` plus three counts, and nothing else. No host's
 *    command lines are published to the team.
 *
 * A reviewer sees enough because `shape12` is *verifiable*: it is unsalted and deterministic, so
 * anyone reading the proposal can recompute `shapeHash(tool, segment)` from the readable clause and
 * confirm each witness row is about that clause and not another. The honest cost of choosing
 * verifiable over secret: an unsalted hash is a commitment, not a ciphertext. Given a guess, you can
 * confirm it — so a witness row does reveal *membership* in a guessable dictionary of two-token
 * commands (someone can test whether a host runs `acme-deploy prod`). A salted hash would close that
 * and simultaneously destroy the review, which is the property the tier exists for. Verifiable wins,
 * and the dictionary is the price, stated rather than buried.
 *
 * Hostnames are identifying, so `host` is a stable pseudonym by default and raw only on an explicit
 * opt-in — {@link hostLabel}, following the same rule `export.ts` applies to `sessionId` and `cwd`.
 *
 * ## Where they live, and why
 *
 * `<corpusRoot>/data/aggregates/<host>.json`. The corpus is already a private git repo that both the
 * runtime and the pipeline read, so this needs no new transport, no daemon, and no network code — and
 * it puts the evidence under review in the same PR as the clause it supports. The costs are real and
 * are not hidden: publishing is a `git commit` a human runs (this module writes the file and stops —
 * nothing here shells out to git, and nothing ships automatically), so a machine with no push access
 * cannot participate, and a machine that has push access can write a file.
 *
 * ## Anti-forgery, and what it does not buy
 *
 * One file per host, named by the host identity, and {@link readAggregates} refuses any file whose
 * internal `host` disagrees with its own filename. Because the filename *is* the host key, one file
 * cannot claim to be two witnesses, and the proposing host's own file is ignored in favour of live
 * local counts, so a stale or edited self-file cannot inflate anything. `ci/check-aggregates.sh`
 * adds the commit-scope half: one commit touches at most one aggregate file.
 *
 * **What that buys: accident prevention and an audit trail. Not authentication.** Anyone with push
 * access to the corpus and the intent to do so can commit a file named for any host, with any
 * counts, and the merge will believe it — there is no signature and no key distribution here. The
 * defence that actually holds is downstream and unchanged: the *only* thing a forged aggregate can
 * achieve is a `status: proposed` clause file, which cannot decide, cannot be matched and cannot
 * render into a prompt. It buys a forger a line in a pull request that a human must still accept.
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
exports.TEAM_HOSTS = exports.AGGREGATE_FIELDS = exports.AGGREGATE_VERSION = void 0;
exports.hostLabel = hostLabel;
exports.isHostLabel = isHostLabel;
exports.aggregatesDir = aggregatesDir;
exports.aggregatePath = aggregatePath;
exports.clearsUserRow = clearsUserRow;
exports.buildAggregate = buildAggregate;
exports.renderAggregate = renderAggregate;
exports.publishAggregate = publishAggregate;
exports.readAggregates = readAggregates;
exports.witnessHostsFor = witnessHostsFor;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const learnedClauses_1 = require("../supervisor/learnedClauses");
const mine_1 = require("./mine");
exports.AGGREGATE_VERSION = 1;
/**
 * The keys a published aggregate may contain, at any depth. Named as an allow-list so that a field
 * added to `ShapeStat` later is dropped by default rather than shipped by default.
 */
exports.AGGREGATE_FIELDS = [
    'version', 'host', 'generatedAt', 'shapes', 'shape12', 'occurrences', 'sessions', 'days',
];
/**
 * A host label that is safe as a filename and as a merge key.
 *
 * Pseudonymous by default: `h-<hmac(key, hostname)>`, under the per-machine key `export.ts` already
 * generates, which is never shared — so the pseudonym is stable for this host and joins to nothing.
 * `raw` is the opt-in, and it still gets sanitised, because this string becomes a path.
 */
function hostLabel(hostname, key, raw) {
    if (!raw) {
        return `h-${(0, crypto_1.createHmac)('sha256', key).update(hostname, 'utf8').digest('hex').slice(0, 12)}`;
    }
    const short = hostname.split('.')[0].toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '').slice(0, 40);
    return short || 'unknown-host';
}
/** Rejects a traversal, a dotfile and anything that is not a plain label. */
function isHostLabel(host) {
    return /^[a-z0-9][a-z0-9._-]*$/.test(host) && !host.includes('..') && host.length <= 64;
}
function aggregatesDir(corpusRoot) {
    return path.join(corpusRoot, 'data', 'aggregates');
}
function aggregatePath(corpusRoot, host) {
    return path.join(aggregatesDir(corpusRoot), `${host}.json`);
}
/**
 * Does this row clear the whole `user` row on its own? The witness test.
 *
 * The three counts are compared against `THRESHOLDS.user` directly rather than through
 * `distanceFrom`, because a row deliberately carries no `cwd` data and so cannot answer a
 * confinement bar. `THRESHOLDS.user.confinement` is 0 today, and a test asserts it stays 0 — if it
 * ever moves, that test fails and forces this decision to be re-made rather than silently skipping
 * a bar a witness cannot see.
 */
function clearsUserRow(row) {
    const bar = mine_1.THRESHOLDS.user;
    return row.occurrences >= bar.occurrences
        && row.sessions >= bar.sessions
        && row.days >= bar.days;
}
/**
 * This machine's aggregate, from the local fold.
 *
 * Only shapes that clear the `user` row are published: a shape that is not a witness has no reason
 * to cross the boundary, so the smallest useful payload is also the most private one. Rows are
 * sorted by `shape12` so re-publishing unchanged counts produces byte-identical bytes and an empty
 * `git diff`.
 */
function buildAggregate(shapes, host, now) {
    const rows = [];
    for (const stat of Object.values(shapes.shapes)) {
        const support = (0, mine_1.supportOfStat)(stat);
        if (!(0, mine_1.distanceFrom)('user', support).clears) {
            continue;
        }
        rows.push({
            shape12: stat.shape12,
            occurrences: support.occurrences,
            sessions: support.sessions,
            days: support.days,
        });
    }
    rows.sort((a, b) => a.shape12.localeCompare(b.shape12));
    return {
        version: exports.AGGREGATE_VERSION,
        host,
        generatedAt: now.toISOString(),
        shapes: rows,
    };
}
/** Two spaces and a trailing newline, so a human reads the diff and git sees a text file. */
function renderAggregate(aggregate) {
    return `${JSON.stringify(aggregate, null, 2)}\n`;
}
/**
 * Write this machine's aggregate into the corpus checkout, and stop.
 *
 * Nothing here runs git. The file lands in the working tree and the human commits it, which keeps
 * the two things a machine must not do on its own — egress and a claim about the team — on the far
 * side of a deliberate human act. It is also what makes a machine with no push access degrade to
 * "cannot publish" instead of "crashes".
 *
 * `assertAggregateWritable` throws before any byte is written, so a bad corpus root leaves the tree
 * untouched, and tmp + fsync + rename means no reader ever sees half a file.
 */
function publishAggregate(corpusRoot, aggregate) {
    const target = aggregatePath(corpusRoot, aggregate.host);
    (0, learnedClauses_1.assertAggregateWritable)(corpusRoot, target, aggregate.host);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeSync(fd, renderAggregate(aggregate));
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    return path.posix.join('data', 'aggregates', `${aggregate.host}.json`);
}
/**
 * Every published aggregate, validated.
 *
 * Nothing here throws: a corpus with a broken aggregate file must still produce a run, and the
 * refusal is data rather than a crash. Every refusal is reported, because a witness that silently
 * stopped counting and a witness that was never there are otherwise the same observation — the
 * silence-that-reads-as-success shape this pipeline keeps finding.
 */
function readAggregates(corpusRoot) {
    const out = { aggregates: [], rejected: [] };
    const dir = aggregatesDir(corpusRoot);
    let names;
    try {
        names = fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort();
    }
    catch {
        return out;
    }
    for (const name of names) {
        const refuse = (why) => { out.rejected.push({ file: name, why }); };
        const host = name.slice(0, -'.json'.length);
        if (!isHostLabel(host)) {
            refuse('the filename is not a host label');
            continue;
        }
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        }
        catch {
            refuse('unreadable or not JSON');
            continue;
        }
        if (parsed?.version !== exports.AGGREGATE_VERSION) {
            refuse(`version ${String(parsed?.version)} is not ${exports.AGGREGATE_VERSION}`);
            continue;
        }
        // The filename *is* the merge key, so a file whose `host` disagrees with it is either a rename
        // or an attempt to publish under another machine's identity. Both are refused, loudly.
        if (parsed.host !== host) {
            refuse(`declares host ${JSON.stringify(parsed.host)} but is named ${JSON.stringify(host)}`);
            continue;
        }
        if (!Array.isArray(parsed.shapes)) {
            refuse('`shapes` is not a list');
            continue;
        }
        const rows = parsed.shapes.filter(isRow);
        if (rows.length !== parsed.shapes.length) {
            refuse(`${parsed.shapes.length - rows.length} malformed row(s)`);
        }
        out.aggregates.push({
            version: parsed.version,
            host,
            generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
            shapes: rows,
        });
    }
    return out;
}
function isRow(row) {
    const r = row;
    const count = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
    return r !== null && typeof r === 'object'
        && typeof r.shape12 === 'string' && /^[0-9a-f]{12}$/.test(r.shape12)
        && count(r.occurrences) && count(r.sessions) && count(r.days);
}
/**
 * The hosts that witness one shape: every published host other than this one whose row clears the
 * whole `user` row by itself.
 *
 * No sum, anywhere. `selfHosts` is excluded because the proposing host's evidence is read live from
 * its own fold, and counting its published file as well would let a stale copy of its own counts
 * stand in as a second developer — the exact "one developer's habit with a witness" this design
 * exists to reject, with the developer witnessing themselves.
 *
 * It is a *list* because one machine has two possible labels: its pseudonym and, under
 * `--allow-host-names`, its real short hostname. A machine that published under one and mines under
 * the other would otherwise find its own file and count it. Both are always excluded, so the switch
 * cannot create a self-witness.
 */
function witnessHostsFor(shape12, aggregates, selfHosts) {
    const hosts = [];
    for (const aggregate of aggregates) {
        if (selfHosts.includes(aggregate.host)) {
            continue;
        }
        const row = aggregate.shapes.find(r => r.shape12 === shape12);
        if (row !== undefined && clearsUserRow(row) && !hosts.includes(aggregate.host)) {
            hosts.push(aggregate.host);
        }
    }
    return hosts;
}
/** How many hosts the team row asks for, including the proposing one. */
exports.TEAM_HOSTS = mine_1.THRESHOLDS.team.hosts;
