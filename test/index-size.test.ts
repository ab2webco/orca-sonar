import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { openIndex, SCHEMA_VERSION } from '../src/core/index-store.ts'
import { refreshIndex } from '../src/core/refresh-index.ts'
import { findLines, findSymbols } from '../src/core/search.ts'
import { resolveWorkspace } from '../src/core/workspace.ts'

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-sonar-size-'))
  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

/** A project shaped like a real one: deep paths, short lines, some blank. */
function writeProject(root: string, files: number, linesPerFile: number): number {
  let bytes = 0
  for (let f = 0; f < files; f++) {
    const folder = join(root, 'src', 'features', `feature-${String(f % 20)}`, 'components')
    mkdirSync(folder, { recursive: true })
    const lines: string[] = []
    for (let l = 0; l < linesPerFile; l++) {
      lines.push(
        l % 7 === 0 ? '' : `  const value${String(l)}Of${String(f)} = compute(input${String(l)})`
      )
    }
    const text = `export function handler${String(f)}() {\n${lines.join('\n')}\n}\n`
    writeFileSync(join(folder, `component-with-a-long-name-${String(f)}.ts`), text)
    bytes += Buffer.byteLength(text)
  }
  return bytes
}

test('the index stays within twice the size of the source it holds', async () => {
  const base = tempDir()
  const root = join(base, 'project')
  const sourceBytes = writeProject(root, 200, 300)
  const indexPath = join(base, 'index.sqlite')

  const index = openIndex(indexPath)
  await refreshIndex(index, await resolveWorkspace(root))
  index.close()

  const indexBytes = statSync(indexPath).size
  assert.ok(
    indexBytes <= sourceBytes * 2,
    `index is ${String(indexBytes)} bytes for ${String(sourceBytes)} bytes of source`
  )
})

const VERSION_2_SCHEMA = `
CREATE TABLE files (path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size INTEGER NOT NULL);
CREATE TABLE lines (id INTEGER PRIMARY KEY, path TEXT NOT NULL, line_no INTEGER NOT NULL, text TEXT NOT NULL);
CREATE INDEX lines_by_path ON lines (path);
CREATE VIRTUAL TABLE lines_fts USING fts5(text, tokenize = "unicode61 tokenchars '_'");
CREATE TABLE symbols (id INTEGER PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL);
CREATE INDEX symbols_by_path ON symbols (path);
CREATE VIRTUAL TABLE symbols_fts USING fts5(name, tokenize = "unicode61 tokenchars '_'");
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO files VALUES ('src/old.ts', 1, 1);
INSERT INTO lines VALUES (1, 'src/old.ts', 1, 'const stale = 1');
INSERT INTO lines_fts (rowid, text) VALUES (1, 'const stale = 1');
PRAGMA user_version = 2;
`

test('an index built by an older version is emptied and rebuilt on open', async () => {
  const base = tempDir()
  const root = join(base, 'project')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'fresh.ts'), 'export function freshStart() {\n  return 1\n}\n')
  const indexPath = join(base, 'index.sqlite')
  const old = new DatabaseSync(indexPath)
  old.exec(VERSION_2_SCHEMA)
  old.close()

  const index = openIndex(indexPath)
  try {
    assert.equal(index.schemaVersion(), SCHEMA_VERSION)
    assert.deepEqual(findLines(index, 'stale', 10), [])

    const summary = await refreshIndex(index, await resolveWorkspace(root))

    assert.deepEqual(summary, { indexed: 1, unchanged: 0, removed: 0 })
    assert.deepEqual(findLines(index, 'freshStart', 10), [
      { path: 'src/fresh.ts', line: 1, text: 'export function freshStart() {' }
    ])
    assert.deepEqual(findSymbols(index, 'freshStart', 10), [
      { path: 'src/fresh.ts', line: 1, name: 'freshStart', kind: 'function' }
    ])
  } finally {
    index.close()
  }
})
