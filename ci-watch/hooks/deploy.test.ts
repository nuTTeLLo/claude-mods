import { expect, mock, test } from 'claude-code/testing'

import { formatTime } from './deploy'

const LIST = {
  command: 'ci-watch',
  args: 'list',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
const OPTIONS = { options: { repos: 'acme/web' } }
const NOW = Date.parse('2026-10-30T03:35:00Z')

const job = (run: number, commitOid: string, createdAt: string, state: string) => ({
  commitOid,
  createdAt,
  latestStatus: { state, createdAt, logUrl: `https://github.com/acme/web/actions/runs/${run}/job/${run}1` },
})
const pull = (number: number, oid: string, mergedAt: string) => ({
  number,
  headRefName: `fix-${number}`,
  baseRefName: 'main',
  url: `https://example.test/${number}`,
  mergedAt,
  mergeCommit: { oid },
})
const answer = (merged: unknown[], deployments: unknown[]) => ({
  data: {
    r0: {
      ref: { name: 'main', target: { oid: 'head', statusCheckRollup: { contexts: { nodes: [] } } } },
      pullRequests: { nodes: [] },
      merged: { nodes: merged },
      deployments: { nodes: deployments },
    },
  },
})
const run = (status: string, conclusion: string | null, updated_at: string) => ({ status, conclusion, updated_at })

test('follows a merged PR until its deploy finishes, then toasts the time', OPTIONS, async ($, on) => {
  mock.clock(on, { now: NOW })
  let state = run('in_progress', null, '2026-10-30T03:27:00Z')
  const toasts: string[] = []
  on('process.run', (_$, e) => {
    if (e.argv[2] === 'graphql') {
      expect(e.argv[4]).toContain('deployments(environments: ["production"]')

      return ok(
        JSON.stringify(
          answer(
            [pull(505, 'm505', '2026-10-30T03:24:00Z')],
            // The migrate job's record has settled; the run as a whole has not.
            [job(100, 'm505', '2026-10-30T03:24:04Z', 'SUCCESS'), job(100, 'm505', '2026-10-30T03:24:05Z', 'IN_PROGRESS')],
          ),
        ),
      )
    }
    expect(e.argv).toEqual(['gh', 'api', 'repos/acme/web/actions/runs/100'])

    return ok(JSON.stringify(state))
  })
  on('ui.toast', (_$, e, next) => {
    toasts.push(e.text)

    return next(e)
  })

  const first = await $.command.run(LIST)
  expect(first.text).toBe('web #505 fix-505  merged  deploy to production ● running\nweb main  CI –')

  state = run('completed', 'success', '2026-10-30T03:30:22Z')
  const second = await $.command.run(LIST)
  const at = formatTime('2026-10-30T03:30:22Z')
  expect(second.text).toContain(`web #505 fix-505  merged  deployed to production ${at} ✓`)
  expect(toasts).toEqual([`web #505 fix-505: deployed to production ${at} ✓`])
})

test('counts a later deploy that includes the merge when its own run was cancelled', OPTIONS, async ($, on) => {
  mock.clock(on, { now: NOW })
  const compared: string[] = []
  on('process.run', (_$, e) => {
    const path = e.argv[2] ?? ''
    if (path === 'graphql') {
      return ok(
        JSON.stringify(
          answer(
            [pull(500, 'm500', '2026-10-30T03:10:00Z')],
            [job(200, 'm500', '2026-10-30T03:10:05Z', 'FAILURE'), job(201, 'm501', '2026-10-30T03:12:00Z', 'SUCCESS')],
          ),
        ),
      )
    }
    if (path.includes('/compare/')) {
      compared.push(path)

      return ok(JSON.stringify({ status: 'ahead' }))
    }
    if (path.endsWith('/200')) return ok(JSON.stringify(run('completed', 'cancelled', '2026-10-30T03:10:40Z')))

    return ok(JSON.stringify(run('completed', 'success', '2026-10-30T03:18:00Z')))
  })

  const ran = await $.command.run(LIST)
  expect(ran.text).toContain(`merged  deployed to production ${formatTime('2026-10-30T03:18:00Z')} ✓`)
  expect(compared).toEqual(['repos/acme/web/compare/m500...m501'])
})

test('shows a failed deploy and toasts its log', OPTIONS, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let state = run('in_progress', null, '2026-10-30T03:27:00Z')
  const toasts: string[] = []
  on('process.run', (_$, e) => {
    if (e.argv[2] === 'graphql') {
      return ok(
        JSON.stringify(
          answer([pull(506, 'm506', '2026-10-30T03:25:00Z')], [job(300, 'm506', '2026-10-30T03:25:05Z', 'IN_PROGRESS')]),
        ),
      )
    }

    return ok(JSON.stringify(state))
  })
  on('ui.toast', (_$, e, next) => {
    toasts.push(e.text)

    return next(e)
  })

  await $.command.run(LIST)
  state = run('completed', 'failure', '2026-10-30T03:29:00Z')
  await clock.advance(60_000)
  const ran = await $.command.run(LIST)
  expect(ran.text).toContain('web #506 fix-506  merged  deploy to production ✗')
  expect(toasts).toEqual(['web #506 fix-506: deploy to production ✗ https://github.com/acme/web/actions/runs/300/job/3001'])
})

test('queues a fresh merge, and drops PRs deployed long ago or in repos with no deployments', OPTIONS, async ($, on) => {
  mock.clock(on, { now: NOW })
  let deployments: unknown[] = [job(400, 'old', '2026-10-30T00:00:00Z', 'SUCCESS')]
  on('process.run', (_$, e) => {
    if (e.argv[2] === 'graphql') {
      return ok(
        JSON.stringify(
          answer([pull(510, 'm510', '2026-10-30T03:34:00Z'), pull(490, 'old', '2026-10-29T23:59:00Z')], deployments),
        ),
      )
    }

    return ok(JSON.stringify(run('completed', 'success', '2026-10-30T00:06:00Z')))
  })

  const ran = await $.command.run(LIST)
  expect(ran.text).toBe('web #510 fix-510  merged  deploy to production ● queued\nweb main  CI –')

  deployments = []
  expect((await $.command.run(LIST)).text).toBe('web main  CI –')
})

test('leaves deploys out of the query when the environment option is blank', { options: { repos: 'acme/web', environment: '' } }, async ($, on) => {
  mock.clock(on, { now: NOW })
  let query = ''
  on('process.run', (_$, e) => {
    query = e.argv[4] ?? ''

    return ok(JSON.stringify(answer([], [])))
  })

  await $.command.run(LIST)
  expect(query).not.toContain('deployments')
  expect(query).not.toContain('merged:')
})
