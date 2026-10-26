import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MESSAGE_KEYS, translate } from '../src/core/messages.ts'

test('every message exists in Spanish and English', () => {
  for (const key of MESSAGE_KEYS) {
    assert.notEqual(translate('en', key), key)
    assert.notEqual(translate('es', key), key)
  }
})

test('placeholders are filled from the values passed in', () => {
  assert.equal(translate('en', 'noMatches', { query: 'parseFile' }), 'No matches for "parseFile".')
  assert.equal(
    translate('es', 'noMatches', { query: 'parseFile' }),
    'Ninguna coincidencia para "parseFile".'
  )
})

test('a placeholder without a value stays visible instead of disappearing', () => {
  assert.equal(translate('en', 'noMatches'), 'No matches for "{query}".')
})
