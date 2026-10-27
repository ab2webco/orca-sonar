/**
 * Example data for the panel screenshots. Every name and path here is made up
 * on purpose: the screenshots are shown to people, and real workspace names
 * can be client names.
 */
export type Language = 'en' | 'es'

export interface Scenario {
  readonly name: string
  readonly panel: 'settings.html' | 'usage.html'
  /** Plugin storage as the worker left it. */
  readonly storage: Readonly<Record<string, unknown>>
  readonly context?: unknown
  /** A script that turns true once the panel has rendered its data. */
  readonly ready: string
  /** CSS selectors clicked in order before the screenshot. */
  readonly clicks?: readonly string[]
  /** A script that turns true once the clicks took effect; without it the runner waits briefly. */
  readonly settled?: string
  /**
   * Whether this Orca lets a panel run its plugin's commands. When it does, `sonar.refresh` acts
   * like the worker: every pending rebuild request starts running.
   */
  readonly runsCommands?: boolean
  /** Text that must be visible, per language. */
  readonly expect: Readonly<Record<Language, readonly string[]>>
  /** Text that must not be visible, in either language. */
  readonly absent?: readonly string[]
  /** Checks what the panel wrote to storage; returns a problem or null. */
  readonly checkWritten?: (written: unknown) => string | null
  /** Photographed at every width and theme; the others only at the extremes. */
  readonly full?: boolean
}

const MINUTE = 60_000
const now = Date.now()
const ago = (minutes: number): string => new Date(now - minutes * MINUTE).toISOString()
const DATA = '/Users/dev/Library/Application Support/orca/plugins-data/ab2web.orca-sonar/index'

function indexOf(files: number, minutesAgo: number, key: string): Record<string, unknown> {
  return {
    exists: true,
    indexPath: `${DATA}/${key}.sqlite`,
    files,
    symbols: files * 4,
    lastIndexedAt: ago(minutesAgo),
    sizeBytes: files * 51_000
  }
}

const WORKSPACES = [
  {
    root: '/Users/dev/work/checkout-service',
    displayName: 'checkout-service',
    branch: 'feature/cart-totals',
    index: indexOf(1840, 12, 'a1/b1')
  },
  {
    root: '/Users/dev/work/design-system',
    displayName: 'design-system',
    branch: 'main',
    index: indexOf(16993, 180, 'a2/b2')
  },
  {
    root: '/Users/dev/work/mobile-app',
    displayName: 'mobile-app',
    branch: 'release/4.2',
    index: indexOf(5210, 60 * 26, 'a3/b3')
  },
  {
    root: '/Users/dev/work/billing-api',
    displayName: 'billing-api',
    branch: 'fix/invoice-rounding'
  },
  { root: '/Users/dev/work/docs-site', displayName: 'docs-site', branch: '' },
  {
    root: '/Users/dev/work/search-worker',
    displayName: 'search-worker',
    branch: 'spike/embeddings'
  },
  {
    root: '/Users/dev/work/analytics',
    displayName: 'analytics',
    branch: 'main',
    error: 'EACCES: permission denied, scandir'
  },
  { root: '/Users/dev/work/infra', displayName: 'infra', branch: 'chore/terraform-1.9' },
  {
    root: '/Users/dev/work/a-very-long-workspace-name-that-keeps-going-on-and-on',
    displayName: 'a-very-long-workspace-name-that-keeps-going-on-and-on',
    branch: 'feature/an-equally-long-branch-name-for-wrapping'
  }
]

function state(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    checkedAt: ago(1),
    sonarCommand: 'missing',
    workspaces: WORKSPACES,
    ...extra
  }
}

const SETTINGS_READY = "document.getElementById('agents').disabled === false"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'settings',
    panel: 'settings.html',
    full: true,
    storage: {
      state: state(),
      preferences: { agents: true, warmup: false },
      rebuilds: {
        '/Users/dev/work/checkout-service': {
          state: 'done',
          startedAt: ago(13),
          finishedAt: ago(12)
        },
        '/Users/dev/work/billing-api': {
          state: 'failed',
          startedAt: ago(5),
          finishedAt: ago(5),
          error: 'Sonar failed: database is locked'
        }
      }
    },
    ready: SETTINGS_READY,
    expect: {
      en: [
        'Sonar for agents',
        'Agents can use Sonar',
        '3 of 9 local workspaces have an index',
        '1,840 files',
        'No index yet',
        'Failed: Sonar failed: database is locked',
        'Could not read: EACCES',
        'does not include the orca sonar command'
      ],
      es: [
        'Sonar para los agentes',
        'Los agentes pueden usar Sonar',
        '3 de 9 espacios de trabajo locales tienen índice',
        '1840 archivos',
        'Aún sin índice',
        'Falló: Sonar failed: database is locked',
        'No se pudo leer: EACCES',
        'no incluye el comando orca sonar'
      ]
    }
  },
  {
    name: 'settings-switch-off',
    panel: 'settings.html',
    storage: { state: state({ sonarCommand: 'available' }) },
    ready: SETTINGS_READY,
    clicks: ['#agents'],
    expect: {
      en: ['Saved. The next orca sonar command follows it.'],
      es: ['Guardado. El próximo comando orca sonar lo respeta.']
    },
    absent: ['does not include the orca sonar command', 'no incluye el comando orca sonar'],
    checkWritten: (written) =>
      JSON.stringify(written) === JSON.stringify({ preferences: { agents: false, warmup: true } })
        ? null
        : `wrote ${JSON.stringify(written)}, expected agents off with the warm-up default`
  },
  {
    name: 'settings-rebuild-now',
    panel: 'settings.html',
    storage: { state: state() },
    ready: SETTINGS_READY,
    runsCommands: true,
    clicks: ['#list li:first-child button'],
    settled: 'window.__ran === true',
    expect: {
      en: ['Rebuilding…'],
      es: ['Reconstruyendo…']
    },
    absent: ['Queued: runs on the next agent activity', 'En cola: se ejecuta']
  },
  {
    name: 'settings-rebuild-queued',
    panel: 'settings.html',
    storage: { state: state() },
    ready: SETTINGS_READY,
    clicks: ['#list li:first-child button'],
    expect: {
      en: ['Queued: runs on the next agent activity'],
      es: ['En cola: se ejecuta con la próxima actividad']
    },
    checkWritten: (written) => {
      const entries = isRecord(written) ? Object.entries(written) : []
      const [entry] = entries
      const value = entry?.[1]
      return entries.length === 1 &&
        entry?.[0].startsWith('rebuild:') === true &&
        isRecord(value) &&
        value.root === '/Users/dev/work/checkout-service' &&
        typeof value.at === 'string'
        ? null
        : `wrote ${JSON.stringify(written)}, expected one rebuild request for checkout-service`
    }
  },
  {
    name: 'settings-never-checked',
    panel: 'settings.html',
    storage: {},
    ready: SETTINGS_READY,
    expect: {
      en: ['Not checked yet', 'Sonar: Refresh'],
      es: ['Aún sin comprobar', 'Sonar: Refresh']
    },
    absent: ['does not include the orca sonar command', 'no incluye el comando orca sonar']
  },
  {
    name: 'settings-orca-missing',
    panel: 'settings.html',
    storage: { state: state({ problem: 'orca-cli-missing', workspaces: [] }) },
    ready: SETTINGS_READY,
    expect: { en: ['not on PATH for plugins'], es: ['no está en el PATH de los plugins'] },
    absent: [
      'Orca lists no local workspaces',
      'Orca no lista espacios',
      '0 of 0',
      '0 de 0',
      'workspaces: 0',
      'locales: 0'
    ]
  },
  {
    name: 'settings-node-missing',
    panel: 'settings.html',
    storage: {
      state: state({
        problem: 'node-missing',
        workspaces: WORKSPACES.map(({ root, displayName, branch }) => ({
          root,
          displayName,
          branch
        }))
      })
    },
    ready: SETTINGS_READY,
    expect: {
      en: ['Node.js 24 or newer', 'Local workspaces: 9.'],
      es: ['Node.js 24 o más reciente', 'Espacios de trabajo locales: 9.']
    },
    absent: ['0 of 9', '0 de 9', 'No index yet', 'Aún sin índice']
  },
  {
    name: 'settings-error',
    panel: 'settings.html',
    storage: {
      state: state({
        problem: 'error',
        error: 'Sonar failed: unable to open database file',
        workspaces: []
      })
    },
    ready: SETTINGS_READY,
    expect: {
      en: ['Could not read the index status: Sonar failed: unable to open database file'],
      es: ['No se pudo leer el estado de los índices']
    }
  }
]

function localDay(offset: number): string {
  const date = new Date(now)
  date.setDate(date.getDate() - offset)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/** A month of made-up lookups: quiet weekends, a busy last week. */
const DAYS = Array.from({ length: 30 }, (_, n) => {
  const offset = 29 - n
  const weekend = [0, 6].includes(new Date(now - offset * 86_400_000).getDay())
  const find = weekend ? n % 3 : 8 + ((n * 7) % 13) + (offset < 7 ? 14 : 0)
  return { day: localDay(offset), find, symbol: weekend ? 0 : 3 + ((n * 5) % 7) }
})
const FIND = DAYS.reduce((sum, day) => sum + day.find, 0)
const SYMBOL = DAYS.reduce((sum, day) => sum + day.symbol, 0)

const USAGE = {
  command: 'usage',
  since: ago(60 * 24 * 40),
  days: DAYS,
  totals: {
    queries: FIND + SYMBOL,
    find: FIND,
    symbol: SYMBOL,
    results: (FIND + SYMBOL) * 11,
    averageMs: 183.4,
    outputBytes: 1_412_000,
    baselineBytes: 96_830_000,
    savedBytes: 95_418_000,
    savedTokens: 23_854_500
  },
  workspacesQueried: 7,
  workspacesIndexed: 12
}

const USAGE_READY =
  "!document.getElementById('message').hidden || !document.getElementById('tiles').hidden"

export const USAGE_SCENARIOS: readonly Scenario[] = [
  {
    name: 'usage',
    panel: 'usage.html',
    full: true,
    storage: { usage: USAGE, state: { checkedAt: ago(2) } },
    ready: USAGE_READY,
    expect: {
      en: [
        'Sonar usage',
        'Queries',
        '183 ms',
        'Workspaces indexed',
        '7 queried',
        'Tokens saved, estimated',
        '23.9M',
        'Queries per day',
        'counting up to 2,000 lines',
        'not a measurement'
      ],
      es: [
        'Uso de Sonar',
        'Consultas',
        '183 ms',
        'Espacios de trabajo indexados',
        '7 consultados',
        'Tokens ahorrados, estimado',
        '23,9\u00a0M',
        'Consultas por día',
        'contando hasta 2000 líneas',
        'no una medición'
      ]
    }
  },
  {
    name: 'usage-tooltip',
    panel: 'usage.html',
    storage: { usage: USAGE, state: { checkedAt: ago(2) } },
    ready: USAGE_READY,
    clicks: ['#plot .day:nth-child(30)'],
    expect: {
      en: [`: ${String(DAYS[29]?.find)} find, ${String(DAYS[29]?.symbol)} symbol`],
      es: [`: ${String(DAYS[29]?.find)} find, ${String(DAYS[29]?.symbol)} symbol`]
    }
  },
  {
    name: 'usage-no-queries',
    panel: 'usage.html',
    storage: {
      usage: {
        ...USAGE,
        days: DAYS.map(({ day }) => ({ day, find: 0, symbol: 0 })),
        totals: {
          ...USAGE.totals,
          queries: 0,
          find: 0,
          symbol: 0,
          results: 0,
          averageMs: null,
          outputBytes: 0,
          baselineBytes: 0,
          savedBytes: 0,
          savedTokens: 0
        },
        workspacesQueried: 0
      },
      state: { checkedAt: ago(2) }
    },
    ready: USAGE_READY,
    expect: {
      en: ['No lookups in the last 30 days', 'Workspaces indexed'],
      es: ['No hubo búsquedas en los últimos 30 días', 'Espacios de trabajo indexados']
    },
    absent: ['Queries per day', 'Consultas por día']
  },
  {
    name: 'usage-never-checked',
    panel: 'usage.html',
    storage: {},
    ready: USAGE_READY,
    expect: {
      en: ['No statistics yet', 'Sonar: Refresh'],
      es: ['Aún no hay estadísticas', 'Sonar: Refresh']
    },
    absent: ['Tokens saved', 'Tokens ahorrados']
  }
]
