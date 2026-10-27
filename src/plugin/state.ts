/**
 * What the worker publishes to plugin storage and the panels read back. Plugin
 * storage is the only channel between them: a panel cannot call the worker.
 */

/** Every local workspace's index status. Written only by the worker. */
export const STATE_KEY = 'state'
/** Progress of rebuilds, by workspace root. Written only by the worker. */
export const REBUILDS_KEY = 'rebuilds'
/** The `usage --json` summary for the statistics panel. Written only by the worker. */
export const USAGE_KEY = 'usage'
/**
 * Prefix of the keys the settings panel writes to ask for a rebuild, one key
 * per root so two quick clicks never overwrite each other. The worker removes
 * each key once attended.
 */
export const REBUILD_REQUEST_PREFIX = 'rebuild:'

export type Problem = 'orca-cli-missing' | 'node-missing' | 'error'
export type SonarCommand = 'available' | 'missing'

export interface IndexSummary {
  readonly exists: boolean
  readonly indexPath: string
  readonly files: number
  readonly symbols: number
  readonly lastIndexedAt: string | null
  readonly sizeBytes: number
}

export interface WorkspaceEntry {
  readonly root: string
  readonly displayName: string
  readonly branch: string
  readonly index?: IndexSummary
  readonly error?: string
}

export interface PublishedState {
  readonly version: 2
  readonly checkedAt: string
  readonly sonarCommand: SonarCommand
  /** Why the list could not be read, when it could not. */
  readonly problem?: Problem
  readonly error?: string
  readonly workspaces: readonly WorkspaceEntry[]
}

export interface RebuildProgress {
  readonly state: 'running' | 'done' | 'failed'
  readonly startedAt: string
  readonly finishedAt?: string
  readonly error?: string
}

export interface RebuildRequest {
  readonly root: string
  readonly at: string
}

/** Orca reports branches either as `refs/heads/x` or as `x`. */
export function normalizeBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function parseIndexSummary(value: unknown): IndexSummary | null {
  if (
    !isRecord(value) ||
    typeof value.exists !== 'boolean' ||
    !isString(value.indexPath) ||
    !isCount(value.files) ||
    !isCount(value.symbols) ||
    !(value.lastIndexedAt === null || isString(value.lastIndexedAt)) ||
    !isCount(value.sizeBytes)
  ) {
    return null
  }
  return {
    exists: value.exists,
    indexPath: value.indexPath,
    files: value.files,
    symbols: value.symbols,
    lastIndexedAt: value.lastIndexedAt,
    sizeBytes: value.sizeBytes
  }
}

export function parseRebuildProgress(value: unknown): RebuildProgress | null {
  if (!isRecord(value) || !isString(value.startedAt)) {
    return null
  }
  if (value.state !== 'running' && value.state !== 'done' && value.state !== 'failed') {
    return null
  }
  return {
    state: value.state,
    startedAt: value.startedAt,
    ...(isString(value.finishedAt) ? { finishedAt: value.finishedAt } : {}),
    ...(isString(value.error) ? { error: value.error } : {})
  }
}

/** Rebuild progress by root, dropping malformed entries. */
export function parseRebuilds(value: unknown): Record<string, RebuildProgress> {
  const rebuilds: Record<string, RebuildProgress> = {}
  if (isRecord(value)) {
    for (const [root, progress] of Object.entries(value)) {
      const parsed = parseRebuildProgress(progress)
      if (parsed) {
        rebuilds[root] = parsed
      }
    }
  }
  return rebuilds
}

export function parseRebuildRequest(value: unknown): RebuildRequest | null {
  if (!isRecord(value) || !isString(value.root) || !isString(value.at)) {
    return null
  }
  return { root: value.root, at: value.at }
}
