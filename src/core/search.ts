import type { IndexStore } from './index-store.ts'

export interface LineMatch {
  readonly path: string
  /** 1-based. */
  readonly line: number
  readonly text: string
}

export interface SymbolMatch {
  readonly path: string
  /** 1-based. */
  readonly line: number
  readonly name: string
  readonly kind: string
}

const WORD = /[\p{L}\p{N}_$]+/gu

/**
 * Turns free text into an FTS5 expression where every word must match. Only
 * words are kept, so quotes, operators and parentheses are never parsed as
 * query syntax. Returns null when the query has no words.
 */
export function matchExpression(query: string): string | null {
  const words = query.match(WORD) ?? []
  return words.length > 0 ? words.map((word) => `"${word}"`).join(' ') : null
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function findLines(index: IndexStore, query: string, limit: number): LineMatch[] {
  const expression = matchExpression(query)
  if (expression === null) {
    return []
  }
  return index
    .all(
      `SELECT lines.path AS path, lines.line_no AS line, lines.text AS text
         FROM lines_fts JOIN lines ON lines.id = lines_fts.rowid
        WHERE lines_fts MATCH ?
        ORDER BY bm25(lines_fts)
        LIMIT ?`,
      [expression, limit]
    )
    .map((row) => ({ path: asText(row.path), line: Number(row.line), text: asText(row.text) }))
}

export function findSymbols(index: IndexStore, name: string, limit: number): SymbolMatch[] {
  const expression = matchExpression(name)
  if (expression === null) {
    return []
  }
  return index
    .all(
      `SELECT symbols.path AS path, symbols.line AS line, symbols.name AS name, symbols.kind AS kind
         FROM symbols_fts JOIN symbols ON symbols.id = symbols_fts.rowid
        WHERE symbols_fts MATCH ? AND symbols.name = ? COLLATE NOCASE
        ORDER BY symbols.path, symbols.line
        LIMIT ?`,
      [expression, name.trim(), limit]
    )
    .map((row) => ({
      path: asText(row.path),
      line: Number(row.line),
      name: asText(row.name),
      kind: asText(row.kind)
    }))
}
