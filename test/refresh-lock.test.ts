import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { tryRefreshLock, waitForRefreshLock } from '../src/core/refresh-lock.ts'

function indexPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-sonar-lock-'))
  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return join(dir, 'index.sqlite')
}

/** A pid no process holds: above every platform's limit. */
const DEAD_PID = 2 ** 31 - 1

test('only one holder at a time, and a released lock can be taken again', () => {
  const path = indexPath()

  const first = tryRefreshLock(path)
  assert.ok(first)
  assert.equal(tryRefreshLock(path), null)

  first.release()
  const second = tryRefreshLock(path)
  assert.ok(second)
  second.release()
})

test('a lock left by a process that is gone is taken over', () => {
  const path = indexPath()
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: DEAD_PID, at: Date.now() }))

  const lock = tryRefreshLock(path)

  assert.ok(lock)
  lock.release()
})

test('a lock older than the longest refresh is taken over', () => {
  const path = indexPath()
  const anHourAgo = Date.now() - 60 * 60_000
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, at: anHourAgo }))

  const lock = tryRefreshLock(path)

  assert.ok(lock)
  lock.release()
})

test('an empty lock file is busy while fresh and taken over once its writer is clearly gone', () => {
  const path = indexPath()
  writeFileSync(`${path}.lock`, '')
  assert.equal(tryRefreshLock(path), null)

  const aMinuteAgo = new Date(Date.now() - 60_000)
  utimesSync(`${path}.lock`, aMinuteAgo, aMinuteAgo)
  const lock = tryRefreshLock(path)

  assert.ok(lock)
  lock.release()
})

test('waiting gets the lock as soon as its holder releases it', async () => {
  const path = indexPath()
  const holder = tryRefreshLock(path)
  assert.ok(holder)
  setTimeout(() => {
    holder.release()
  }, 100)

  const lock = await waitForRefreshLock(path, { timeoutMs: 5000, pollMs: 20 })

  lock.release()
})

test('waiting gives up after the timeout', async () => {
  const path = indexPath()
  const holder = tryRefreshLock(path)
  assert.ok(holder)

  await assert.rejects(waitForRefreshLock(path, { timeoutMs: 100, pollMs: 20 }), /in use/)

  holder.release()
})
