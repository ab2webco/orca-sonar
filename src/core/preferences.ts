import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginDataDir } from './index-location.ts'

/** The owner's switches, set in Sonar's settings panel. */
export interface Preferences {
  /** Agents may run `find` and `symbol`. */
  readonly agents: boolean
  /** Orca may build an index in the background when a worktree is created. */
  readonly warmup: boolean
}

/** What a switch is until the owner flips it. The settings panel shows the same values. */
export const DEFAULT_PREFERENCES: Preferences = { agents: true, warmup: true }

/** The plugin storage key the settings panel writes the switches to. */
export const PREFERENCES_KEY = 'preferences'

/** Orca's file behind the plugin's `storage.*` API. Sonar only ever reads it. */
const STORAGE_FILE = 'storage.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The switches as the settings panel last saved them. The panel writes through
 * Orca's storage API, which persists at once, so a flip takes effect on the
 * next command even while the plugin's worker is asleep. Anything missing or
 * malformed reads as its default.
 */
export function readPreferences(userDataDir: string): Preferences {
  let stored: unknown
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(pluginDataDir(userDataDir), STORAGE_FILE), 'utf8')
    )
    stored = isRecord(parsed) ? parsed[PREFERENCES_KEY] : undefined
  } catch {
    stored = undefined
  }
  const values = isRecord(stored) ? stored : {}
  return {
    agents: typeof values.agents === 'boolean' ? values.agents : DEFAULT_PREFERENCES.agents,
    warmup: typeof values.warmup === 'boolean' ? values.warmup : DEFAULT_PREFERENCES.warmup
  }
}
