import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { runCli, type CliContext } from '../src/cli/run.ts'
import { openIndex } from '../src/core/index-store.ts'
import { readIndexStatus } from '../src/core/index-status.ts'
import { refreshIndex } from '../src/core/refresh-index.ts'
import { resolveWorkspace } from '../src/core/workspace.ts'

let base: string
let userData: string
let workspace: string

before(() => {
  base = mkdtempSync(join(tmpdir(), 'orca-sonar-status-'))
  userData = join(base, 'user-data')
  workspace = join(base, 'workspace')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(
    join(workspace, 'src', 'cart.ts'),
    'export class Cart {}\nexport interface Line {}\n'
  )
})

after(() => {
  rmSync(base, { recursive: true, force: true })
})

async function run(args: readonly string[]): Promise<{ code: number; stdout: string }> {
  let stdout = ''
  const context: CliContext = {
    env: { ORCA_USER_DATA_PATH: userData },
    platform: process.platform,
    home: base,
    cwd: workspace,
    systemLocale: 'en-US',
    stdout: (text) => {
      stdout += text
    },
    stderr: () => undefined
  }
  const code = await runCli(args, context)
  return { code, stdout }
}

test('status of a missing index says so and creates nothing', () => {
  const indexPath = join(base, 'missing', 'index.sqlite')

  const status = readIndexStatus(indexPath)

  assert.deepEqual(status, {
    exists: false,
    indexPath,
    files: 0,
    symbols: 0,
    lastIndexedAt: null,
    sizeBytes: 0
  })
  assert.equal(existsSync(join(base, 'missing')), false)
})

test('status of an index counts files and symbols and sums the WAL files', async () => {
  const indexPath = join(base, 'built', 'index.sqlite')
  const index = openIndex(indexPath)
  try {
    await refreshIndex(index, await resolveWorkspace(workspace), {
      now: () => new Date('2026-10-26T08:30:00.000Z')
    })

    const status = readIndexStatus(indexPath)

    assert.equal(status.exists, true)
    assert.equal(status.files, 1)
    assert.equal(status.symbols, 2)
    assert.equal(status.lastIndexedAt, '2026-10-26T08:30:00.000Z')
    assert.ok(status.sizeBytes > 0)
  } finally {
    index.close()
  }
})

test('status of an index written before the meta table has no last indexed time', () => {
  const indexPath = join(base, 'legacy.sqlite')
  const legacy = new DatabaseSync(indexPath)
  legacy.exec(
    'CREATE TABLE files (path TEXT PRIMARY KEY, mtime_ms REAL, size INTEGER);' +
      'CREATE TABLE symbols (id INTEGER PRIMARY KEY, path TEXT, name TEXT, kind TEXT, line INTEGER);' +
      "INSERT INTO files VALUES ('a.ts', 1, 1);"
  )
  legacy.close()

  const status = readIndexStatus(indexPath)

  assert.equal(status.files, 1)
  assert.equal(status.symbols, 0)
  assert.equal(status.lastIndexedAt, null)
})

test('status --json reports a missing index without creating it, then the built one', async () => {
  const before = await run(['status', '--json'])
  const parsed = JSON.parse(before.stdout) as { command: string; exists: boolean; root: string }

  assert.equal(before.code, 0)
  assert.equal(parsed.command, 'status')
  assert.equal(parsed.exists, false)
  assert.equal(existsSync(join(userData, 'plugins-data')), false)

  await run(['index'])
  const built = JSON.parse((await run(['status', '--json'])).stdout) as {
    exists: boolean
    files: number
    symbols: number
    root: string
  }

  assert.equal(built.exists, true)
  assert.equal(built.files, 1)
  assert.equal(built.symbols, 2)
  assert.equal(built.root, parsed.root)
})

test('status in text mode names the counts', async () => {
  const status = await run(['status'])

  assert.equal(status.code, 0)
  assert.match(status.stdout, /1 files, 2 symbols/)
})
