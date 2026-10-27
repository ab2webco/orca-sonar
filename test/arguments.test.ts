import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseInvocation, UsageError } from '../src/cli/arguments.ts'

test('reads the command, its words and the shared options', () => {
  assert.deepEqual(parseInvocation(['find', 'parse', 'file', '--json', '--limit', '5']), {
    command: 'find',
    positionals: ['parse', 'file'],
    json: true,
    root: undefined,
    limit: 5,
    warmup: false,
    stdin: false
  })
})

test('reads --root and defaults to no command options', () => {
  assert.deepEqual(parseInvocation(['index', '--root', '/work/repo']), {
    command: 'index',
    positionals: [],
    json: false,
    root: '/work/repo',
    limit: undefined,
    warmup: false,
    stdin: false
  })
})

test('reads --warmup for a background index', () => {
  assert.equal(parseInvocation(['index', '--warmup']).warmup, true)
})

test('no arguments and --help both ask for the usage text', () => {
  assert.equal(parseInvocation([]).command, 'help')
  assert.equal(parseInvocation(['--help']).command, 'help')
})

test('an unknown command is a usage error that names the command', () => {
  assert.throws(
    () => parseInvocation(['grep', 'x']),
    (error: unknown) =>
      error instanceof UsageError &&
      error.code === 'unknown_command' &&
      error.values.command === 'grep'
  )
})

test('a limit must be a positive whole number', () => {
  for (const limit of ['0', '-3', '2.5', 'many']) {
    assert.throws(
      () => parseInvocation(['find', 'x', '--limit', limit]),
      (error: unknown) => error instanceof UsageError && error.code === 'invalid_limit'
    )
  }
})

test('an unknown option is a usage error', () => {
  assert.throws(
    () => parseInvocation(['find', 'x', '--fast']),
    (error: unknown) => error instanceof UsageError && error.code === 'unknown_option'
  )
})
