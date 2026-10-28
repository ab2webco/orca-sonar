import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { indexFilePath, pluginDataDir } from '../src/core/index-location.ts'
import { openIndex } from '../src/core/index-store.ts'
import { pruneIndexes } from '../src/core/prune-indexes.ts'
import { refreshIndex } from '../src/core/refresh-index.ts'
import { tryRefreshLock } from '../src/core/refresh-lock.ts'
import { resolveWorkspace } from '../src/core/workspace.ts'

function sandbox(): { base: string; userData: string } {
  const base = mkdtempSync(join(tmpdir(), 'orca-sonar-prune-'))
  after(() => {
    rmSync(base, { recursive: true, force: true })
  })
  return { base, userData: join(base, 'user-data') }
}

/** A real workspace folder with one file, indexed the way the CLI does it. */
async function indexedWorkspace(
  base: string,
  userData: string,
  name: string
): Promise<{ path: string; root: string }> {
  const root = join(base, name)
  mkdirSync(root)
  writeFileSync(join(root, 'cart.ts'), 'export function addToCart() {}\n')
  const workspace = await resolveWorkspace(root)
  const path = indexFilePath({ userDataDir: userData, ...workspace })
  const index = openIndex(path)
  try {
    await refreshIndex(index, workspace)
  } finally {
    index.close()
  }
  writeFileSync(`${path}-wal`, '')
  writeFileSync(`${path}-shm`, '')
  return { path, root: workspace.root }
}

/** An index as Sonar 0.2.2 and older left it: created, but with no root recorded. */
function legacyIndex(userData: string, repoId: string, rootKey: string): string {
  const path = indexFilePath({ userDataDir: userData, repoId, rootKey })
  openIndex(path).close()
  return path
}

test('the index of a deleted workspace is removed with its companions; a live one stays', async () => {
  const { base, userData } = sandbox()
  const live = await indexedWorkspace(base, userData, 'shop')
  const gone = await indexedWorkspace(base, userData, 'blog')
  rmSync(join(base, 'blog'), { recursive: true })

  const removed = pruneIndexes(userData)

  assert.deepEqual(
    removed.map((entry) => ({ indexPath: entry.indexPath, root: entry.root })),
    [{ indexPath: gone.path, root: gone.root }]
  )
  assert.ok((removed[0]?.sizeBytes ?? 0) > 0)
  assert.equal(existsSync(gone.path), false)
  assert.equal(existsSync(`${gone.path}-wal`), false)
  assert.equal(existsSync(`${gone.path}-shm`), false)
  assert.equal(existsSync(`${gone.path}.lock`), false)
  assert.equal(existsSync(dirname(gone.path)), false)
  assert.equal(existsSync(live.path), true)
})

test('an index with no recorded root is kept unless a list of live indexes leaves it out', () => {
  const { userData } = sandbox()
  const listed = legacyIndex(userData, 'a'.repeat(16), 'b'.repeat(16))
  const unlisted = legacyIndex(userData, 'a'.repeat(16), 'c'.repeat(16))

  assert.deepEqual(pruneIndexes(userData), [])
  assert.equal(existsSync(unlisted), true)

  const removed = pruneIndexes(userData, { keep: new Set([listed]) })

  assert.deepEqual(
    removed.map((entry) => ({ indexPath: entry.indexPath, root: entry.root })),
    [{ indexPath: unlisted, root: null }]
  )
  assert.equal(existsSync(unlisted), false)
  assert.equal(existsSync(listed), true)
})

test('an index another process is updating is left alone', async () => {
  const { base, userData } = sandbox()
  const gone = await indexedWorkspace(base, userData, 'blog')
  rmSync(join(base, 'blog'), { recursive: true })
  const lock = tryRefreshLock(gone.path)
  assert.ok(lock)

  try {
    assert.deepEqual(pruneIndexes(userData), [])
    assert.equal(existsSync(gone.path), true)
  } finally {
    lock.release()
  }
})

test('files Sonar did not name as an index are never touched', () => {
  const { userData } = sandbox()
  assert.deepEqual(pruneIndexes(userData), [])

  const data = pluginDataDir(userData)
  const repo = join(data, 'index', 'd'.repeat(16))
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(data, 'usage.sqlite'), '')
  writeFileSync(join(repo, 'notes.sqlite'), '')
  writeFileSync(join(repo, 'readme.txt'), '')

  assert.deepEqual(pruneIndexes(userData, { keep: new Set() }), [])
  assert.deepEqual(readdirSync(repo).sort(), ['notes.sqlite', 'readme.txt'])
  assert.equal(existsSync(join(data, 'usage.sqlite')), true)
})
