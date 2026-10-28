// Orca forks this file as the plugin's worker: a lazy process started by a
// palette command or a subscribed event and reaped after five idle minutes.
// It only wires Orca's API to src/plugin/worker.ts, where the logic and its
// tests live; plugin storage is the only channel to the panels.
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveUserDataDir } from './src/core/index-location.ts'
import { createProcessRunner } from './src/plugin/run-process.ts'
import { createWorker, userDataDirFromPluginRoot } from './src/plugin/worker.ts'

export default function activate(orca) {
  const pluginRoot = dirname(fileURLToPath(import.meta.url))
  const worker = createWorker({
    host: orca.host,
    run: createProcessRunner(process.platform),
    pluginRoot,
    userDataDir:
      userDataDirFromPluginRoot(pluginRoot) ??
      resolveUserDataDir(process.env, process.platform, homedir()),
    home: homedir(),
    baseEnv: process.env,
    now: () => new Date()
  })

  const logFailure = (error) => {
    orca.log(`sonar: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Rebuilds can outlast the 30 s command timeout, so they are never awaited here.
  const wake = async (force) => {
    const handle = await worker.wake({ force })
    handle.done.catch(logFailure)
  }

  orca.commands.register('sonar.refresh', async () => {
    await wake(true)
    return { ok: true }
  })
  orca.events.on('agent.status.changed', () => wake(false).catch(logFailure))
  orca.events.on('worktree.created', () => wake(false).catch(logFailure))
}
