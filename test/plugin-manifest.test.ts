import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8')) as unknown
}

test('orca-plugin.json declares the reserved ab2web.orca-sonar identity', () => {
  const manifest = readJson('orca-plugin.json') as Record<string, unknown>

  assert.equal(manifest.manifestVersion, 1)
  assert.equal(manifest.pluginApi, 1)
  assert.equal(manifest.id, 'orca-sonar')
  assert.equal(manifest.publisher, 'ab2web')
  assert.deepEqual(manifest.engines, { orca: '>=1.4.0' })
})

test('orca-plugin.json contributes nothing that is not wired yet', () => {
  const manifest = readJson('orca-plugin.json') as Record<string, unknown>

  assert.equal('main' in manifest, false)
  assert.equal('contributes' in manifest, false)
  assert.deepEqual(manifest.capabilities, [])
})

test('the repository ships an MIT license held by Ab2Web', () => {
  const license = readFileSync(join(root, 'LICENSE'), 'utf8')

  assert.match(license, /^MIT License/)
  assert.match(license, /Copyright \(c\) \d{4} Ab2Web/)
})
