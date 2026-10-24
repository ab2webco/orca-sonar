import assert from 'node:assert/strict'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { indexFilePath, resolveUserDataDir } from '../src/core/index-location.ts'

test('uses ORCA_USER_DATA_PATH when Orca exports it', () => {
  const dir = resolveUserDataDir({ ORCA_USER_DATA_PATH: '/data/orca' }, 'linux', '/home/ana')

  assert.equal(dir, '/data/orca')
})

test('uses Application Support on macOS when no override is set', () => {
  const dir = resolveUserDataDir({}, 'darwin', '/Users/ana')

  assert.equal(dir, join('/Users/ana', 'Library', 'Application Support', 'orca'))
})

test('uses APPDATA on Windows and falls back to the roaming folder', () => {
  assert.equal(
    resolveUserDataDir({ APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' }, 'win32', 'C:\\Users\\ana'),
    join('C:\\Users\\ana\\AppData\\Roaming', 'orca')
  )
  assert.equal(
    resolveUserDataDir({}, 'win32', 'C:\\Users\\ana'),
    join('C:\\Users\\ana', 'AppData', 'Roaming', 'orca')
  )
})

test('uses XDG_CONFIG_HOME on Linux and falls back to ~/.config', () => {
  assert.equal(
    resolveUserDataDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/ana'),
    join('/xdg', 'orca')
  )
  assert.equal(resolveUserDataDir({}, 'linux', '/home/ana'), join('/home/ana', '.config', 'orca'))
})

test('keeps the index under the plugin data folder, keyed by repo and root', () => {
  const path = indexFilePath({
    userDataDir: '/data/orca',
    repoId: 'repo-1',
    rootKey: 'root-1'
  })

  assert.equal(
    path,
    join('/data/orca', 'plugins-data', 'ab2web.orca-sonar', 'index', 'repo-1', 'root-1.sqlite')
  )
  assert.equal(path.split(sep).includes('.git'), false)
})
