# claude-mods

Mods (function-hook plugins) for [Claude Code](https://claude.com/claude-code). Each mod
lives in its own folder with its own README.

| Mod | What it does |
| --- | --- |
| [`vim-cursor`](vim-cursor/) | Terminal cursor is a block in vim normal mode and a thin bar in insert mode. |
| [`ci-watch`](ci-watch/) | CI and CodeRabbit review progress for your GitHub repos, above the prompt. |

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install vim-cursor --marketplace nuTTeLLo/claude-mods
/plugin install ci-watch --marketplace nuTTeLLo/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

## Develop

```
claude --plugin-dir ./vim-cursor     # run a mod straight from its folder
claude plugin validate ./vim-cursor
claude plugin test ./vim-cursor
```

## License

[MIT](LICENSE)
