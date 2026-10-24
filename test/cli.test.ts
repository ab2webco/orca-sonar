import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { runCli, type CliContext } from '../src/cli/run.ts'

let base: string
let userData: string
let workspace: string

before(() => {
  base = mkdtempSync(join(tmpdir(), 'orca-sonar-cli-'))
  userData = join(base, 'user-data')
  workspace = join(base, 'workspace')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(
    join(workspace, 'src', 'invoice.ts'),
    'export function parseInvoice(raw: string) {\n  return raw.trim()\n}\n'
  )
})

after(() => {
  rmSync(base, { recursive: true, force: true })
})

interface Captured {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function run(args: readonly string[], systemLocale = 'en-US'): Promise<Captured> {
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

test('install creates the index inside the plugin data folder and names it', async () => {
  const result = await run(['install'])

  assert.equal(result.code, 0)
  assert.match(result.stdout, /Index ready at .*plugins-data[\\/]ab2web\.orca-sonar[\\/]index/)
  assert.equal(result.stdout.includes(workspace), false)
  assert.equal(existsSync(join(workspace, '.orca-sonar')), false)
})

test('index reports what it did and find --json returns file, line and text', async () => {
  const indexed = await run(['index'])
  assert.equal(indexed.code, 0)
  assert.match(indexed.stdout, /Indexed 1 files, 0 unchanged, 0 removed\./)

  const found = await run(['find', 'parseInvoice', '--json'])
  assert.equal(found.code, 0)
  assert.deepEqual(JSON.parse(found.stdout), {
    command: 'find',
    query: 'parseInvoice',
    results: [
      { path: 'src/invoice.ts', line: 1, text: 'export function parseInvoice(raw: string) {' }
    ]
  })
})

test('find in text mode prints file:line and the matching text', async () => {
  const found = await run(['find', 'trim'])

  assert.equal(found.code, 0)
  assert.equal(found.stdout, 'src/invoice.ts:2  return raw.trim()\n')
})

test('symbol --json returns the declaration kind and line', async () => {
  const found = await run(['symbol', 'parseinvoice', '--json'])

  assert.deepEqual(JSON.parse(found.stdout), {
    command: 'symbol',
    query: 'parseinvoice',
    results: [{ path: 'src/invoice.ts', line: 1, name: 'parseInvoice', kind: 'function' }]
  })
})

test('--limit caps the number of results', async () => {
  const found = await run(['find', 'raw', '--limit', '1', '--json'])

  assert.equal((JSON.parse(found.stdout) as { results: unknown[] }).results.length, 1)
})

test('a usage mistake exits with code 2 and names the problem on stderr', async () => {
  const unknown = await run(['grep', 'x'])
  const missingQuery = await run(['find'])

  assert.equal(unknown.code, 2)
  assert.match(unknown.stderr, /Unknown command "grep"/)
  assert.equal(missingQuery.code, 2)
  assert.match(missingQuery.stderr, /Give at least one word/)
})

test('help prints the usage text and exits with code 0', async () => {
  const help = await run(['--help'], 'en-US')

  assert.equal(help.code, 0)
  assert.match(help.stdout, /^Usage: orca-sonar <command> \[options\]/)
})

test('a search with no matches says so, in Spanish when Orca is set to Spanish', async () => {
  writeFileSync(
    join(userData, 'orca-data.json'),
    JSON.stringify({ settings: { uiLanguage: 'es' } })
  )

  const found = await run(['find', 'zzz-no-existe'])

  assert.equal(found.code, 0)
  assert.equal(found.stdout, 'Ninguna coincidencia para "zzz-no-existe".\n')
})
