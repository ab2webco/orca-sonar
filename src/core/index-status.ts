import { existsSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { INDEXED_AT_KEY } from './refresh-index.ts'

export interface IndexStatus {
  readonly exists: boolean
  readonly indexPath: string
  readonly files: number
  readonly symbols: number
  /** ISO time of the last refresh, or null for a missing index or one older than the `meta` table. */
  readonly lastIndexedAt: string | null
  /** The SQLite file plus its WAL and shared-memory files. */
  readonly sizeBytes: number
}

const COMPANION_SUFFIXES = ['', '-wal', '-shm'] as const

function fileSize(path: string): number {
  return statSync(path, { throwIfNoEntry: false })?.size ?? 0
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").all(name).length > 0
  )
}

function count(db: DatabaseSync, table: 'files' | 'symbols'): number {
  if (!hasTable(db, table)) {
    return 0
  }
  const [row] = db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).all()
  return Number(row?.total ?? 0)
}

function indexedAt(db: DatabaseSync): string | null {
  if (!hasTable(db, 'meta')) {
    return null
  }
  const [row] = db.prepare('SELECT value FROM meta WHERE key = ?').all(INDEXED_AT_KEY)
  return typeof row?.value === 'string' ? row.value : null
}

/**
 * What one workspace's index holds. Read-only: a missing index is reported as
 * missing and never created, so checking the status leaves no trace on disk.
 */
export function readIndexStatus(indexPath: string): IndexStatus {
  if (!existsSync(indexPath)) {
    return { exists: false, indexPath, files: 0, symbols: 0, lastIndexedAt: null, sizeBytes: 0 }
  }
  const db = new DatabaseSync(indexPath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 2000')
    return {
      exists: true,
      indexPath,
      files: count(db, 'files'),
      symbols: count(db, 'symbols'),
      lastIndexedAt: indexedAt(db),
      sizeBytes: COMPANION_SUFFIXES.reduce(
        (total, suffix) => total + fileSize(indexPath + suffix),
        0
      )
    }
  } finally {
    db.close()
  }
}
