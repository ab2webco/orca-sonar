import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface GitFixture {
  readonly repo: string
  readonly worktree: string
  readonly cleanup: () => void
}

/** Runs git with argv (never a shell) and returns its stdout. */
export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Sonar Test',
      GIT_AUTHOR_EMAIL: 'sonar-test@example.invalid',
      GIT_COMMITTER_NAME: 'Sonar Test',
      GIT_COMMITTER_EMAIL: 'sonar-test@example.invalid'
    }
  })
}

/**
 * A temporary repository with one commit and one linked worktree. Paths are
 * real paths so that comparisons match what the CLI resolves on macOS, where
 * the temp folder lives behind a symlink.
 */
export function createGitFixture(): GitFixture {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-sonar-')))
  const repo = join(base, 'repo')
  const worktree = join(base, 'repo-worktree')

  mkdirSync(repo)
  git(repo, ['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(repo, 'README.md'), '# fixture\n')
  git(repo, ['add', 'README.md'])
  git(repo, ['commit', '--quiet', '-m', 'initial'])
  git(repo, ['worktree', 'add', '--quiet', '-b', 'feature', worktree])

  return {
    repo,
    worktree,
    cleanup: () => {
      git(repo, ['worktree', 'remove', '--force', worktree])
      rmSync(base, { recursive: true, force: true })
    }
  }
}
