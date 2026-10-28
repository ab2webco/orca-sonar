import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { PLUGIN_IDENTITY, type Environment } from './index-location.ts'
import type { Locale } from './locale.ts'
import { translate } from './messages.ts'

/**
 * Puts Sonar where agents look, the way Orca's own skills reach them: a copy of
 * the skill in every agent's skills folder, and for Claude Code a PreToolUse
 * hook that points a plain grep or rg search at `orca sonar`. Orca serves a
 * plugin's skill only to whoever asks `orca skills get` by name, so without
 * this an agent never learns Sonar exists.
 */

export interface IntegrationContext {
  readonly home: string
  readonly userDataDir: string
  readonly env: Environment
  /** The installed plugin folder, holding `skills/orca-sonar` and `agent-hooks`. */
  readonly pluginRoot: string
  /** Absolute path of the Node.js that runs the hook; a bare `node` is not on every PATH. */
  readonly nodePath: string
  readonly locale: Locale
}

export type AgentKind = 'claude' | 'codex'

export interface RootReport {
  readonly agent: AgentKind
  readonly root: string
  readonly outcome: 'installed' | 'removed' | 'unchanged' | 'skipped'
  readonly reason?: string
}

const SKILL_NAME = 'orca-sonar'
const HOOK_FILE = 'search-hint.mjs'
/** Written into every skill copy; a folder without it belongs to someone else. */
const MARKER_FILE = '.orca-sonar.json'
const HOOK_MATCHER = 'Grep|Bash'
const HOOK_TIMEOUT_SECONDS = 5
const OUR_HOOK_SCRIPT = /[\\/]skills[\\/]orca-sonar[\\/]search-hint\.mjs$/

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface AgentRoot {
  readonly agent: AgentKind
  readonly root: string
}

/** Claude Code's config folder and every Orca-managed Claude account, then the same for Codex. */
function agentRoots(context: IntegrationContext): AgentRoot[] {
  const roots: AgentRoot[] = []
  const claude = context.env.CLAUDE_CONFIG_DIR || join(context.home, '.claude')
  if (existsSync(claude)) {
    roots.push({ agent: 'claude', root: claude })
  }
  const accounts = join(context.userDataDir, 'claude-accounts')
  if (existsSync(accounts)) {
    for (const account of readdirSync(accounts, { withFileTypes: true })) {
      const auth = join(accounts, account.name, 'auth')
      if (
        account.isDirectory() &&
        (existsSync(join(auth, 'settings.json')) || existsSync(join(auth, '.claude.json')))
      ) {
        roots.push({ agent: 'claude', root: auth })
      }
    }
  }
  const codex = context.env.CODEX_HOME || join(context.home, '.codex')
  if (existsSync(codex)) {
    roots.push({ agent: 'codex', root: codex })
  }
  const codexAccounts = join(context.userDataDir, 'codex-accounts')
  if (existsSync(codexAccounts)) {
    for (const account of readdirSync(codexAccounts, { withFileTypes: true })) {
      const accountHome = join(codexAccounts, account.name, 'home')
      if (account.isDirectory() && existsSync(accountHome) && accountHome !== codex) {
        roots.push({ agent: 'codex', root: accountHome })
      }
    }
  }
  return roots
}

/** Writes through a temporary file, so a reader never sees half a file. */
function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, content)
  renameSync(temporary, path)
}

/** Writes the file when its content differs; true when it did. */
function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) {
    return false
  }
  writeAtomically(path, content)
  return true
}

type SkillFolder = 'missing' | 'ours' | 'foreign'

function skillFolderState(folder: string): SkillFolder {
  const stats = lstatSync(folder, { throwIfNoEntry: false })
  if (stats === undefined) {
    return 'missing'
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return 'foreign'
  }
  try {
    const marker: unknown = JSON.parse(readFileSync(join(folder, MARKER_FILE), 'utf8'))
    return isRecord(marker) && marker.owner === PLUGIN_IDENTITY ? 'ours' : 'foreign'
  } catch {
    return 'foreign'
  }
}

type SettingsFile =
  | { readonly kind: 'read'; readonly settings: Json; readonly text: string | null }
  | { readonly kind: 'unreadable' }

function readSettings(path: string): SettingsFile {
  if (!existsSync(path)) {
    return { kind: 'read', settings: {}, text: null }
  }
  try {
    const text = readFileSync(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? { kind: 'read', settings: parsed, text } : { kind: 'unreadable' }
  } catch {
    return { kind: 'unreadable' }
  }
}

function isOurHook(hook: unknown): boolean {
  return (
    isRecord(hook) &&
    Array.isArray(hook.args) &&
    typeof hook.args[0] === 'string' &&
    OUR_HOOK_SCRIPT.test(hook.args[0])
  )
}

/** The PreToolUse groups without Sonar's hook; a group left empty by that goes too. */
function withoutOurHook(groups: readonly unknown[]): unknown[] {
  const kept: unknown[] = []
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks) || !group.hooks.some(isOurHook)) {
      kept.push(group)
      continue
    }
    const hooks = group.hooks.filter((hook) => !isOurHook(hook))
    if (hooks.length > 0) {
      kept.push({ ...group, hooks })
    }
  }
  return kept
}

/**
 * The settings with Sonar's hook taken out, or put back as `group` when given.
 * Keys keep their place, so the owner's file only changes where Sonar's entry is.
 */
function withHookGroup(settings: Json, group: Json | null): Json {
  const hooks: Json = isRecord(settings.hooks) ? { ...settings.hooks } : {}
  const current = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []
  const preToolUse = [...withoutOurHook(current), ...(group === null ? [] : [group])]
  if (preToolUse.length > 0) {
    hooks.PreToolUse = preToolUse
  } else {
    delete hooks.PreToolUse
  }
  const next: Json = { ...settings }
  if (Object.keys(hooks).length > 0) {
    next.hooks = hooks
  } else {
    delete next.hooks
  }
  return next
}

function serialize(settings: Json): string {
  return `${JSON.stringify(settings, null, 2)}\n`
}

/** Writes the settings when Sonar's change altered them; true when it did. */
function updateSettings(
  path: string,
  file: { settings: Json; text: string | null },
  next: Json
): boolean {
  if (JSON.stringify(next) === JSON.stringify(file.settings)) {
    return false
  }
  if (file.text === null && Object.keys(next).length === 0) {
    return false
  }
  writeAtomically(path, serialize(next))
  return true
}

function copySkill(context: IntegrationContext, folder: string, withHook: boolean): boolean {
  const source = join(context.pluginRoot, 'skills', SKILL_NAME, 'SKILL.md')
  let changed = writeIfChanged(join(folder, 'SKILL.md'), readFileSync(source, 'utf8'))
  if (withHook) {
    const hook = join(context.pluginRoot, 'agent-hooks', HOOK_FILE)
    changed = writeIfChanged(join(folder, HOOK_FILE), readFileSync(hook, 'utf8')) || changed
  }
  return (
    writeIfChanged(join(folder, MARKER_FILE), `${JSON.stringify({ owner: PLUGIN_IDENTITY })}\n`) ||
    changed
  )
}

function install(context: IntegrationContext, { agent, root }: AgentRoot): RootReport {
  const folder = join(root, 'skills', SKILL_NAME)
  if (skillFolderState(folder) === 'foreign') {
    return { agent, root, outcome: 'skipped', reason: `${folder} was not created by Sonar` }
  }
  if (agent === 'codex') {
    return { agent, root, outcome: copySkill(context, folder, false) ? 'installed' : 'unchanged' }
  }
  const settingsPath = join(root, 'settings.json')
  const file = readSettings(settingsPath)
  if (file.kind === 'unreadable') {
    return { agent, root, outcome: 'skipped', reason: `${settingsPath} is not a JSON object` }
  }
  const copied = copySkill(context, folder, true)
  const group = {
    matcher: HOOK_MATCHER,
    hooks: [
      {
        type: 'command',
        command: context.nodePath,
        args: [join(folder, HOOK_FILE), context.userDataDir],
        timeout: HOOK_TIMEOUT_SECONDS,
        statusMessage: translate(context.locale, 'hookStatus')
      }
    ]
  }
  const written = updateSettings(settingsPath, file, withHookGroup(file.settings, group))
  return { agent, root, outcome: copied || written ? 'installed' : 'unchanged' }
}

function remove({ agent, root }: AgentRoot): RootReport {
  const folder = join(root, 'skills', SKILL_NAME)
  let changed = false
  if (agent === 'claude') {
    const settingsPath = join(root, 'settings.json')
    const file = readSettings(settingsPath)
    if (file.kind === 'read' && file.text !== null) {
      changed = updateSettings(settingsPath, file, withHookGroup(file.settings, null))
    }
  }
  if (skillFolderState(folder) === 'ours') {
    rmSync(folder, { recursive: true, force: true })
    changed = true
  }
  return { agent, root, outcome: changed ? 'removed' : 'unchanged' }
}

/** Installs or refreshes Sonar for every agent found; idempotent, and never touches what others own. */
export function installAgentIntegration(context: IntegrationContext): RootReport[] {
  return agentRoots(context).map((root) => install(context, root))
}

/** Takes out exactly what `installAgentIntegration` put in. */
export function removeAgentIntegration(context: IntegrationContext): RootReport[] {
  return agentRoots(context).map(remove)
}
