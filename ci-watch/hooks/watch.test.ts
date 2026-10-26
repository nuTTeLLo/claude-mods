import { expect, mock, test } from 'claude-code/testing'

const CHECK = {
  command: 'ci-watch',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

const roll = (nodes: unknown[]) => ({ oid: 'abc', statusCheckRollup: { contexts: { nodes } } })
const run = (status: string, conclusion: string | null) => ({ __typename: 'CheckRun', name: 'build', status, conclusion })
const rabbit = (state: string) => ({ __typename: 'StatusContext', context: 'CodeRabbit', state })
const thread = (isResolved: boolean) => ({ isResolved, comments: { nodes: [{ author: { login: 'coderabbitai' } }] } })

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
const OPTIONS = { options: { repos: 'acme/web, acme/api@release' } }

const answer = (prNodes: unknown[], threads: unknown[]) => ({
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
})

test('reports CI and CodeRabbit progress, then toasts when they settle', OPTIONS, async ($, on) => {
  mock.clock(on)
  let body = answer([run('IN_PROGRESS', null), rabbit('PENDING')], [])
  const toasts: string[] = []
  on('process.run', (_$, e) => {
    expect(e.argv.slice(0, 3)).toEqual(['gh', 'api', 'graphql'])
    expect(e.argv[4]).toContain('r0: repository(owner: "acme", name: "web")')
    expect(e.argv[4]).toContain('ref(qualifiedName: "refs/heads/release")')

    return ok(JSON.stringify(body))
  })
  on('ui.toast', (_$, e, next) => {
    toasts.push(e.text)

    return next(e)
  })

  const first = await $.command.run(CHECK)
  expect(first.text).toContain('web #17 feature  CI ░░░░░░░░░░ 0/1  CodeRabbit ● reviewing')
  expect(first.text).toContain('api release  CI ░░░░░░░░░░ 0/1')
  expect(toasts).toEqual([])

  body = answer([run('COMPLETED', 'FAILURE'), rabbit('SUCCESS')], [thread(false), thread(true)])
  const second = await $.command.run(CHECK)
  expect(second.text).toContain('web #17 feature  CI ██████████ 1/1 ✗ build  CodeRabbit ✓ 1 open')
  expect(toasts).toEqual([
    'web #17 feature: CI failed (build)',
    'web #17 feature: CodeRabbit reviewed, 1 comments to address',
  ])
})

test('keeps the last rows and says why when gh fails', OPTIONS, async ($, on) => {
  mock.clock(on)
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: 'gh: not logged in\n', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  const ran = await $.command.run(CHECK)
  expect(ran.text).toBe('ci-watch: gh: not logged in')
})

test('watches the session repo from its origin remote, without CodeRabbit when it has none', async ($, on) => {
  mock.clock(on)
  let query = ''
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'git') return ok('git@github.com:someone/tool.git\n')
    query = e.argv[4] ?? ''

    return ok(
      JSON.stringify({
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
      }),
    )
  })

  const ran = await $.command.run(CHECK)
  expect(query).toContain('repository(owner: "someone", name: "tool")')
  expect(query).toContain('ref: defaultBranchRef')
  expect(ran.text).toBe('tool #3 fix  CI ██████████ 1/1 ✓\ntool trunk  CI –')
})

test('says how to configure it outside a GitHub repo', async ($, on) => {
  mock.clock(on)
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  const ran = await $.command.run(CHECK)
  expect(ran.text).toContain('no GitHub repo here')
})
