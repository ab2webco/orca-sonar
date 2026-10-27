import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'

export const SCHEMA_VERSION = 2

const TOKENIZER = `tokenize = "unicode61 tokenchars '_'"`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  mtime_ms REAL NOT NULL,
  size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lines (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS lines_by_path ON lines (path);
CREATE VIRTUAL TABLE IF NOT EXISTS lines_fts USING fts5(text, ${TOKENIZER});
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS symbols_by_path ON symbols (path);
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, ${TOKENIZER});
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
PRAGMA user_version = ${String(SCHEMA_VERSION)};
`

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
  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA)

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
