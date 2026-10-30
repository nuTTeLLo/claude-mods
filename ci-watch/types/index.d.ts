export type Check = 'none' | 'pending' | 'pass' | 'fail'

export type Item = {
  /** `<repo>#<pr>` for a pull request, `<repo>@<branch>` for a base branch. */
  id: string
  repo: string
  label: string
  isPr: boolean
  url?: string
  sha: string
  ci: Check
  ciDone: number
  ciTotal: number
  failed: string[]
  rabbit: Check
  /** A PR in a repo that CodeRabbit reviews. */
  hasRabbit: boolean
  /** Unresolved review threads CodeRabbit opened. */
  threads: number
  /** Set on a recently merged PR, in a repo that records deployments, while its deploy is followed. */
  merged?: { oid: string; at: string; deploy: Deploy }
}

/** `queued`: merged, no deploy that includes it has started yet. */
export type DeployState = 'queued' | 'running' | 'done' | 'fail'

export type Deploy = {
  state: DeployState
  /** The environment watched, e.g. `production`. */
  env: string
  /** When the deploy that shipped the PR finished, as an ISO time. */
  at?: string
  /** The deploy's log, an Actions job page for an Actions deploy. */
  url?: string
}

export type Snapshot = {
  items: Item[]
  error: string | null
  checkedAt: number
}

/** `auto` shows only rows that need attention, `on` every row, `off` nothing and stops polling. */
export type Mode = 'auto' | 'on' | 'off'

declare module 'claude-code' {
  interface PluginState {
    'ci-watch': { snapshot: Snapshot; mode: Mode }
  }
}
