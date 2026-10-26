import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { indexedFiles, removeFile, replaceFile } from './index-files.ts'
import type { IndexStore } from './index-store.ts'
import { extractSymbols } from './symbols.ts'
import { listWorkspaceFiles } from './file-walk.ts'
import type { Workspace } from './workspace.ts'

/** Files above this size are not indexed: they are rarely code worth searching. */
export const MAX_FILE_BYTES = 1024 * 1024

/** Bytes checked for a NUL, the usual sign of binary content. */
const BINARY_PROBE_BYTES = 8000

/** The `meta` key holding when the index was last brought up to date, as an ISO time. */
export const INDEXED_AT_KEY = 'indexed_at'

export interface RefreshOptions {
  readonly now?: () => Date
}

export interface RefreshSummary {
  readonly indexed: number
  readonly unchanged: number
  readonly removed: number
}

/**
 * Brings the index up to date with the files on disk. A file is read only when
 * its modification time or size changed, so a refresh on an unchanged tree
 * reads nothing but metadata.
 */
export async function refreshIndex(
  index: IndexStore,
  workspace: Workspace,
  options: RefreshOptions = {}
): Promise<RefreshSummary> {
  const known = indexedFiles(index)
  const present = await listWorkspaceFiles(workspace)
  const seen = new Set<string>()
  let indexed = 0
  let unchanged = 0

  for (const path of present) {
    const absolute = join(workspace.root, ...path.split('/'))
    const stats = statSync(absolute, { throwIfNoEntry: false })
    if (stats === undefined || !stats.isFile()) {
      continue
    }
    seen.add(path)

    const record = known.get(path)
    if (record?.mtimeMs === stats.mtimeMs && record.size === stats.size) {
      unchanged++
      continue
    }
    if (stats.size > MAX_FILE_BYTES) {
      removeFile(index, path)
      continue
    }

    const content = readFileSync(absolute)
    if (content.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
      removeFile(index, path)
      continue
    }

    const lines = content.toString('utf8').split(/\r?\n/)
    replaceFile(
      index,
      { path, mtimeMs: stats.mtimeMs, size: stats.size },
      lines,
      extractSymbols(path, lines)
    )
    indexed++
  }

  let removed = 0
  for (const path of known.keys()) {
    if (!seen.has(path)) {
      removeFile(index, path)
      removed++
    }
  }

  const now = options.now ?? (() => new Date())
  index.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
    INDEXED_AT_KEY,
    now().toISOString()
  ])

  return { indexed, unchanged, removed }
}

/** When the index was last brought up to date, or null if it never was. */
export function readIndexedAt(index: IndexStore): string | null {
  const [row] = index.all('SELECT value FROM meta WHERE key = ?', [INDEXED_AT_KEY])
  return typeof row?.value === 'string' ? row.value : null
}
