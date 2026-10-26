import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Snapshot } from '../types'
import type { Repo } from './watch'
import {
  PUSH,
  buildQuery,
  changes,
  ciText,
  describe,
  isPending,
  isShown,
  parse,
  parseRepos,
  rabbitText,
  repoOfRemote,
} from './watch'

const TICK_MS = 15_000
const ACTIVE_MS = 20_000
const IDLE_MS = 5 * 60_000
// How long after a push to keep polling fast, while GitHub registers the checks.
const HOT_MS = 10 * 60_000

const EMPTY: Snapshot = { items: [], error: null, checkedAt: 0 }
const snapshot = atom({ plugin: 'ci-watch', key: 'snapshot' } as const, EMPTY)

const COLORS = { none: undefined, pending: 'yellow', pass: 'green', fail: 'red' } as const

let nextAt = 0
let hotUntil = 0
let isPolling = false
// The `repos` option; empty means the repo the session runs in.
let configured: Repo[] = []
// What the last poll watched.
let watched: Repo[] = []

/** The `origin` remote of the session's directory, from git or, outside a git checkout, jj. */
async function currentRepo($: EngineInterface): Promise<Repo | null> {
  const asks = [
    ['git', 'remote', 'get-url', 'origin'],
    ['jj', 'git', 'remote', 'list'],
  ]
  for (const argv of asks) {
    try {
      const ran = await $.process.run(argv)
      if (ran.exitCode !== 0) continue
      const line = ran.stdout.split('\n').find(one => argv[0] === 'git' || one.startsWith('origin '))
      const repo = repoOfRemote((line ?? '').replace(/^origin\s+/, ''))
      if (repo !== null) return repo
    } catch {
      // Not installed: try the next one.
    }
  }

  return null
}

async function poll($: EngineInterface): Promise<Snapshot> {
  const now = await $.clock.now()
  let items: Item[] = []
  let error: string | null = null
  try {
    const here = configured.length > 0 ? null : await currentRepo($)
    const repos = here === null ? configured : [here]
    watched = repos
    if (repos.length > 0) {
      const ran = await $.process.run(['gh', 'api', 'graphql', '-f', `query=${buildQuery(repos)}`])
      if (ran.exitCode === 0) items = parse(repos, JSON.parse(ran.stdout).data ?? {})
      else error = ran.stderr.trim().split('\n')[0] || `gh exited ${ran.exitCode}`
    }
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown)
  }

  const before = await read($, snapshot)
  // A failed poll keeps the last good rows on screen beside the error.
  const taken: Snapshot = { items: error === null ? items : before.items, error, checkedAt: now }
  await update($, snapshot, () => taken)
  if (error === null) {
    for (const line of changes(before.items, items)) $.ui.toast(line)
  }
  const isActive = now < hotUntil || taken.items.some(isPending)
  nextAt = now + (isActive ? ACTIVE_MS : IDLE_MS)

  return taken
}

async function tick($: EngineInterface): Promise<void> {
  if (isPolling || (await $.clock.now()) < nextAt) return
  isPolling = true
  try {
    await poll($)
  } finally {
    isPolling = false
  }
}

export const register: Register = (on, options) => {
  configured = parseRepos(typeof options.repos === 'string' ? options.repos : '')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ci-watch',
      description: 'Check CI and CodeRabbit progress on the watched repos now',
    })
    $.clock.every(TICK_MS, () => void tick($))
    void tick($)

    return next(e)
  })

  on('command.run', { command: 'ci-watch' }, async $ => {
    const taken = await poll($)
    const lines = taken.items.map(describe)
    if (taken.error !== null) lines.unshift(`ci-watch: ${taken.error}`)

    if (watched.length === 0) lines.push('ci-watch: no GitHub repo here; set the repos option in /config to watch others.')

    return { text: lines.join('\n') || 'ci-watch: nothing to report.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (PUSH.test(e.command)) {
      const now = await $.clock.now()
      hotUntil = now + HOT_MS
      // GitHub needs a moment before the new commit's checks exist.
      nextAt = now + 5_000
    }

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const taken = await read($, snapshot)
    const rows = taken.items.filter(isShown)
    if (e.props.hasSurvey || (rows.length === 0 && taken.error === null)) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {taken.error !== null && <Text color="red">ci-watch: {taken.error}</Text>}
        {rows.map(item => (
          <Box>
            <Text dimColor>{item.repo} </Text>
            <Text>{item.label}  </Text>
            <Text color={COLORS[item.ci]}>{ciText(item)}</Text>
            {item.hasRabbit && (
              <Text color={item.rabbit === 'none' ? 'yellow' : COLORS[item.rabbit]}>
                {'  '}
                {rabbitText(item)}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
