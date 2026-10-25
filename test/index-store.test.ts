import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { openIndex, SCHEMA_VERSION } from '../src/core/index-store.ts'

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
    index.exec(
      "INSERT INTO lines (path, line_no, text) VALUES ('src/a.ts', 3, 'const greeting = 1')"
    )
    index.exec(
      "INSERT INTO lines_fts (rowid, text) SELECT id, text FROM lines WHERE path = 'src/a.ts'"
    )

    const rows = index.all(
      'SELECT l.path FROM lines_fts f JOIN lines l ON l.id = f.rowid WHERE lines_fts MATCH ?',
      ['greeting']
    )

    assert.deepEqual(rows, [{ path: 'src/a.ts' }])
  } finally {
    index.close()
  }
})

test('identifiers with underscores stay one token', () => {
  const index = openIndex(tempIndexPath())
  try {
    index.exec("INSERT INTO lines (path, line_no, text) VALUES ('a.py', 1, 'def parse_file(x)')")
    index.exec("INSERT INTO lines_fts (rowid, text) SELECT id, text FROM lines WHERE path = 'a.py'")

    assert.equal(
      index.all(
        'SELECT l.path FROM lines_fts f JOIN lines l ON l.id = f.rowid WHERE lines_fts MATCH ?',
        ['parse']
      ).length,
      0
    )
    assert.equal(
      index.all(
        'SELECT l.path FROM lines_fts f JOIN lines l ON l.id = f.rowid WHERE lines_fts MATCH ?',
        ['parse_file']
      ).length,
      1
    )
  } finally {
    index.close()
  }
})
