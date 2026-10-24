import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Workspace } from './workspace.ts'

const execFileAsync = promisify(execFile)

/** Folders a plain-folder walk never enters. Git workspaces use `.gitignore` instead. */
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules'])

/** Maximum output of `git ls-files` we accept for a large repository. */
const GIT_OUTPUT_LIMIT = 256 * 1024 * 1024

/**
 * Relative paths of every file that belongs to the workspace, with `/` as the
 * separator on every platform. A git workspace lists tracked and untracked
 * files that are not ignored; a folder is walked and symlinks are not followed.
 */
export async function listWorkspaceFiles(workspace: Workspace): Promise<string[]> {
  if (workspace.kind === 'git') {
    return listGitFiles(workspace.root)
  }
  return walkFolder(workspace.root, '')
}

async function listGitFiles(root: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: GIT_OUTPUT_LIMIT }
  )
  return stdout.split('\0').filter((path) => path.length > 0)
}

function walkFolder(root: string, prefix: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) {
        files.push(...walkFolder(root, `${relative}/`))
      }
    } else if (entry.isFile()) {
      files.push(relative)
    }
  }
  return files
}
