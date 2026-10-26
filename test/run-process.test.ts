import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProcessRunner, windowsInvocation } from '../src/plugin/run-process.ts'

const run = createProcessRunner(process.platform)
const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT }

test('a program that exits reports its code and output', async () => {
  const result = await run(
    process.execPath,
    ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'],
    { env, timeoutMs: 10_000 }
  )

  assert.deepEqual(result, { kind: 'exited', code: 3, stdout: 'out', stderr: 'err' })
})

test('a program that is not on PATH is reported as not found', async () => {
  const result = await run('orca-sonar-no-such-program', ['--help'], { env, timeoutMs: 10_000 })

  assert.deepEqual(result, { kind: 'not-found' })
})

test('a program that runs past its timeout is stopped and reported as failed', async () => {
  const result = await run(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
    env,
    timeoutMs: 200
  })

  if (result.kind !== 'exited') {
    assert.fail('a timed-out program still exits')
  }
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /timed out/)
})

test('on Windows a command script runs through cmd.exe only with plain arguments', () => {
  assert.deepEqual(
    windowsInvocation('orca', ['worktree', 'list', '--json'], 'C:\\Windows\\cmd.exe'),
    {
      command: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/s', '/c', 'orca', 'worktree', 'list', '--json']
    }
  )
  assert.deepEqual(windowsInvocation('node', ['C:\\p\\bin\\orca-sonar.ts', 'status'], 'cmd.exe'), {
    command: 'node',
    args: ['C:\\p\\bin\\orca-sonar.ts', 'status']
  })
  assert.equal(windowsInvocation('orca', ['a&b'], 'cmd.exe'), null)
})

test('input is written to the program on standard input', async () => {
  const result = await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
    env,
    timeoutMs: 10_000,
    input: 'one\ntwo\n'
  })

  assert.deepEqual(result, { kind: 'exited', code: 0, stdout: 'one\ntwo\n', stderr: '' })
})
