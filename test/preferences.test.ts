import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { runCli, type CliContext } from '../src/cli/run.ts'
import { pluginDataDir } from '../src/core/index-location.ts'
import { DEFAULT_PREFERENCES, readPreferences } from '../src/core/preferences.ts'

let base: string
let userData: string
let workspace: string

before(() => {
  base = mkdtempSync(join(tmpdir(), 'orca-sonar-preferences-'))
  userData = join(base, 'user-data')
  workspace = join(base, 'workspace')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'tax.ts'), 'export function applyTax() {}\n')
})

beforeEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

after(() => {
  rmSync(base, { recursive: true, force: true })
})

function storeRaw(content: string): void {
  mkdirSync(pluginDataDir(userData), { recursive: true })
  writeFileSync(join(pluginDataDir(userData), 'storage.json'), content)
}

function store(preferences: unknown): void {
  storeRaw(JSON.stringify({ other: 1, preferences }))
}

async function run(
  args: readonly string[],
  systemLocale = 'en-US'
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const context: CliContext = {
    env: { ORCA_USER_DATA_PATH: userData },
    platform: process.platform,
    home: base,
    cwd: workspace,
    systemLocale,
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

test('without stored preferences Sonar is on for agents and warms up', () => {
  assert.deepEqual(readPreferences(userData), { agents: true, warmup: true })
  assert.deepEqual(DEFAULT_PREFERENCES, { agents: true, warmup: true })
})

test('stored preferences override the defaults one switch at a time', () => {
  store({ agents: false })
  assert.deepEqual(readPreferences(userData), { agents: false, warmup: true })

  store({ agents: true, warmup: false })
  assert.deepEqual(readPreferences(userData), { agents: true, warmup: false })
})

test('a malformed store or value falls back to the default', () => {
  storeRaw('{not json')
  assert.deepEqual(readPreferences(userData), DEFAULT_PREFERENCES)

  store({ agents: 'no', warmup: 0 })
  assert.deepEqual(readPreferences(userData), DEFAULT_PREFERENCES)
})

test('with Sonar off for agents, find and symbol refuse and point to rg', async () => {
  store({ agents: false })

  const find = await run(['find', 'applyTax'])
  const symbol = await run(['symbol', 'applyTax'])

  assert.equal(find.code, 1)
  assert.equal(find.stdout, '')
  assert.match(find.stderr, /turned off for agents.*rg/s)
  assert.equal(symbol.code, 1)
  assert.equal(existsSync(join(pluginDataDir(userData), 'index')), false)
})

test('with Sonar off for agents, status and an explicit index still work', async () => {
  store({ agents: false })

  const indexed = await run(['index', '--json'])
  const status = await run(['status', '--json'])

  assert.equal(indexed.code, 0)
  assert.equal((JSON.parse(status.stdout) as { files: number }).files, 1)
})

test('the refusal follows Orca language', async () => {
  storeRaw(JSON.stringify({ preferences: { agents: false } }))
  writeFileSync(
    join(userData, 'orca-data.json'),
    JSON.stringify({ settings: { uiLanguage: 'es' } })
  )

  const find = await run(['find', 'applyTax'])

  assert.match(find.stderr, /desactivado para los agentes/)
})

test('index --warmup skips without touching the index when warm-up is off', async () => {
  store({ warmup: false })

  const result = await run(['index', '--warmup', '--json'])

  assert.equal(result.code, 0)
  assert.deepEqual(JSON.parse(result.stdout), { command: 'index', skipped: 'warmup-off' })
  assert.equal(existsSync(join(pluginDataDir(userData), 'index')), false)
})

test('index --warmup also skips when Sonar is off for agents', async () => {
  store({ agents: false, warmup: true })

  const result = await run(['index', '--warmup'])

  assert.equal(result.code, 0)
  assert.match(result.stdout, /Warm-up skipped/)
  assert.equal(existsSync(join(pluginDataDir(userData), 'index')), false)
})

test('index --warmup indexes when both switches are on', async () => {
  const result = await run(['index', '--warmup', '--json'])

  assert.equal(result.code, 0)
  assert.equal((JSON.parse(result.stdout) as { indexed: number }).indexed, 1)
})
