import { expect, mock, test } from 'claude-code/testing';
import { formatTime, isSameDay } from './deploy';
import { bandRows, mergedItem } from './watch';
const merged = (number) => ({
    repo: { owner: 'acme', name: 'web' },
    number,
    label: `#${number} fix-${number}`,
    url: `https://example.test/${number}`,
    oid: `m${number}`,
    at: '2026-10-30T02:00:00Z',
    attempts: [],
});
const LIST = {
    command: 'ci-watch',
    args: 'list',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
};
const ok = (stdout) => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
});
const OPTIONS = { options: { repos: 'acme/web' } };
const NOW = Date.parse('2026-10-30T03:35:00Z');
const job = (run, commitOid, createdAt, state) => ({
    commitOid,
    createdAt,
    latestStatus: { state, createdAt, logUrl: `https://github.com/acme/web/actions/runs/${run}/job/${run}1` },
});
const pull = (number, oid, mergedAt) => ({
    number,
    headRefName: `fix-${number}`,
    baseRefName: 'main',
    url: `https://example.test/${number}`,
    mergedAt,
    mergeCommit: { oid },
});
const answer = (merged, deployments) => ({
    data: {
        r0: {
            ref: { name: 'main', target: { oid: 'head', statusCheckRollup: { contexts: { nodes: [] } } } },
            pullRequests: { nodes: [] },
            merged: { nodes: merged },
            deployments: { nodes: deployments },
        },
    },
});
const run = (status, conclusion, updated_at) => ({ status, conclusion, updated_at });
test('follows a merged PR until its deploy finishes, then toasts the time', OPTIONS, async ($, on) => {
    mock.clock(on, { now: NOW });
    let state = run('in_progress', null, '2026-10-30T03:27:00Z');
    const toasts = [];
    on('process.run', (_$, e) => {
        if (e.argv[2] === 'graphql') {
            expect(e.argv[4]).toContain('deployments(environments: ["production"]');
            return ok(JSON.stringify(answer([pull(505, 'm505', '2026-10-30T03:24:00Z')], 
            // The migrate job's record has settled; the run as a whole has not.
            [job(100, 'm505', '2026-10-30T03:24:04Z', 'SUCCESS'), job(100, 'm505', '2026-10-30T03:24:05Z', 'IN_PROGRESS')])));
        }
        expect(e.argv).toEqual(['gh', 'api', 'repos/acme/web/actions/runs/100']);
        return ok(JSON.stringify(state));
    });
    on('ui.toast', (_$, e, next) => {
        toasts.push(e.text);
        return next(e);
    });
    const first = await $.command.run(LIST);
    expect(first.text).toBe('web #505 fix-505  merged  deploy to production ● running\nweb main  CI –');
    state = run('completed', 'success', '2026-10-30T03:30:22Z');
    const second = await $.command.run(LIST);
    const at = formatTime('2026-10-30T03:30:22Z');
    expect(second.text).toContain(`web #505 fix-505  merged  deployed to production ${at} ✓`);
    expect(toasts).toEqual([`web #505 fix-505: deployed to production ${at} ✓`]);
});
test('counts a later deploy that includes the merge when its own run was cancelled', OPTIONS, async ($, on) => {
    mock.clock(on, { now: NOW });
    const compared = [];
    on('process.run', (_$, e) => {
        const path = e.argv[2] ?? '';
        if (path === 'graphql') {
            return ok(JSON.stringify(answer([pull(500, 'm500', '2026-10-30T03:10:00Z')], [job(200, 'm500', '2026-10-30T03:10:05Z', 'FAILURE'), job(201, 'm501', '2026-10-30T03:12:00Z', 'SUCCESS')])));
        }
        if (path.includes('/compare/')) {
            compared.push(path);
            return ok(JSON.stringify({ status: 'ahead' }));
        }
        if (path.endsWith('/200'))
            return ok(JSON.stringify(run('completed', 'cancelled', '2026-10-30T03:10:40Z')));
        return ok(JSON.stringify(run('completed', 'success', '2026-10-30T03:18:00Z')));
    });
    const ran = await $.command.run(LIST);
    expect(ran.text).toContain(`merged  deployed to production ${formatTime('2026-10-30T03:18:00Z')} ✓`);
    expect(compared).toEqual(['repos/acme/web/compare/m500...m501']);
});
test('shows a failed deploy and toasts its log', OPTIONS, async ($, on) => {
    const clock = mock.clock(on, { now: NOW });
    let state = run('in_progress', null, '2026-10-30T03:27:00Z');
    const toasts = [];
    on('process.run', (_$, e) => {
        if (e.argv[2] === 'graphql') {
            return ok(JSON.stringify(answer([pull(506, 'm506', '2026-10-30T03:25:00Z')], [job(300, 'm506', '2026-10-30T03:25:05Z', 'IN_PROGRESS')])));
        }
        return ok(JSON.stringify(state));
    });
    on('ui.toast', (_$, e, next) => {
        toasts.push(e.text);
        return next(e);
    });
    await $.command.run(LIST);
    state = run('completed', 'failure', '2026-10-30T03:29:00Z');
    await clock.advance(60_000);
    const ran = await $.command.run(LIST);
    expect(ran.text).toContain('web #506 fix-506  merged  deploy to production ✗');
    expect(toasts).toEqual(['web #506 fix-506: deploy to production ✗ https://github.com/acme/web/actions/runs/300/job/3001']);
});
test('queues a fresh merge, and drops PRs deployed before today or in repos with no deployments', OPTIONS, async ($, on) => {
    mock.clock(on, { now: NOW });
    // The 29th wherever NOW is still the 30th (UTC-3 to UTC+14).
    let deployments = [job(400, 'old', '2026-10-29T06:00:00Z', 'SUCCESS')];
    on('process.run', (_$, e) => {
        if (e.argv[2] === 'graphql') {
            expect(e.argv[4]).toContain('merged: pullRequests(states: MERGED, first: 20');
            return ok(JSON.stringify(answer([pull(510, 'm510', '2026-10-30T03:34:00Z'), pull(490, 'old', '2026-10-29T05:59:00Z')], deployments)));
        }
        return ok(JSON.stringify(run('completed', 'success', '2026-10-29T06:06:00Z')));
    });
    const ran = await $.command.run(LIST);
    expect(ran.text).toBe('web #510 fix-510  merged  deploy to production ● queued\nweb main  CI –');
    deployments = [];
    expect((await $.command.run(LIST)).text).toBe('web main  CI –');
});
test('keeps a PR deployed hours ago today', OPTIONS, async ($, on) => {
    // Mid-day UTC, so the deploy six hours earlier is the same day in most time zones.
    const now = Date.parse('2026-10-30T12:00:00Z');
    mock.clock(on, { now });
    on('process.run', (_$, e) => {
        if (e.argv[2] === 'graphql') {
            return ok(JSON.stringify(answer([pull(520, 'm520', '2026-10-30T06:00:00Z')], [job(500, 'm520', '2026-10-30T06:00:05Z', 'SUCCESS')])));
        }
        return ok(JSON.stringify(run('completed', 'success', '2026-10-30T06:06:00Z')));
    });
    const ran = await $.command.run(LIST);
    const isToday = isSameDay('2026-10-30T06:06:00Z', now);
    expect((ran.text ?? '').includes('web #520 fix-520  merged  deployed to production')).toBe(isToday);
});
test('the band shows every row under on, and only what needs attention under auto', () => {
    const branch = { ...mergedItem(merged(1), { state: 'done', env: 'production' }), id: 'web@main', label: 'main', isPr: false, merged: undefined, ci: 'pass' };
    const done = mergedItem(merged(2), { state: 'done', env: 'production', at: '2026-10-30T03:00:00Z' });
    const running = mergedItem(merged(3), { state: 'running', env: 'production' });
    const items = [done, running, branch];
    expect(bandRows(items, 'on')).toEqual(items);
    expect(bandRows(items, 'auto')).toEqual([running]);
    expect(bandRows(items, 'off')).toEqual([]);
});
test('leaves deploys out of the query when the environment option is blank', { options: { repos: 'acme/web', environment: '' } }, async ($, on) => {
    mock.clock(on, { now: NOW });
    let query = '';
    on('process.run', (_$, e) => {
        query = e.argv[4] ?? '';
        return ok(JSON.stringify(answer([], [])));
    });
    await $.command.run(LIST);
    expect(query).not.toContain('deployments');
    expect(query).not.toContain('merged:');
});
