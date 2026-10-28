import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import activate, { type OrcaWorkerApi } from '../main.mjs'

/**
 * activate() runs the real worker, which writes into the agents' config
 * folders, so the whole process points at a throwaway home and Orca data
 * folder; nothing reaches the developer's own configuration.
 */
const ISOLATED = ['HOME', 'USERPROFILE', 'ORCA_USER_DATA_PATH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']
const saved = new Map<string, string | undefined>()
let home: string
let userData: string

before(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-sonar-main-'))
  userData = join(home, 'orca-data')
  mkdirSync(join(home, '.claude'))
  for (const name of ISOLATED) {
    saved.set(name, process.env[name])
  }
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.ORCA_USER_DATA_PATH = userData
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CODEX_HOME
})

after(() => {
  for (const [name, value] of saved) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name)
    } else {
      process.env[name] = value
    }
  }
  rmSync(home, { recursive: true, force: true })
})

test('activate registers the palette command and the events that wake the worker', async () => {
  const commands = new Map<string, (args: unknown) => unknown>()
  const events = new Map<string, (payload: unknown) => unknown>()
  const logs: string[] = []
  const methods: string[] = []
  const api: OrcaWorkerApi = {
    commands: {
      register: (id, handler) => commands.set(id, handler)
    },
    events: { on: (name, handler) => events.set(name, handler) },
    host: {
      call: (method, params) => {
        methods.push(method)
        if (method === 'storage.get') {
          const value = params.key === 'state' ? { checkedAt: new Date().toISOString() } : null
          return Promise.resolve({ value })
        }
        if (method === 'storage.keys') return Promise.resolve({ keys: [] })
        return Promise.reject(new Error(method))
      }
    },
    log: (message) => logs.push(message)
  }

  activate(api)

  assert.deepEqual([...commands.keys()], ['sonar.refresh'])
  assert.deepEqual([...events.keys()].sort(), ['agent.status.changed', 'worktree.created'])
  // A fresh check and no requests: the event wakes the worker, which only
  // teaches the agents about Sonar, once.
  await events.get('agent.status.changed')?.({})
  assert.deepEqual(logs, [])
  assert.ok(methods.includes('storage.keys'))
  const claude = join(home, '.claude')
  assert.ok(existsSync(join(claude, 'skills', 'orca-sonar', 'SKILL.md')))
  const settings = JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8')) as {
    hooks: { PreToolUse: { hooks: { args: string[] }[] }[] }
  }
  assert.equal(settings.hooks.PreToolUse[0]?.hooks[0]?.args[1], userData)
})
