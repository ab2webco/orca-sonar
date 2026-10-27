import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openIndex, type IndexStore } from '../src/core/index-store.ts'
import { refreshIndex } from '../src/core/refresh-index.ts'
import {
  BYTES_PER_TOKEN,
  GREP_LINE_CAP,
  estimateSaving,
  grepOutputBytes,
  readBytes
} from '../src/core/savings.ts'
import { resolveWorkspace } from '../src/core/workspace.ts'

let base: string
let index: IndexStore
const A = 'const total = 1\nconst tax = 2\n'
const B = 'export const rate = 3\n'

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'orca-sonar-savings-'))
  const root = join(base, 'project')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), A)
  writeFileSync(join(root, 'src', 'b.ts'), B)
  index = openIndex(join(base, 'index.sqlite'))
  await refreshIndex(index, await resolveWorkspace(root))
})

after(() => {
  index.close()
  rmSync(base, { recursive: true, force: true })
})

test('grep output is counted as path:line:text and a newline for every matching line', () => {
  const expected = [
    'src/a.ts:1:const total = 1',
    'src/a.ts:2:const tax = 2',
    'src/b.ts:1:export const rate = 3'
  ]
    .map((line) => Buffer.byteLength(`${line}\n`))
    .reduce((sum, bytes) => sum + bytes, 0)

  assert.equal(grepOutputBytes(index, 'const'), expected)
  assert.equal(grepOutputBytes(index, 'nothing-here'), 0)
})

test('grep output stops counting at the line cap', () => {
  assert.equal(GREP_LINE_CAP, 2000)
  assert.equal(
    grepOutputBytes(index, 'const', 1),
    Buffer.byteLength('src/a.ts:1:const total = 1\n')
  )
})

test('reading the files is the size of each distinct file holding a result', () => {
  assert.equal(readBytes(index, ['src/a.ts', 'src/a.ts', 'src/b.ts']), Buffer.byteLength(A + B))
  assert.equal(readBytes(index, []), 0)
})

test('the saving is grep plus reading minus what Sonar printed, never below zero', () => {
  assert.deepEqual(estimateSaving({ outputBytes: 100, grepBytes: 300, readBytes: 1000 }), {
    baselineBytes: 1300,
    savedBytes: 1200,
    savedTokens: 1200 / BYTES_PER_TOKEN
  })
  assert.deepEqual(estimateSaving({ outputBytes: 500, grepBytes: 100, readBytes: 0 }), {
    baselineBytes: 100,
    savedBytes: 0,
    savedTokens: 0
  })
})
