# ci-watch

Shows CI and CodeRabbit review progress for your GitHub repos above the Claude Code
prompt, and toasts when they settle.

```
web #17 my-feature  CI –  CodeRabbit ● reviewing
web main  CI ████░░░░░░ 2/5
```

## Requirements

- `gh` on `PATH`, authenticated with access to the watched repos.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install ci-watch --marketplace nuTTeLLo/claude-mods
```

From a shell: `claude plugin install ci-watch --marketplace nuTTeLLo/claude-mods`.

## Configuration

One option, `repos`, set in `/config` or on the install screen:

- **Blank (default)**: watches the repo the session runs in, read from its `origin`
  remote (git, or jj outside a git checkout), on its default branch. SSH host aliases
  (`git@github-work:owner/name.git`) count when `ssh -G` resolves them to github.com.
- **A list**: `owner/name` or `owner/name@branch`, separated by commas, e.g.
  `acme/web, acme/api@release`. A repo without `@branch` uses its default branch.

## What it shows

- **Band above the prompt**: one row per open PR, plus a row for the watched branch while
  its build is running or has failed. Empty when everything is green and no PR is open.
- **CI**: a 10-cell bar and `finished/total` checks on the latest commit; `✓` when all
  passed, `✗ <check names>` on failure. Yellow pending, green pass, red fail.
- **CodeRabbit** (PR rows, only in repos that use it): `waiting`, `reviewing`, or
  `✓ N open`, where N is unresolved review threads CodeRabbit opened. A repo counts as
  using CodeRabbit when the watched branch has a `.coderabbit.yaml` (or `.yml`), or a
  PR already carries a CodeRabbit status.
- **Toasts**: CI passed/failed, CodeRabbit finished its review.
- **`/ci-watch`**: polls now and prints every row, green branches included.

## Polling

One `gh api graphql` call per poll. Every 20s while anything is pending or for 10 minutes
after a push (a Bash call running `jj git push`, `git push` or
`gh pr create/merge/ready/comment`); every 5 minutes otherwise.
