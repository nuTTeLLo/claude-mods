import { atom, read, update } from 'claude-code';
import { deployOf, deployText, isSameDay } from './deploy';
import { PUSH, bandRows, buildQuery, changes, ciText, describe, isPending, mergedItem, parse, parseEnvironment, parseMerged, parseRemote, parseRepos, rabbitText, sshHostname, summary, } from './watch';
const TICK_MS = 15_000;
const ACTIVE_MS = 20_000;
const IDLE_MS = 5 * 60_000;
// How long after a push to keep polling fast, while GitHub registers the checks.
const HOT_MS = 10 * 60_000;
const EMPTY = { items: [], error: null, checkedAt: 0 };
const snapshot = atom({ plugin: 'ci-watch', key: 'snapshot' }, EMPTY);
const mode = atom({ plugin: 'ci-watch', key: 'mode' }, 'auto');
const MODES = ['auto', 'on', 'off'];
const USAGE = 'usage: /ci-watch [list | auto | on | off]';
const COLORS = { none: undefined, pending: 'yellow', pass: 'green', fail: 'red' };
const DEPLOY_COLORS = { queued: 'yellow', running: 'yellow', done: 'green', fail: 'red' };
// A merged PR whose deploy never starts (the workflow skipped it, say) stops being followed.
const QUEUED_MS = 30 * 60_000;
const MERGED_MS = 24 * 60 * 60_000;
let nextAt = 0;
let hotUntil = 0;
let isPolling = false;
// The `repos` option; empty means the repo the session runs in.
let configured = [];
// What the last poll watched.
let watched = [];
// The `environment` option; null when deploys aren't followed.
let environment = 'production';
// Answers that can't change: whether a commit includes a merge, and runs that have finished.
const included = new Map();
const finished = new Map();
async function ghJson($, path) {
    const ran = await $.process.run(['gh', 'api', path]);
    if (ran.exitCode !== 0)
        throw new Error(ran.stderr.trim().split('\n')[0] || `gh exited ${ran.exitCode}`);
    return JSON.parse(ran.stdout);
}
function lookups($, repo) {
    const path = `repos/${repo.owner}/${repo.name}`;
    return {
        async includes(merge, commit) {
            const key = `${path}:${merge}...${commit}`;
            const known = included.get(key);
            if (known !== undefined)
                return known;
            try {
                const { status } = (await ghJson($, `${path}/compare/${merge}...${commit}`));
                const answer = status === 'ahead' || status === 'identical';
                included.set(key, answer);
                return answer;
            }
            catch {
                return false;
            }
        },
        async run(id) {
            const key = `${path}:${id}`;
            const known = finished.get(key);
            if (known !== undefined)
                return known;
            try {
                const run = (await ghJson($, `${path}/actions/runs/${id}`));
                const found = { status: run.status ?? '', conclusion: run.conclusion ?? null, updatedAt: run.updated_at ?? '' };
                if (found.status === 'completed')
                    finished.set(key, found);
                return found;
            }
            catch {
                return null;
            }
        },
    };
}
/** Rows for the PRs merged lately, while their deploy is under way and for a while after. */
async function mergedItems($, pulls, now) {
    const items = [];
    for (const pull of pulls) {
        const age = now - Date.parse(pull.at);
        if (environment === null || !(age < MERGED_MS))
            continue;
        let deploy = await deployOf(pull.oid, pull.at, pull.attempts, environment, lookups($, pull.repo));
        if (deploy === null && age < QUEUED_MS)
            deploy = { state: 'queued', env: environment };
        if (deploy === null)
            continue;
        // A deployed PR's row stays for the rest of the day, for `/ci-watch on` and `list`.
        if (deploy.state === 'done' && !isSameDay(deploy.at ?? '', now))
            continue;
        items.push(mergedItem(pull, deploy));
    }
    return items;
}
/** Whether a remote's host is github.com, directly or through an SSH config alias. */
async function isGitHub($, host) {
    if (host === 'github.com')
        return true;
    try {
        const ran = await $.process.run(['ssh', '-G', host]);
        return ran.exitCode === 0 && sshHostname(ran.stdout) === 'github.com';
    }
    catch {
        return false;
    }
}
/** The `origin` remote of the session's directory, from git or, outside a git checkout, jj. */
async function currentRepo($) {
    const asks = [
        ['git', 'remote', 'get-url', 'origin'],
        ['jj', 'git', 'remote', 'list'],
    ];
    for (const argv of asks) {
        try {
            const ran = await $.process.run(argv);
            if (ran.exitCode !== 0)
                continue;
            const line = ran.stdout.split('\n').find(one => argv[0] === 'git' || one.startsWith('origin '));
            const remote = parseRemote((line ?? '').replace(/^origin\s+/, ''));
            if (remote !== null && (await isGitHub($, remote.host)))
                return remote.repo;
        }
        catch {
            // Not installed: try the next one.
        }
    }
    return null;
}
async function poll($) {
    const now = await $.clock.now();
    let items = [];
    let error = null;
    try {
        const here = configured.length > 0 ? null : await currentRepo($);
        const repos = here === null ? configured : [here];
        watched = repos;
        if (repos.length > 0) {
            const ran = await $.process.run(['gh', 'api', 'graphql', '-f', `query=${buildQuery(repos, environment)}`]);
            if (ran.exitCode === 0) {
                const data = JSON.parse(ran.stdout).data ?? {};
                const merged = await mergedItems($, parseMerged(repos, data), now);
                // Merged rows go before the branch row of their repo, after its open PRs.
                items = parse(repos, data).flatMap(item => item.isPr ? [item] : [...merged.filter(one => one.repo === item.repo), item]);
            }
            else
                error = ran.stderr.trim().split('\n')[0] || `gh exited ${ran.exitCode}`;
        }
    }
    catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    const before = await read($, snapshot);
    // A failed poll keeps the last good rows on screen beside the error.
    const taken = { items: error === null ? items : before.items, error, checkedAt: now };
    await update($, snapshot, () => taken);
    if (error === null) {
        for (const line of changes(before.items, items))
            $.ui.toast(line);
    }
    const isActive = now < hotUntil || taken.items.some(isPending);
    nextAt = now + (isActive ? ACTIVE_MS : IDLE_MS);
    return taken;
}
async function tick($) {
    if (isPolling || (await read($, mode)) === 'off' || (await $.clock.now()) < nextAt)
        return;
    isPolling = true;
    try {
        await poll($);
    }
    finally {
        isPolling = false;
    }
}
export const register = (on, options) => {
    configured = parseRepos(typeof options.repos === 'string' ? options.repos : '');
    environment = parseEnvironment(typeof options.environment === 'string' ? options.environment : 'production');
    on('session.start', async ($, e, next) => {
        await $.command.register({
            name: 'ci-watch',
            description: 'Check CI and CodeRabbit progress now; `list` prints every row, `auto`/`on`/`off` sets the band',
        });
        $.clock.every(TICK_MS, () => void tick($));
        void tick($);
        return next(e);
    });
    on('command.run', { command: 'ci-watch' }, async ($, e) => {
        const arg = e.args.trim().toLowerCase();
        if (MODES.includes(arg)) {
            const chosen = arg;
            await update($, mode, () => chosen);
            if (chosen === 'off')
                return { text: 'band off, polling stopped; /ci-watch auto turns it back on.' };
            nextAt = 0;
            await tick($);
            return { text: chosen === 'on' ? 'band shows every row.' : 'band shows only rows that need attention.' };
        }
        if (arg !== '' && arg !== 'list')
            return { text: USAGE };
        const taken = await poll($);
        // The command's output is already shown under its name, so no `ci-watch:` prefix here.
        const lines = arg === 'list' ? taken.items.map(describe) : [];
        if (arg === '' && taken.items.length > 0)
            lines.push(`${summary(taken.items)} · band ${await read($, mode)}`);
        if (taken.error !== null)
            lines.unshift(taken.error);
        if (watched.length === 0)
            lines.push('no GitHub repo here; set the repos option in /config to watch others.');
        return { text: lines.join('\n') || 'nothing to report.' };
    });
    on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
        const ran = await next(e);
        if (PUSH.test(e.command)) {
            const now = await $.clock.now();
            hotUntil = now + HOT_MS;
            // GitHub needs a moment before the new commit's checks exist.
            nextAt = now + 5_000;
        }
        return ran;
    });
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const chosen = await read($, mode);
        const taken = await read($, snapshot);
        const rows = bandRows(taken.items, chosen);
        if (chosen === 'off' || e.props.hasSurvey || (rows.length === 0 && taken.error === null)) {
            return next(e);
        }
        const { Box, Text } = $.ui.resolve(e);
        return (h(Box, { flexDirection: "column" },
            taken.error !== null && h(Text, { color: "red" },
                "ci-watch: ",
                taken.error),
            rows.map(item => (h(Box, null,
                h(Text, { dimColor: true },
                    item.repo,
                    " "),
                h(Text, null,
                    item.label,
                    "  "),
                item.merged !== undefined ? (h(Text, { color: DEPLOY_COLORS[item.merged.deploy.state] },
                    "merged  ",
                    deployText(item.merged.deploy))) : (h(Text, { color: COLORS[item.ci] }, ciText(item))),
                item.hasRabbit && (h(Text, { color: item.rabbit === 'none' ? 'yellow' : COLORS[item.rabbit] },
                    '  ',
                    rabbitText(item))))))));
    });
};
