import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runCli, type CliContext } from '../src/cli/run.ts'
import {
  installAgentIntegration,
  removeAgentIntegration,
  type IntegrationContext
} from '../src/core/agent-integration.ts'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NODE = '/usr/local/bin/node'

interface Sandbox {
  readonly home: string
  readonly userData: string
  readonly claude: string
  readonly context: IntegrationContext
}

function sandbox(env: Record<string, string> = {}): Sandbox {
  const home = mkdtempSync(join(tmpdir(), 'orca-sonar-agents-'))
  after(() => {
    rmSync(home, { recursive: true, force: true })
  })
  const userData = join(home, 'orca-data')
  const claude = join(home, '.claude')
  mkdirSync(claude)
  mkdirSync(userData)
  return {
    home,
    userData,
    claude,
    context: {
      home,
      userDataDir: userData,
      env,
      pluginRoot: PLUGIN_ROOT,
      nodePath: NODE,
      locale: 'en'
    }
  }
}

interface HookCommand {
  type: string
  command: string
  args?: string[]
  timeout?: number
  statusMessage?: string
}
interface Settings {
  env?: Record<string, string>
  hooks?: Record<string, { matcher?: string; hooks: HookCommand[] }[]>
}

function settingsOf(root: string): Settings {
  return JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')) as Settings
}

const FOREIGN_GROUP = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: 'bash /hooks/guard.sh' }]
}

test('install copies the skill and adds one search hint hook to the Claude settings', () => {
  const { claude, userData, context } = sandbox()
  writeFileSync(
    join(claude, 'settings.json'),
    JSON.stringify({ env: { KEEP: '1' }, hooks: { PreToolUse: [FOREIGN_GROUP] } })
  )

  const report = installAgentIntegration(context)

  assert.deepEqual(report, [{ agent: 'claude', root: claude, outcome: 'installed' }])
  const skill = join(claude, 'skills', 'orca-sonar')
  assert.equal(
    readFileSync(join(skill, 'SKILL.md'), 'utf8'),
    readFileSync(join(PLUGIN_ROOT, 'skills', 'orca-sonar', 'SKILL.md'), 'utf8')
  )
  assert.ok(existsSync(join(skill, 'search-hint.mjs')))
  const settings = settingsOf(claude)
  assert.deepEqual(settings.env, { KEEP: '1' })
  assert.deepEqual(settings.hooks?.PreToolUse?.[0], FOREIGN_GROUP)
  assert.deepEqual(settings.hooks.PreToolUse[1], {
    matcher: 'Grep|Bash',
    hooks: [
      {
        type: 'command',
        command: NODE,
        args: [join(skill, 'search-hint.mjs'), userData],
        timeout: 5,
        statusMessage: 'orca-sonar: checking whether Sonar can answer this search'
      }
    ]
  })
})

test('a second install changes nothing, and a stale hook path is replaced, not duplicated', () => {
  const { claude, context } = sandbox()
  installAgentIntegration(context)
  const written = statSync(join(claude, 'settings.json')).mtimeMs

  assert.deepEqual(installAgentIntegration(context), [
    { agent: 'claude', root: claude, outcome: 'unchanged' }
  ])
  assert.equal(statSync(join(claude, 'settings.json')).mtimeMs, written)

  installAgentIntegration({ ...context, nodePath: '/opt/node/bin/node' })
  const groups = settingsOf(claude).hooks?.PreToolUse ?? []
  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.hooks[0]?.command, '/opt/node/bin/node')
})

test('every Orca Claude account gets it too, and Codex gets the skill when it is installed', () => {
  const { home, userData, claude, context } = sandbox()
  const account = join(userData, 'claude-accounts', 'a1', 'auth')
  const loggedOut = join(userData, 'claude-accounts', 'a2', 'auth')
  mkdirSync(account, { recursive: true })
  mkdirSync(loggedOut, { recursive: true })
  writeFileSync(join(account, '.claude.json'), '{}')
  mkdirSync(join(home, '.codex'))

  const report = installAgentIntegration(context)

  assert.deepEqual(report, [
    { agent: 'claude', root: claude, outcome: 'installed' },
    { agent: 'claude', root: account, outcome: 'installed' },
    { agent: 'codex', root: join(home, '.codex'), outcome: 'installed' }
  ])
  assert.equal(settingsOf(account).hooks?.PreToolUse?.length, 1)
  assert.ok(existsSync(join(home, '.codex', 'skills', 'orca-sonar', 'SKILL.md')))
  assert.equal(existsSync(join(loggedOut, 'skills')), false)
})

test('CLAUDE_CONFIG_DIR and CODEX_HOME are honoured, and a missing agent home is left alone', () => {
  const { home, context } = sandbox()
  const custom = join(home, 'custom-claude')
  mkdirSync(custom)

  const report = installAgentIntegration({
    ...context,
    env: { CLAUDE_CONFIG_DIR: custom, CODEX_HOME: join(home, 'none') }
  })

  assert.deepEqual(report, [{ agent: 'claude', root: custom, outcome: 'installed' }])
  assert.equal(existsSync(join(home, '.claude', 'skills')), false)
  assert.equal(existsSync(join(home, 'none')), false)
})

test('a skill folder Sonar did not create and an unreadable settings file are never touched', () => {
  const { home, claude, userData, context } = sandbox()
  mkdirSync(join(claude, 'skills', 'orca-sonar'), { recursive: true })
  writeFileSync(join(claude, 'skills', 'orca-sonar', 'SKILL.md'), 'mine')
  const account = join(userData, 'claude-accounts', 'a1', 'auth')
  mkdirSync(account, { recursive: true })
  writeFileSync(join(account, 'settings.json'), '{ not json')
  const elsewhere = join(home, 'elsewhere')
  mkdirSync(elsewhere)
  mkdirSync(join(account, 'skills'))
  symlinkSync(elsewhere, join(account, 'skills', 'orca-sonar'), 'junction')

  const report = installAgentIntegration(context)

  assert.equal(report[0]?.outcome, 'skipped')
  assert.equal(report[1]?.outcome, 'skipped')
  assert.equal(readFileSync(join(claude, 'skills', 'orca-sonar', 'SKILL.md'), 'utf8'), 'mine')
  assert.equal(existsSync(join(claude, 'settings.json')), false)
  assert.equal(readFileSync(join(account, 'settings.json'), 'utf8'), '{ not json')
})

test('remove takes out only what Sonar added', () => {
  const { home, claude, context } = sandbox()
  mkdirSync(join(home, '.codex'))
  writeFileSync(
    join(claude, 'settings.json'),
    JSON.stringify({ hooks: { PreToolUse: [FOREIGN_GROUP] } })
  )
  installAgentIntegration(context)

  const report = removeAgentIntegration(context)

  assert.deepEqual(report, [
    { agent: 'claude', root: claude, outcome: 'removed' },
    { agent: 'codex', root: join(home, '.codex'), outcome: 'removed' }
  ])
  assert.deepEqual(settingsOf(claude), { hooks: { PreToolUse: [FOREIGN_GROUP] } })
  assert.equal(existsSync(join(claude, 'skills', 'orca-sonar')), false)
  assert.equal(existsSync(join(home, '.codex', 'skills', 'orca-sonar')), false)
  assert.deepEqual(removeAgentIntegration(context), [
    { agent: 'claude', root: claude, outcome: 'unchanged' },
    { agent: 'codex', root: join(home, '.codex'), outcome: 'unchanged' }
  ])
})

test('remove drops the hooks section it created when nothing else is left in it', () => {
  const { claude, context } = sandbox()
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ model: 'opus' }))
  installAgentIntegration(context)

  removeAgentIntegration(context)

  assert.deepEqual(settingsOf(claude), { model: 'opus' })
})

async function agents(
  box: Sandbox,
  args: readonly string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const context: CliContext = {
    env: { ORCA_USER_DATA_PATH: box.userData },
    platform: process.platform,
    home: box.home,
    cwd: box.home,
    systemLocale: 'en-US',
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    }
  }
  const code = await runCli(['agents', ...args], context)
  return { code, stdout, stderr }
}

test('agents install and agents remove report each agent folder, in JSON or in words', async () => {
  const box = sandbox()

  const installed = await agents(box, ['install', '--json'])
  assert.equal(installed.code, 0)
  assert.deepEqual(JSON.parse(installed.stdout), {
    command: 'agents',
    action: 'install',
    roots: [{ agent: 'claude', root: box.claude, outcome: 'installed' }]
  })
  const hook = settingsOf(box.claude).hooks?.PreToolUse?.[0]?.hooks[0]
  assert.equal(hook?.command, process.execPath)

  const removed = await agents(box, ['remove'])
  assert.equal(removed.code, 0)
  assert.equal(removed.stdout, `Claude Code at ${box.claude}: removed\n`)
})

test('agents without install or remove is a usage mistake', async () => {
  const box = sandbox()

  const result = await agents(box, ['upgrade'])

  assert.equal(result.code, 2)
  assert.match(result.stderr, /agents install.*agents remove/)
})
