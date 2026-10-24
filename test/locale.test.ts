import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { resolveLocale } from '../src/core/locale.ts'

let userDataDir: string

before(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-sonar-locale-'))
})

after(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

function writeSettings(uiLanguage: string): void {
  writeFileSync(join(userDataDir, 'orca-data.json'), JSON.stringify({ settings: { uiLanguage } }))
}

test('an explicit Spanish or English setting wins over the system locale', () => {
  writeSettings('es')
  assert.equal(resolveLocale(userDataDir, 'en-US'), 'es')

  writeSettings('en')
  assert.equal(resolveLocale(userDataDir, 'es-MX'), 'en')
})

test('the system setting follows the operating system locale', () => {
  writeSettings('system')

  assert.equal(resolveLocale(userDataDir, 'es-419'), 'es')
  assert.equal(resolveLocale(userDataDir, 'de-DE'), 'en')
})

test('a plugin language falls back to English', () => {
  writeSettings('plugin:acme.pack')

  assert.equal(resolveLocale(userDataDir, 'es-ES'), 'en')
})

test('a missing or unreadable settings file falls back to the system locale', () => {
  const empty = join(userDataDir, 'empty')
  mkdirSync(empty)

  assert.equal(resolveLocale(empty, 'es-AR'), 'es')

  writeFileSync(join(empty, 'orca-data.json'), '{ not json')
  assert.equal(resolveLocale(empty, 'fr-FR'), 'en')
})
