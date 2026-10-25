import { join } from 'node:path'

/** Orca plugin identity: `<publisher>.<id>`, also the plugin's data folder name. */
export const PLUGIN_IDENTITY = 'ab2web.orca-sonar'

export interface IndexLocation {
  readonly userDataDir: string
  readonly repoId: string
  readonly rootKey: string
}

export type Environment = Readonly<Record<string, string | undefined>>

/**
 * Orca's userData folder. Orca exports ORCA_USER_DATA_PATH to the processes it
 * starts; outside Orca the folder is the same one Electron picks per platform.
 */
export function resolveUserDataDir(
  env: Environment,
  platform: NodeJS.Platform,
  home: string
): string {
  const override = env.ORCA_USER_DATA_PATH
  if (override) {
    return override
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'orca')
  }
  if (platform === 'win32') {
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'orca')
  }
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'orca')
}

/**
 * The SQLite file for one workspace. The repo id is shared by a repository and
 * its worktrees; the root key separates the worktrees, so each keeps its own
 * uncommitted files. The path is always under the plugin's data folder.
 */
export function indexFilePath(location: IndexLocation): string {
  return join(
    location.userDataDir,
    'plugins-data',
    PLUGIN_IDENTITY,
    'index',
    location.repoId,
    `${location.rootKey}.sqlite`
  )
}
