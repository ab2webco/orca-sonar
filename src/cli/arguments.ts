import { parseArgs } from 'node:util'
import type { MessageKey, MessageValues } from '../core/messages.ts'

export type Command = 'help' | 'install' | 'index' | 'status' | 'find' | 'symbol'

export type UsageErrorCode =
  'unknown_command' | 'unknown_option' | 'invalid_limit' | 'query_required'

const MESSAGE_KEY_BY_CODE: Record<UsageErrorCode, MessageKey> = {
  unknown_command: 'unknownCommand',
  unknown_option: 'unknownOption',
  invalid_limit: 'invalidLimit',
  query_required: 'queryRequired'
}

/** A mistake in the command line. The CLI reports it and exits with code 2. */
export class UsageError extends Error {
  readonly code: UsageErrorCode
  readonly values: MessageValues

  constructor(code: UsageErrorCode, values: MessageValues = {}) {
    super(code)
    this.code = code
    this.values = values
  }

  get messageKey(): MessageKey {
    return MESSAGE_KEY_BY_CODE[this.code]
  }
}

export interface Invocation {
  readonly command: Command
  readonly positionals: readonly string[]
  readonly json: boolean
  readonly root: string | undefined
  readonly limit: number | undefined
}

const OPTIONS = {
  json: { type: 'boolean', default: false },
  root: { type: 'string' },
  limit: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false }
} as const

const COMMANDS: readonly Command[] = ['install', 'index', 'status', 'find', 'symbol']
const QUERY_COMMANDS: readonly Command[] = ['find', 'symbol']
const WHOLE_NUMBER = /^[1-9]\d*$/

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value)
}

export function parseInvocation(argv: readonly string[]): Invocation {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: OPTIONS })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    // A value that starts with "-" (such as -3) is read by parseArgs as a missing value for --limit.
    if (message.includes("'--limit")) {
      throw new UsageError('invalid_limit')
    }
    const option = /'(-[^' ]*)/.exec(message)?.[1] ?? ''
    throw new UsageError('unknown_option', { option })
  }

  const { values, positionals } = parsed
  const [first, ...rest] = positionals
  if (values.help || first === undefined) {
    return { command: 'help', positionals: [], json: false, root: undefined, limit: undefined }
  }
  if (!isCommand(first)) {
    throw new UsageError('unknown_command', { command: first })
  }
  if (QUERY_COMMANDS.includes(first) && rest.length === 0) {
    throw new UsageError('query_required')
  }
  if (values.limit !== undefined && !WHOLE_NUMBER.test(values.limit)) {
    throw new UsageError('invalid_limit')
  }

  return {
    command: first,
    positionals: rest,
    json: values.json,
    root: values.root,
    limit: values.limit === undefined ? undefined : Number(values.limit)
  }
}
