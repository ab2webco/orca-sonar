// Claude Code PreToolUse hook installed by the Sonar plugin for Orca Lab.
// When an agent is about to search for a plain name or words with Grep, rg,
// grep or git grep, it adds a note pointing at the equivalent `orca sonar`
// command, once per session. It never blocks a tool call and prints nothing
// when there is nothing to say. Plain JavaScript with no imports beyond Node,
// so it runs from the skill folder it is copied into, on any platform.
//
// argv[2]: Orca's data folder, where Sonar is installed and keeps its data.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PLUGIN = 'ab2web.orca-sonar'
/** A session is remembered this long; older entries are dropped. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MIN_NAME_LENGTH = 3
const NAME = /^[A-Za-z_$][\w$]*$/
const WORDS = /^[A-Za-z_$][\w$]*(?: [A-Za-z_$][\w$]*)+$/
const SEARCH_COMMANDS = new Set(['rg', 'grep', 'egrep', 'fgrep'])
/** Options of rg and grep that take the next word as their value. */
const VALUE_OPTIONS = new Set([
  '-f',
  '--file',
  '-g',
  '--glob',
  '-t',
  '--type',
  '-T',
  '--type-not',
  '-A',
  '-B',
  '-C',
  '--after-context',
  '--before-context',
  '--context',
  '-m',
  '--max-count',
  '--include',
  '--exclude',
  '--exclude-dir',
  '-d',
  '-D'
])
const PATTERN_OPTIONS = new Set(['-e', '--regexp'])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Splits a shell command into commands, and each into words, honouring quotes.
 * `piped` marks a command that reads the previous one's output through `|`.
 */
function shellCommands(text) {
  const commands = [{ words: [], piped: false }]
  let word = null
  let quote = null
  const endWord = () => {
    if (word !== null) {
      commands[commands.length - 1].words.push(word)
      word = null
    }
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote !== null) {
      if (char === quote) {
        quote = null
      } else {
        word += char
      }
    } else if (char === '"' || char === "'") {
      quote = char
      word ??= ''
    } else if (char === ';' || char === '|' || char === '&' || char === '\n') {
      endWord()
      const pipe = char === '|' && text[index - 1] !== '|' && text[index + 1] !== '|'
      if (commands[commands.length - 1].words.length > 0) {
        commands.push({ words: [], piped: pipe })
      } else if (pipe) {
        commands[commands.length - 1].piped = true
      }
    } else if (char === ' ' || char === '\t') {
      endWord()
    } else {
      word = (word ?? '') + char
    }
  }
  endWord()
  return commands
}

/** The pattern of the first rg, grep or git grep in a shell command. */
function shellPattern(command) {
  for (const { words, piped } of shellCommands(command)) {
    // A search of another command's output is not a search of the repository.
    if (piped) {
      continue
    }
    let start = -1
    if (SEARCH_COMMANDS.has(words[0])) {
      start = 1
    } else if (words[0] === 'git' && words[1] === 'grep') {
      start = 2
    }
    if (start < 0) {
      continue
    }
    for (let index = start; index < words.length; index++) {
      const current = words[index]
      if (PATTERN_OPTIONS.has(current) || current === '--') {
        return words[index + 1]
      }
      if (VALUE_OPTIONS.has(current)) {
        index++
      } else if (!current.startsWith('-')) {
        return current
      }
    }
  }
  return undefined
}

function searchedText(input) {
  const toolInput = isRecord(input.tool_input) ? input.tool_input : {}
  if (input.tool_name === 'Grep') {
    return typeof toolInput.pattern === 'string' ? toolInput.pattern : undefined
  }
  if (input.tool_name === 'Bash' && typeof toolInput.command === 'string') {
    return shellPattern(toolInput.command)
  }
  return undefined
}

function advice(text) {
  const query = text.trim()
  if (NAME.test(query) && query.length >= MIN_NAME_LENGTH) {
    return (
      `Sonar keeps a search index of this repository. \`orca sonar symbol ${query}\` shows where ` +
      `${query} is declared and \`orca sonar find ${query}\` lists the lines that mention it, ` +
      'in a fraction of a second and with far less output than grep. Keep grep or rg for ' +
      'regular expressions, context lines or ignored files (see the orca-sonar skill).'
    )
  }
  if (WORDS.test(query)) {
    return (
      `Sonar keeps a search index of this repository. \`orca sonar find ${query}\` lists the ` +
      'lines that contain every one of those words, in a fraction of a second and with far ' +
      'less output than grep. Keep grep or rg for regular expressions, context lines or ' +
      'ignored files (see the orca-sonar skill).'
    )
  }
  return undefined
}

function agentsAllowed(dataDir) {
  const storage = readJson(join(dataDir, 'storage.json'))
  const preferences = isRecord(storage) ? storage.preferences : undefined
  return !(isRecord(preferences) && preferences.agents === false)
}

/** Records the session; false when it was already advised. */
function firstTimeIn(dataDir, sessionId, now) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return true
  }
  const path = join(dataDir, 'hint-sessions.json')
  const stored = readJson(path)
  const sessions = {}
  if (isRecord(stored)) {
    for (const [id, at] of Object.entries(stored)) {
      if (typeof at === 'number' && now - at < SESSION_TTL_MS) {
        sessions[id] = at
      }
    }
  }
  if (sessionId in sessions) {
    return false
  }
  sessions[sessionId] = now
  try {
    mkdirSync(dataDir, { recursive: true })
    const temporary = `${path}.${String(process.pid)}.tmp`
    writeFileSync(temporary, JSON.stringify(sessions))
    renameSync(temporary, path)
  } catch {
    // Remembering is best effort: at worst the advice comes once more.
  }
  return true
}

function main() {
  const userDataDir = process.argv[2]
  if (!userDataDir || !existsSync(join(userDataDir, 'plugins', PLUGIN))) {
    return
  }
  const input = readJson(0)
  if (!isRecord(input)) {
    return
  }
  const text = searchedText(input)
  const note = typeof text === 'string' ? advice(text) : undefined
  const dataDir = join(userDataDir, 'plugins-data', PLUGIN)
  if (
    note === undefined ||
    !agentsAllowed(dataDir) ||
    !firstTimeIn(dataDir, input.session_id, Date.now())
  ) {
    return
  }
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note } })
  )
}

try {
  main()
} catch {
  // A hint is never worth failing the agent's tool call.
}
