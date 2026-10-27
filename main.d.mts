import type { Host } from './src/plugin/worker.ts'

/** The slice of Orca's worker API (`activate(orca)`) this plugin uses. */
export interface OrcaWorkerApi {
  readonly commands: {
    register(commandId: string, handler: (args: unknown) => unknown): void
  }
  readonly events: {
    on(event: string, handler: (payload: unknown) => unknown): void
  }
  readonly host: Host
  log(message: string): void
}

export default function activate(orca: OrcaWorkerApi): void
