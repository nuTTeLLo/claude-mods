import { expect, mock, test } from 'claude-code/testing';
const CHECK = {
    command: 'ci-watch',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
};
const LIST = { ...CHECK, args: 'list' };
const roll = (nodes) => ({ oid: 'abc', statusCheckRollup: { contexts: { nodes } } });
const run = (status, conclusion) => ({ __typename: 'CheckRun', name: 'build', status, conclusion });
const rabbit = (state) => ({ __typename: 'StatusContext', context: 'CodeRabbit', state });
const thread = (isResolved) => ({ isResolved, comments: { nodes: [{ author: { login: 'coderabbitai' } }] } });
const ok = (stdout) => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
});
const OPTIONS = { options: { repos: 'acme/web, acme/api@release' } };
const answer = (prNodes, threads) => ({
    data: {
        r0: {
            ref: { name: 'main', target: roll([run('COMPLETED', 'SUCCESS')]) },
            rabbitYaml: { id: 'blob' },
            pullRequests: {
                nodes: [
                    {
                        number: 17,
                        headRefName: 'feature',
                        url: 'https://example.test/17',
                        commits: { nodes: [{ commit: roll(prNodes) }] },
                        reviewThreads: { nodes: threads },
                    },
                ],
            },
        },
        r1: { ref: { name: 'release', target: roll([run('IN_PROGRESS', null)]) }, pullRequests: { nodes: [] } },
    },
});
test('reports CI and CodeRabbit progress, then toasts when they settle', OPTIONS, async ($, on) => {
    mock.clock(on);
    let body = answer([run('IN_PROGRESS', null), rabbit('PENDING')], []);
    const toasts = [];
    on('process.run', (_$, e) => {
        expect(e.argv.slice(0, 3)).toEqual(['gh', 'api', 'graphql']);
        expect(e.argv[4]).toContain('r0: repository(owner: "acme", name: "web")');
        expect(e.argv[4]).toContain('ref(qualifiedName: "refs/heads/release")');
        return ok(JSON.stringify(body));
    });
    on('ui.toast', (_$, e, next) => {
        toasts.push(e.text);
        return next(e);
    });
    const first = await $.command.run(LIST);
    expect(first.text).toContain('web #17 feature  CI ░░░░░░░░░░ 0/1  CodeRabbit ● reviewing');
    expect(first.text).toContain('api release  CI ░░░░░░░░░░ 0/1');
    expect(toasts).toEqual([]);
    body = answer([run('COMPLETED', 'FAILURE'), rabbit('SUCCESS')], [thread(false), thread(true)]);
    const second = await $.command.run(LIST);
    expect(second.text).toContain('web #17 feature  CI ██████████ 1/1 ✗ build  CodeRabbit ✓ 1 open');
    expect(toasts).toEqual([
        'web #17 feature: CI failed (build)',
        'web #17 feature: CodeRabbit reviewed, 1 comments to address',
    ]);
});
test('keeps the last rows and says why when gh fails', OPTIONS, async ($, on) => {
    mock.clock(on);
    on('process.run', () => ({
        value: { exitCode: 1, stdout: '', stderr: 'gh: not logged in\n', isStdoutTruncated: false, isStderrTruncated: false },
    }));
    const ran = await $.command.run(CHECK);
    expect(ran.text).toBe('gh: not logged in');
});
test('watches the session repo from its origin remote, without CodeRabbit when it has none', async ($, on) => {
    mock.clock(on);
    let query = '';
    on('process.run', (_$, e) => {
        if (e.argv[0] === 'git')
            return ok('git@github.com:someone/tool.git\n');
        query = e.argv[4] ?? '';
        return ok(JSON.stringify({
            data: {
                r0: {
                    ref: { name: 'trunk', target: roll([]) },
                    pullRequests: {
                        nodes: [
                            {
                                number: 3,
                                headRefName: 'fix',
                                url: 'https://example.test/3',
                                commits: { nodes: [{ commit: roll([run('COMPLETED', 'SUCCESS')]) }] },
                                reviewThreads: { nodes: [] },
                            },
                        ],
                    },
                },
            },
        }));
    });
    const ran = await $.command.run(LIST);
    expect(query).toContain('repository(owner: "someone", name: "tool")');
    expect(query).toContain('ref: defaultBranchRef');
    expect(ran.text).toBe('tool #3 fix  CI ██████████ 1/1 ✓\ntool trunk  CI –');
});
test('says how to configure it outside a GitHub repo', async ($, on) => {
    mock.clock(on);
    on('process.run', () => ({
        value: { exitCode: 1, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false },
    }));
    const ran = await $.command.run(CHECK);
    expect(ran.text).toContain('no GitHub repo here');
});
const EMPTY_REPO = JSON.stringify({ data: { r0: { ref: { name: 'main', target: roll([]) }, pullRequests: { nodes: [] } } } });
test('follows an SSH config alias to github.com', async ($, on) => {
    mock.clock(on);
    let query = '';
    on('process.run', (_$, e) => {
        if (e.argv[0] === 'git')
            return ok('git@github-work:someone/tool.git\n');
        if (e.argv[0] === 'ssh') {
            expect(e.argv).toEqual(['ssh', '-G', 'github-work']);
            return ok('user git\nhostname github.com\nport 22\n');
        }
        query = e.argv[4] ?? '';
        return ok(EMPTY_REPO);
    });
    const ran = await $.command.run(LIST);
    expect(query).toContain('repository(owner: "someone", name: "tool")');
    expect(ran.text).toBe('tool main  CI –');
});
test('ignores a remote whose host is not GitHub', async ($, on) => {
    mock.clock(on);
    on('process.run', (_$, e) => {
        if (e.argv[0] === 'git')
            return ok('ssh://git@gitlab.example:2222/someone/tool.git\n');
        if (e.argv[0] === 'ssh')
            return ok('hostname gitlab.example\n');
        if (e.argv[0] === 'gh')
            throw new Error('should not query GitHub');
        return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
    });
    const ran = await $.command.run(CHECK);
    expect(ran.text).toBe('no GitHub repo here; set the repos option in /config to watch others.');
});
test('answers in one line without arguments, and switches modes', OPTIONS, async ($, on) => {
    const clock = mock.clock(on);
    let polls = 0;
    on('process.run', () => {
        polls += 1;
        return ok(JSON.stringify(answer([run('COMPLETED', 'SUCCESS'), rabbit('SUCCESS')], [])));
    });
    const ran = await $.command.run(CHECK);
    expect(ran.text).toBe('2 watched, 1 running · band auto');
    expect((await $.command.run({ ...CHECK, args: 'off' })).text).toContain('polling stopped');
    const before = polls;
    await clock.advance(10 * 60_000);
    expect(polls).toBe(before);
    expect((await $.command.run({ ...CHECK, args: 'on' })).text).toBe('band shows every row.');
    expect((await $.command.run({ ...CHECK, args: 'nope' })).text).toContain('usage: /ci-watch');
});
