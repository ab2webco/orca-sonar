import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pluginDataDir } from './index-location.ts'
import { estimateSaving } from './savings.ts'

/** Older records are dropped on the next write. */
export const USAGE_RETENTION_DAYS = 90

const DAY_MS = 86_400_000

/**
 * One lookup, as recorded. The words searched for are never kept: they can
 * name clients or code, and the statistics are shown to people.
 */
export interface QueryRecord {
  /** Epoch milliseconds. */
  readonly at: number
  readonly command: 'find' | 'symbol'
  readonly repoId: string
  readonly rootKey: string
  readonly durationMs: number
  readonly results: number
  readonly outputBytes: number
  readonly grepBytes: number
  readonly readBytes: number
}

export interface UsageDay {
  /** Local calendar day, YYYY-MM-DD. */
  readonly day: string
  readonly find: number
  readonly symbol: number
}

export interface UsageTotals {
  readonly queries: number
  readonly find: number
  readonly symbol: number
  readonly results: number
  readonly averageMs: number | null
  readonly outputBytes: number
  readonly baselineBytes: number
  readonly savedBytes: number
  readonly savedTokens: number
}

export interface UsageSummary {
  /** ISO time of the oldest record kept, or null when nothing was recorded. */
  readonly since: string | null
  readonly days: readonly UsageDay[]
  readonly totals: UsageTotals
  readonly workspacesQueried: number
  readonly workspacesIndexed: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queries (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  command TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  root_key TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  results INTEGER NOT NULL,
  output_bytes INTEGER NOT NULL,
  grep_bytes INTEGER NOT NULL,
  read_bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS queries_by_time ON queries (at);
`

export function usageFilePath(userDataDir: string): string {
  return join(pluginDataDir(userDataDir), 'usage.sqlite')
}

/**
 * Adds one lookup to the statistics. Several agents can search at once, so
 * the file is SQLite with a busy timeout. A failure here is swallowed: the
 * statistics must never cost an agent its results.
 */
export function recordQuery(userDataDir: string, record: QueryRecord): void {
  try {
    mkdirSync(pluginDataDir(userDataDir), { recursive: true })
    const db = new DatabaseSync(usageFilePath(userDataDir))
    try {
      db.exec('PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL;')
      db.exec(SCHEMA)
      db.prepare(
        `INSERT INTO queries (at, command, repo_id, root_key, duration_ms, results,
                              output_bytes, grep_bytes, read_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        record.at,
        record.command,
        record.repoId,
        record.rootKey,
        record.durationMs,
        record.results,
        record.outputBytes,
        record.grepBytes,
        record.readBytes
      )
      db.prepare('DELETE FROM queries WHERE at < ?').run(record.at - USAGE_RETENTION_DAYS * DAY_MS)
    } finally {
      db.close()
    }
  } catch {
    // Statistics are best effort; the lookup already printed its results.
  }
}

function localDay(time: number): string {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/** Index files under Sonar's data folder: one per indexed workspace. */
function countIndexes(userDataDir: string): number {
  const root = join(pluginDataDir(userDataDir), 'index')
  if (!existsSync(root)) {
    return 0
  }
  let count = 0
  for (const repo of readdirSync(root, { withFileTypes: true })) {
    if (repo.isDirectory()) {
      count += readdirSync(join(root, repo.name)).filter((name) => name.endsWith('.sqlite')).length
    }
  }
  return count
}

interface Row {
  readonly at: number
  readonly command: string
  readonly rootKey: string
  readonly durationMs: number
  readonly results: number
  readonly outputBytes: number
  readonly grepBytes: number
  readonly readBytes: number
}

function readRows(userDataDir: string, from: number): { rows: Row[]; since: number | null } {
  const path = usageFilePath(userDataDir)
  if (!existsSync(path)) {
    return { rows: [], since: null }
  }
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 2000')
    const [oldest] = db.prepare('SELECT MIN(at) AS at FROM queries').all()
    const rows = db
      .prepare(
        `SELECT at, command, root_key, duration_ms, results, output_bytes, grep_bytes, read_bytes
           FROM queries WHERE at >= ? ORDER BY at`
      )
      .all(from)
      .map((row) => ({
        at: Number(row.at),
        command: String(row.command),
        rootKey: String(row.root_key),
        durationMs: Number(row.duration_ms),
        results: Number(row.results),
        outputBytes: Number(row.output_bytes),
        grepBytes: Number(row.grep_bytes),
        readBytes: Number(row.read_bytes)
      }))
    return { rows, since: oldest?.at === null || oldest === undefined ? null : Number(oldest.at) }
  } finally {
    db.close()
  }
}

/** Statistics for the last `days` local days, today included. Read-only. */
export function summarizeUsage(
  userDataDir: string,
  options: { readonly now: number; readonly days: number }
): UsageSummary {
  const today = new Date(options.now)
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - (options.days - 1)
  )
  const buckets = new Map<string, { find: number; symbol: number }>()
  for (let offset = 0; offset < options.days; offset++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset)
    buckets.set(localDay(day.getTime()), { find: 0, symbol: 0 })
  }

  const { rows, since } = readRows(userDataDir, start.getTime())
  const roots = new Set<string>()
  let find = 0
  let symbol = 0
  let results = 0
  let durationMs = 0
  let outputBytes = 0
  let baselineBytes = 0
  let savedBytes = 0
  let savedTokens = 0
  for (const row of rows) {
    const bucket = buckets.get(localDay(row.at))
    const isSymbol = row.command === 'symbol'
    if (bucket) {
      if (isSymbol) bucket.symbol++
      else bucket.find++
    }
    if (isSymbol) symbol++
    else find++
    roots.add(row.rootKey)
    results += row.results
    durationMs += row.durationMs
    outputBytes += row.outputBytes
    const saving = estimateSaving(row)
    baselineBytes += saving.baselineBytes
    savedBytes += saving.savedBytes
    savedTokens += saving.savedTokens
  }

  const queries = rows.length
  return {
    since: since === null ? null : new Date(since).toISOString(),
    days: [...buckets].map(([day, counts]) => ({ day, ...counts })),
    totals: {
      queries,
      find,
      symbol,
      results,
      averageMs: queries === 0 ? null : durationMs / queries,
      outputBytes,
      baselineBytes,
      savedBytes,
      savedTokens
    },
    workspacesQueried: roots.size,
    workspacesIndexed: countIndexes(userDataDir)
  }
}
