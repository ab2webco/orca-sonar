import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * A lock older than this is taken over even when its process looks alive: the
 * pid may have been reused, and no refresh runs this long (Orca stops a
 * background build after 10 minutes).
 */
export const STALE_LOCK_MS = 15 * 60_000

/** A lock file still without its holder is being written; after this long, its writer died. */
const UNWRITTEN_LOCK_MS = 10_000

export interface RefreshLock {
  release(): void
}

interface Holder {
  readonly pid: number
  readonly at: number
}

function lockPath(indexPath: string): string {
  return `${indexPath}.lock`
}

function readHolder(path: string): Holder | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'pid' in parsed &&
      'at' in parsed &&
      typeof parsed.pid === 'number' &&
      typeof parsed.at === 'number'
    ) {
      return { pid: parsed.pid, at: parsed.at }
    }
    return null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

function create(path: string): RefreshLock | null {
  let fd: number
  try {
    fd = openSync(path, 'wx')
  } catch {
    return null
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
  } finally {
    closeSync(fd)
  }
  let released = false
  return {
    release: () => {
      if (!released) {
        released = true
        rmSync(path, { force: true })
      }
    }
  }
}

/**
 * Takes the right to update one index, or returns null while another process
 * holds it. Only one process refreshes an index at a time, so writers never
 * queue on SQLite's lock; readers are never blocked, because the index uses WAL.
 */
export function tryRefreshLock(indexPath: string): RefreshLock | null {
  const path = lockPath(indexPath)
  const lock = create(path)
  if (lock) {
    return lock
  }
  const holder = readHolder(path)
  if (holder === null) {
    const writtenAt = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0
    if (Date.now() - writtenAt < UNWRITTEN_LOCK_MS) {
      return null
    }
  } else if (isAlive(holder.pid) && Date.now() - holder.at < STALE_LOCK_MS) {
    return null
  }
  rmSync(path, { force: true })
  return create(path)
}

/** Waits until the lock is free and takes it; rejects after `timeoutMs`. */
export async function waitForRefreshLock(
  indexPath: string,
  options: { readonly timeoutMs: number; readonly pollMs: number }
): Promise<RefreshLock> {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    const lock = tryRefreshLock(indexPath)
    if (lock) {
      return lock
    }
    if (Date.now() >= deadline) {
      throw new Error(`the index at ${indexPath} is in use by another Sonar process`)
    }
    await sleep(options.pollMs)
  }
}
