import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { runCli, type CliContext } from '../src/cli/run.ts'
import { tryRefreshLock } from '../src/core/refresh-lock.ts'

let base: string
let userData: string
let workspace: string
let indexPath: string

interface Captured {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function run(args: readonly string[]): Promise<Captured> {
  let stdout = ''
  let stderr = ''
  const context: CliContext = {
    env: { ORCA_USER_DATA_PATH: userData },
    platform: process.platform,
    home: base,
    cwd: workspace,
    systemLocale: 'en-US',
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    }
  }
  const code = await runCli(args, context)
  return { code, stdout, stderr }
}

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'orca-sonar-busy-'))
  userData = join(base, 'user-data')
  workspace = join(base, 'workspace')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'first.ts'), 'export function firstOne() {}\n')
  const installed = await run(['install', '--json'])
  indexPath = (JSON.parse(installed.stdout) as { indexPath: string }).indexPath
  await run(['index'])
})

after(() => {
  rmSync(base, { recursive: true, force: true })
})

test('while another process updates the index, find answers from it as it is and says so', async () => {
  writeFileSync(join(workspace, 'src', 'second.ts'), 'export function secondOne() {}\n')
  const other = tryRefreshLock(indexPath)
  assert.ok(other)
  try {
    const known = await run(['find', 'firstOne'])
    const unseen = await run(['symbol', 'secondOne', '--json'])

    assert.equal(known.code, 0)
    assert.equal(known.stdout, 'src/first.ts:1  export function firstOne() {}\n')
    assert.match(known.stderr, /Another Sonar process is updating this index/)
    assert.equal(unseen.code, 0)
    assert.deepEqual((JSON.parse(unseen.stdout) as { results: unknown[] }).results, [])
  } finally {
    other.release()
  }
})

test('index waits for the other process to finish, then brings the index up to date', async () => {
  writeFileSync(join(workspace, 'src', 'third.ts'), 'export function thirdOne() {}\n')
  const other = tryRefreshLock(indexPath)
  assert.ok(other)
  setTimeout(() => {
    other.release()
  }, 150)

  const indexed = await run(['index', '--json'])
  const found = await run(['symbol', 'thirdOne'])

  assert.equal(indexed.code, 0)
  assert.equal(found.stdout, 'src/third.ts:1  function thirdOne\n')
  assert.equal(found.stderr, '')
})
