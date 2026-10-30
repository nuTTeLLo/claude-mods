import type { Check, Deploy, Item, Mode } from '../types'
import type { Attempt, DeployRecord } from './deploy'
import { attempts, deployText } from './deploy'

/** A repo to watch; with no `base`, its default branch. */
export type Repo = { owner: string; name: string; base?: string }

/** Reads the `repos` option: `owner/name` or `owner/name@branch`, split by commas or spaces. */
export function parseRepos(text: string): Repo[] {
  const repos: Repo[] = []
  for (const one of text.split(/[\s,]+/).filter(Boolean)) {
    const found = /^([\w.-]+)\/([\w.-]+)(?:@([^"\\]+))?$/.exec(one)
    const [, owner, name, base] = found ?? []
    if (owner !== undefined && name !== undefined) repos.push({ owner, name, base })
  }

  return repos
}

/** The host and repo a remote URL names, for HTTPS, SSH and scp-style remotes alike. */
export function parseRemote(url: string): { host: string; repo: Repo } | null {
  const [, host, owner, name] =
    /^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?([^:/\s]+)(?::\d+)?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim()) ?? []
  if (host === undefined || owner === undefined || name === undefined) return null

  return { host: host.toLowerCase(), repo: { owner, name } }
}

/** The real host name in `ssh -G <alias>` output, so `git@github-work:...` counts as GitHub. */
export function sshHostname(config: string): string | null {
  const line = config.split('\n').find(one => one.startsWith('hostname '))

  return line === undefined ? null : line.slice('hostname '.length).trim().toLowerCase()
}

export const PUSH = /\b(jj\s+git\s+push|git\s+push|gh\s+pr\s+(create|merge|ready|comment))\b/

const ROLLUP = `oid statusCheckRollup { contexts(first: 100) { nodes {
  __typename
  ... on CheckRun { name status conclusion }
  ... on StatusContext { context state }
} } }`

/** The `environment` option, if it is a name GitHub allows; blank turns deploy tracking off. */
export function parseEnvironment(text: string): string | null {
  const env = text.trim()

  return /^[\w .-]+$/.test(env) ? env : null
}

// Enough merges for a busy morning's burst, and attempts to cover them at a few records per
// deploy (100 is GitHub's page limit).
const MERGED_PULLS = 20
const DEPLOY_RECORDS = 100

function deployQuery(env: string | null): string {
  if (env === null) return ''

  return `
  merged: pullRequests(states: MERGED, first: ${MERGED_PULLS}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes {
    number headRefName baseRefName url mergedAt mergeCommit { oid }
  } }
  deployments(environments: ["${env}"], first: ${DEPLOY_RECORDS}, orderBy: { field: CREATED_AT, direction: DESC }) { nodes {
    commitOid createdAt latestStatus { state createdAt logUrl }
  } }`
}

export function buildQuery(repos: readonly Repo[], env: string | null = null): string {
  const parts = repos.map((repo, i) => {
    // The branch watched decides whether CodeRabbit is configured.
    const tree = repo.base ?? 'HEAD'

    return `r${i}: repository(owner: "${repo.owner}", name: "${repo.name}") {${deployQuery(env)}
  ${repo.base === undefined ? 'ref: defaultBranchRef' : `ref(qualifiedName: "refs/heads/${repo.base}")`} { name target { ... on Commit { ${ROLLUP} } } }
  rabbitYaml: object(expression: "${tree}:.coderabbit.yaml") { id }
  rabbitYml: object(expression: "${tree}:.coderabbit.yml") { id }
  pullRequests(states: OPEN, first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes {
    number headRefName url
    commits(last: 1) { nodes { commit { ${ROLLUP} } } }
    reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { author { login } } } } }
  } }
}`
  })

  return `query {\n${parts.join('\n')}\n}`
}

type Context = {
  __typename?: string
  name?: string
  status?: string
  conclusion?: string | null
  context?: string
  state?: string
}
type Commit = { oid?: string; statusCheckRollup?: { contexts?: { nodes?: Context[] } } | null }
type Pull = {
  number: number
  headRefName: string
  url: string
  commits?: { nodes?: { commit?: Commit }[] }
  reviewThreads?: {
    nodes?: { isResolved: boolean; comments?: { nodes?: { author?: { login?: string } | null }[] } }[]
  }
}
type MergedPull = {
  number: number
  headRefName: string
  baseRefName?: string
  url: string
  mergedAt?: string | null
  mergeCommit?: { oid?: string } | null
}
type RepoData = {
  ref?: { name?: string; target?: Commit } | null
  rabbitYaml?: { id: string } | null
  rabbitYml?: { id: string } | null
  pullRequests?: { nodes?: Pull[] }
  merged?: { nodes?: MergedPull[] }
  deployments?: { nodes?: DeployRecord[] }
} | null

/** A PR merged into the watched branch, with the deploy attempts of the repo it is in. */
export type Merged = {
  repo: Repo
  number: number
  label: string
  head: string
  url: string
  oid: string
  at: string
  attempts: Attempt[]
}

/** The PRs merged into each watched branch, in repos that have deployed to the environment. */
export function parseMerged(repos: readonly Repo[], data: Record<string, RepoData>): Merged[] {
  const found: Merged[] = []
  repos.forEach((repo, i) => {
    const one = data[`r${i}`]
    const records = one?.deployments?.nodes ?? []
    // No deployments recorded: nothing here tells GitHub when it ships.
    if (one === null || one === undefined || records.length === 0) return
    const base = one.ref?.name ?? repo.base
    const tried = attempts(records)
    for (const pull of one.merged?.nodes ?? []) {
      const oid = pull.mergeCommit?.oid
      if (pull.baseRefName !== base || oid === undefined || !pull.mergedAt) continue
      found.push({
        repo,
        number: pull.number,
        label: `#${pull.number} ${pull.headRefName}`,
        head: pull.headRefName,
        url: pull.url,
        oid,
        at: pull.mergedAt,
        attempts: tried,
      })
    }
  })

  return found
}

/** A merged PR's row. */
export function mergedItem(pull: Merged, deploy: Deploy): Item {
  return {
    id: `${pull.repo.name}#${pull.number}`,
    repo: pull.repo.name,
    label: pull.label,
    isPr: true,
    head: pull.head,
    url: pull.url,
    sha: pull.oid,
    ci: 'none',
    ciDone: 0,
    ciTotal: 0,
    failed: [],
    rabbit: 'none',
    hasRabbit: false,
    threads: 0,
    merged: { oid: pull.oid, at: pull.at, deploy },
  }
}

const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const WAITING = new Set(['PENDING', 'EXPECTED'])

function checkOf(one: Context): Check {
  if (one.__typename === 'CheckRun') {
    if (one.status !== 'COMPLETED') return 'pending'

    return PASSING.has(one.conclusion ?? '') ? 'pass' : 'fail'
  }
  if (WAITING.has(one.state ?? '')) return 'pending'

  return one.state === 'SUCCESS' ? 'pass' : 'fail'
}

function rollup(commit: Commit | undefined) {
  const nodes = commit?.statusCheckRollup?.contexts?.nodes ?? []
  const ci = nodes.filter(one => one.context !== 'CodeRabbit')
  const rabbit = nodes.find(one => one.context === 'CodeRabbit')
  const states = ci.map(checkOf)
  const failed = ci.filter((_, i) => states[i] === 'fail').map(one => one.name ?? one.context ?? '?')
  let state: Check = 'none'
  if (failed.length > 0) state = 'fail'
  else if (states.includes('pending')) state = 'pending'
  else if (states.length > 0) state = 'pass'

  return {
    sha: commit?.oid ?? '',
    ci: state,
    ciDone: states.filter(one => one !== 'pending').length,
    ciTotal: states.length,
    failed,
    rabbit: rabbit === undefined ? ('none' as const) : checkOf(rabbit),
  }
}

/** Turns the GraphQL answer into one item per base branch and open pull request. */
export function parse(repos: readonly Repo[], data: Record<string, RepoData>): Item[] {
  const items: Item[] = []
  repos.forEach((repo, i) => {
    const found = data[`r${i}`]
    if (found === null || found === undefined) return
    const pulls = found.pullRequests?.nodes ?? []
    // CodeRabbit counts where the repo configures it or it has already posted a status.
    const hasRabbit =
      Boolean(found.rabbitYaml ?? found.rabbitYml) ||
      pulls.some(pull => rollup(pull.commits?.nodes?.[0]?.commit).rabbit !== 'none')
    for (const pull of pulls) {
      const threads = (pull.reviewThreads?.nodes ?? []).filter(
        thread =>
          !thread.isResolved &&
          (thread.comments?.nodes?.[0]?.author?.login ?? '').startsWith('coderabbitai'),
      ).length
      items.push({
        id: `${repo.name}#${pull.number}`,
        repo: repo.name,
        label: `#${pull.number} ${pull.headRefName}`,
        isPr: true,
        head: pull.headRefName,
        url: pull.url,
        ...rollup(pull.commits?.nodes?.[0]?.commit),
        hasRabbit,
        threads,
      })
    }
    const base = found.ref?.name ?? repo.base ?? '?'
    items.push({
      id: `${repo.name}@${base}`,
      repo: repo.name,
      label: base,
      isPr: false,
      ...rollup(found.ref?.target),
      hasRabbit: false,
      threads: 0,
    })
  })

  return items
}

export function isPending(item: Item): boolean {
  if (item.merged !== undefined) return item.merged.deploy.state === 'queued' || item.merged.deploy.state === 'running'
  // An open PR with no CodeRabbit status yet is still waiting for its review.
  return item.ci === 'pending' || item.rabbit === 'pending' || (item.hasRabbit && item.rabbit === 'none')
}

/** A base branch is only worth a row while its build runs or has failed. */
export function isShown(item: Item): boolean {
  return item.isPr || item.ci === 'pending' || item.ci === 'fail'
}

/** A row that needs attention: still running, failed, or with CodeRabbit comments open. */
export function needsAttention(item: Item): boolean {
  if (item.merged !== undefined) return item.merged.deploy.state !== 'done'

  return isPending(item) || item.ci === 'fail' || item.rabbit === 'fail' || item.threads > 0
}

/**
 * The band's rows: those that need attention under `auto`; under `on`, every row while a watched
 * branch (or no branch) is checked out, else just that branch's PRs (open or merged) and the
 * watched branches.
 */
export function bandRows(items: readonly Item[], mode: Mode, branch: string | null = null): Item[] {
  if (mode === 'off') return []
  if (mode === 'auto') return items.filter(isShown).filter(needsAttention)
  if (branch === null || items.some(item => !item.isPr && item.label === branch)) return [...items]

  return items.filter(item => !item.isPr || item.head === branch)
}

/** One line counting the rows, for `/ci-watch` without arguments. */
export function summary(items: readonly Item[]): string {
  const shown = items.filter(isShown)
  if (shown.length === 0) return 'nothing open'
  const failing = shown.filter(
    item => item.ci === 'fail' || item.rabbit === 'fail' || item.merged?.deploy.state === 'fail',
  ).length
  const running = shown.filter(isPending).length
  const comments = shown.filter(item => item.threads > 0).length
  const parts = [`${shown.length} watched`]
  if (running > 0) parts.push(`${running} running`)
  if (failing > 0) parts.push(`${failing} failing`)
  if (comments > 0) parts.push(`${comments} with comments`)
  if (running + failing + comments === 0) parts.push('all green')

  return parts.join(', ')
}

const BAR_CELLS = 10

export function bar(done: number, total: number): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * BAR_CELLS)

  return '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled)
}

export function ciText(item: Item): string {
  if (item.ci === 'none') return 'CI –'
  const progress = `CI ${bar(item.ciDone, item.ciTotal)} ${item.ciDone}/${item.ciTotal}`
  if (item.ci === 'pending') return progress
  if (item.ci === 'pass') return `${progress} ✓`

  return `${progress} ✗ ${item.failed.join(', ')}`
}

export function rabbitText(item: Item): string {
  if (!item.hasRabbit) return ''
  const open = item.threads > 0 ? ` ${item.threads} open` : ''
  if (item.rabbit === 'pass') return `CodeRabbit ✓${open}`
  if (item.rabbit === 'fail') return `CodeRabbit ✗${open}`

  return item.rabbit === 'pending' ? 'CodeRabbit ● reviewing' : 'CodeRabbit ● waiting'
}

export function describe(item: Item): string {
  if (item.merged !== undefined) return `${item.repo} ${item.label}  merged  ${deployText(item.merged.deploy)}`

  return [`${item.repo} ${item.label}`, ciText(item), rabbitText(item)].filter(Boolean).join('  ')
}

/** What changed for the same commit between two polls, as toast lines. */
export function changes(before: readonly Item[], after: readonly Item[]): string[] {
  const lines: string[] = []
  for (const item of after) {
    const was = before.find(one => one.id === item.id)
    const name = `${item.repo} ${item.label}`
    // A merged PR keeps its id from when it was open, so its deploy is followed across the merge.
    if (was !== undefined && item.merged !== undefined) {
      const { deploy } = item.merged
      const had = was.merged?.deploy.state
      if (had !== 'done' && deploy.state === 'done') lines.push(`${name}: ${deployText(deploy)}`)
      if (had !== 'fail' && deploy.state === 'fail') lines.push(`${name}: ${deployText(deploy)} ${deploy.url ?? ''}`.trim())
      continue
    }
    if (was === undefined || was.sha !== item.sha) continue
    if (was.ci === 'pending' && item.ci === 'pass') lines.push(`${name}: CI passed`)
    if (was.ci !== 'fail' && item.ci === 'fail') lines.push(`${name}: CI failed (${item.failed.join(', ')})`)
    if (was.rabbit !== 'pass' && item.rabbit === 'pass') {
      const found = item.threads > 0 ? `${item.threads} comments to address` : 'no open comments'
      lines.push(`${name}: CodeRabbit reviewed, ${found}`)
    }
    if (was.rabbit !== 'fail' && item.rabbit === 'fail') lines.push(`${name}: CodeRabbit failed`)
  }

  return lines
}
