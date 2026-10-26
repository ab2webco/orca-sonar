import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { DEFAULT_PREFERENCES } from '../src/core/preferences.ts'
import { BYTES_PER_TOKEN, GREP_LINE_CAP } from '../src/core/savings.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

interface Manifest {
  readonly [key: string]: unknown
  readonly contributes: {
    readonly panels: readonly { readonly icon: string; readonly entry: string }[]
  }
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(root, 'orca-plugin.json'), 'utf8')) as Manifest
}

test('orca-plugin.json declares the reserved ab2web.orca-sonar identity', () => {
  const plugin = manifest()

  assert.equal(plugin.manifestVersion, 1)
  assert.equal(plugin.pluginApi, 1)
  assert.equal(plugin.id, 'orca-sonar')
  assert.equal(plugin.publisher, 'ab2web')
  assert.deepEqual(plugin.engines, { orca: '>=1.4.160' })
})

test('orca-plugin.json wires the worker, both panels, the command, the events and the skill', () => {
  const plugin = manifest()

  assert.equal(plugin.main, 'main.mjs')
  assert.deepEqual(plugin.contributes, {
    panels: [
      {
        id: 'sonar-settings',
        title: 'Sonar',
        icon: 'icons/sonar.svg',
        entry: 'panels/settings.html',
        surface: 'settings'
      },
      {
        id: 'sonar-usage',
        title: 'Sonar',
        icon: 'icons/sonar.svg',
        entry: 'panels/usage.html',
        surface: 'nav'
      }
    ],
    commands: [{ id: 'sonar.refresh', title: 'Sonar: Refresh' }],
    events: [{ on: 'agent.status.changed' }, { on: 'worktree.created' }],
    skills: [{ path: 'skills/orca-sonar' }]
  })
  assert.deepEqual(plugin.capabilities, [
    { kind: 'process:spawn' },
    { kind: 'storage' },
    { kind: 'settings:own' },
    { kind: 'events:subscribe' },
    { kind: 'skills:contribute' }
  ])
})

test('every file the manifest points to ships with the plugin', () => {
  const plugin = manifest()
  const paths = [
    String(plugin.main),
    'bin/orca-sonar.ts',
    'skills/orca-sonar/SKILL.md',
    ...plugin.contributes.panels.flatMap((panel) => [panel.icon, panel.entry])
  ]
  for (const path of paths) {
    assert.equal(existsSync(join(root, path)), true, `${path} is missing`)
  }
})

test('the settings panel starts from the same switch defaults as the CLI', () => {
  const panel = readFileSync(join(root, 'panels', 'settings.html'), 'utf8')
  const match = /var DEFAULT_PREFERENCES = (\{[^}]*\})/.exec(panel)

  assert.ok(match?.[1], 'the panel declares DEFAULT_PREFERENCES')
  const declared = JSON.parse(match[1].replace(/(\w+):/g, '"$1":')) as unknown
  assert.deepEqual(declared, DEFAULT_PREFERENCES)
})

test('the skill names itself, stays small enough for Orca to serve and tells agents what to do when Sonar is off', () => {
  const skill = readFileSync(join(root, 'skills', 'orca-sonar', 'SKILL.md'), 'utf8')

  assert.match(skill, /^---\nname: orca-sonar\ndescription: .+\n---\n/)
  assert.ok(Buffer.byteLength(skill) < 256 * 1024)
  assert.match(skill, /Sonar is turned off for agents/)
  assert.match(skill, /Unknown command: sonar/)
})

test('the repository ships an MIT license held by Ab2Web', () => {
  const license = readFileSync(join(root, 'LICENSE'), 'utf8')

  assert.match(license, /^MIT License/)
  assert.match(license, /Copyright \(c\) \d{4} Ab2Web/)
})

test('the statistics panel states the same saving formula the CLI computes', () => {
  const panel = readFileSync(join(root, 'panels', 'usage.html'), 'utf8')

  assert.match(panel, new RegExp(`up to ${GREP_LINE_CAP.toLocaleString('en-US')} lines`))
  assert.match(panel, new RegExp(`hasta ${GREP_LINE_CAP.toLocaleString('es-ES')} líneas`))
  assert.equal(panel.split(`÷ ${String(BYTES_PER_TOKEN)} bytes`).length - 1, 2)
})
