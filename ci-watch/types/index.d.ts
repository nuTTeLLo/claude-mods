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
