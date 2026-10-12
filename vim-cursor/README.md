# vim-cursor

Changes the terminal cursor with Claude Code's vim mode: a steady **block** in normal
mode, a steady thin **bar** in insert mode.

## Requirements

- Claude Code in a terminal, with vim mode on (`/config` → Editor mode → vim).
- A terminal that honours cursor-shape codes (DECSCUSR, `ESC [ N q`). Most do.
- macOS or Linux (`sh` and `ps`).

## Install

```
/plugin install vim-cursor --marketplace nuTTeLLo/claude-mods
```

Nothing to configure. To remove it: `/plugin uninstall vim-cursor`.

## How it works

- The mod API does not expose vim mode, so the mod reads the hint line under the prompt:
  it carries `-- INSERT --` while in insert mode. Anything else counts as normal.
- When the mode changes it writes the cursor-shape code to the terminal device, found by
  walking up the process tree to the first ancestor with a terminal (hooks have none).
- On session end it resets the cursor to the terminal's default.

## Limits

- Visual mode, and a running turn (when the hint line is replaced), show the block.
- Detection depends on the `-- INSERT --` wording; a Claude Code release that changes it
  leaves the cursor a block.
- Each mode switch runs one short `sh`, so the change lags the keypress slightly.
- Does nothing in desktop or headless sessions.

## Changing the shapes

Edit the codes at the top of `hooks/register.ts`: `1`/`2` block, `3`/`4` underline,
`5`/`6` bar (odd blinks, even is steady).
