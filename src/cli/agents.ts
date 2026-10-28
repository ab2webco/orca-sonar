import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  installAgentIntegration,
  removeAgentIntegration,
  type RootReport
} from '../core/agent-integration.ts'
import type { Locale } from '../core/locale.ts'
import { translate, type MessageKey } from '../core/messages.ts'
import type { Invocation } from './arguments.ts'
import type { CliContext } from './run.ts'

/** The plugin folder this CLI runs from; it holds the skill and the hook script to copy. */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const AGENT_NAMES: Record<RootReport['agent'], string> = { claude: 'Claude Code', codex: 'Codex' }
const OUTCOME_KEYS: Record<RootReport['outcome'], MessageKey> = {
  installed: 'outcomeInstalled',
  removed: 'outcomeRemoved',
  unchanged: 'outcomeUnchanged',
  skipped: 'outcomeSkipped'
}

interface AgentsRun {
  readonly userDataDir: string
  readonly locale: Locale
  readonly context: CliContext
}

/** `agents install|remove`: puts Sonar's skill and search hint where agents look, or takes them out. */
export function runAgents(invocation: Invocation, run: AgentsRun): void {
  const { userDataDir, locale, context } = run
  const action = invocation.positionals[0] === 'remove' ? 'remove' : 'install'
  const integration = {
    home: context.home,
    userDataDir,
    env: context.env,
    pluginRoot: PLUGIN_ROOT,
    // The Node.js running this command; the hook needs an absolute path to it.
    nodePath: process.execPath,
    locale
  }
  const roots =
    action === 'install'
      ? installAgentIntegration(integration)
      : removeAgentIntegration(integration)
  if (invocation.json) {
    context.stdout(`${JSON.stringify({ command: 'agents', action, roots }, null, 2)}\n`)
    return
  }
  const lines = roots.map((report) =>
    translate(locale, 'agentsRoot', {
      agent: AGENT_NAMES[report.agent],
      root: report.root,
      outcome: translate(locale, OUTCOME_KEYS[report.outcome], { reason: report.reason ?? '' })
    })
  )
  context.stdout(`${lines.length === 0 ? translate(locale, 'agentsNone') : lines.join('\n')}\n`)
}
