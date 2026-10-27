import { LINE_SPAN, type IndexStore } from './index-store.ts'

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

/** Inlined: a bound number is a REAL, and REAL division never yields a file id. */
const SPAN = String(LINE_SPAN)

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
      `SELECT files.path AS path, m.rowid % ${SPAN} AS line, m.text AS text
         FROM (SELECT rowid, text, bm25(lines_fts) AS score FROM lines_fts
                WHERE lines_fts MATCH ?
                ORDER BY score
                LIMIT ?) AS m
         JOIN files ON files.id = m.rowid / ${SPAN}
        ORDER BY m.score, m.rowid`,
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
      `SELECT files.path AS path, symbols.line AS line, symbols.name AS name, symbols.kind AS kind
         FROM symbols_fts
         JOIN symbols ON symbols.id = symbols_fts.rowid
         JOIN files ON files.id = symbols.file_id
        WHERE symbols_fts MATCH ? AND symbols.name = ? COLLATE NOCASE
        ORDER BY files.path, symbols.line
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
