import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openIndex, type IndexStore } from '../src/core/index-store.ts'
import { readIndexedAt, refreshIndex } from '../src/core/refresh-index.ts'
import { resolveWorkspace } from '../src/core/workspace.ts'

let base: string
let root: string
let index: IndexStore

before(() => {
  base = mkdtempSync(join(tmpdir(), 'orca-sonar-refresh-'))
  root = join(base, 'project')
  index = openIndex(join(base, 'index.sqlite'))
  mkdirSync(root)
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(root, 'src', 'greet.ts'), 'export function greeting() {\n  return 1\n}\n')
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'function skipMe() {}\n')
  writeFileSync(join(root, 'logo.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]))
})

after(() => {
  index.close()
  rmSync(base, { recursive: true, force: true })
})

async function refresh(): Promise<Awaited<ReturnType<typeof refreshIndex>>> {
  const workspace = await resolveWorkspace(root)
  return refreshIndex(index, workspace)
}

test('the first refresh indexes text files and skips dependencies and binaries', async () => {
  const summary = await refresh()

  assert.deepEqual(summary, { indexed: 1, unchanged: 0, removed: 0 })
  assert.deepEqual(index.all('SELECT path FROM files ORDER BY path'), [{ path: 'src/greet.ts' }])
  assert.deepEqual(index.all("SELECT name FROM symbols WHERE path = 'src/greet.ts'"), [
    { name: 'greeting' }
  ])
})

test('a refresh with no changes reads nothing', async () => {
  const summary = await refresh()

  assert.deepEqual(summary, { indexed: 0, unchanged: 1, removed: 0 })
})

test('an edited file is indexed again and its new text is searchable', async () => {
  const file = join(root, 'src', 'greet.ts')
  writeFileSync(file, 'export function farewell() {\n  return 2\n}\n')
  const later = new Date(Date.now() + 5000)
  utimesSync(file, later, later)

  const summary = await refresh()

  assert.deepEqual(summary, { indexed: 1, unchanged: 0, removed: 0 })
  assert.deepEqual(
    index.all(
      'SELECT l.line_no FROM lines_fts f JOIN lines l ON l.id = f.rowid WHERE lines_fts MATCH ?',
      ['farewell']
    ),
    [{ line_no: 1 }]
  )
  assert.equal(index.all('SELECT name FROM symbols WHERE name = ?', ['greeting']).length, 0)
})

test('a deleted file leaves no rows behind', async () => {
  writeFileSync(join(root, 'src', 'temp.ts'), 'export const temporary = 1\n')
  await refresh()
  unlinkSync(join(root, 'src', 'temp.ts'))

  const summary = await refresh()

  assert.deepEqual(summary, { indexed: 0, unchanged: 1, removed: 1 })
  assert.equal(index.all("SELECT path FROM lines WHERE path = 'src/temp.ts'").length, 0)
  assert.equal(index.all("SELECT path FROM symbols WHERE path = 'src/temp.ts'").length, 0)
})

test('a refresh records when the index was last brought up to date', async () => {
  const workspace = await resolveWorkspace(root)
  const at = new Date('2026-10-26T12:00:00.000Z')

  await refreshIndex(index, workspace, { now: () => at })

  assert.equal(readIndexedAt(index), '2026-10-26T12:00:00.000Z')
})
