import { join } from 'node:path'
import { PLUGIN_IDENTITY } from '../core/index-location.ts'
import { PREFERENCES_KEY } from '../core/preferences.ts'
import type { RunResult, Runner } from './run-process.ts'
import {
  REBUILDS_KEY,
  REBUILD_REQUEST_PREFIX,
  STATE_KEY,
  USAGE_KEY,
  isRecord,
  normalizeBranch,
  parseIndexSummary,
  parseRebuildRequest,
  parseRebuilds,
  type IndexSummary,
  type Problem,
  type PublishedState,
  type RebuildProgress,
  type SonarCommand,
  type WorkspaceEntry
} from './state.ts'

/** The part of Orca's plugin host API the worker uses. */
export interface Host {
  call(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown>
}

export interface WorkerOptions {
  readonly host: Host
  readonly run: Runner
  /** The plugin's own folder, holding `bin/orca-sonar.ts`. */
  readonly pluginRoot: string
  /** Orca's userData folder; the CLI keeps its index and statistics under it. */
  readonly userDataDir: string
  /** The user's home folder, where Claude Code and Codex keep their configuration. */
  readonly home: string
  readonly baseEnv: Readonly<Record<string, string | undefined>>
  readonly now: () => Date
}

/** Rebuilds a wake started. `done` settles once they ran and the status was published again. */
export interface RebuildHandle {
  readonly done: Promise<void>
}

export interface Worker {
  /**
   * Mirrors the panel's switches into the plugin settings, attends pending
   * rebuild requests and publishes every local workspace's status and the usage
   * statistics. Without `force`, a check younger than a minute is kept.
   */
  wake(options: { readonly force: boolean }): Promise<RebuildHandle>
}

/** Event-driven checks closer together than this reuse the last one. */
export const RECHECK_AFTER_MS = 60_000
/** A panel request older than this is dropped: whoever asked has moved on. */
export const REBUILD_REQUEST_TTL_MS = 60 * 60_000

const ORCA_TIMEOUT_MS = 15_000
const STATUS_TIMEOUT_MS = 25_000
const INDEX_TIMEOUT_MS = 10 * 60_000
const MAX_ERROR_LENGTH = 300
/** Keeps the published list well inside Orca's 256 KiB storage value limit. */
const MAX_WORKSPACES = 500

const INSTALLED_ROOT = /^(.*)[\\/]plugins[\\/]ab2web\.orca-sonar[\\/][0-9a-f]{64}[\\/]?$/

/**
 * Orca installs a plugin under `<userData>/plugins/<publisher>.<id>/<hash>/`.
 * Returns undefined for any other location, such as a development folder.
 */
export function userDataDirFromPluginRoot(pluginRoot: string): string | undefined {
  return INSTALLED_ROOT.exec(pluginRoot)?.[1]
}

/**
 * Node hands the worker's own --permission sandbox (read: the plugin folder
 * only) to every node child through NODE_OPTIONS, and clearing that variable
 * does not stop it. So the CLI gets explicit grants instead: it reads the
 * worktree, its git folder and Orca's settings, writes only Sonar's data
 * folder, and runs git.
 */
export function cliPermissions(userDataDir: string): readonly string[] {
  return [
    '--permission',
    '--allow-fs-read=*',
    `--allow-fs-write=${join(userDataDir, 'plugins-data', PLUGIN_IDENTITY)}`,
    '--allow-child-process',
    '--disable-warning=SecurityWarning'
  ]
}

/**
 * The grants for `agents install|remove`: the same as the CLI's, plus write
 * access to exactly the folders where Claude Code and Codex look for skills
 * and hooks, honouring CLAUDE_CONFIG_DIR and CODEX_HOME.
 */
export function agentsPermissions(
  userDataDir: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>
): readonly string[] {
  const writable = [
    join(userDataDir, 'plugins-data', PLUGIN_IDENTITY),
    env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    join(userDataDir, 'claude-accounts'),
    env.CODEX_HOME || join(home, '.codex'),
    join(userDataDir, 'codex-accounts')
  ]
  return [
    '--permission',
    '--allow-fs-read=*',
    ...writable.map((path) => `--allow-fs-write=${path}`),
    '--disable-warning=SecurityWarning'
  ]
}

/** Node's own warnings, which can precede the CLI's message on stderr. */
const NODE_WARNING = /^\(node:\d+\) |^\(Use `node --trace-warnings/

function firstLine(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .find((candidate) => candidate.trim().length > 0 && !NODE_WARNING.test(candidate)) ?? ''
  return line.trim().slice(0, MAX_ERROR_LENGTH)
}

function failureMessage(result: RunResult): string {
  if (result.kind === 'not-found') {
    return 'not found'
  }
  return firstLine(result.stderr) || firstLine(result.stdout) || `exit code ${String(result.code)}`
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

interface LocalWorktree {
  readonly root: string
  readonly displayName: string
  readonly branch: string
}

type WorktreeList =
  | { readonly kind: 'listed'; readonly worktrees: readonly LocalWorktree[] }
  | { readonly kind: 'failed'; readonly problem: Problem; readonly error?: string }

/** Local worktrees from `orca worktree list --json`, one per path. Remote hosts are left out. */
function parseWorktreeList(stdout: string): LocalWorktree[] | null {
  const parsed = parseJson(stdout)
  const listed = isRecord(parsed) && isRecord(parsed.result) ? parsed.result.worktrees : undefined
  if (!Array.isArray(listed)) {
    return null
  }
  const byRoot = new Map<string, LocalWorktree>()
  for (const entry of listed) {
    if (
      isRecord(entry) &&
      typeof entry.path === 'string' &&
      entry.hostId === 'local' &&
      !byRoot.has(entry.path)
    ) {
      byRoot.set(entry.path, {
        root: entry.path,
        displayName: typeof entry.displayName === 'string' ? entry.displayName : entry.path,
        branch: typeof entry.branch === 'string' ? normalizeBranch(entry.branch) : ''
      })
    }
  }
  return [...byRoot.values()]
}

/** `status --stdin --json` output, by root. */
function parseStatuses(stdout: string): Map<string, IndexSummary | { error: string }> | null {
  const parsed = parseJson(stdout)
  if (!isRecord(parsed) || !Array.isArray(parsed.workspaces)) {
    return null
  }
  const statuses = new Map<string, IndexSummary | { error: string }>()
  for (const entry of parsed.workspaces) {
    if (!isRecord(entry) || typeof entry.root !== 'string') {
      continue
    }
    const summary = parseIndexSummary(entry)
    if (summary) {
      statuses.set(entry.root, summary)
    } else if (typeof entry.error === 'string') {
      statuses.set(entry.root, { error: entry.error.slice(0, MAX_ERROR_LENGTH) })
    }
  }
  return statuses
}

export function createWorker(options: WorkerOptions): Worker {
  const { host, run, pluginRoot, userDataDir, now } = options
  const cli = [...cliPermissions(userDataDir), join(pluginRoot, 'bin', 'orca-sonar.ts')]
  const env: Record<string, string | undefined> = {
    ...options.baseEnv,
    ORCA_USER_DATA_PATH: userDataDir
  }
  delete env.ELECTRON_RUN_AS_NODE

  const read = async (key: string): Promise<unknown> => {
    const stored = await host.call('storage.get', { key })
    return isRecord(stored) ? stored.value : undefined
  }
  const write = (key: string, value: unknown): Promise<unknown> =>
    host.call('storage.set', { key, value })

  /** Whether this worker already put Sonar in the agents (true) or took it out (false). */
  let agentsApplied: boolean | undefined
  /**
   * Teaches Claude Code and Codex about Sonar while the agents switch is on,
   * and takes that out when it is off. Once per worker: Orca starts a fresh
   * worker after a plugin update, so the copies follow the installed version.
   */
  const applyAgentIntegration = async (): Promise<void> => {
    const preferences = await read(PREFERENCES_KEY)
    const enabled = !(isRecord(preferences) && preferences.agents === false)
    if (agentsApplied === enabled) {
      return
    }
    const permissions = agentsPermissions(userDataDir, options.home, options.baseEnv)
    const script = join(pluginRoot, 'bin', 'orca-sonar.ts')
    const result = await run(
      'node',
      [...permissions, script, 'agents', enabled ? 'install' : 'remove', '--json'],
      { env, timeoutMs: STATUS_TIMEOUT_MS }
    )
    if (result.kind === 'exited' && result.code === 0) {
      agentsApplied = enabled
    }
  }

  let rebuildWrites: Promise<unknown> = Promise.resolve()
  /** Read-modify-write of the rebuild progress, one at a time. */
  const setProgress = (root: string, progress: RebuildProgress): Promise<void> => {
    const next = rebuildWrites.then(async () => {
      const rebuilds = parseRebuilds(await read(REBUILDS_KEY))
      await write(REBUILDS_KEY, { ...rebuilds, [root]: progress })
    })
    rebuildWrites = next.catch(() => undefined)
    return next
  }

  const runOrca = (args: readonly string[]): Promise<RunResult> =>
    run('orca', args, { env, timeoutMs: ORCA_TIMEOUT_MS })

  const listWorktrees = async (): Promise<WorktreeList> => {
    const result = await runOrca(['worktree', 'list', '--json'])
    if (result.kind === 'not-found') {
      return { kind: 'failed', problem: 'orca-cli-missing' }
    }
    const worktrees = result.code === 0 ? parseWorktreeList(result.stdout) : null
    return worktrees === null
      ? { kind: 'failed', problem: 'error', error: failureMessage(result) }
      : { kind: 'listed', worktrees: worktrees.slice(0, MAX_WORKSPACES) }
  }

  const probeSonar = async (): Promise<SonarCommand> => {
    const result = await runOrca(['sonar', '--help'])
    return result.kind === 'exited' && result.code === 0 ? 'available' : 'missing'
  }

  const mirrorUsage = async (): Promise<void> => {
    const result = await run('node', [...cli, 'usage', '--json'], {
      env,
      timeoutMs: STATUS_TIMEOUT_MS
    })
    const usage = result.kind === 'exited' && result.code === 0 ? parseJson(result.stdout) : null
    if (isRecord(usage)) {
      await write(USAGE_KEY, usage)
    }
  }

  /**
   * Deletes the indexes of workspaces whose folder is gone. Indexes from before
   * roots were recorded are judged against the live index paths, which are only
   * passed when every workspace was checked. Best effort: the next check retries.
   */
  const pruneIndexes = async (
    worktrees: readonly LocalWorktree[],
    statuses: ReadonlyMap<string, IndexSummary | { error: string }>
  ): Promise<void> => {
    const live = worktrees.map((worktree) => statuses.get(worktree.root))
    const indexPaths = live.flatMap((status) =>
      status === undefined || 'error' in status ? [] : [status.indexPath]
    )
    const complete = indexPaths.length === worktrees.length
    await run('node', [...cli, 'prune', ...(complete ? ['--stdin'] : []), '--json'], {
      env,
      timeoutMs: STATUS_TIMEOUT_MS,
      ...(complete ? { input: indexPaths.map((path) => `${path}\n`).join('') } : {})
    })
  }

  const mirrorPreferences = async (): Promise<void> => {
    const preferences = await read(PREFERENCES_KEY)
    if (!isRecord(preferences)) {
      return
    }
    const current = await host.call('settings.get', {})
    const settings = isRecord(current) && isRecord(current.settings) ? current.settings : {}
    if (JSON.stringify(settings[PREFERENCES_KEY]) !== JSON.stringify(preferences)) {
      await host.call('settings.set', { key: PREFERENCES_KEY, value: preferences })
    }
  }

  /** Publishes every local workspace's status; returns the roots it found. */
  const refresh = async (): Promise<ReadonlySet<string>> => {
    const [list, sonarCommand] = await Promise.all([listWorktrees(), probeSonar()])
    const checkedAt = now().toISOString()
    if (list.kind === 'failed') {
      const state: PublishedState = {
        version: 2,
        checkedAt,
        sonarCommand,
        problem: list.problem,
        ...(list.error === undefined ? {} : { error: list.error }),
        workspaces: []
      }
      await write(STATE_KEY, state)
      return new Set()
    }

    const result = await run('node', [...cli, 'status', '--stdin', '--json'], {
      env,
      timeoutMs: STATUS_TIMEOUT_MS,
      input: list.worktrees.map((worktree) => `${worktree.root}\n`).join('')
    })
    const statuses =
      result.kind === 'exited' && result.code === 0 ? parseStatuses(result.stdout) : null
    const problem: Problem | undefined =
      result.kind === 'not-found' ? 'node-missing' : statuses === null ? 'error' : undefined
    const workspaces: WorkspaceEntry[] = list.worktrees.map((worktree) => {
      const status = statuses?.get(worktree.root)
      if (status === undefined) {
        return worktree
      }
      return 'error' in status
        ? { ...worktree, error: status.error }
        : { ...worktree, index: status }
    })
    const state: PublishedState = {
      version: 2,
      checkedAt,
      sonarCommand,
      ...(problem === undefined ? {} : { problem }),
      ...(problem === 'error' ? { error: failureMessage(result) } : {}),
      workspaces
    }
    await write(STATE_KEY, state)
    if (problem === undefined && statuses !== null) {
      await pruneIndexes(list.worktrees, statuses)
      await mirrorUsage()
    }
    return new Set(list.worktrees.map((worktree) => worktree.root))
  }

  const isDue = async (): Promise<boolean> => {
    const state = await read(STATE_KEY)
    const checkedAt = isRecord(state) && typeof state.checkedAt === 'string' ? state.checkedAt : ''
    const age = now().getTime() - Date.parse(checkedAt)
    return !(age >= 0 && age < RECHECK_AFTER_MS)
  }

  /** Takes every pending request out of storage, keeping the fresh ones. */
  const takeRequests = async (): Promise<string[]> => {
    const listed = await host.call('storage.keys', {})
    const keys = isRecord(listed) && Array.isArray(listed.keys) ? listed.keys : []
    const roots: string[] = []
    for (const key of keys) {
      if (typeof key !== 'string' || !key.startsWith(REBUILD_REQUEST_PREFIX)) {
        continue
      }
      const request = parseRebuildRequest(await read(key))
      await host.call('storage.delete', { key })
      const age = request ? now().getTime() - Date.parse(request.at) : NaN
      if (request && age >= 0 && age <= REBUILD_REQUEST_TTL_MS && !roots.includes(request.root)) {
        roots.push(request.root)
      }
    }
    return roots
  }

  const rebuild = async (root: string): Promise<void> => {
    const startedAt = now().toISOString()
    const result = await run('node', [...cli, 'index', '--root', root, '--json'], {
      env,
      timeoutMs: INDEX_TIMEOUT_MS
    })
    const finishedAt = now().toISOString()
    await setProgress(
      root,
      result.kind === 'exited' && result.code === 0
        ? { state: 'done', startedAt, finishedAt }
        : {
            state: 'failed',
            startedAt,
            finishedAt,
            error: result.kind === 'not-found' ? 'node not found' : failureMessage(result)
          }
    )
  }

  return {
    wake: async ({ force }) => {
      await mirrorPreferences()
      await applyAgentIntegration()
      const requested = await takeRequests()
      if (!force && requested.length === 0 && !(await isDue())) {
        return { done: Promise.resolve() }
      }
      const local = await refresh()

      const accepted: string[] = []
      for (const root of requested) {
        if (local.has(root)) {
          accepted.push(root)
          await setProgress(root, { state: 'running', startedAt: now().toISOString() })
        } else {
          const at = now().toISOString()
          await setProgress(root, {
            state: 'failed',
            startedAt: at,
            finishedAt: at,
            error: 'not a local Orca worktree'
          })
        }
      }
      if (accepted.length === 0) {
        return { done: Promise.resolve() }
      }

      // One at a time, so several rebuilds never compete for the disk.
      const done = (async () => {
        for (const root of accepted) {
          await rebuild(root)
        }
        await refresh()
      })()
      return { done }
    }
  }
}
