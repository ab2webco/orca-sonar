import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { resolveWorkspace } from '../src/core/workspace.ts'
import { createGitFixture, type GitFixture } from './git-fixture.ts'

let fixture: GitFixture
let folder: string

before(() => {
  fixture = createGitFixture()
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-sonar-folder-')))
})

after(() => {
  fixture.cleanup()
  rmSync(folder, { recursive: true, force: true })
})

test('a repository and its worktree share one repo id but keep their own root', async () => {
  const main = await resolveWorkspace(fixture.repo)
  const linked = await resolveWorkspace(fixture.worktree)

  assert.equal(main.kind, 'git')
  assert.equal(linked.kind, 'git')
  assert.equal(main.repoId, linked.repoId)
  assert.notEqual(main.rootKey, linked.rootKey)
  assert.equal(main.root, fixture.repo)
  assert.equal(linked.root, fixture.worktree)
})

test('a subdirectory of a repository resolves to the repository root', async () => {
  const nested = join(fixture.repo, 'src', 'deep')
  mkdirSync(nested, { recursive: true })

  const identity = await resolveWorkspace(nested)

  assert.equal(identity.root, fixture.repo)
})

test('a folder that is not a repository is its own workspace', async () => {
  const identity = await resolveWorkspace(folder)

  assert.equal(identity.kind, 'folder')
  assert.equal(identity.root, folder)
  assert.match(identity.repoId, /^[0-9a-f]{16}$/)
  assert.match(identity.rootKey, /^[0-9a-f]{16}$/)
})

test('repo ids are stable across calls', async () => {
  const first = await resolveWorkspace(fixture.repo)
  const second = await resolveWorkspace(fixture.repo)

  assert.equal(first.repoId, second.repoId)
})
