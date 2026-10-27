import assert from 'node:assert/strict'
import { test } from 'node:test'
import activate, { type OrcaWorkerApi } from '../main.mjs'

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
  // A fresh check and no requests: the event wakes the worker, which spawns nothing.
  await events.get('agent.status.changed')?.({})
  assert.deepEqual(logs, [])
  assert.ok(methods.includes('storage.keys'))
})
