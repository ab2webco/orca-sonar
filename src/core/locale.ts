import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Locale = 'en' | 'es'

/** Orca keeps its settings in this file inside userData. */
const SETTINGS_FILE = 'orca-data.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The `uiLanguage` Orca saved, or undefined when the file is missing or unreadable. */
export function readUiLanguage(userDataDir: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(userDataDir, SETTINGS_FILE), 'utf8'))
  } catch {
    return undefined
  }
  const settings = isRecord(parsed) ? parsed.settings : undefined
  const language = isRecord(settings) ? settings.uiLanguage : undefined
  return typeof language === 'string' ? language : undefined
}

/**
 * The language for user-facing text, following Orca's setting. Orca supports
 * `system`, `en`, `es` and plugin languages; only Spanish has its own text, so
 * everything else is English.
 */
export function resolveLocale(userDataDir: string, systemLocale: string): Locale {
  const language = readUiLanguage(userDataDir) ?? 'system'
  const tag = language === 'system' ? systemLocale : language
  return tag.toLowerCase().startsWith('es') ? 'es' : 'en'
}
