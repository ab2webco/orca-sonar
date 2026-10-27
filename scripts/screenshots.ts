/**
 * Photographs every panel in every state at 1440, 768, 390 and 320 px, light
 * and dark, Spanish and English, and fails when a state does not show its
 * text, shows text it must not, scrolls sideways, or a click does not write
 * what the worker expects.
 *
 * Each panel is loaded the way Orca serves it: after a shell with Orca's CSP,
 * `html.light|dark`, `html lang` and the design tokens, with a stub that
 * answers the postMessage bridge from fixed example data and keeps what the
 * panel writes.
 *
 * Playwright and the PNGs live outside the plugin folder: Orca hashes and
 * copies everything under it, refuses symlinks (node_modules/.bin) and caps the
 * tree at 2,000 entries and 50 MB.
 *
 *   npm --prefix ../.orca-sonar-deps install playwright@1.59.1   (once)
 *   npm run screenshots
 *
 * SONAR_DEPS and SONAR_SHOTS override the two folders.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCENARIOS, USAGE_SCENARIOS, type Language, type Scenario } from './panel-scenarios.ts'

interface Page {
  setContent(html: string): Promise<void>
  waitForFunction(
    script: string,
    arg?: unknown,
    options?: { readonly timeout: number }
  ): Promise<unknown>
  evaluate(script: string): Promise<unknown>
  click(selector: string): Promise<void>
  waitForTimeout(ms: number): Promise<void>
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>
  close(): Promise<void>
}
interface Browser {
  newPage(options: { viewport: { width: number; height: number } }): Promise<Page>
  close(): Promise<void>
}
interface Playwright {
  chromium: { launch(): Promise<Browser> }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEPS = process.env.SONAR_DEPS ?? join(ROOT, '..', '.orca-sonar-deps')
const OUT = process.env.SONAR_SHOTS ?? join(ROOT, '..', '.orca-sonar-screenshots')
const WIDTHS = [1440, 768, 390, 320] as const
const THEMES = ['light', 'dark'] as const
const LANGUAGES: readonly Language[] = ['en', 'es']

const CSP =
  "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

/** Orca's main.css values for the tokens it injects into panels. */
const TOKENS = {
  light: {
    '--background': '#fff',
    '--foreground': '#0a0a0a',
    '--card': '#fff',
    '--card-foreground': '#0a0a0a',
    '--primary': '#171717',
    '--primary-foreground': '#fafafa',
    '--secondary': '#f5f5f5',
    '--secondary-foreground': '#171717',
    '--muted': '#f5f5f5',
    '--muted-foreground': '#737373',
    '--accent': '#f5f5f5',
    '--destructive': '#e40014',
    '--border': '#e5e5e5',
    '--input': '#e5e5e5',
    '--ring': '#a1a1a1'
  },
  dark: {
    '--background': '#0a0a0a',
    '--foreground': '#fafafa',
    '--card': '#171717',
    '--card-foreground': '#fafafa',
    '--primary': '#e5e5e5',
    '--primary-foreground': '#171717',
    '--secondary': '#262626',
    '--secondary-foreground': '#fafafa',
    '--muted': '#262626',
    '--muted-foreground': '#a1a1a1',
    '--accent': '#404040',
    '--destructive': '#ff6568',
    '--border': 'rgb(255 255 255 / 0.07)',
    '--input': 'rgb(255 255 255 / 0.15)',
    '--ring': '#737373'
  }
} as const

const BASE_STYLE =
  ':root{--radius:0.625rem;--font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
  '--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;' +
  '--radius-sm:calc(var(--radius) * 0.6);--radius-md:calc(var(--radius) * 0.8);--radius-lg:var(--radius)}' +
  '*,*::before,*::after{box-sizing:border-box}' +
  'body{font-family:var(--font-sans);font-size:14px;line-height:1.5;letter-spacing:0.01em}'

/** Answers the panel's bridge like Orca's host does, and keeps what the panel writes in `window.__written`. */
function hostStub(scenario: Scenario): string {
  return `
    (function () {
      var storage = ${JSON.stringify(scenario.storage)}
      var context = ${JSON.stringify(scenario.context ?? null)}
      var runsCommands = ${JSON.stringify(scenario.runsCommands === true)}
      window.__written = {}
      window.addEventListener('message', function (event) {
        var data = event.data
        if (!data || data.type !== 'orca-panel-action') return
        var value
        if (data.action === 'workspace.readContext') value = context
        else if (data.action === 'storage.get') {
          var stored = storage[data.params.key]
          value = { value: stored === undefined ? null : stored }
        } else if (data.action === 'storage.set') {
          storage[data.params.key] = data.params.value
          window.__written[data.params.key] = data.params.value
          value = { ok: true }
        } else if (data.action === 'panel.runCommand') {
          // An Orca without it refuses the action before it reaches the plugin.
          if (!runsCommands) {
            window.postMessage({ type: 'orca-panel-action-result', requestId: data.requestId, ok: false, errorCode: 'invalid_request', error: 'action: not a panel-callable action' }, '*')
            return
          }
          var rebuilds = Object.assign({}, storage.rebuilds)
          Object.keys(storage).forEach(function (key) {
            if (key.indexOf('rebuild:') !== 0) return
            rebuilds[storage[key].root] = { state: 'running', startedAt: new Date().toISOString() }
            delete storage[key]
          })
          storage.rebuilds = rebuilds
          window.__ran = data.params.commandId === 'sonar.refresh'
          value = { ran: true }
        }
        window.postMessage({ type: 'orca-panel-action-result', requestId: data.requestId, ok: true, value: value }, '*')
      })
    })()`
}

function page(panel: string, scenario: Scenario, theme: 'light' | 'dark', lang: Language): string {
  const tokens = Object.entries(TOKENS[theme])
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
  return (
    `<!doctype html>\n<html class="${theme}" lang="${lang}">\n<head>\n<meta charset="utf-8">\n` +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">\n` +
    `<style>${BASE_STYLE}</style><style>:root{${tokens}}</style>\n` +
    `<script>${hostStub(scenario)}</script>\n</head>\n${panel}`
  )
}

async function main(): Promise<void> {
  const require = createRequire(join(DEPS, 'package.json'))
  const { chromium } = require('playwright') as Playwright
  const panels = new Map<string, string>()
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const browser = await chromium.launch()
  const problems: string[] = []
  let taken = 0
  try {
    for (const scenario of [...SCENARIOS, ...USAGE_SCENARIOS]) {
      const html =
        panels.get(scenario.panel) ?? readFileSync(join(ROOT, 'panels', scenario.panel), 'utf8')
      panels.set(scenario.panel, html)
      for (const lang of LANGUAGES) {
        for (const theme of THEMES) {
          for (const width of WIDTHS) {
            const extreme =
              (width === 1440 && theme === 'dark') || (width === 320 && theme === 'light')
            if (!scenario.full && !extreme) {
              continue
            }
            const label = `${scenario.name} ${lang} ${theme} ${String(width)}`
            const tab = await browser.newPage({ viewport: { width, height: 900 } })
            await tab.setContent(page(html, scenario, theme, lang))
            await tab.waitForFunction(scenario.ready)
            for (const step of scenario.clicks ?? []) {
              await tab.click(step)
              await tab.waitForTimeout(50)
            }
            if (scenario.settled !== undefined) {
              await tab
                .waitForFunction(scenario.settled, undefined, { timeout: 5000 })
                .catch(() => {
                  problems.push(`${label}: never settled (${scenario.settled ?? ''})`)
                })
              await tab.waitForTimeout(50)
            }
            const text = String(await tab.evaluate('document.body.innerText'))
            const overflow = Number(
              await tab.evaluate('document.documentElement.scrollWidth - window.innerWidth')
            )
            for (const expected of scenario.expect[lang]) {
              if (!text.includes(expected)) problems.push(`${label}: missing "${expected}"`)
            }
            for (const unexpected of scenario.absent ?? []) {
              if (text.includes(unexpected)) problems.push(`${label}: shows "${unexpected}"`)
            }
            if (overflow > 0) problems.push(`${label}: scrolls sideways by ${String(overflow)} px`)
            // Without it the frame's own scrollbar stays light in dark mode, as seen live in Orca.
            const scheme = String(
              await tab.evaluate('getComputedStyle(document.documentElement).colorScheme')
            )
            if (scheme !== theme)
              problems.push(`${label}: color-scheme is "${scheme}", not ${theme}`)
            if (scenario.checkWritten) {
              const problem = scenario.checkWritten(await tab.evaluate('window.__written'))
              if (problem !== null) problems.push(`${label}: ${problem}`)
            }
            const file = `${scenario.name}-${lang}-${theme}-${String(width)}.png`
            await tab.screenshot({ path: join(OUT, file), fullPage: true })
            await tab.close()
            taken++
          }
        }
      }
    }
  } finally {
    await browser.close()
  }

  process.stdout.write(`${String(taken)} screenshots in ${OUT}\n`)
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`)
    process.exitCode = 1
  }
}

await main()
