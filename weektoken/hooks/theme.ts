// 配色:WeekToken macOS 版 PaceTheme / PaceVisuals 的色值。
// 状态色(配速驱动)深浅模式通用;配额身份色分浅/深两版。

import type { Status } from './pace.ts'

export type Tri = { start: string; end: string; solid: string }

export const STATUS: Record<Status, Tri> = {
  comfortable: { start: '#4FC94F', end: '#0A8A0A', solid: '#0CA30C' },
  onPace: { start: '#2FA85F', end: '#05663A', solid: '#0A7D46' },
  overPace: { start: '#FBC957', end: '#C98C00', solid: '#FAB219' },
  exhausted: { start: '#E06A6A', end: '#A32C2C', solid: '#D03B3B' },
  early: { start: '#D6DAE0', end: '#6B7280', solid: '#9AA1AC' },
  unknown: { start: '#DDE0E4', end: '#8E949C', solid: '#A3A8B0' },
}

export type Identity = { light: Tri; dark: Tri }

const tri = (s: string, e: string, so: string): Tri => ({ start: '#' + s, end: '#' + e, solid: '#' + so })

const FIXED: Record<string, Identity> = {
  seven_day: { light: tri('6BA3E8', '1B5AA8', '2A78D6'), dark: tri('74B0F0', '2A6DC4', '3987E5') },
  five_hour: { light: tri('5FCFA4', '12805A', '1BAF7A'), dark: tri('4FC79A', '0F7A56', '199E70') },
  weekly_fable: { light: tri('8B7DD8', '342A78', '4A3AA7'), dark: tri('B3ABF0', '6A5FC0', '9085E9') },
}

// 其它键按名字散列到四个槽(start-light, start-dark, end-light, end-dark, solid-light, solid-dark)
const SLOTS: [string, string, string, string, string, string][] = [
  ['F08A5C', 'E07A4A', 'C24E1C', 'B84518', 'EB6834', 'D95926'], // orange
  ['F0A4C0', 'E58FB0', 'D05A85', 'C04A75', 'E87BA4', 'D55181'], // magenta
  ['EDB84D', 'D9A030', 'C08000', 'A86E00', 'EDA100', 'C98500'], // yellow
  ['EE7A79', 'F08585', 'C03332', 'D04A4A', 'E34948', 'E66767'], // red
]

export function identity(key: string): Identity {
  const f = FIXED[key]
  if (f) return f
  let h = 0
  for (const ch of key) h = (h * 31 + (ch.codePointAt(0) ?? 0)) & 0xffffff
  const s = SLOTS[h % 4]
  return { light: tri(s[0], s[2], s[4]), dark: tri(s[1], s[3], s[5]) }
}

/** 给原生 Text 用的单色:取深色版的 solid,深浅背景上都够亮够清楚 */
export const identityText = (key: string) => identity(key).dark.solid
export const statusText = (s: Status) => STATUS[s].solid
