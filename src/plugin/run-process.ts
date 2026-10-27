import { execFile, type ExecFileException } from 'node:child_process'
import { statSync } from 'node:fs'
import { join } from 'node:path'

export type RunResult =
  | {
      readonly kind: 'exited'
      readonly code: number
      readonly stdout: string
      readonly stderr: string
    }
  | { readonly kind: 'not-found' }

export interface RunOptions {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly timeoutMs: number
  /** Written to the program's standard input, which is then closed. */
  readonly input?: string
}

/** Runs a program with argv (never a shell). `not-found` means it is not on PATH. */
export type Runner = (
  command: string,
  args: readonly string[],
  options: RunOptions
) => Promise<RunResult>

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/** Windows' own default when PATHEXT is not set. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/** Arguments cmd.exe passes through untouched: no quotes, spaces or metacharacters. */
const PLAIN_ARGUMENT = /^[\w./:=-]+$/

export interface Invocation {
  readonly command: string
  readonly args: readonly string[]
}

/**
 * On Windows `orca` is a command script, which Node only runs through cmd.exe.
 * That route is taken only for plain, fixed arguments; anything else returns
 * null so a path or a name can never be read by cmd.exe as syntax. `node` is an
 * executable and runs directly.
 */
export function windowsInvocation(
  command: string,
  args: readonly string[],
  comspec: string
): Invocation | null {
  if (command === 'node' || /\.exe$/i.test(command)) {
    return { command, args }
  }
  if (![command, ...args].every((part) => PLAIN_ARGUMENT.test(part))) {
    return null
  }
  return { command: comspec, args: ['/d', '/s', '/c', command, ...args] }
}

/**
 * Where Windows would find `command` on PATH, trying each PATHEXT extension.
 * cmd.exe reports a missing program only as a localised message, so the runner
 * looks it up first instead of reading that message.
 */
export function findWindowsCommand(
  command: string,
  env: Readonly<Record<string, string | undefined>>
): string | null {
  const directories = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)
  const extensions = (env.PATHEXT ?? DEFAULT_PATHEXT).split(';').filter(Boolean)
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`)
      if (statSync(candidate, { throwIfNoEntry: false })?.isFile() === true) {
        return candidate
      }
    }
  }
  return null
}

function exitCode(error: ExecFileException): number {
  return typeof error.code === 'number' ? error.code : 1
}

/** Runs programs with argv, never through a shell, except cmd.exe for Windows command scripts. */
export function createProcessRunner(platform: NodeJS.Platform): Runner {
  return (command, args, options) => {
    const invocation =
      platform === 'win32'
        ? windowsInvocation(command, args, options.env.COMSPEC ?? 'cmd.exe')
        : { command, args }
    if (
      platform === 'win32' &&
      invocation !== null &&
      invocation.command !== command &&
      findWindowsCommand(command, options.env) === null
    ) {
      return Promise.resolve({ kind: 'not-found' })
    }
    if (invocation === null) {
      return Promise.resolve({
        kind: 'exited',
        code: 1,
        stdout: '',
        stderr: `refused to pass unusual arguments to ${command} through cmd.exe`
      })
    }
    return new Promise<RunResult>((resolve) => {
      const child = execFile(
        invocation.command,
        [...invocation.args],
        {
          env: options.env,
          timeout: options.timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: 'utf8',
          windowsHide: true
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ kind: 'exited', code: 0, stdout, stderr })
            return
          }
          if (error.code === 'ENOENT') {
            resolve({ kind: 'not-found' })
            return
          }
          if (error.killed) {
            resolve({
              kind: 'exited',
              code: 1,
              stdout,
              stderr: `${command} timed out after ${String(options.timeoutMs)} ms\n${stderr}`
            })
            return
          }
          const code = exitCode(error)
          resolve({ kind: 'exited', code, stdout, stderr })
        }
      )
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(options.input ?? '')
    })
  }
}
