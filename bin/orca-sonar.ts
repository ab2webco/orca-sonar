#!/usr/bin/env node
import { homedir } from 'node:os'
import { runCli } from '../src/cli/run.ts'

const exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  platform: process.platform,
  home: homedir(),
  cwd: process.cwd(),
  systemLocale: Intl.DateTimeFormat().resolvedOptions().locale,
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  }
})

process.exitCode = exitCode
