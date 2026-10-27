import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { replaceFile } from '../src/core/index-files.ts'
import { openIndex, SCHEMA_VERSION } from '../src/core/index-store.ts'
import { findLines } from '../src/core/search.ts'

function tempIndexDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-sonar-index-'))
  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function tempIndexPath(): string {
  return join(tempIndexDir(), 'nested', 'index.sqlite')
}

test('opening an index creates its parent folders and the current schema', () => {
  const path = tempIndexPath()

  const index = openIndex(path)
  try {
    assert.equal(existsSync(path), true)
    assert.equal(index.schemaVersion(), SCHEMA_VERSION)
  } finally {
    index.close()
  }
})

test('the FTS5 tables answer MATCH queries', () => {
  const index = openIndex(tempIndexPath())
  try {
    replaceFile(
      index,
      { path: 'src/a.ts', mtimeMs: 1, size: 1 },
      ['', '', 'const greeting = 1'],
      []
    )

    assert.deepEqual(findLines(index, 'greeting', 10), [
      { path: 'src/a.ts', line: 3, text: 'const greeting = 1' }
    ])
  } finally {
    index.close()
  }
})

test('identifiers with underscores stay one token', () => {
  const index = openIndex(tempIndexPath())
  try {
    replaceFile(index, { path: 'a.py', mtimeMs: 1, size: 1 }, ['def parse_file(x)'], [])

    assert.equal(findLines(index, 'parse', 10).length, 0)
    assert.equal(findLines(index, 'parse_file', 10).length, 1)
  } finally {
    index.close()
  }
})
