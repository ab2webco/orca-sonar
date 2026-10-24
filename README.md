# orca-sonar

Orca plugin: fast file and symbol lookup for agents, with fewer tokens.

Status: phase 2, first PR. This change adds the project scaffold, the MIT
license and the cross-platform CI. The index and the `find` and `symbol`
commands come in the PRs that follow.

## Requirements

- Node.js 24 or newer (the plugin runs TypeScript directly, with no build step).
- Git on `PATH`, for repositories and worktrees.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

## Principles

- The index lives in Orca's data folder, never inside a repository, a worktree
  or a home directory of a repository.
- Nothing is wired into `.claude/`, `.mcp.json`, `.gitignore`, `AGENTS.md`,
  `CLAUDE.md` or git configuration and hooks of any repository.
- User-facing strings are available in Spanish and English, following Orca's
  language setting.

## License

MIT. See [LICENSE](LICENSE).
