import { existsSync, readdirSync, rmSync, rmdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pluginDataDir } from './index-location.ts'
import { ROOT_KEY } from './refresh-index.ts'
import { tryRefreshLock } from './refresh-lock.ts'

export interface PrunedIndex {
  readonly indexPath: string
  /** The workspace root the index recorded, or null for an index built before roots were kept. */
  readonly root: string | null
  /** The SQLite file plus its WAL and shared-memory files. */
  readonly sizeBytes: number
}

export interface PruneOptions {
  /**
   * Index paths of every workspace known to be alive. An index that recorded
   * no root is removed only when this list is given and leaves it out.
   */
  readonly keep?: ReadonlySet<string>
}

/** Index file names are hashes: `index/<repoId>/<rootKey>.sqlite`. */
const HASH = /^[0-9a-f]{16}$/
const INDEX_FILE = /^[0-9a-f]{16}\.sqlite$/
const COMPANION_SUFFIXES = ['', '-wal', '-shm'] as const

/** The recorded root; null when none was recorded; undefined when the file cannot be read. */
function recordedRoot(indexPath: string): string | null | undefined {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(indexPath, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 2000')
    const hasMeta =
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").all()
        .length > 0
    if (!hasMeta) {
      return null
    }
    const [row] = db.prepare('SELECT value FROM meta WHERE key = ?').all(ROOT_KEY)
    return typeof row?.value === 'string' ? row.value : null
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

function isOrphan(
  indexPath: string,
  root: string | null,
  keep: ReadonlySet<string> | undefined
): boolean {
  if (root !== null) {
    return !existsSync(root)
  }
  return keep !== undefined && !keep.has(indexPath)
}

/** Deletes one index under its refresh lock and returns its size; null when another process holds it or a file stays. */
function remove(indexPath: string): number | null {
  const lock = tryRefreshLock(indexPath)
  if (!lock) {
    return null
  }
  try {
    let sizeBytes = 0
    for (const suffix of COMPANION_SUFFIXES) {
      const path = indexPath + suffix
      sizeBytes += statSync(path, { throwIfNoEntry: false })?.size ?? 0
      rmSync(path, { force: true })
    }
    return sizeBytes
  } catch {
    return null
  } finally {
    lock.release()
  }
}

/**
 * Deletes the index of every workspace whose folder no longer exists, so an
 * index never outlives its workspace. Only files named the way Sonar names its
 * indexes are considered; an index another process is updating is left for
 * the next run.
 */
export function pruneIndexes(userDataDir: string, options: PruneOptions = {}): PrunedIndex[] {
  const indexDir = join(pluginDataDir(userDataDir), 'index')
  const keep =
    options.keep === undefined ? undefined : new Set([...options.keep].map((path) => resolve(path)))
  const pruned: PrunedIndex[] = []
  if (!existsSync(indexDir)) {
    return pruned
  }

  for (const repo of readdirSync(indexDir, { withFileTypes: true })) {
    if (!repo.isDirectory() || !HASH.test(repo.name)) {
      continue
    }
    const repoDir = join(indexDir, repo.name)
    for (const file of readdirSync(repoDir, { withFileTypes: true })) {
      if (!file.isFile() || !INDEX_FILE.test(file.name)) {
        continue
      }
      const indexPath = join(repoDir, file.name)
      const root = recordedRoot(indexPath)
      if (root === undefined || !isOrphan(indexPath, root, keep)) {
        continue
      }
      const sizeBytes = remove(indexPath)
      if (sizeBytes !== null) {
        pruned.push({ indexPath, root, sizeBytes })
      }
    }
    if (readdirSync(repoDir).length === 0) {
      rmdirSync(repoDir)
    }
  }
  return pruned
}
