import { resolve } from 'node:path'
import { indexFilePath, resolveUserDataDir, type Environment } from '../core/index-location.ts'
import { readIndexStatus, type IndexStatus } from '../core/index-status.ts'
import { openIndex, type IndexStore } from '../core/index-store.ts'
import { resolveLocale, type Locale } from '../core/locale.ts'
import { readPreferences } from '../core/preferences.ts'
import { pruneIndexes } from '../core/prune-indexes.ts'
import { runAgents } from './agents.ts'
import { translate, type MessageKey, type MessageValues } from '../core/messages.ts'
import { refreshIndex, type RefreshSummary } from '../core/refresh-index.ts'
import { tryRefreshLock, waitForRefreshLock } from '../core/refresh-lock.ts'
import { grepOutputBytes, readBytes } from '../core/savings.ts'
import { findLines, findSymbols } from '../core/search.ts'
import { recordQuery, summarizeUsage } from '../core/usage.ts'
import { resolveWorkspace, type Workspace } from '../core/workspace.ts'
import { parseInvocation, UsageError, type Invocation } from './arguments.ts'

export const DEFAULT_LIMIT = 20

/** How long `index` waits for another process to finish updating the same index. */
export const INDEX_LOCK_WAIT_MS = 10 * 60_000
const INDEX_LOCK_POLL_MS = 100

/** Days the `usage` command summarises. */
export const USAGE_WINDOW_DAYS = 30

export interface CliContext {
  readonly env: Environment
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly cwd: string
  readonly systemLocale: string
  /** Standard input, read whole; only `status --stdin` and `prune --stdin` ask for it. */
  readonly stdin?: () => Promise<string>
  /** Epoch milliseconds; defaults to the system clock. */
  readonly now?: () => number
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const EXIT_OK = 0
const EXIT_FAILURE = 1
const EXIT_USAGE = 2

export async function runCli(argv: readonly string[], context: CliContext): Promise<number> {
  const userDataDir = resolveUserDataDir(context.env, context.platform, context.home)
  const locale = resolveLocale(userDataDir, context.systemLocale)
  const say = (key: MessageKey, values?: MessageValues): string => translate(locale, key, values)

  let invocation: Invocation
  try {
    invocation = parseInvocation(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      context.stderr(`${say(error.messageKey, error.values)}\n`)
      return EXIT_USAGE
    }
    throw error
  }

  if (invocation.command === 'help') {
    context.stdout(`${say('usage')}\n`)
    return EXIT_OK
  }

  if (invocation.command === 'usage') {
    const summary = summarizeUsage(userDataDir, {
      now: (context.now ?? Date.now)(),
      days: USAGE_WINDOW_DAYS
    })
    const { totals } = summary
    context.stdout(
      invocation.json
        ? `${JSON.stringify({ command: 'usage', ...summary }, null, 2)}\n`
        : `${say('usageSummary', {
            queries: totals.queries,
            find: totals.find,
            symbol: totals.symbol,
            results: totals.results,
            averageMs: totals.averageMs === null ? 0 : Math.round(totals.averageMs),
            savedTokens: totals.savedTokens,
            savedBytes: totals.savedBytes
          })}\n`
    )
    return EXIT_OK
  }

  if (invocation.command === 'agents') {
    runAgents(invocation, { userDataDir, locale, context })
    return EXIT_OK
  }

  if (invocation.command === 'prune') {
    const keep = invocation.stdin ? new Set(nonEmptyLines(await readStdin(context))) : undefined
    const removed = pruneIndexes(userDataDir, keep === undefined ? {} : { keep })
    const size = removed.reduce((total, entry) => total + entry.sizeBytes, 0)
    context.stdout(
      invocation.json
        ? `${JSON.stringify({ command: 'prune', removed }, null, 2)}\n`
        : `${removed.length === 0 ? say('prunedNone') : say('pruned', { count: removed.length, size })}\n`
    )
    return EXIT_OK
  }

  const preferences = readPreferences(userDataDir)
  if ((invocation.command === 'find' || invocation.command === 'symbol') && !preferences.agents) {
    context.stderr(`${say('agentsOff')}\n`)
    return EXIT_FAILURE
  }
  // Orca's background warm-up sets ORCA_SONAR_WARMUP=1; --warmup does the same by hand.
  const warmup = invocation.warmup || context.env.ORCA_SONAR_WARMUP === '1'
  if (invocation.command === 'index' && warmup && !(preferences.warmup && preferences.agents)) {
    context.stdout(
      invocation.json
        ? `${JSON.stringify({ command: 'index', skipped: 'warmup-off' }, null, 2)}\n`
        : `${say('warmupSkipped')}\n`
    )
    return EXIT_OK
  }

  if (invocation.command === 'status' && invocation.stdin) {
    const roots = nonEmptyLines(await readStdin(context))
    const workspaces = await Promise.all(roots.map((root) => statusOf(root, userDataDir)))
    const lines = workspaces.map((entry) =>
      'error' in entry
        ? `${entry.root}: ${entry.error}`
        : entry.exists
          ? say('status', {
              root: entry.root,
              files: entry.files,
              symbols: entry.symbols,
              lastIndexedAt: entry.lastIndexedAt ?? say('neverIndexed'),
              size: entry.sizeBytes,
              path: entry.indexPath
            })
          : say('statusMissing', { root: entry.root })
    )
    context.stdout(
      invocation.json
        ? `${JSON.stringify({ command: 'status', workspaces }, null, 2)}\n`
        : `${lines.join('\n')}\n`
    )
    return EXIT_OK
  }

  try {
    const workspace = await resolveWorkspace(resolve(context.cwd, invocation.root ?? '.'))
    const indexPath = indexFilePath({
      userDataDir,
      repoId: workspace.repoId,
      rootKey: workspace.rootKey
    })
    if (invocation.command === 'status') {
      return reportStatus(invocation, { workspace, indexPath, locale, context })
    }
    const index = openIndex(indexPath)
    try {
      return await execute(invocation, {
        index,
        workspace,
        indexPath,
        locale,
        userDataDir,
        context
      })
    } finally {
      index.close()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const key: MessageKey = /fts5/i.test(message) ? 'fts5Missing' : 'failed'
    context.stderr(`${say(key, { message })}\n`)
    return EXIT_FAILURE
  }
}

function readStdin(context: CliContext): Promise<string> {
  return context.stdin ? context.stdin() : Promise.resolve('')
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

type RootStatus =
  ({ readonly root: string } & IndexStatus) | { readonly root: string; readonly error: string }

/** One root's index status; a root that cannot be resolved is reported, not thrown. */
async function statusOf(root: string, userDataDir: string): Promise<RootStatus> {
  try {
    const workspace = await resolveWorkspace(root)
    const indexPath = indexFilePath({
      userDataDir,
      repoId: workspace.repoId,
      rootKey: workspace.rootKey
    })
    return { root, ...readIndexStatus(indexPath) }
  } catch (error) {
    return { root, error: error instanceof Error ? error.message : String(error) }
  }
}

interface StatusReport {
  readonly workspace: Workspace
  readonly indexPath: string
  readonly locale: Locale
  readonly context: CliContext
}

/** Read-only: never opens the index for writing, so a missing index stays missing. */
function reportStatus(invocation: Invocation, report: StatusReport): number {
  const { workspace, indexPath, locale, context } = report
  const status = readIndexStatus(indexPath)
  if (invocation.json) {
    context.stdout(
      `${JSON.stringify({ command: 'status', root: workspace.root, ...status }, null, 2)}\n`
    )
    return EXIT_OK
  }
  const text = status.exists
    ? translate(locale, 'status', {
        root: workspace.root,
        files: status.files,
        symbols: status.symbols,
        lastIndexedAt: status.lastIndexedAt ?? translate(locale, 'neverIndexed'),
        size: status.sizeBytes,
        path: indexPath
      })
    : translate(locale, 'statusMissing', { root: workspace.root })
  context.stdout(`${text}\n`)
  return EXIT_OK
}

interface Execution {
  readonly index: IndexStore
  readonly workspace: Workspace
  readonly indexPath: string
  readonly locale: Locale
  readonly userDataDir: string
  readonly context: CliContext
}

async function execute(invocation: Invocation, execution: Execution): Promise<number> {
  const { index, workspace, indexPath, locale, userDataDir, context } = execution
  const say = (key: MessageKey, values?: MessageValues): string => translate(locale, key, values)
  const emit = (payload: Record<string, unknown>, text: string): number => {
    const printed = invocation.json ? `${JSON.stringify(payload, null, 2)}\n` : `${text}\n`
    context.stdout(printed)
    return Buffer.byteLength(printed)
  }
  const now = context.now ?? Date.now

  if (invocation.command === 'install') {
    emit({ command: 'install', indexPath }, say('installed', { path: indexPath }))
    return EXIT_OK
  }

  if (invocation.command === 'index') {
    const lock = await waitForRefreshLock(indexPath, {
      timeoutMs: INDEX_LOCK_WAIT_MS,
      pollMs: INDEX_LOCK_POLL_MS
    })
    let summary: RefreshSummary
    try {
      summary = await refreshIndex(index, workspace)
    } finally {
      lock.release()
    }
    emit(
      { command: 'index', ...summary },
      say('indexed', {
        indexed: summary.indexed,
        unchanged: summary.unchanged,
        removed: summary.removed
      })
    )
    return EXIT_OK
  }

  const query = invocation.positionals.join(' ')
  const limit = invocation.limit ?? DEFAULT_LIMIT
  const startedAt = now()
  // While another process updates the index, answer from it as it is rather than queue.
  const lock = tryRefreshLock(indexPath)
  if (lock) {
    try {
      await refreshIndex(index, workspace)
    } finally {
      lock.release()
    }
  } else {
    context.stderr(`${say('refreshBusy')}\n`)
  }
  // Time the agent waited for its answer: the incremental refresh plus the lookup.
  let answeredAt = startedAt
  const record = (
    command: 'find' | 'symbol',
    paths: readonly string[],
    outputBytes: number
  ): void => {
    try {
      recordQuery(userDataDir, {
        at: now(),
        command,
        repoId: workspace.repoId,
        rootKey: workspace.rootKey,
        durationMs: answeredAt - startedAt,
        results: paths.length,
        outputBytes,
        grepBytes: grepOutputBytes(index, query),
        readBytes: readBytes(index, paths)
      })
    } catch {
      // Statistics are best effort: the results are already printed.
    }
  }

  if (invocation.command === 'find') {
    const results = findLines(index, query, limit)
    answeredAt = now()
    const text =
      results.length === 0
        ? say('noMatches', { query })
        : results
            .map((match) => `${match.path}:${String(match.line)}  ${match.text.trim()}`)
            .join('\n')
    const printed = emit({ command: 'find', query, results }, text)
    record(
      'find',
      results.map((match) => match.path),
      printed
    )
    return EXIT_OK
  }

  const results = findSymbols(index, query, limit)
  answeredAt = now()
  const text =
    results.length === 0
      ? say('noMatches', { query })
      : results
          .map((match) => `${match.path}:${String(match.line)}  ${match.kind} ${match.name}`)
          .join('\n')
  const printed = emit({ command: 'symbol', query, results }, text)
  record(
    'symbol',
    results.map((match) => match.path),
    printed
  )
  return EXIT_OK
}
