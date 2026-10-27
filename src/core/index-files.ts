import type { CodeSymbol } from './symbols.ts'
import { LINE_SPAN, type IndexStore } from './index-store.ts'

/** Longer lines are cut before they reach the index; minified bundles stay small. */
export const MAX_LINE_LENGTH = 500

export interface FileRecord {
  readonly path: string
  readonly mtimeMs: number
  readonly size: number
}

type FileStamps = Map<string, { mtimeMs: number; size: number }>

function stamps(index: IndexStore, table: 'files' | 'skipped_files'): FileStamps {
  const records: FileStamps = new Map()
  for (const row of index.all(`SELECT path, mtime_ms, size FROM ${table}`)) {
    if (typeof row.path === 'string') {
      records.set(row.path, { mtimeMs: Number(row.mtime_ms), size: Number(row.size) })
    }
  }
  return records
}

export function indexedFiles(index: IndexStore): FileStamps {
  return stamps(index, 'files')
}

/** Binary and oversized files, with the modification time and size they were skipped at. */
export function skippedFiles(index: IndexStore): FileStamps {
  return stamps(index, 'skipped_files')
}

/** Forgets the file's content and records it as skipped, so it is not read again until it changes. */
export function skipFile(index: IndexStore, file: FileRecord): void {
  index.transaction(() => {
    removeFile(index, file.path)
    index.run('INSERT INTO skipped_files (path, mtime_ms, size) VALUES (?, ?, ?)', [
      file.path,
      file.mtimeMs,
      file.size
    ])
  })
}

/**
 * Replaces everything the index knows about one file, in one transaction.
 * Blank lines are skipped: no word ever matches them.
 */
export function replaceFile(
  index: IndexStore,
  file: FileRecord,
  lines: readonly string[],
  symbols: readonly CodeSymbol[]
): void {
  index.transaction(() => {
    removeFile(index, file.path)
    const fileId = index.run('INSERT INTO files (path, mtime_ms, size) VALUES (?, ?, ?)', [
      file.path,
      file.mtimeMs,
      file.size
    ])
    lines.forEach((text, offset) => {
      const lineNo = offset + 1
      if (lineNo >= LINE_SPAN || text.trim() === '') {
        return
      }
      index.run('INSERT INTO lines_fts (rowid, text) VALUES (?, ?)', [
        fileId * LINE_SPAN + lineNo,
        text.slice(0, MAX_LINE_LENGTH)
      ])
    })
    for (const symbol of symbols) {
      const rowid = index.run(
        'INSERT INTO symbols (file_id, name, kind, line) VALUES (?, ?, ?, ?)',
        [fileId, symbol.name, symbol.kind, symbol.line]
      )
      index.run('INSERT INTO symbols_fts (rowid, name) VALUES (?, ?)', [rowid, symbol.name])
    }
  })
}

/** Forgets one file, indexed or skipped. Removing a file the index does not know is a no-op. */
export function removeFile(index: IndexStore, path: string): void {
  index.transaction(() => {
    index.run('DELETE FROM skipped_files WHERE path = ?', [path])
    const [row] = index.all('SELECT id FROM files WHERE path = ?', [path])
    if (row === undefined) {
      return
    }
    const fileId = Number(row.id)
    index.run('DELETE FROM lines_fts WHERE rowid >= ? AND rowid < ?', [
      fileId * LINE_SPAN,
      (fileId + 1) * LINE_SPAN
    ])
    index.run('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE file_id = ?)', [
      fileId
    ])
    index.run('DELETE FROM symbols WHERE file_id = ?', [fileId])
    index.run('DELETE FROM files WHERE id = ?', [fileId])
  })
}
