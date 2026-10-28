import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'agent-hooks',
  'search-hint.mjs'
)

/** Orca's data folder with Sonar installed in it. */
function userData(installed = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-sonar-hint-'))
  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  if (installed) {
    mkdirSync(join(dir, 'plugins', 'ab2web.orca-sonar'), { recursive: true })
  }
  return dir
}

let session = 0

/** Runs the hook as Claude Code does; returns the advice it printed, or null for none. */
function hint(
  data: string,
  tool: { tool_name: string; tool_input: Record<string, unknown> },
  sessionId = `session-${String(++session)}`
): string | null {
  const result = spawnSync(process.execPath, [HOOK, data], {
    input: JSON.stringify({
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      cwd: data,
      ...tool
    }),
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  if (result.stdout.trim() === '') {
    return null
  }
  const output = JSON.parse(result.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string }
  }
  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse')
  return output.hookSpecificOutput.additionalContext
}

const grep = (pattern: string) => ({ tool_name: 'Grep', tool_input: { pattern } })
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } })

test('a Grep for a plain name gets the matching orca sonar commands', () => {
  const advice = hint(userData(), grep('parseInvoice'))

  assert.ok(advice)
  assert.match(advice, /orca sonar symbol parseInvoice/)
  assert.match(advice, /orca sonar find parseInvoice/)
})

test('rg, grep and git grep in a shell command are recognised, flags and quotes included', () => {
  const data = userData()

  assert.match(hint(data, bash('rg -n "createWorker" src')) ?? '', /orca sonar symbol createWorker/)
  assert.match(
    hint(data, bash('cd app && grep -rn --include=*.ts parse_invoice .')) ?? '',
    /parse_invoice/
  )
  assert.match(
    hint(data, bash("git grep -e 'invoice total'")) ?? '',
    /orca sonar find invoice total/
  )
})

test('regular expressions, short words and other commands get no advice', () => {
  const data = userData()

  assert.equal(hint(data, grep('parse.*Invoice')), null)
  assert.equal(hint(data, grep('id')), null)
  assert.equal(hint(data, bash('npm test')), null)
  assert.equal(hint(data, bash('rg "foo(bar"')), null)
  assert.equal(hint(data, { tool_name: 'Read', tool_input: { file_path: '/a.ts' } }), null)
})

test('the advice comes once per session', () => {
  const data = userData()

  assert.ok(hint(data, grep('parseInvoice'), 'same'))
  assert.equal(hint(data, grep('createWorker'), 'same'), null)
  assert.ok(hint(data, grep('createWorker'), 'other'))
})

test('no advice once Sonar is uninstalled or switched off for agents', () => {
  assert.equal(hint(userData(false), grep('parseInvoice')), null)

  const off = userData()
  mkdirSync(join(off, 'plugins-data', 'ab2web.orca-sonar'), { recursive: true })
  writeFileSync(
    join(off, 'plugins-data', 'ab2web.orca-sonar', 'storage.json'),
    JSON.stringify({ preferences: { agents: false, warmup: true } })
  )
  assert.equal(hint(off, grep('parseInvoice')), null)
})

test('input the hook cannot read is ignored without failing the tool call', () => {
  const result = spawnSync(process.execPath, [HOOK, userData()], {
    input: 'not json',
    encoding: 'utf8'
  })

  assert.equal(result.status, 0)
  assert.equal(result.stdout, '')
})
