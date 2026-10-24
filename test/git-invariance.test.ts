import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { runCli, type CliContext } from '../src/cli/run.ts'
import { git } from './git-fixture.ts'

/**
 * Owner requirement (ORCA-766): orca-sonar never writes into a repository or
 * worktree. This test runs every command in a repository and in a linked
 * worktree, edits a tracked file between index runs, and then checks that
 * `git status --porcelain --ignored` and the files on disk are unchanged.
 */

const EDITED = join('src', 'greet.ts')

let base: string
let repo: string
let worktree: string
let userData: string
let testStart: number

function status(cwd: string): string {
  return git(cwd, ['status', '--porcelain', '--ignored'])
}

/** Path and modification time of every file under a root, except `.git`. */
function snapshotTree(root: string): Map<string, number> {
  const files = new Map<string, number>()
  const visit = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === '.git') {
        continue
      }
      const absolute = join(folder, entry.name)
      if (entry.isDirectory()) {
        visit(absolute)
      } else if (entry.isFile()) {
        files.set(absolute.slice(root.length + 1), statSync(absolute).mtimeMs)
      }
    }
  }
  visit(root)
  return files
}

async function run(
  cwd: string,
  args: readonly string[]
): Promise<{ code: number; stdout: string }> {
  let stdout = ''
  const context: CliContext = {
    env: { ORCA_USER_DATA_PATH: userData },
    platform: process.platform,
    home: base,
    cwd,
    systemLocale: 'en-US',
    stdout: (text) => {
      stdout += text
    },
    stderr: () => undefined
  }
  const code = await runCli(args, context)
  return { code, stdout }
}

before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-sonar-invariance-')))
  repo = join(base, 'repo')
  worktree = join(base, 'repo-worktree')
  userData = join(base, 'user-data')

  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, '.gitignore'), 'ignored.log\n')
  writeFileSync(join(repo, 'README.md'), '# fixture\n')
  writeFileSync(join(repo, EDITED), 'export function greet() {\n  return "hi"\n}\n')
  git(repo, ['init', '--quiet', '--initial-branch=main'])
  git(repo, ['add', '.'])
  git(repo, ['commit', '--quiet', '-m', 'initial'])
  git(repo, ['worktree', 'add', '--quiet', '-b', 'feature', worktree])
  writeFileSync(join(repo, 'ignored.log'), 'noise\n')
  writeFileSync(join(repo, 'untracked.ts'), 'export const loose = 1\n')
})

after(() => {
  git(repo, ['worktree', 'remove', '--force', worktree])
  rmSync(base, { recursive: true, force: true })
})

test('install, index, find and symbol leave git status and the files untouched', async () => {
  testStart = Date.now()
  const editedFile = join(worktree, EDITED)
  writeFileSync(editedFile, 'export function greet() {\n  return "hello"\n}\n')

  const beforeRepo = status(repo)
  const beforeWorktree = status(worktree)
  const filesBefore = snapshotTree(repo)
  const worktreeFilesBefore = snapshotTree(worktree)

  for (const cwd of [repo, worktree]) {
    assert.equal((await run(cwd, ['install'])).code, 0)
    assert.equal((await run(cwd, ['index'])).code, 0)
    assert.equal((await run(cwd, ['find', 'hello', '--json'])).code, 0)
    assert.equal((await run(cwd, ['symbol', 'greet', '--json'])).code, 0)
  }

  assert.equal(status(repo), beforeRepo)
  assert.equal(status(worktree), beforeWorktree)
  assert.deepEqual(snapshotTree(repo), filesBefore)
  assert.deepEqual(snapshotTree(worktree), worktreeFilesBefore)
  for (const [path, mtime] of worktreeFilesBefore) {
    if (path !== EDITED) {
      assert.ok(mtime < testStart, `${path} was modified during the run`)
    }
  }
})

test('an incremental re-index after an edit finds the new text and changes nothing else', async () => {
  const editedFile = join(worktree, EDITED)
  const beforeWorktree = status(worktree)
  const worktreeFilesBefore = snapshotTree(worktree)

  writeFileSync(editedFile, 'export function greet() {\n  return "bonjour"\n}\n')
  const found = await run(worktree, ['find', 'bonjour', '--json'])

  assert.deepEqual(JSON.parse(found.stdout).results, [
    { path: 'src/greet.ts', line: 2, text: '  return "bonjour"' }
  ])
  assert.equal(status(worktree), beforeWorktree)
  const worktreeFilesAfter = snapshotTree(worktree)
  assert.deepEqual([...worktreeFilesAfter.keys()].sort(), [...worktreeFilesBefore.keys()].sort())
  for (const [path, mtime] of worktreeFilesBefore) {
    if (path !== EDITED) {
      assert.equal(worktreeFilesAfter.get(path), mtime)
    }
  }
})
