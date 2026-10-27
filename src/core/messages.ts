import type { Locale } from './locale.ts'

/** Every user-facing sentence, in English and Spanish. Keys are English identifiers. */
const EN = {
  usage: [
    'Usage: orca-sonar <command> [options]',
    '',
    'Commands:',
    '  install            Create the index folder for this workspace',
    '  index              Bring the index up to date',
    '  status             Show what the index holds, without changing it',
    '  usage              Show how agents used Sonar in the last 30 days',
    '  find <words...>    Find lines that contain every word',
    '  symbol <name>      Find declarations with this exact name',
    '',
    'Options:',
    '  --root <path>      Workspace to use (default: current folder)',
    '  --limit <n>        Maximum results (default: 20)',
    '  --json             Print machine-readable output',
    '  --warmup           For index: skip when the owner switched the warm-up off',
    '  --stdin            For status: read one workspace root per line from stdin',
    '  -h, --help         Show this help'
  ].join('\n'),
  unknownCommand: 'Unknown command "{command}". Run with --help to see the commands.',
  unknownOption: 'Unknown option "{option}".',
  invalidLimit: '--limit must be a positive whole number.',
  queryRequired: 'Give at least one word to search for.',
  noMatches: 'No matches for "{query}".',
  installed: 'Index ready at {path}',
  indexed: 'Indexed {indexed} files, {unchanged} unchanged, {removed} removed.',
  status:
    'Index for {root}: {files} files, {symbols} symbols, last indexed {lastIndexedAt}, {size} bytes at {path}',
  statusMissing: 'No index yet for {root}. Run "orca-sonar index" to build it.',
  neverIndexed: 'unknown',
  usageSummary:
    '{queries} queries in the last 30 days ({find} find, {symbol} symbol), {results} results, {averageMs} ms on average. Estimated saving versus grep: {savedTokens} tokens ({savedBytes} bytes).',
  agentsOff:
    'Sonar is turned off for agents in Orca (Settings, Plugins, Sonar). Search with rg or grep instead.',
  warmupSkipped: 'Warm-up skipped: it is switched off in Sonar settings.',
  refreshBusy:
    'Another Sonar process is updating this index, so these results may miss the latest changes.',
  fts5Missing: 'This Node.js build has no SQLite FTS5 support. Use Node.js 24 or newer.',
  failed: 'Sonar failed: {message}'
} as const

export type MessageKey = keyof typeof EN

const ES: Record<MessageKey, string> = {
  usage: [
    'Uso: orca-sonar <comando> [opciones]',
    '',
    'Comandos:',
    '  install            Crea la carpeta de índice de este espacio de trabajo',
    '  index              Actualiza el índice',
    '  status             Muestra qué contiene el índice, sin modificarlo',
    '  usage              Muestra cómo usaron Sonar los agentes en los últimos 30 días',
    '  find <palabras...> Busca líneas que contengan todas las palabras',
    '  symbol <nombre>    Busca declaraciones con este nombre exacto',
    '',
    'Opciones:',
    '  --root <ruta>      Espacio de trabajo a usar (por defecto: carpeta actual)',
    '  --limit <n>        Máximo de resultados (por defecto: 20)',
    '  --json             Muestra salida legible por máquinas',
    '  --warmup           Para index: no hace nada si el precalentamiento está desactivado',
    '  --stdin            Para status: lee una raíz por línea desde la entrada estándar',
    '  -h, --help         Muestra esta ayuda'
  ].join('\n'),
  unknownCommand: 'Comando desconocido "{command}". Usa --help para ver los comandos.',
  unknownOption: 'Opción desconocida "{option}".',
  invalidLimit: '--limit debe ser un número entero positivo.',
  queryRequired: 'Indica al menos una palabra para buscar.',
  noMatches: 'Ninguna coincidencia para "{query}".',
  installed: 'Índice listo en {path}',
  indexed: 'Archivos indexados: {indexed}, sin cambios: {unchanged}, eliminados: {removed}.',
  status:
    'Índice de {root}: {files} archivos, {symbols} símbolos, última indexación {lastIndexedAt}, {size} bytes en {path}',
  statusMissing: 'Aún no hay índice para {root}. Ejecuta "orca-sonar index" para crearlo.',
  neverIndexed: 'desconocida',
  usageSummary:
    '{queries} consultas en los últimos 30 días ({find} find, {symbol} symbol), {results} resultados, {averageMs} ms en promedio. Ahorro estimado frente a grep: {savedTokens} tokens ({savedBytes} bytes).',
  agentsOff:
    'Sonar está desactivado para los agentes en Orca (Ajustes, Plugins, Sonar). Busca con rg o grep.',
  warmupSkipped: 'Precalentamiento omitido: está desactivado en los ajustes de Sonar.',
  refreshBusy:
    'Otro proceso de Sonar está actualizando este índice, así que estos resultados pueden no incluir los cambios más recientes.',
  fts5Missing: 'Esta versión de Node.js no incluye SQLite FTS5. Usa Node.js 24 o más reciente.',
  failed: 'Sonar falló: {message}'
}

const CATALOGS: Readonly<Record<Locale, Record<MessageKey, string>>> = { en: EN, es: ES }

export const MESSAGE_KEYS: readonly MessageKey[] = Object.keys(EN) as MessageKey[]

export type MessageValues = Readonly<Record<string, string | number>>

/** Fills `{name}` placeholders. A placeholder without a value is left visible. */
export function translate(locale: Locale, key: MessageKey, values: MessageValues = {}): string {
  return CATALOGS[locale][key].replace(/\{(\w+)\}/g, (placeholder: string, name: string) => {
    const value = values[name]
    return value === undefined ? placeholder : String(value)
  })
}
