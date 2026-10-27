import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { LINE_SPAN, openIndex, type IndexStore } from '../src/core/index-store.ts'
import { readIndexedAt, refreshIndex } from '../src/core/refresh-index.ts'
import { findLines, findSymbols } from '../src/core/search.ts'
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
  assert.deepEqual(findSymbols(index, 'greeting', 10), [
    { path: 'src/greet.ts', line: 1, name: 'greeting', kind: 'function' }
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
  assert.deepEqual(findLines(index, 'farewell', 10), [
    { path: 'src/greet.ts', line: 1, text: 'export function farewell() {' }
  ])
  assert.deepEqual(findLines(index, 'greeting', 10), [])
  assert.deepEqual(findSymbols(index, 'greeting', 10), [])
})

test('a deleted file leaves no rows behind', async () => {
  writeFileSync(join(root, 'src', 'temp.ts'), 'export const temporary = 1\n')
  await refresh()
  unlinkSync(join(root, 'src', 'temp.ts'))

  const summary = await refresh()

  assert.deepEqual(summary, { indexed: 0, unchanged: 1, removed: 1 })
  assert.deepEqual(findLines(index, 'temporary', 10), [])
  assert.equal(index.all("SELECT path FROM files WHERE path = 'src/temp.ts'").length, 0)
  assert.deepEqual(
    index.all(
      `SELECT rowid FROM lines_fts
        WHERE rowid / ${String(LINE_SPAN)} NOT IN (SELECT id FROM files)`
    ),
    []
  )
  assert.deepEqual(
    index.all('SELECT id FROM symbols WHERE file_id NOT IN (SELECT id FROM files)'),
    []
  )
})

test('a binary file is read once, and again only after it changes', async () => {
  const logo = join(root, 'logo.bin')
  // A whole second, so the time written back below is exactly the recorded one.
  const recorded = new Date('2026-01-01T00:00:00.000Z')
  utimesSync(logo, recorded, recorded)
  await refresh()
  // Same size and modification time: a refresh that trusts its record never sees the text.
  writeFileSync(logo, 'abcd')
  utimesSync(logo, recorded, recorded)

  await refresh()
  assert.deepEqual(findLines(index, 'abcd', 10), [])

  const later = new Date(Date.now() + 10_000)
  utimesSync(logo, later, later)
  const summary = await refresh()

  assert.equal(summary.indexed, 1)
  assert.deepEqual(findLines(index, 'abcd', 10), [{ path: 'logo.bin', line: 1, text: 'abcd' }])
})

test('a file that turns binary leaves the index, and its record does not linger once deleted', async () => {
  const file = join(root, 'src', 'turns.ts')
  writeFileSync(file, 'export const turnsBinary = 1\n')
  await refresh()
  writeFileSync(file, Buffer.from([0x00, 0x74, 0x75, 0x72, 0x6e, 0x73]))
  const later = new Date(Date.now() + 20_000)
  utimesSync(file, later, later)

  await refresh()
  assert.deepEqual(findLines(index, 'turnsBinary', 10), [])

  unlinkSync(file)
  await refresh()
  assert.deepEqual(index.all("SELECT path FROM skipped_files WHERE path = 'src/turns.ts'"), [])
})

test('a refresh records when the index was last brought up to date', async () => {
  const workspace = await resolveWorkspace(root)
  const at = new Date('2026-10-26T12:00:00.000Z')

  await refreshIndex(index, workspace, { now: () => at })

  assert.equal(readIndexedAt(index), '2026-10-26T12:00:00.000Z')
})
