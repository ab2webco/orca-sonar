import { resolve } from 'node:path'
import { indexFilePath, resolveUserDataDir, type Environment } from '../core/index-location.ts'
import { readIndexStatus } from '../core/index-status.ts'
import { openIndex, type IndexStore } from '../core/index-store.ts'
import { resolveLocale, type Locale } from '../core/locale.ts'
import { readPreferences } from '../core/preferences.ts'
import { translate, type MessageKey, type MessageValues } from '../core/messages.ts'
import { refreshIndex } from '../core/refresh-index.ts'
import { findLines, findSymbols } from '../core/search.ts'
import { resolveWorkspace, type Workspace } from '../core/workspace.ts'
import { parseInvocation, UsageError, type Invocation } from './arguments.ts'

export const DEFAULT_LIMIT = 20

export interface CliContext {
  readonly env: Environment
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly cwd: string
  readonly systemLocale: string
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
      return await execute(invocation, { index, workspace, indexPath, locale, context })
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
  readonly context: CliContext
}

async function execute(invocation: Invocation, execution: Execution): Promise<number> {
  const { index, workspace, indexPath, locale, context } = execution
  const say = (key: MessageKey, values?: MessageValues): string => translate(locale, key, values)
  const emit = (payload: Record<string, unknown>, text: string): void => {
    context.stdout(invocation.json ? `${JSON.stringify(payload, null, 2)}\n` : `${text}\n`)
  }

  if (invocation.command === 'install') {
    emit({ command: 'install', indexPath }, say('installed', { path: indexPath }))
    return EXIT_OK
  }

  if (invocation.command === 'index') {
    const summary = await refreshIndex(index, workspace)
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
  await refreshIndex(index, workspace)

  if (invocation.command === 'find') {
    const results = findLines(index, query, limit)
    const text =
      results.length === 0
        ? say('noMatches', { query })
        : results
            .map((match) => `${match.path}:${String(match.line)}  ${match.text.trim()}`)
            .join('\n')
    emit({ command: 'find', query, results }, text)
    return EXIT_OK
  }

  const results = findSymbols(index, query, limit)
  const text =
    results.length === 0
      ? say('noMatches', { query })
      : results
          .map((match) => `${match.path}:${String(match.line)}  ${match.kind} ${match.name}`)
          .join('\n')
  emit({ command: 'symbol', query, results }, text)
  return EXIT_OK
}
