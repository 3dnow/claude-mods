// 界面语言:中文 / 英文,其他语言一律英文。
// register.tsx 在会话开始时探测(mod 设置 → Claude Code 的 language 设置 → 系统语言)后 setLang;
// 纯函数用 L(中文, 英文) 按当前语言出文案。

export type Lang = 'zh' | 'en'

let current: Lang = 'en'

export const setLang = (l: Lang): void => { current = l }
export const getLang = (): Lang => current

/** 按当前语言二选一 */
export const L = <T>(zh: T, en: T): T => (current === 'zh' ? zh : en)

const ZH = /^zh([-_.\s]|$)|chinese|mandarin|cantonese|中文|汉语|漢語|简体|繁體|繁体|普通话|国语|國語|粤语/i

/** Claude Code 的 language 设置:没设(空,或显示成 "Default (English)")→ null;中文 → zh;别的语言 → en */
export function langFromSetting(v: unknown): Lang | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || /^default\b/i.test(s)) return null
  return ZH.test(s) ? 'zh' : 'en'
}

/** LANG / LC_ALL / LC_MESSAGES:C、POSIX 不算语言 */
export function langFromEnv(v: string | undefined): Lang | null {
  const s = (v ?? '').trim()
  if (!s || /^(c|posix)([._]|$)/i.test(s)) return null
  return /^zh([-_.]|$)/i.test(s) ? 'zh' : 'en'
}

/** `defaults read -g AppleLanguages` 的输出:取首选的第一项 */
export function langFromAppleLanguages(out: string): Lang | null {
  const first = out.replace(/[()]/g, '').split(/[,\n]/).map(x => x.trim().replace(/^"|"$/g, '')).find(Boolean)
  if (!first) return null
  return /^zh([-_]|$)/i.test(first) ? 'zh' : 'en'
}
