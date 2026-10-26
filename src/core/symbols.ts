import { extname } from 'node:path'

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum'

export interface CodeSymbol {
  readonly path: string
  readonly name: string
  readonly kind: SymbolKind
  /** 1-based line of the declaration. */
  readonly line: number
}

interface Rule {
  readonly pattern: RegExp
  readonly kind: SymbolKind
}

const IDENTIFIER = '([A-Za-z_$][\\w$]*)'

/**
 * Line-based declaration rules. They are a heuristic, not a parser: they find
 * declarations that start a line, which is how most code is written, and they
 * never read the code around a match.
 */
const SCRIPT_RULES: readonly Rule[] = [
  {
    pattern: new RegExp(
      `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${IDENTIFIER}`
    ),
    kind: 'function'
  },
  {
    pattern: new RegExp(
      `^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${IDENTIFIER}`
    ),
    kind: 'class'
  },
  {
    pattern: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?interface\\s+${IDENTIFIER}`),
    kind: 'interface'
  },
  {
    pattern: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+${IDENTIFIER}`),
    kind: 'type'
  },
  {
    pattern: new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+${IDENTIFIER}`),
    kind: 'enum'
  },
  {
    pattern: new RegExp(
      `^\\s*(?:export\\s+)?const\\s+${IDENTIFIER}\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=>`
    ),
    kind: 'function'
  }
]

const PYTHON_RULES: readonly Rule[] = [
  { pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function' },
  { pattern: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class' }
]

const SCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'])

function rulesFor(path: string): readonly Rule[] {
  const extension = extname(path).toLowerCase()
  if (SCRIPT_EXTENSIONS.has(extension)) {
    return SCRIPT_RULES
  }
  if (extension === '.py') {
    return PYTHON_RULES
  }
  return []
}

export function extractSymbols(path: string, lines: readonly string[]): CodeSymbol[] {
  const rules = rulesFor(path)
  const symbols: CodeSymbol[] = []

  lines.forEach((text, offset) => {
    for (const rule of rules) {
      const name = rule.pattern.exec(text)?.[1]
      if (name !== undefined) {
        symbols.push({ path, name, kind: rule.kind, line: offset + 1 })
        return
      }
    }
  })

  return symbols
}
