---
name: orca-sonar
description: Find where a word, string or declaration lives in the current repository with `orca sonar find` and `orca sonar symbol` instead of grep, rg or reading files one by one. Use it for "where is X defined", "where is X used", "which file mentions Y" in any repository Orca manages, when the Sonar plugin is enabled.
---

# Sonar: look things up without grep

Sonar keeps a search index of the current worktree in Orca's data folder, never
inside the repository. A lookup costs a fraction of a second and returns only
`path:line` plus the matching line, so it uses far fewer tokens than grep
output or opening files to look around.

## When to use it

Prefer `orca sonar` over `grep`, `rg`, `find` or `git grep` when you want to:

- find where a function, class, interface, type or enum is declared:
  `orca sonar symbol parseInvoice`
- find the lines that mention some words, in any order:
  `orca sonar find invoice total`
- get machine-readable results: add `--json`
- see more or fewer results: `--limit 50` (default 20)

Run it from anywhere inside the worktree, or pass `--root <path>`.

## When to use grep or rg instead

- You need a regular expression, an exact phrase with punctuation, or lines of
  context around each match.
- You are searching files git ignores (`node_modules`, build output), binary
  files or files larger than 1 MB: Sonar does not index them.
- The path is outside the current worktree.

## How it behaves

- The first lookup in a worktree builds the index; on a large repository that
  can take around 20 seconds. Later lookups only re-read files that changed.
- `symbol` matches the exact name, ignoring case. `find` matches whole words
  (identifiers count as one word, `snake_case` included).
- It never writes inside the repository, so `git status` stays the same.
- Each lookup is counted (command, time taken, number of results, never the
  words searched for) for the owner's usage panel.

## If `orca sonar` is not available

- `Sonar is turned off for agents` (in Spanish, `Sonar está desactivado para
los agentes`): the owner switched it off in Orca's
  settings. Use `rg` (or `grep`) and do not try to switch it back on.
- `Unknown command: sonar`, or `orca` is not found: this Orca build does not
  include the command yet. Use `rg` (or `grep`).

In either case, do not look for the plugin's install folder or run its files
directly.
