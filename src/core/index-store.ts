import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

export const SCHEMA_VERSION = 1

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
PRAGMA user_version = ${String(SCHEMA_VERSION)};
`

export type Row = Record<string, SQLInputValue>

export interface IndexStore {
  exec(sql: string): void
  all(sql: string, params?: readonly SQLInputValue[]): Row[]
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

  return {
    exec: (sql) => {
      db.exec(sql)
    },
    all: (sql, params = []) =>
      db
        .prepare(sql)
        .all(...params)
        .map((row) => ({ ...row })),
    schemaVersion: () => {
      const [row] = db.prepare('PRAGMA user_version').all()
      return Number(row?.user_version ?? 0)
    },
    close: () => {
      db.close()
    }
  }
}
