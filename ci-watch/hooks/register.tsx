import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Mode, Snapshot } from '../types'
import type { Repo } from './watch'
import {
  PUSH,
  buildQuery,
  changes,
  ciText,
  describe,
  isPending,
  isShown,
  needsAttention,
  parse,
  parseRemote,
  parseRepos,
  rabbitText,
  sshHostname,
  summary,
} from './watch'

const TICK_MS = 15_000
const ACTIVE_MS = 20_000
const IDLE_MS = 5 * 60_000
// How long after a push to keep polling fast, while GitHub registers the checks.
const HOT_MS = 10 * 60_000

const EMPTY: Snapshot = { items: [], error: null, checkedAt: 0 }
const snapshot = atom({ plugin: 'ci-watch', key: 'snapshot' } as const, EMPTY)
const mode = atom({ plugin: 'ci-watch', key: 'mode' } as const, 'auto' as Mode)
const MODES: readonly string[] = ['auto', 'on', 'off'] satisfies Mode[]

const USAGE = 'usage: /ci-watch [list | auto | on | off]'

const COLORS = { none: undefined, pending: 'yellow', pass: 'green', fail: 'red' } as const

let nextAt = 0
let hotUntil = 0
let isPolling = false
// The `repos` option; empty means the repo the session runs in.
let configured: Repo[] = []
// What the last poll watched.
let watched: Repo[] = []

/** Whether a remote's host is github.com, directly or through an SSH config alias. */
async function isGitHub($: EngineInterface, host: string): Promise<boolean> {
  if (host === 'github.com') return true
  try {
    const ran = await $.process.run(['ssh', '-G', host])

    return ran.exitCode === 0 && sshHostname(ran.stdout) === 'github.com'
  } catch {
    return false
  }
}

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
      const remote = parseRemote((line ?? '').replace(/^origin\s+/, ''))
      if (remote !== null && (await isGitHub($, remote.host))) return remote.repo
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
  if (isPolling || (await read($, mode)) === 'off' || (await $.clock.now()) < nextAt) return
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
      description: 'Check CI and CodeRabbit progress now; `list` prints every row, `auto`/`on`/`off` sets the band',
    })
    $.clock.every(TICK_MS, () => void tick($))
    void tick($)

    return next(e)
  })

  on('command.run', { command: 'ci-watch' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (MODES.includes(arg)) {
      const chosen = arg as Mode
      await update($, mode, () => chosen)
      if (chosen === 'off') return { text: 'band off, polling stopped; /ci-watch auto turns it back on.' }
      nextAt = 0
      await tick($)

      return { text: chosen === 'on' ? 'band shows every row.' : 'band shows only rows that need attention.' }
    }
    if (arg !== '' && arg !== 'list') return { text: USAGE }

    const taken = await poll($)
    // The command's output is already shown under its name, so no `ci-watch:` prefix here.
    const lines = arg === 'list' ? taken.items.map(describe) : []
    if (arg === '' && taken.items.length > 0) lines.push(`${summary(taken.items)} · band ${await read($, mode)}`)
    if (taken.error !== null) lines.unshift(taken.error)

    if (watched.length === 0) lines.push('no GitHub repo here; set the repos option in /config to watch others.')

    return { text: lines.join('\n') || 'nothing to report.' }
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
    const chosen = await read($, mode)
    const taken = await read($, snapshot)
    const rows = taken.items.filter(isShown).filter(item => chosen === 'on' || needsAttention(item))
    if (chosen === 'off' || e.props.hasSurvey || (rows.length === 0 && taken.error === null)) {
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
