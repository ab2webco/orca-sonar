import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RunResult, Runner } from '../src/plugin/run-process.ts'
import { REBUILDS_KEY, STATE_KEY, USAGE_KEY } from '../src/plugin/state.ts'
import { createWorker, userDataDirFromPluginRoot, type Host } from '../src/plugin/worker.ts'

const PLUGIN_ROOT = join('/plugins', 'ab2web.orca-sonar', 'a'.repeat(64))
const CLI = join(PLUGIN_ROOT, 'bin', 'orca-sonar.ts')
const USER_DATA = '/data/orca'
const SHOP = '/work/shop'
const BLOG = '/work/blog'
const NOW = new Date('2026-10-26T10:00:00.000Z')

/**
 * Node passes the worker's own --permission sandbox on to every node child, so
 * the CLI gets its grants explicitly: read anything, write only Sonar's data folder.
 */
const CHILD_PERMISSIONS = [
  '--permission',
  '--allow-fs-read=*',
  `--allow-fs-write=${join(USER_DATA, 'plugins-data', 'ab2web.orca-sonar')}`,
  '--allow-child-process',
  '--disable-warning=SecurityWarning'
]

const NODE_WARNING =
  '(node:41) [PERM0002] SecurityWarning: The flag --allow-child-process must be used with extreme caution.\n' +
  '(Use `node --trace-warnings ...` to show where the warning was created)\n'

interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly input: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
}

const ok = (stdout: string): RunResult => ({ kind: 'exited', code: 0, stdout, stderr: '' })

function index(files: number): Record<string, unknown> {
  return {
    exists: files > 0,
    indexPath: `/data/orca/plugins-data/ab2web.orca-sonar/index/r/${String(files)}.sqlite`,
    files,
    symbols: files * 2,
    lastIndexedAt: files > 0 ? '2026-10-26T09:00:00.000Z' : null,
    sizeBytes: files * 100
  }
}

const WORKTREES = {
  ok: true,
  result: {
    worktrees: [
      { path: SHOP, branch: 'refs/heads/feature/cart', displayName: 'shop', hostId: 'local' },
      { path: BLOG, branch: '', displayName: 'blog', hostId: 'local' },
      { path: SHOP, branch: 'refs/heads/feature/cart', displayName: 'shop', hostId: 'local' },
      { path: '/remote/api', branch: 'main', displayName: 'api', hostId: 'ssh-box' }
    ]
  }
}

const USAGE = { command: 'usage', totals: { queries: 3 }, days: [] }

interface Fixture {
  readonly host: Host
  readonly storage: Map<string, unknown>
  readonly settings: Map<string, unknown>
  readonly calls: Call[]
  clock: Date
  /** When set, an `index` run waits for it, so a test can look at the running state. */
  indexGate: Promise<void> | null
  respond: (command: string, args: readonly string[], input: string | undefined) => RunResult
}

function defaultResponse(
  command: string,
  args: readonly string[],
  input: string | undefined
): RunResult {
  if (command === 'orca' && args[0] === 'worktree') return ok(JSON.stringify(WORKTREES))
  if (command === 'orca' && args[0] === 'sonar') {
    return { kind: 'exited', code: 1, stdout: '', stderr: 'Unknown command: sonar' }
  }
  if (command === 'node' && args.includes('status')) {
    const roots = (input ?? '').split('\n').filter(Boolean)
    const workspaces = roots.map((root) => ({ root, ...index(root === SHOP ? 120 : 0) }))
    return ok(JSON.stringify({ command: 'status', workspaces }))
  }
  if (command === 'node' && args.includes('usage')) return ok(JSON.stringify(USAGE))
  if (command === 'node' && args.includes('prune')) return ok('{"command":"prune","removed":[]}')
  if (command === 'node' && args.includes('index')) return ok('{"command":"index"}')
  throw new Error(`unexpected ${command} ${args.join(' ')}`)
}

function fixture(): Fixture {
  const storage = new Map<string, unknown>()
  const settings = new Map<string, unknown>()
  const state: Fixture = {
    storage,
    settings,
    calls: [],
    clock: NOW,
    indexGate: null,
    respond: defaultResponse,
    host: {
      call: (method, params) => {
        const key = typeof params.key === 'string' ? params.key : ''
        switch (method) {
          case 'storage.get':
            return Promise.resolve({ value: storage.get(key) ?? null })
          case 'storage.set':
            storage.set(key, params.value)
            return Promise.resolve({ ok: true })
          case 'storage.delete':
            storage.delete(key)
            return Promise.resolve({ ok: true })
          case 'storage.keys':
            return Promise.resolve({ keys: [...storage.keys()] })
          case 'settings.get':
            return Promise.resolve({ settings: Object.fromEntries(settings) })
          case 'settings.set':
            settings.set(key, params.value)
            return Promise.resolve({ ok: true })
          default:
            return Promise.reject(new Error(`unexpected host method ${method}`))
        }
      }
    }
  }
  return state
}

function workerFor(state: Fixture) {
  const run: Runner = (command, args, options) => {
    state.calls.push({ command, args, input: options.input, env: options.env })
    const gate = args.includes('index') ? state.indexGate : null
    return (gate ?? Promise.resolve()).then(() => state.respond(command, args, options.input))
  }
  return createWorker({
    host: state.host,
    run,
    pluginRoot: PLUGIN_ROOT,
    userDataDir: USER_DATA,
    baseEnv: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
    now: () => state.clock
  })
}

interface StoredState {
  checkedAt: string
  sonarCommand: string
  problem?: string
  error?: string
  workspaces: {
    root: string
    displayName: string
    branch: string
    index?: { files: number }
    error?: string
  }[]
}

function stored(state: Fixture): StoredState {
  return state.storage.get(STATE_KEY) as StoredState
}

function rebuilds(state: Fixture): Record<string, { state: string; error?: string }> {
  return state.storage.get(REBUILDS_KEY) as Record<string, { state: string; error?: string }>
}

test('a wake publishes every local worktree once with its index status, from one status run', async () => {
  const state = fixture()

  await (
    await workerFor(state).wake({ force: true })
  ).done

  const published = stored(state)
  assert.equal(published.checkedAt, NOW.toISOString())
  assert.equal(published.sonarCommand, 'missing')
  assert.deepEqual(
    published.workspaces.map(({ root, displayName, branch }) => ({ root, displayName, branch })),
    [
      { root: SHOP, displayName: 'shop', branch: 'feature/cart' },
      { root: BLOG, displayName: 'blog', branch: '' }
    ]
  )
  assert.equal(published.workspaces[0]?.index?.files, 120)
  const [status, ...more] = state.calls.filter((call) => call.args.includes('status'))
  assert.ok(status)
  assert.equal(more.length, 0)
  assert.deepEqual(status.args, [...CHILD_PERMISSIONS, CLI, 'status', '--stdin', '--json'])
  assert.equal(status.input, `${SHOP}\n${BLOG}\n`)
  assert.equal(status.env.ORCA_USER_DATA_PATH, USER_DATA)
  assert.equal(status.env.ELECTRON_RUN_AS_NODE, undefined)
})

test('a wake mirrors the usage summary for the statistics panel', async () => {
  const state = fixture()

  await (
    await workerFor(state).wake({ force: true })
  ).done

  assert.deepEqual(state.storage.get(USAGE_KEY), USAGE)
  const usage = state.calls.find((call) => call.args.includes('usage'))
  assert.deepEqual(usage?.args, [...CHILD_PERMISSIONS, CLI, 'usage', '--json'])
})

test('a wake records whether Orca has the orca sonar command', async () => {
  const state = fixture()
  state.respond = (command, args, input) =>
    command === 'orca' && args[0] === 'sonar' ? ok('Usage') : defaultResponse(command, args, input)

  await (
    await workerFor(state).wake({ force: true })
  ).done

  assert.equal(stored(state).sonarCommand, 'available')
})

test('the switches the panel saved are mirrored into the plugin settings', async () => {
  const state = fixture()
  state.storage.set('preferences', { agents: false, warmup: true })

  await (
    await workerFor(state).wake({ force: true })
  ).done

  assert.deepEqual(state.settings.get('preferences'), { agents: false, warmup: true })
})

test('without the orca command the list cannot be read and the state says so', async () => {
  const state = fixture()
  state.respond = (command, args, input) =>
    command === 'orca' ? { kind: 'not-found' } : defaultResponse(command, args, input)

  await (
    await workerFor(state).wake({ force: true })
  ).done

  assert.equal(stored(state).problem, 'orca-cli-missing')
  assert.deepEqual(stored(state).workspaces, [])
})

test('without node the worktrees are listed and the state says node is missing', async () => {
  const state = fixture()
  state.respond = (command, args, input) =>
    command === 'node' ? { kind: 'not-found' } : defaultResponse(command, args, input)

  await (
    await workerFor(state).wake({ force: true })
  ).done

  assert.equal(stored(state).problem, 'node-missing')
  assert.equal(stored(state).workspaces.length, 2)
  assert.equal(stored(state).workspaces[0]?.index, undefined)
})

test('a failing status run is published with its message, not Node warnings', async () => {
  const state = fixture()
  state.respond = (command, args, input) =>
    command === 'node' && args.includes('status')
      ? { kind: 'exited', code: 1, stdout: '', stderr: `${NODE_WARNING}Sonar failed: disk full\n` }
      : defaultResponse(command, args, input)

  await (
    await workerFor(state).wake({ force: true })
  ).done

  assert.equal(stored(state).problem, 'error')
  assert.equal(stored(state).error, 'Sonar failed: disk full')
})

test('a wake prunes vanished workspaces after the status run, keeping every index it just checked', async () => {
  const state = fixture()

  await (
    await workerFor(state).wake({ force: true })
  ).done

  const commands = state.calls.map((call) => call.args.find((arg) => /^[a-z]+$/.test(arg)))
  assert.ok(commands.indexOf('prune') > commands.indexOf('status'))
  const prunes = state.calls.filter((call) => call.args.includes('prune'))
  assert.equal(prunes.length, 1)
  assert.deepEqual(prunes[0]?.args, [...CHILD_PERMISSIONS, CLI, 'prune', '--stdin', '--json'])
  assert.equal(prunes[0].input, `${String(index(120).indexPath)}\n${String(index(0).indexPath)}\n`)
})

test('when a workspace could not be checked, prune gets no list and keeps every unrecorded index', async () => {
  const state = fixture()
  state.respond = (command, args, input) =>
    command === 'node' && args.includes('status')
      ? ok(
          JSON.stringify({
            command: 'status',
            workspaces: [
              { root: SHOP, ...index(120) },
              { root: BLOG, error: 'permission denied' }
            ]
          })
        )
      : defaultResponse(command, args, input)

  await (
    await workerFor(state).wake({ force: true })
  ).done

  const prune = state.calls.find((call) => call.args.includes('prune'))
  assert.deepEqual(prune?.args, [...CHILD_PERMISSIONS, CLI, 'prune', '--json'])
  assert.equal(prune.input, undefined)
})

test('nothing is pruned when the status run failed, and a failed prune changes no state', async () => {
  const failedStatus = fixture()
  failedStatus.respond = (command, args, input) =>
    command === 'node' && args.includes('status')
      ? { kind: 'exited', code: 1, stdout: '', stderr: 'Sonar failed: disk full\n' }
      : defaultResponse(command, args, input)
  const failedPrune = fixture()
  failedPrune.respond = (command, args, input) =>
    command === 'node' && args.includes('prune')
      ? { kind: 'exited', code: 1, stdout: '', stderr: 'Sonar failed: busy\n' }
      : defaultResponse(command, args, input)

  await (
    await workerFor(failedStatus).wake({ force: true })
  ).done
  await (
    await workerFor(failedPrune).wake({ force: true })
  ).done

  assert.equal(
    failedStatus.calls.some((call) => call.args.includes('prune')),
    false
  )
  assert.equal(stored(failedPrune).problem, undefined)
  assert.equal(stored(failedPrune).workspaces.length, 2)
})

test('an event-driven wake within a minute of the last check spawns nothing', async () => {
  const state = fixture()
  const worker = workerFor(state)
  await (
    await worker.wake({ force: true })
  ).done
  const spawned = state.calls.length

  state.clock = new Date(NOW.getTime() + 30_000)
  await (
    await worker.wake({ force: false })
  ).done
  assert.equal(state.calls.length, spawned)

  state.clock = new Date(NOW.getTime() + 61_000)
  await (
    await worker.wake({ force: false })
  ).done
  assert.ok(state.calls.length > spawned)
})

test('a rebuild request for a local worktree is attended once, indexed and reported', async () => {
  const state = fixture()
  state.storage.set('rebuild:1a2b', {
    root: SHOP,
    at: new Date(NOW.getTime() - 5_000).toISOString()
  })
  let release = (): void => undefined
  state.indexGate = new Promise((resolve) => {
    release = resolve
  })
  const worker = workerFor(state)

  const handle = await worker.wake({ force: false })
  assert.equal(state.storage.has('rebuild:1a2b'), false)
  assert.equal(rebuilds(state)[SHOP]?.state, 'running')
  release()
  await handle.done

  assert.deepEqual(rebuilds(state)[SHOP], {
    state: 'done',
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString()
  })
  const indexRuns = state.calls.filter((call) => call.args.includes('index'))
  assert.deepEqual(
    indexRuns.map((call) => call.args),
    [[...CHILD_PERMISSIONS, CLI, 'index', '--root', SHOP, '--json']]
  )
  assert.equal(stored(state).checkedAt, NOW.toISOString())
})

test('a rebuild request for a path Orca does not list as local is refused', async () => {
  const state = fixture()
  state.storage.set('rebuild:x', { root: '/etc', at: NOW.toISOString() })
  state.storage.set('rebuild:y', { root: '/remote/api', at: NOW.toISOString() })

  await (
    await workerFor(state).wake({ force: false })
  ).done

  assert.equal(
    state.calls.some((call) => call.args.includes('index')),
    false
  )
  assert.equal(rebuilds(state)['/etc']?.state, 'failed')
  assert.equal(state.storage.has('rebuild:x'), false)
})

test('a rebuild request older than an hour is dropped without indexing', async () => {
  const state = fixture()
  state.storage.set('rebuild:old', {
    root: SHOP,
    at: new Date(NOW.getTime() - 3_700_000).toISOString()
  })

  await (
    await workerFor(state).wake({ force: false })
  ).done

  assert.equal(state.storage.has('rebuild:old'), false)
  assert.equal(
    state.calls.some((call) => call.args.includes('index')),
    false
  )
})

test('a failed rebuild keeps its error, without Node warnings', async () => {
  const state = fixture()
  state.storage.set('rebuild:1', { root: SHOP, at: NOW.toISOString() })
  state.respond = (command, args, input) =>
    command === 'node' && args.includes('index')
      ? { kind: 'exited', code: 1, stdout: '', stderr: `${NODE_WARNING}Sonar failed: locked` }
      : defaultResponse(command, args, input)

  await (
    await workerFor(state).wake({ force: false })
  ).done

  assert.equal(rebuilds(state)[SHOP]?.state, 'failed')
  assert.equal(rebuilds(state)[SHOP]?.error, 'Sonar failed: locked')
})

test('the user data folder comes from an installed plugin path on every platform', () => {
  const hash = 'f'.repeat(64)
  assert.equal(
    userDataDirFromPluginRoot(
      join('/Users/me/Library/Application Support/orca/plugins/ab2web.orca-sonar', hash)
    ),
    join('/Users/me/Library/Application Support/orca')
  )
  assert.equal(
    userDataDirFromPluginRoot(
      `C:\\Users\\me\\AppData\\Roaming\\orca\\plugins\\ab2web.orca-sonar\\${hash}`
    ),
    'C:\\Users\\me\\AppData\\Roaming\\orca'
  )
  assert.equal(userDataDirFromPluginRoot('/home/me/src/orca-sonar'), undefined)
})
