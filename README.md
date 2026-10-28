# Sonar for Orca Lab

Sonar lets your agents find where something lives in a repository without
grep. It keeps a search index of each worktree and answers a lookup in a
fraction of a second with only `path:line` and the matching line, so agents
spend far fewer tokens looking around.

- `orca sonar find invoice total`: lines that contain every word.
- `orca sonar symbol parseInvoice`: where a function, class, interface, type or
  enum with that exact name is declared.

The indexes live in Orca's data folder, never inside your repository. Sonar
never touches `.gitignore`, `.claude/`, `CLAUDE.md`, `AGENTS.md` or your git
configuration, so `git status` stays the same.

## What you get when you enable it

- **Settings → Plugins → Sonar**: two switches and every local workspace's
  index.
  - _Agents can use Sonar_: when off, `orca sonar find` and `symbol` refuse and
    tell the agent to use `rg` or `grep`. Indexes and panels keep working.
  - _Build the index in the background_: lets Orca index a new worktree as soon
    as it is created, so the first search does not wait. It never runs while
    agents are switched off.
  - For each workspace: files, symbols, size, when it was last indexed, and a
    **Rebuild** (or **Build index**) button that starts right away on Orca
    builds that let a panel run its plugin's commands, and is queued on older
    ones.
- **A Sonar page in the left sidebar** with usage over the last 30 days:
  queries per day (`find` and `symbol`), average query time, results returned,
  workspaces indexed, and an **estimated** saving in tokens and bytes versus
  grep, with the formula it uses.
- **One palette command**, _Sonar: Refresh_, which updates both panels and runs
  any rebuild you queued.
- **The `orca-sonar` skill**, which tells agents when to use `orca sonar`
  instead of grep, and what to do when it is switched off or missing.

Both panels follow Orca's language (Spanish or English) and theme. Because the
plugin ships a skill, Orca asks for your consent again on every update.

## Requirements

- Orca Lab 1.4.160 or newer.
- Node.js 24 or newer on `PATH` (Sonar runs TypeScript directly and uses
  Node's built-in SQLite).
- Git on `PATH`, for repositories and worktrees.
- Orca's `orca` command on `PATH`; Sonar uses it to list your workspaces.
- For agents: an Orca build that includes the `orca sonar` command. Until yours
  does, the panels say so and agents keep using grep; the switches are saved
  and apply as soon as it does.

## Check that it works

1. Enable Sonar in **Settings → Plugins** and accept the permissions.
2. Run _Sonar: Refresh_ from the command palette (or wait for the next agent
   activity). The Sonar card in Settings lists your local workspaces.
3. Press **Build index** on one of them (on an older Orca, then run
   _Sonar: Refresh_). The first build of a large repository can take around 20
   seconds; later updates only re-read files that changed, and a binary or
   oversized file is read again only after it changes.
4. From a terminal in that worktree, run `orca sonar symbol <a function you
know>`. You should get its `path:line` back, and the lookup shows up on the
   Sonar page in the sidebar.

### Why the panels wait for activity

Orca starts a plugin's background worker for a palette command or an event,
such as an agent changing state. So the panels refresh on the next agent
activity, and _Sonar: Refresh_ refreshes them at once. **Rebuild** runs
_Sonar: Refresh_ itself on Orca builds that let a panel run its plugin's
commands; on older ones it is queued until the next activity. The switches take
effect on the very next `orca sonar` command.

### When several searches run at once

Only one Sonar process updates an index at a time. A `find` or `symbol` that
arrives while another process is updating answers from the index as it is and
says its results may miss the latest changes; `orca sonar index` waits its
turn. Indexes built by 0.2.1 are upgraded in place, without a rebuild.

## How the saving is estimated

For each lookup Sonar compares what it printed with what an agent would have
read with grep and then opening the files that hold the results:

```text
baseline = grep output (path:line:text per matching line, up to 2,000 lines)
         + size of the files holding Sonar's results
saving   = baseline − Sonar's output, never below 0
tokens   ≈ saving ÷ 4 bytes
```

It is an estimate, not a measurement. Sonar records the command, the time
taken, the number of results and these byte counts for each lookup, never the
words searched for, and keeps 90 days.

## Command line

The plugin is also a plain command line, which is what `orca sonar` runs:

```sh
node bin/orca-sonar.ts status            # what the index holds, without changing it
node bin/orca-sonar.ts index             # bring the index up to date
node bin/orca-sonar.ts find <words...>   # lines that contain every word
node bin/orca-sonar.ts symbol <name>     # declarations with this exact name
node bin/orca-sonar.ts usage             # how agents used Sonar in the last 30 days
node bin/orca-sonar.ts prune             # delete the indexes of workspaces that no longer exist
```

Options: `--root <path>` (default: current folder), `--limit <n>` (default 20),
`--json`, `--warmup` (for `index`: skip when the background build is switched
off), `--stdin` (for `status`: one workspace root per line; for `prune`: the index
paths of the live workspaces), `-h`/`--help`.
Orca's own background build runs `index` with `ORCA_SONAR_WARMUP=1` in the
environment, which works like `--warmup`. Messages follow Orca's language
setting.

## What gets indexed

Every file git tracks or would track (ignored files such as `node_modules` are
skipped), except binary files and files larger than 1 MB. Symbols are
extracted from TypeScript, JavaScript and Python declarations. Each worktree
of a repository has its own index, so uncommitted changes in one never show up
in another.

An index keeps each searchable line's text once, so it takes roughly 1.7 times
the size of the code it covers (about 210 MB for a 17,000-file, 127 MB
repository). When an update changes the index format, the old index is deleted
on first use and rebuilt.

Each index is a SQLite file at
`<Orca data folder>/plugins-data/ab2web.orca-sonar/index/<repo>/<worktree>.sqlite`,
where both names are hashes (the data folder is `~/Library/Application Support/orca`
on macOS, `%APPDATA%\orca` on Windows and `~/.config/orca` on Linux). An index
records the folder it belongs to, and it does not outlive that folder: each
time the panels refresh (see _Why the panels wait for activity_), Sonar
deletes the index of any workspace whose folder no longer exists, such as a
removed worktree. An index built before 0.2.3 records no folder, so it is
deleted only when it belongs to none of the worktrees Orca lists.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
```

Screenshots of both panels in every state, at 1440, 768, 390 and 320 px, light
and dark, Spanish and English. Playwright and the images live outside the
plugin folder, because Orca hashes and copies everything inside it:

```sh
npm --prefix ../.orca-sonar-deps install playwright@1.59.1   # once
npm run screenshots                                          # PNGs in ../.orca-sonar-screenshots
```

The script fails when a state does not show its text, shows text it must not,
scrolls sideways, or a click does not write what the worker expects.

## License

MIT. See [LICENSE](LICENSE).
