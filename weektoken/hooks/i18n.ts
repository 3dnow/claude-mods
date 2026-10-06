// UI language: Chinese / English; any other language falls back to English.
// register.tsx detects it at session start (mod setting → Claude Code language setting → system language), then calls setLang;
// pure functions use L(zh, en) to pick text for the current language.

export type Lang = 'zh' | 'en'

let current: Lang = 'en'

export const setLang = (l: Lang): void => { current = l }
export const getLang = (): Lang => current

/** Pick one of the two by the current language */
export const L = <T>(zh: T, en: T): T => (current === 'zh' ? zh : en)

const ZH = /^zh([-_.\s]|$)|chinese|mandarin|cantonese|中文|汉语|漢語|简体|繁體|繁体|普通话|国语|國語|粤语/i

/** Claude Code language setting: unset (empty, or shown as "Default (English)") → null; Chinese → zh; any other language → en */
export function langFromSetting(v: unknown): Lang | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || /^default\b/i.test(s)) return null
  return ZH.test(s) ? 'zh' : 'en'
}

/** LANG / LC_ALL / LC_MESSAGES: C and POSIX don't count as a language */
export function langFromEnv(v: string | undefined): Lang | null {
  const s = (v ?? '').trim()
  if (!s || /^(c|posix)([._]|$)/i.test(s)) return null
  return /^zh([-_.]|$)/i.test(s) ? 'zh' : 'en'
}

/** Output of `defaults read -g AppleLanguages`: take the first (preferred) entry */
export function langFromAppleLanguages(out: string): Lang | null {
  const first = out.replace(/[()]/g, '').split(/[,\n]/).map(x => x.trim().replace(/^"|"$/g, '')).find(Boolean)
  if (!first) return null
  return /^zh([-_]|$)/i.test(first) ? 'zh' : 'en'
}
