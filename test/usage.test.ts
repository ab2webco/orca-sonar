import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { runCli, type CliContext } from '../src/cli/run.ts'
import { pluginDataDir } from '../src/core/index-location.ts'
import {
  USAGE_RETENTION_DAYS,
  recordQuery,
  summarizeUsage,
  usageFilePath,
  type QueryRecord
} from '../src/core/usage.ts'

const DAY = 86_400_000
let base: string
let userData: string
let workspace: string

before(() => {
  base = mkdtempSync(join(tmpdir(), 'orca-sonar-usage-'))
  workspace = join(base, 'workspace')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'cart.ts'), 'export function addToCart() {}\n')
})

beforeEach(() => {
  userData = join(base, `user-data-${String(Math.random()).slice(2)}`)
})

after(() => {
  rmSync(base, { recursive: true, force: true })
})

function at(day: string, hour = 12): number {
  return new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).getTime()
}

function record(overrides: Partial<QueryRecord> = {}): QueryRecord {
  return {
    at: at('2026-10-20'),
    command: 'find',
    repoId: 'repo',
    rootKey: 'root',
    durationMs: 10,
    results: 3,
    outputBytes: 100,
    grepBytes: 400,
    readBytes: 2000,
    ...overrides
  }
}

test('a summary of no usage is all zeros and creates nothing', () => {
  const summary = summarizeUsage(userData, { now: at('2026-10-26'), days: 3 })

  assert.deepEqual(summary, {
    since: null,
    days: [
      { day: '2026-10-24', find: 0, symbol: 0 },
      { day: '2026-10-25', find: 0, symbol: 0 },
      { day: '2026-10-26', find: 0, symbol: 0 }
    ],
    totals: {
      queries: 0,
      find: 0,
      symbol: 0,
      results: 0,
      averageMs: null,
      outputBytes: 0,
      baselineBytes: 0,
      savedBytes: 0,
      savedTokens: 0
    },
    workspacesQueried: 0,
    workspacesIndexed: 0
  })
  assert.equal(existsSync(pluginDataDir(userData)), false)
})

test('queries are counted per local day and totalled over the window', () => {
  recordQuery(userData, record({ at: at('2026-10-25', 9), durationMs: 10 }))
  recordQuery(
    userData,
    record({ at: at('2026-10-25', 23), command: 'symbol', durationMs: 30, rootKey: 'other' })
  )
  recordQuery(
    userData,
    record({ at: at('2026-10-26', 1), results: 0, outputBytes: 50, grepBytes: 0, readBytes: 0 })
  )
  recordQuery(userData, record({ at: at('2026-10-10') }))

  const summary = summarizeUsage(userData, { now: at('2026-10-26', 18), days: 2 })

  assert.deepEqual(summary.days, [
    { day: '2026-10-25', find: 1, symbol: 1 },
    { day: '2026-10-26', find: 1, symbol: 0 }
  ])
  assert.deepEqual(summary.totals, {
    queries: 3,
    find: 2,
    symbol: 1,
    results: 6,
    averageMs: 50 / 3,
    outputBytes: 250,
    baselineBytes: 4800,
    savedBytes: 4600,
    savedTokens: 1150
  })
  assert.equal(summary.workspacesQueried, 2)
  assert.equal(summary.since, new Date(at('2026-10-10')).toISOString())
})

test(`records older than ${String(USAGE_RETENTION_DAYS)} days are dropped on the next write`, () => {
  const now = at('2026-10-26')
  recordQuery(userData, record({ at: now - (USAGE_RETENTION_DAYS + 1) * DAY }))
  recordQuery(userData, record({ at: now }))

  const summary = summarizeUsage(userData, { now, days: 200 })

  assert.equal(summary.totals.queries, 1)
})

test('recording never throws, even when the data folder cannot be used', () => {
  mkdirSync(join(userData), { recursive: true })
  writeFileSync(join(userData, 'plugins-data'), 'a file where a folder should be')

  assert.doesNotThrow(() => {
    recordQuery(userData, record())
  })
})

async function run(
  args: readonly string[],
  now: number
): Promise<{ code: number; stdout: string }> {
  let stdout = ''
  const context: CliContext = {
    env: { ORCA_USER_DATA_PATH: userData },
    platform: process.platform,
    home: base,
    cwd: workspace,
    systemLocale: 'en-US',
    now: () => now,
    stdout: (text) => {
      stdout += text
    },
    stderr: () => undefined
  }
  const code = await runCli(args, context)
  return { code, stdout }
}

test('find and symbol record a query without its text, and usage --json reports it', async () => {
  const now = at('2026-10-26')
  const found = await run(['find', 'addToCart'], now)
  await run(['symbol', 'addToCart', '--json'], now)
  await run(['find', 'zzzz'], now)

  const usage = JSON.parse((await run(['usage', '--json'], now)).stdout) as {
    command: string
    totals: { queries: number; find: number; symbol: number; results: number; outputBytes: number }
    workspacesIndexed: number
  }

  assert.equal(usage.command, 'usage')
  assert.equal(usage.totals.queries, 3)
  assert.equal(usage.totals.find, 2)
  assert.equal(usage.totals.symbol, 1)
  assert.equal(usage.totals.results, 2)
  assert.ok(usage.totals.outputBytes >= Buffer.byteLength(found.stdout))
  assert.equal(usage.workspacesIndexed, 1)
  assert.equal(readFileSync(usageFilePath(userData)).includes('addToCart'), false)
})

test('usage in text mode summarises the window', async () => {
  const now = at('2026-10-26')
  await run(['find', 'addToCart'], now)

  const usage = await run(['usage'], now)

  assert.equal(usage.code, 0)
  assert.match(usage.stdout, /1 queries in the last 30 days/)
})
