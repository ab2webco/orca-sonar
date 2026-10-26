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
