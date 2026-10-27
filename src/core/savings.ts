import { LINE_SPAN, type IndexStore } from './index-store.ts'
import { matchExpression } from './search.ts'

/**
 * The saving Sonar estimates for one lookup, against an agent that runs grep
 * for the same words and then opens the files holding the results:
 *
 *   baseline = grep output + bytes of the files holding Sonar's results
 *   saving   = max(0, baseline - Sonar's output)
 *   tokens   = saving / 4
 *
 * grep output is counted as `path:line:text` plus a newline per matching line,
 * up to GREP_LINE_CAP lines, so a very common word is never under-reported as
 * slow and the estimate stays on the low side. It is an estimate, and the
 * panel says so next to this formula.
 */
/** Inlined: a bound number is a REAL, and REAL division never yields a file id. */
const SPAN = String(LINE_SPAN)

export const GREP_LINE_CAP = 2000

/** A common rule of thumb for code and English text. */
export const BYTES_PER_TOKEN = 4

export interface QueryBytes {
  readonly outputBytes: number
  readonly grepBytes: number
  readonly readBytes: number
}

export interface Saving {
  readonly baselineBytes: number
  readonly savedBytes: number
  readonly savedTokens: number
}

/** Bytes grep would print for lines holding every word of `query`. */
export function grepOutputBytes(index: IndexStore, query: string, cap = GREP_LINE_CAP): number {
  const expression = matchExpression(query)
  if (expression === null) {
    return 0
  }
  const [row] = index.all(
    `SELECT COALESCE(SUM(
              LENGTH(CAST(f.path AS BLOB)) + LENGTH(CAST(m.rowid % ${SPAN} AS TEXT)) +
              LENGTH(CAST(m.text AS BLOB)) + 3), 0) AS bytes
       FROM (SELECT rowid, text FROM lines_fts WHERE lines_fts MATCH ? LIMIT ?) AS m
       JOIN files AS f ON f.id = m.rowid / ${SPAN}`,
    [expression, cap]
  )
  return Number(row?.bytes ?? 0)
}

/** Bytes of the distinct files an agent would open to see these results. */
export function readBytes(index: IndexStore, paths: readonly string[]): number {
  let total = 0
  for (const path of new Set(paths)) {
    const [row] = index.all('SELECT size FROM files WHERE path = ?', [path])
    total += Number(row?.size ?? 0)
  }
  return total
}

export function estimateSaving(bytes: QueryBytes): Saving {
  const baselineBytes = bytes.grepBytes + bytes.readBytes
  const savedBytes = Math.max(0, baselineBytes - bytes.outputBytes)
  return { baselineBytes, savedBytes, savedTokens: Math.round(savedBytes / BYTES_PER_TOKEN) }
}
