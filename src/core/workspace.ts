import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface Workspace {
  readonly kind: 'git' | 'folder'
  /** Real path of the worktree, or of the folder when git is not involved. */
  readonly root: string
  /** Shared by a repository and all of its worktrees; a folder is its own repo. */
  readonly repoId: string
  /** Separates worktrees of one repository. */
  readonly rootKey: string
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/** Runs git with argv (never a shell). Returns null when git fails or is missing. */
async function gitOutput(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true
    })
    return stdout.trim()
  } catch {
    return null
  }
}

export async function resolveWorkspace(start: string): Promise<Workspace> {
  const cwd = realpathSync.native(start)
  const top = await gitOutput(cwd, ['rev-parse', '--show-toplevel'])

  if (top === null) {
    return { kind: 'folder', root: cwd, repoId: digest(cwd), rootKey: digest(cwd) }
  }

  const root = realpathSync.native(top)
  const commonDir = await gitOutput(cwd, ['rev-parse', '--git-common-dir'])
  const sharedGitDir = realpathSync.native(resolve(cwd, commonDir ?? top))

  return { kind: 'git', root, repoId: digest(sharedGitDir), rootKey: digest(root) }
}
