# ci-watch

Shows CI, CodeRabbit review and deploy progress for your GitHub repos above the Claude
Code prompt, and toasts when they settle.

```
web #17 my-feature  CI –  CodeRabbit ● reviewing
web #16 fix-login  merged  deploy to production ● running
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

Two options, set in `/config` or on the install screen.

`repos`:

- **Blank (default)**: watches the repo the session runs in, read from its `origin`
  remote (git, or jj outside a git checkout), on its default branch. SSH host aliases
  (`git@github-work:owner/name.git`) count when `ssh -G` resolves them to github.com.
- **A list**: `owner/name` or `owner/name@branch`, separated by commas, e.g.
  `acme/web, acme/api@release`. A repo without `@branch` uses its default branch.

`environment`: the GitHub deployment environment merged PRs are followed to,
`production` by default. Blank stops following deploys.

## What it shows

- **Band above the prompt**, in one of three modes set with `/ci-watch auto|on|off`
  (per session, `auto` to start):
  - `auto`: only rows that need you: CI running or failed, CodeRabbit still reviewing,
    or review comments open. Gone once everything is green.
  - `on`: with the watched branch (or no branch) checked out where the session runs,
    every row: each open PR, each PR merged lately, and the watched branch, green or
    not. On any other branch, only that branch's PR (open, or merged while its deploy
    is followed) and the watched branch. Under jj, the nearest bookmark on `@` or its
    ancestors counts as the branch.
  - `off`: no band, no polling, no toasts, until you switch it back on.
- **CI**: a 10-cell bar and `finished/total` checks on the latest commit; `✓` when all
  passed, `✗ <check names>` on failure. Yellow pending, green pass, red fail.
- **CodeRabbit** (PR rows, only in repos that use it): `waiting`, `reviewing`, or
  `✓ N open`, where N is unresolved review threads CodeRabbit opened. A repo counts as
  using CodeRabbit when the watched branch has a `.coderabbit.yaml` (or `.yml`), or a
  PR already carries a CodeRabbit status.
- **Deploy** (merged PR rows, only in repos that record deployments): for each PR
  merged into the watched branch in the last day (up to the 20 most recent), `queued`, `running`, `✗`, or
  `deployed to <environment> <day> <time> ✓` in the machine's time zone. A PR counts as
  deployed once a deploy that started after its merge, on its merge commit or a later
  one, succeeds, so a cancelled run superseded by a newer one still counts. For deploys
  made by GitHub Actions the run's own status decides, not its jobs' deployment records,
  which settle one by one. A deployed row stays for the rest of the day (under `on` and in `list`); a merge no deploy picks up
  within 30 minutes is dropped. Repos whose deploys don't report to GitHub (pull-based
  deploys, manual scripts) show no deploy rows.
- **Toasts**: CI passed/failed, CodeRabbit finished its review, a merged PR deployed
  (with the time) or its deploy failed (with the log link).
- **`/ci-watch`**: polls now and prints one summary line (`9 watched, 1 running · band auto`).
- **`/ci-watch list`**: polls now and prints every row, green branches included.

## Polling

One `gh api graphql` call per poll, plus, while a merged PR waits for its deploy, a
`gh api` call per unfinished Actions run and one to check a newer deploy includes the
merge (answers that can't change are remembered). Every 20s while anything is pending or for 10 minutes
after a push (a Bash call running `jj git push`, `git push` or
`gh pr create/merge/ready/comment`); every 5 minutes otherwise.
