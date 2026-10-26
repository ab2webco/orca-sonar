import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { replaceFile } from '../src/core/index-files.ts'
import { openIndex, type IndexStore } from '../src/core/index-store.ts'
import { findLines, findSymbols } from '../src/core/search.ts'
import { extractSymbols } from '../src/core/symbols.ts'

let base: string
let index: IndexStore

function seed(path: string, lines: readonly string[]): void {
  replaceFile(index, { path, mtimeMs: 1, size: 1 }, lines, extractSymbols(path, lines))
}

before(() => {
  base = mkdtempSync(join(tmpdir(), 'orca-sonar-search-'))
  index = openIndex(join(base, 'index.sqlite'))
  seed('src/billing.ts', [
    'export function chargeCustomer(id: string) {',
    '  return chargeCustomer(id, "retry")',
    '}'
  ])
  seed('src/receipts.ts', ['export const receiptTotal = 42', 'const note = "charge later"'])
  seed('tools/parse.py', ['def parse_file(path):', '    return path'])
})

after(() => {
  index.close()
  rmSync(base, { recursive: true, force: true })
})

test('find returns each matching line with its file and line number', () => {
  const matches = findLines(index, 'receipttotal', 10)

  assert.deepEqual(matches, [
    { path: 'src/receipts.ts', line: 1, text: 'export const receiptTotal = 42' }
  ])
})

test('find requires every word of the query to appear on the line', () => {
  const matches = findLines(index, 'chargeCustomer retry', 10)

  assert.deepEqual(
    matches.map((match) => `${match.path}:${String(match.line)}`),
    ['src/billing.ts:2']
  )
})

test('find treats quotes and operators in the query as plain text', () => {
  assert.deepEqual(findLines(index, 'NOT "chargeCustomer" OR (', 10), [])
})

test('find respects the limit and returns nothing for an empty query', () => {
  assert.equal(findLines(index, 'charge', 1).length, 1)
  assert.deepEqual(findLines(index, '   ', 10), [])
})

test('symbol finds declarations by exact name, ignoring case', () => {
  const matches = findSymbols(index, 'CHARGECUSTOMER', 10)

  assert.deepEqual(matches, [
    { path: 'src/billing.ts', line: 1, name: 'chargeCustomer', kind: 'function' }
  ])
})

test('symbol does not return a longer name that only contains the query', () => {
  assert.deepEqual(findSymbols(index, 'parse', 10), [])
  assert.deepEqual(findSymbols(index, 'parse_file', 10), [
    { path: 'tools/parse.py', line: 1, name: 'parse_file', kind: 'function' }
  ])
})
