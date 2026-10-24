import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractSymbols } from '../src/core/symbols.ts'

test('finds functions, classes, interfaces, types and enums in TypeScript', () => {
  const lines = [
    'export default async function loadUser(id: string) {',
    'export class UserStore {',
    'export interface UserRecord {',
    'type UserId = string',
    'export enum Role {',
    'export const formatName = (first: string, last: string): string => `${first} ${last}`',
    'const handler = async (event) => event'
  ]

  const symbols = extractSymbols('src/users.ts', lines)

  assert.deepEqual(symbols, [
    { path: 'src/users.ts', name: 'loadUser', kind: 'function', line: 1 },
    { path: 'src/users.ts', name: 'UserStore', kind: 'class', line: 2 },
    { path: 'src/users.ts', name: 'UserRecord', kind: 'interface', line: 3 },
    { path: 'src/users.ts', name: 'UserId', kind: 'type', line: 4 },
    { path: 'src/users.ts', name: 'Role', kind: 'enum', line: 5 },
    { path: 'src/users.ts', name: 'formatName', kind: 'function', line: 6 },
    { path: 'src/users.ts', name: 'handler', kind: 'function', line: 7 }
  ])
})

test('does not mistake an assignment to a variable named type for a symbol', () => {
  const symbols = extractSymbols('src/state.js', ['type = "idle"', 'let type2 = 1'])

  assert.deepEqual(symbols, [])
})

test('finds functions and classes in Python, including methods', () => {
  const lines = ['class Parser:', '    def parse_file(self, path):', 'async def main():']

  const symbols = extractSymbols('tools/parse.py', lines)

  assert.deepEqual(symbols, [
    { path: 'tools/parse.py', name: 'Parser', kind: 'class', line: 1 },
    { path: 'tools/parse.py', name: 'parse_file', kind: 'function', line: 2 },
    { path: 'tools/parse.py', name: 'main', kind: 'function', line: 3 }
  ])
})

test('returns no symbols for languages without a rule', () => {
  assert.deepEqual(extractSymbols('docs/readme.md', ['function looksLikeCode() {}']), [])
})
