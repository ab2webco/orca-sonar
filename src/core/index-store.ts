import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'

export const SCHEMA_VERSION = 4

/**
 * A line's FTS rowid is `file id * LINE_SPAN + line number`, so the index keeps
 * each line's text once, with no path per line, and a file's lines are one
 * rowid range. 2^21 is above the line count of the largest indexed file (1 MB).
 */
export const LINE_SPAN = 2 ** 21

const TOKENIZER = `tokenize = "unicode61 tokenchars '_'"`

/** Binary and oversized files, recorded so a refresh reads them again only after they change. */
const SKIPPED_FILES = `
CREATE TABLE IF NOT EXISTS skipped_files (
  path TEXT PRIMARY KEY,
  mtime_ms REAL NOT NULL,
  size INTEGER NOT NULL
);
`

/** What brings an index from each older version to the next, without rebuilding it. */
const UPGRADES: ReadonlyMap<number, string> = new Map([[3, SKIPPED_FILES]])

function canUpgrade(version: number): boolean {
  if (version <= 0 || version >= SCHEMA_VERSION) {
    return false
  }
  for (let step = version; step < SCHEMA_VERSION; step++) {
    if (!UPGRADES.has(step)) {
      return false
    }
  }
  return true
}

// columnsize=0 drops the per-line token counts; bm25 recounts only the lines
// that match, which are short.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  mtime_ms REAL NOT NULL,
  size INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS lines_fts USING fts5(text, ${TOKENIZER}, columnsize = 0);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS symbols_by_file ON symbols (file_id);
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, ${TOKENIZER});
${SKIPPED_FILES}
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
PRAGMA user_version = ${String(SCHEMA_VERSION)};
`

function userVersion(db: DatabaseSync): number {
  const [row] = db.prepare('PRAGMA user_version').all()
  return Number(row?.user_version ?? 0)
}

function tableNames(db: DatabaseSync, virtual: boolean): string[] {
  return db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          AND (sql LIKE 'CREATE VIRTUAL%') = ?`
    )
    .all(virtual ? 1 : 0)
    .map((row) => String(row.name))
}

/**
 * Deletes an index another schema version built and no upgrade covers, which is far faster than
 * dropping its tables in place (25 s for an 830 MB index). When the files
 * cannot be removed, for example while another process holds them open on
 * Windows, `prepareSchema` replaces the schema in place instead.
 */
function discardOutdated(path: string): void {
  if (!existsSync(path)) {
    return
  }
  const probe = new DatabaseSync(path, { readOnly: true })
  let version: number
  try {
    probe.exec('PRAGMA busy_timeout = 2000')
    version = userVersion(probe)
  } finally {
    probe.close()
  }
  if (version === SCHEMA_VERSION || version === 0 || canUpgrade(version)) {
    return
  }
  try {
    for (const suffix of ['-wal', '-shm', '']) {
      rmSync(path + suffix, { force: true })
    }
  } catch {
    // Kept for prepareSchema to replace in place.
  }
}

/**
 * Creates the schema, upgrades an older index that an upgrade covers, or
 * replaces any other: its tables are dropped, so the next refresh rebuilds it,
 * and the file is compacted. Runs only when the version differs, so opening an
 * up-to-date index writes nothing.
 */
function prepareSchema(db: DatabaseSync): void {
  if (userVersion(db) === SCHEMA_VERSION) {
    return
  }
  db.exec('BEGIN IMMEDIATE')
  let replaced = false
  try {
    const version = userVersion(db)
    if (canUpgrade(version)) {
      for (let step = version; step < SCHEMA_VERSION; step++) {
        db.exec(UPGRADES.get(step) ?? '')
      }
      db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
    } else if (version !== SCHEMA_VERSION) {
      replaced = version !== 0
      // Virtual tables first: dropping one also drops its shadow tables.
      for (const name of [...tableNames(db, true), ...tableNames(db, false)]) {
        db.exec(`DROP TABLE IF EXISTS "${name}"`)
      }
      db.exec(SCHEMA)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  if (replaced) {
    db.exec('VACUUM')
  }
}

export type Row = Record<string, SQLInputValue>

export interface IndexStore {
  exec(sql: string): void
  all(sql: string, params?: readonly SQLInputValue[]): Row[]
  /** Runs one statement and returns the rowid of the last inserted row. */
  run(sql: string, params?: readonly SQLInputValue[]): number
  transaction(work: () => void): void
  schemaVersion(): number
  close(): void
}

/**
 * Opens (and creates, if needed) one workspace's index. Throws when the SQLite
 * build has no FTS5, which is the first thing `install` checks.
 */
export function openIndex(path: string): IndexStore {
  mkdirSync(dirname(path), { recursive: true })
  discardOutdated(path)
  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL;')
  prepareSchema(db)

  const statements = new Map<string, StatementSync>()
  let inTransaction = false
  const statement = (sql: string): StatementSync => {
    const cached = statements.get(sql)
    if (cached) {
      return cached
    }
    const prepared = db.prepare(sql)
    statements.set(sql, prepared)
    return prepared
  }

  return {
    exec: (sql) => {
      db.exec(sql)
    },
    all: (sql, params = []) =>
      statement(sql)
        .all(...params)
        .map((row) => ({ ...row })),
    run: (sql, params = []) => Number(statement(sql).run(...params).lastInsertRowid),
    transaction: (work) => {
      if (inTransaction) {
        work()
        return
      }
      inTransaction = true
      db.exec('BEGIN IMMEDIATE')
      try {
        work()
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      } finally {
        inTransaction = false
      }
    },
    schemaVersion: () => {
      const [row] = statement('PRAGMA user_version').all()
      return Number(row?.user_version ?? 0)
    },
    close: () => {
      statements.clear()
      db.close()
    }
  }
}
