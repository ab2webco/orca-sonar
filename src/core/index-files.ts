import type { CodeSymbol } from './symbols.ts'
import type { IndexStore } from './index-store.ts'

/** Longer lines are cut before they reach the index; minified bundles stay small. */
export const MAX_LINE_LENGTH = 500

export interface FileRecord {
  readonly path: string
  readonly mtimeMs: number
  readonly size: number
}

export function indexedFiles(index: IndexStore): Map<string, { mtimeMs: number; size: number }> {
  const records = new Map<string, { mtimeMs: number; size: number }>()
  for (const row of index.all('SELECT path, mtime_ms, size FROM files')) {
    if (typeof row.path === 'string') {
      records.set(row.path, { mtimeMs: Number(row.mtime_ms), size: Number(row.size) })
    }
  }
  return records
}

/** Replaces everything the index knows about one file, in one transaction. */
export function replaceFile(
  index: IndexStore,
  file: FileRecord,
  lines: readonly string[],
  symbols: readonly CodeSymbol[]
): void {
  index.transaction(() => {
    removeFile(index, file.path)
    index.run('INSERT INTO files (path, mtime_ms, size) VALUES (?, ?, ?)', [
      file.path,
      file.mtimeMs,
      file.size
    ])
    lines.forEach((text, offset) => {
      const rowid = index.run('INSERT INTO lines (path, line_no, text) VALUES (?, ?, ?)', [
        file.path,
        offset + 1,
        text.slice(0, MAX_LINE_LENGTH)
      ])
      index.run('INSERT INTO lines_fts (rowid, text) VALUES (?, ?)', [
        rowid,
        text.slice(0, MAX_LINE_LENGTH)
      ])
    })
    for (const symbol of symbols) {
      const rowid = index.run('INSERT INTO symbols (path, name, kind, line) VALUES (?, ?, ?, ?)', [
        symbol.path,
        symbol.name,
        symbol.kind,
        symbol.line
      ])
      index.run('INSERT INTO symbols_fts (rowid, name) VALUES (?, ?)', [rowid, symbol.name])
    }
  })
}

/** Forgets one file. Removing a file the index does not know is a no-op. */
export function removeFile(index: IndexStore, path: string): void {
  index.transaction(() => {
    index.run('DELETE FROM lines_fts WHERE rowid IN (SELECT id FROM lines WHERE path = ?)', [path])
    index.run('DELETE FROM lines WHERE path = ?', [path])
    index.run('DELETE FROM symbols_fts WHERE rowid IN (SELECT id FROM symbols WHERE path = ?)', [
      path
    ])
    index.run('DELETE FROM symbols WHERE path = ?', [path])
    index.run('DELETE FROM files WHERE path = ?', [path])
  })
}
