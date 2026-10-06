// WeekToken pace model: a port of WeekTokenCore from the WeekToken macOS app.
// Algorithms, thresholds and copy match the original (PaceModel / QuotaDisplay / PaceNarrator / QuotaCatalog /
// Bottleneck / WindowInference / BurnUpSeries / BurnUpOverlay). Pure functions; never touches `$`.
// Time: samples and reset times are ms timestamps; window length W is in seconds. Copy is bilingual zh/en, picked by the current language in i18n.ts.

import { L } from './i18n.ts'

export const FIVE_HOUR = 18000
export const SEVEN_DAY = 604800

/** One quota in an observation: usage 0–100, reset time (ms), display name from the server */
export type Obs = { u: number; r?: number; n?: string }
/** One sample: time (ms) + per-quota observations */
export type Sample = { t: number; w: Record<string, Obs> }

// ---------- Window length and source ----------

export type LengthSource =
  | { kind: 'declared' }
  | { kind: 'measured'; n: number }
  | { kind: 'corroborated'; n: number }
  | { kind: 'clientDeclared' }
  | { kind: 'assumed' }

export type WindowLength = { seconds: number; source: LengthSource }

export function sourceBadge(s: LengthSource): string {
  switch (s.kind) {
    case 'declared': return L('厂商提供', 'vendor-declared')
    case 'measured': return L(`实测 n=${s.n}`, `measured n=${s.n}`)
    case 'corroborated': return L(`已验证 n=${s.n}`, `verified n=${s.n}`)
    case 'clientDeclared': return L('客户端标定', 'client default')
    case 'assumed': return L('假定', 'assumed')
  }
}

/** The UI shows the source only when it is not verified by local data */
export const isVerifiedByData = (s: LengthSource): boolean =>
  (s.kind === 'measured' || s.kind === 'corroborated') && s.n >= 1

export function prior(key: string): WindowLength {
  const k = key.toLowerCase()
  if (k.includes('five_hour') || k.includes('5h') || k.includes('session') || k === 'primary') {
    return { seconds: FIVE_HOUR, source: { kind: 'clientDeclared' } }
  }
  if (k.includes('seven_day') || k.includes('week') || k.includes('7d')) {
    return { seconds: SEVEN_DAY, source: { kind: 'clientDeclared' } }
  }
  return { seconds: SEVEN_DAY, source: { kind: 'assumed' } }
}

const MIN_JUMP = 60
const BOUND_TOLERANCE = 60
const FIXED_PERIOD_TOLERANCE = 60

function robustUpperBound(jumps: number[]): number {
  const sorted = [...jumps].sort((a, b) => a - b)
  if (sorted.length < 10) return sorted[0]
  return sorted[Math.max(1, Math.floor(sorted.length / 20))]
}

/** Infer window length from resets_at jumps: each jump gives an interval [jump − sample gap, jump]; intersect them */
export function inferWindow(key: string, samples: readonly Sample[]): WindowLength {
  const p = prior(key)
  const bounds: { lo: number; hi: number; jump: number }[] = []
  let prevR: number | undefined
  let prevT: number | undefined
  for (const s of samples) {
    const o = s.w[key]
    if (!o || o.r == null) continue
    if (prevR != null && prevT != null) {
      const jump = (o.r - prevR) / 1000
      const gap = (s.t - prevT) / 1000
      if (jump > MIN_JUMP && jump >= 3600 && jump <= 30 * 86400) {
        bounds.push({ lo: Math.max(0, jump - gap), hi: jump, jump })
      }
    }
    prevR = o.r
    prevT = s.t
  }
  if (bounds.length === 0) return p
  const n = bounds.length
  const jumps = bounds.map(b => b.jump)
  const jMin = Math.min(...jumps)
  const jMax = Math.max(...jumps)
  // Fixed period: if the jumps are uniform, that is the exact W.
  // But not when jumps exceed the prior: a rolling window's jump = W + idle gap from reset to first use; when that gap is constant (scheduled jobs)
  // the jumps are uniform too, but that is the gap, not W — leave it to the interval inference below
  const mean = jumps.reduce((a, b) => a + b, 0) / n
  if (n >= 2 && jMax - jMin <= FIXED_PERIOD_TOLERANCE && mean <= p.seconds + FIXED_PERIOD_TOLERANCE) {
    if (Math.abs(mean - p.seconds) <= FIXED_PERIOD_TOLERANCE) return { seconds: p.seconds, source: { kind: 'corroborated', n } }
    return { seconds: mean, source: { kind: 'measured', n } }
  }
  // Rolling window: lower bound = max of the interval lower bounds, upper bound = robust minimum jump
  const lo = Math.max(...bounds.map(b => b.lo))
  const hi = robustUpperBound(jumps)
  if (lo - hi > BOUND_TOLERANCE) {
    // Observations contradict each other: fall back to the upper bound, which always holds
    if (Math.abs(hi - p.seconds) <= BOUND_TOLERANCE) return { seconds: p.seconds, source: { kind: 'corroborated', n } }
    return { seconds: hi, source: { kind: 'measured', n } }
  }
  if (p.seconds >= lo - BOUND_TOLERANCE && p.seconds <= hi + BOUND_TOLERANCE) {
    return { seconds: p.seconds, source: { kind: 'corroborated', n } }
  }
  return { seconds: Math.min(Math.max(p.seconds, lo), hi), source: { kind: 'measured', n } }
}

// ---------- Pace ----------

export type Status = 'unknown' | 'early' | 'comfortable' | 'onPace' | 'overPace' | 'exhausted'

export type Pace = {
  /** U: fraction used 0–1 */
  used: number
  /** T: fraction of time elapsed 0–1 */
  elapsed: number
  /** Window length (seconds) */
  W: number
  /** Computation time (ms) */
  now: number
  delta: number
  burnRate: number | null
  timeToReset: number
  runway: number | null
  exhaustionAt: number | null
  leadTime: number
  overPaceThreshold: number
  status: Status
}

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi)

export const earlyCutoff = (W: number) => Math.max(0.001, 300 / Math.max(W, 1))

/** Official limit-warning calibration (from the claude binary): (utilization, timePct) */
export function officialThresholds(W: number): [number, number][] {
  return W <= 6 * 3600 ? [[0.9, 0.72]] : [[0.75, 0.6], [0.5, 0.35], [0.25, 0.15]]
}

/** Over-pace ratio threshold: tightens as the window progresses (1.67 → 1.43 → 1.25 → 1.1) */
export function overPaceThreshold(elapsed: number, W: number): number {
  const sorted = officialThresholds(W).sort((a, b) => a[1] - b[1])
  for (const [util, timePct] of sorted) if (elapsed <= timePct) return util / timePct
  return 1.1
}

export function paceFromValues(used: number, elapsed: number, W: number, now: number): Pace {
  const cutoff = earlyCutoff(W)
  const delta = used - elapsed
  const burnRate = elapsed > cutoff ? used / elapsed : null
  const timeToReset = Math.max(0, W * (1 - elapsed))
  let runway: number | null
  if (used <= 0) runway = null
  else if (used >= 1) runway = 0
  else if (elapsed <= cutoff) runway = null
  else runway = (W * elapsed * (1 - used)) / used
  const exhaustionAt = runway != null && runway < timeToReset ? now + runway * 1000 : null
  const over = overPaceThreshold(elapsed, W)
  let status: Status
  if (used >= 1) status = 'exhausted'
  else if (elapsed <= cutoff) status = 'early'
  else if (burnRate == null) status = 'unknown'
  else if (burnRate > over) status = 'overPace'
  else if (burnRate < 1 / over) status = 'comfortable'
  else status = 'onPace'
  return { used, elapsed, W, now, delta, burnRate, timeToReset, runway, exhaustionAt, leadTime: delta * W, overPaceThreshold: over, status }
}

/** Build pace from one observation; no reset time, or reset already passed → null (no fabricated clamp to 100%) */
export function paceFromObs(o: Obs, W: number, now: number): Pace | null {
  if (o.r == null) return null
  const remaining = (o.r - now) / 1000
  if (remaining <= 0) return null
  const used = clamp(o.u / 100, 0, 1)
  const elapsed = 1 - Math.min(remaining, W) / W
  return paceFromValues(used, elapsed, W, now)
}

const STATUS_ZH: Record<Status, string> = {
  comfortable: '富余',
  onPace: '贴合配速',
  overPace: '超速',
  exhausted: '已用尽',
  early: '窗口初期',
  unknown: '数据不足',
}
const STATUS_EN: Record<Status, string> = {
  comfortable: 'Under pace',
  onPace: 'On pace',
  overPace: 'Over pace',
  exhausted: 'Used up',
  early: 'Too early',
  unknown: 'No data yet',
}
export const statusLabel = (s: Status): string => L(STATUS_ZH, STATUS_EN)[s]

// ---------- Three display states: pace / usage only / empty ----------

export type UsageOnlyReason =
  | { kind: 'notStarted' }
  | { kind: 'windowEnded' }
  | { kind: 'noResetTime' }
  | { kind: 'stale'; age: number }

export type Display =
  | { kind: 'pace'; pace: Pace; obs: Obs }
  | { kind: 'usageOnly'; obs: Obs; reason: UsageOnlyReason }
  | { kind: 'empty' }

export const staleThreshold = (W: number) => Math.max(15 * 60, 0.05 * W)

export function display(o: Obs | undefined, W: number, now: number, observedAt?: number): Display {
  if (!o) return { kind: 'empty' }
  if (observedAt != null) {
    const age = (now - observedAt) / 1000
    if (age > staleThreshold(W)) return { kind: 'usageOnly', obs: o, reason: { kind: 'stale', age } }
  }
  const pace = paceFromObs(o, W, now)
  if (pace) return { kind: 'pace', pace, obs: o }
  if (o.r != null) return { kind: 'usageOnly', obs: o, reason: { kind: o.r <= now ? 'windowEnded' : 'noResetTime' } }
  return { kind: 'usageOnly', obs: o, reason: { kind: o.u <= 0 ? 'notStarted' : 'noResetTime' } }
}

export function displayUsed(d: Display): number | null {
  if (d.kind === 'pace') return d.pace.used
  if (d.kind === 'usageOnly') return clamp(d.obs.u / 100, 0, 1)
  return null
}

export function displayStatus(d: Display): Status {
  return d.kind === 'pace' ? d.pace.status : 'unknown'
}

export function displayLabel(d: Display): string {
  if (d.kind === 'pace') return statusLabel(d.pace.status)
  if (d.kind === 'empty') return L('数据不足', 'No data yet')
  switch (d.reason.kind) {
    case 'notStarted': return L('窗口未开始', 'Not started')
    case 'windowEnded': return L('窗口已结束', 'Window ended')
    case 'noResetTime': return L('无重置时刻', 'No reset time')
    case 'stale': return L('数据已过期', 'Stale data')
  }
}

export function displayHeadline(d: Display): string {
  if (d.kind === 'pace') return headline(d.pace)
  if (d.kind === 'empty') return L('无法计算配速', "Can't compute pace")
  switch (d.reason.kind) {
    case 'notStarted': return L('额度已重置', 'Quota has reset')
    case 'windowEnded': return L('窗口已重置', 'Window has reset')
    case 'noResetTime': return L('只能显示用量', 'Usage only')
    case 'stale': return L('拿不到当前数据', 'No current data')
  }
}

export function displayDetail(d: Display): string | null {
  if (d.kind !== 'usageOnly') return null
  switch (d.reason.kind) {
    case 'notStarted': return L('还没开始用。没有活跃窗口，接口就不返回重置时刻，配速无从谈起', 'Not used yet. With no active window the API returns no reset time, so there is no pace to compute')
    case 'windowEnded': return L('重置时刻已过，这份数据描述的是上一个窗口。等下次取数刷新', 'The reset time has passed, so this data describes the previous window. Waiting for the next refresh')
    case 'noResetTime': return L('接口没给重置时刻，定位不了窗口相位', 'The API gave no reset time, so the position in the window is unknown')
    case 'stale': {
      const mins = Math.floor(d.reason.age / 60)
      const ago = mins >= 60 ? L(`${Math.floor(mins / 60)} 小时 ${mins % 60} 分`, `${Math.floor(mins / 60)}h ${mins % 60}m`) : L(`${mins} 分`, `${mins}m`)
      return L(`这份数据是 ${ago}前的。拿旧用量配当前时间算出的配速会偏乐观，所以不给结论`, `This data is ${ago} old. Pairing old usage with the current time would look too optimistic, so no verdict`)
    }
  }
}

// ---------- Narration ----------

/** Chinese: 1 day 2 hours / 1 hour 30 min / 5 min; English: 1d 2h / 1h 30m / 5m (truncated, not rounded) */
export function formatDuration(seconds: number): string {
  const s = Math.trunc(Math.abs(seconds))
  const days = Math.floor(s / 86400)
  const hours = Math.floor((s % 86400) / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  if (days > 0) return hours > 0 ? L(`${days} 天 ${hours} 小时`, `${days}d ${hours}h`) : L(`${days} 天`, `${days}d`)
  if (hours > 0) return minutes > 0 ? L(`${hours} 小时 ${minutes} 分`, `${hours}h ${minutes}m`) : L(`${hours} 小时`, `${hours}h`)
  return L(`${minutes} 分`, `${minutes}m`)
}

export function headline(p: Pace): string {
  if (p.status === 'exhausted') return L('额度已用尽', 'Quota used up')
  if (p.status === 'early') return L('窗口刚开始，还看不出配速', 'Window just started, too early to tell')
  if (p.status === 'unknown') return L('数据不足', 'Not enough data')
  if (Math.abs(p.leadTime) < 3600) return L('与时间进度基本同步', 'In step with the clock')
  const d = formatDuration(p.leadTime)
  return p.leadTime > 0 ? L(`用量超前 ${d}`, `Usage ${d} ahead of the clock`) : L(`用量落后 ${d}`, `Usage ${d} behind the clock`)
}

const WEEKDAYS_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad2 = (n: number) => String(n).padStart(2, '0')

function clockText(at: number, withWeekday: boolean): string {
  const d = new Date(at)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return withWeekday ? `${L(WEEKDAYS_ZH, WEEKDAYS_EN)[d.getDay()]} ${hm}` : hm
}

export function forecast(p: Pace): string | null {
  if (p.status === 'exhausted') return L(`${formatDuration(p.timeToReset)}后重置`, `Resets in ${formatDuration(p.timeToReset)}`)
  if (p.status === 'early' || p.burnRate == null) return null
  if (p.exhaustionAt != null && p.runway != null) {
    const at = clockText(p.exhaustionAt, p.runway >= 86400)
    return L(`照这个速度，约 ${at} 用完`, `At this rate, runs out ~${at}`)
  }
  const end = Math.round(p.burnRate * 100)
  return L(`照这个速度，重置时约用到 ${end}%`, `At this rate, ~${end}% by reset`)
}

const fmt4g = (x: number) => String(Number(x.toPrecision(4)))

export function windowNote(len: WindowLength): string {
  const days = len.seconds / 86400
  const span = days >= 1 ? L(`${fmt4g(days)} 天`, `${fmt4g(days)}d`) : L(`${fmt4g(len.seconds / 3600)} 小时`, `${fmt4g(len.seconds / 3600)}h`)
  return L(`窗口 ${span} · ${sourceBadge(len.source)}`, `Window ${span} · ${sourceBadge(len.source)}`)
}

/** Short menu-bar text: pace delta Δ; the leading space is intentional, as in the original */
export function menuBarText(d: Display): string {
  if (d.kind === 'empty') return ' —'
  if (d.kind === 'usageOnly') return ` ${Math.round(d.obs.u)}%`
  const p = d.pace
  if (p.status === 'early') return ' ·'
  if (p.status === 'exhausted') return L(' 用尽', ' out')
  if (p.status === 'unknown') return ' —'
  const x = p.delta * 100
  return ` ${x < 0 ? '-' : '+'}${Math.abs(Math.round(x))}%`
}

export function pct(x: number): string {
  const v = x * 100
  return v < 10 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`
}

/** Full description for screen readers and Svg alt */
export function accessibilityLabel(d: Display, name: string): string {
  if (d.kind === 'empty') return L(`${name}，暂无数据`, `${name}, no data yet`)
  if (d.kind === 'usageOnly') {
    const why = L(
      { notStarted: '窗口尚未开始', windowEnded: '窗口已结束', noResetTime: '缺少重置时刻，算不出配速', stale: '数据过旧，不再据此判断配速' },
      { notStarted: 'window not started yet', windowEnded: 'window ended', noResetTime: 'no reset time, so no pace', stale: 'data too old to judge pace' },
    )[d.reason.kind]
    const u = pct(clamp(d.obs.u / 100, 0, 1))
    return L(`${name}，已用 ${u}，${why}`, `${name}, ${u} used, ${why}`)
  }
  const p = d.pace
  const parts = [name, L(`已用 ${pct(p.used)}`, `${pct(p.used)} used`), L(`时间过了 ${pct(p.elapsed)}`, `${pct(p.elapsed)} of the time elapsed`)]
  const gap = pct(Math.abs(p.delta))
  if (Math.abs(p.delta) >= 0.005) parts.push(p.delta > 0 ? L(`超出时间进度 ${gap}`, `${gap} ahead of the clock`) : L(`落后时间进度 ${gap}`, `${gap} behind the clock`))
  else parts.push(L('与时间进度基本同步', 'in step with the clock'))
  parts.push(statusLabel(p.status), L(`${formatDuration(p.timeToReset)}后重置`, `resets in ${formatDuration(p.timeToReset)}`))
  return parts.join(L('，', ', '))
}

// ---------- Quota catalog ----------

export const isWeekly = (key: string) => key.startsWith('seven_day') || key.startsWith('weekly_')

const capitalize = (s: string) => s.replace(/\b([a-z])([a-z]*)/gi, (_, a: string, b: string) => a.toUpperCase() + b.toLowerCase())

export function displayName(key: string, serverName?: string): string {
  if (serverName) return serverName
  if (key === 'five_hour') return L('5 小时', '5-hour')
  if (key === 'seven_day') return L('7 天', '7-day')
  if (key === 'spend') return L('额度包', 'Credits')
  if (key === 'weekly_scoped') return L('分模型', 'Per-model')
  if (key.startsWith('weekly_')) return capitalize(key.slice(7).replace(/_/g, ' '))
  return key.replace(/_/g, ' ')
}

/** Short name for the quota picker dropdown: Fable / All models / 5 hours */
export function pickName(key: string, serverName?: string): string {
  if (key === 'five_hour') return L('5 小时', '5 hours')
  if (key === 'seven_day') return L('全部模型', 'All models')
  return displayName(key, serverName)
}

export function fullName(key: string, serverName?: string): string {
  const week = L('7 天', '7-day')
  if (serverName) return isWeekly(key) ? `${week} · ${serverName}` : serverName
  if (key === 'five_hour') return L('5 小时会话额度', '5-hour session')
  if (key === 'seven_day') return L('7 天 · 全部模型', '7-day · All models')
  if (isWeekly(key)) return `${week} · ${displayName(key)}`
  return displayName(key)
}

const order = (key: string) => (key === 'five_hour' ? 0 : key === 'seven_day' ? 1 : isWeekly(key) ? 2 : 9)

export function sortKeys(keys: readonly string[]): string[] {
  return [...keys].sort((a, b) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0))
}

export function isKnown(key: string): boolean {
  const k = key.toLowerCase()
  return k.includes('five_hour') || k.includes('seven_day') || k.includes('week') || k.includes('session') || k === 'primary'
}

/** Keys that had a reset time in history and were used or are known quotas (filters out spend / extra_usage / experimental zero-usage keys) */
export function discoveredKeys(samples: readonly Sample[]): string[] {
  const hadReset = new Set<string>()
  const hadUse = new Set<string>()
  for (const s of samples) {
    for (const [k, o] of Object.entries(s.w)) {
      if (o.r != null) hadReset.add(k)
      if (o.u > 0) hadUse.add(k)
    }
  }
  return sortKeys([...hadReset].filter(k => hadUse.has(k) || isKnown(k)))
}

export function neighbor(key: string, keys: readonly string[], offset: number): string | null {
  if (keys.length < 2) return null
  const i = keys.indexOf(key)
  if (i < 0) return null
  return keys[(((i + offset) % keys.length) + keys.length) % keys.length]
}

/** Latest observation for a key, with its observation time */
export function latestObs(samples: readonly Sample[], key: string): { obs: Obs; at: number } | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const o = samples[i].w[key]
    if (o) return { obs: o, at: samples[i].t }
  }
  return null
}

// ---------- Bottleneck: which quota the band above the input box shows ----------

export function pickBottleneck(cands: readonly { key: string; pace: Pace | null }[]): string | null {
  const tier = (p: Pace | null) => (!p ? 3 : p.used >= 1 ? 0 : p.runway != null && p.runway < p.timeToReset ? 1 : 2)
  let best: { key: string; pace: Pace | null } | null = null
  for (const c of cands) {
    if (!best) { best = c; continue }
    const a = tier(c.pace)
    const b = tier(best.pace)
    if (a !== b) { if (a < b) best = c; continue }
    const cp = c.pace
    const bp = best.pace
    let better = false
    if (a === 0 && cp && bp) better = cp.timeToReset > bp.timeToReset
    else if (a === 1 && cp && bp) better = (cp.runway ?? Infinity) < (bp.runway ?? Infinity)
    else if (a === 2 && cp && bp) better = (cp.burnRate ?? 0) > (bp.burnRate ?? 0)
    else if (a === 3) better = c.key < best.key
    if (better) best = c
  }
  return best ? best.key : null
}

// ---------- Usage trajectory (burn-up) ----------

export type Point = { elapsed: number; used: number; t: number }
export type Trend = 'accelerating' | 'easing' | 'steady'
export type Series = {
  key: string
  reset: number
  segments: Point[][]
  gaps: { from: Point; to: Point }[]
  midResets: { before: Point; after: Point }[]
  projection: { from: Point; to: { elapsed: number; used: number } } | null
  exhaustionAt: number | null
  projectionCrossesGap: boolean
  trend: Trend | null
  peak: number
}

const WINDOW_TOLERANCE_MS = 90_000
const RESET_DROP = 0.05
const gapThreshold = (W: number) => Math.max(900, 0.02 * W)

/** Windows (clustered by resets_at; within 90 s counts as the same one), newest first */
export function windowsOf(key: string, samples: readonly Sample[]): number[] {
  const resets = samples.map(s => s.w[key]?.r).filter((r): r is number => r != null).sort((a, b) => a - b)
  const out: number[] = []
  for (const r of resets) if (out.length === 0 || r - out[out.length - 1] > WINDOW_TOLERANCE_MS) out.push(r)
  return out.reverse()
}

function slopeWithin(points: readonly Point[], lookback = 0.15): number | null {
  if (points.length < 2) return null
  const last = points[points.length - 1]
  let anchor = points[0]
  for (let i = points.length - 2; i >= 0; i--) {
    if (last.elapsed - points[i].elapsed >= lookback) { anchor = points[i]; break }
  }
  if (anchor === last) anchor = points[0]
  const dt = last.elapsed - anchor.elapsed
  if (dt <= 0.001) return null
  return (last.used - anchor.used) / dt
}

export function buildSeries(key: string, reset: number, samples: readonly Sample[], W: number): Series | null {
  const pts: Point[] = []
  for (const s of samples) {
    const o = s.w[key]
    if (!o || o.r == null || Math.abs(o.r - reset) > WINDOW_TOLERANCE_MS) continue
    const remain = (reset - s.t) / 1000
    if (remain < 0 || remain > W) continue
    pts.push({ elapsed: 1 - remain / W, used: clamp(o.u / 100, 0, 1), t: s.t })
  }
  if (pts.length < 2) return null
  pts.sort((a, b) => a.t - b.t)
  const segments: Point[][] = [[pts[0]]]
  const gaps: Series['gaps'] = []
  const midResets: Series['midResets'] = []
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1]
    const p = pts[i]
    if ((p.t - prev.t) / 1000 > gapThreshold(W)) { gaps.push({ from: prev, to: p }); segments.push([p]) }
    else if (prev.used - p.used > RESET_DROP) { midResets.push({ before: prev, after: p }); segments.push([p]) }
    else segments[segments.length - 1].push(p)
  }
  const last = pts[pts.length - 1]
  let slope = slopeWithin(segments[segments.length - 1])
  let projectionCrossesGap = false
  if (slope == null) { slope = slopeWithin(pts); projectionCrossesGap = slope != null && segments.length > 1 }
  let projection: Series['projection'] = null
  let exhaustionAt: number | null = null
  if (slope != null && slope > 0) {
    const projected = last.used + slope * (1 - last.elapsed)
    if (projected <= 1) projection = { from: last, to: { elapsed: 1, used: projected } }
    else {
      const at = Math.min(1, last.elapsed + (1 - last.used) / slope)
      projection = { from: last, to: { elapsed: at, used: 1 } }
      exhaustionAt = at
    }
  }
  const overall = last.elapsed > 0.01 ? last.used / last.elapsed : null
  let trend: Trend | null = null
  if (slope != null && overall != null && overall > 0.01) {
    const ratio = slope / overall
    trend = ratio > 1.25 ? 'accelerating' : ratio < 0.75 ? 'easing' : 'steady'
  }
  return { key, reset, segments, gaps, midResets, projection, exhaustionAt, projectionCrossesGap, trend, peak: Math.max(...pts.map(q => q.used)) }
}

export type Range = 'current' | 'month' | 'all'
export const rangeLabel = (r: Range): string =>
  L({ current: '本窗口', month: '近一月', all: '全部' }, { current: 'This window', month: 'Last month', all: 'All' })[r]

export type OverlayEntry = { series: Series; recency: number; isCurrent: boolean }
/** inRange: number of windows in range; beyond MAX_OVERLAY overlaid, only an evenly spaced subset is drawn (entries fewer than inRange) */
export type Overlay = { entries: OverlayEntry[]; totalWindows: number; inRange: number; focused: OverlayEntry | null; current: OverlayEntry | null }

/** Max overlaid windows: Svg source is capped at 131072 chars; past that the engine rejects the whole pane */
export const MAX_OVERLAY = 60

/** Evenly pick n from windows ordered newest to oldest, keeping the newest and oldest */
function spread(list: readonly number[], n: number): number[] {
  if (list.length <= n) return [...list]
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(list[Math.round((i * (list.length - 1)) / (n - 1))])
  return [...new Set(out)]
}

export function buildOverlay(key: string, samples: readonly Sample[], W: number, range: Range, offset: number, now: number): Overlay {
  const all = windowsOf(key, samples)
  let chosen: number[]
  if (all.length === 0) chosen = []
  else if (range === 'current') chosen = [all[clamp(offset, 0, all.length - 1)]]
  else if (range === 'month') {
    chosen = all.filter(r => now - r <= 31 * 86400 * 1000)
    if (chosen.length === 0) chosen = [all[0]]
  } else chosen = all
  const inRange = chosen.length
  chosen = spread(chosen, MAX_OVERLAY)
  const newest = all[0]
  const built = [...chosen].sort((a, b) => a - b)
    .map(r => buildSeries(key, r, samples, W))
    .filter((s): s is Series => s != null)
  const entries = built.map((series, i) => ({
    series,
    recency: built.length > 1 ? i / (built.length - 1) : 1,
    isCurrent: newest != null && Math.abs(series.reset - newest) <= WINDOW_TOLERANCE_MS,
  }))
  return {
    entries,
    totalWindows: all.length,
    inRange,
    focused: entries.length ? entries[entries.length - 1] : null,
    current: entries.find(e => e.isCurrent) ?? null,
  }
}

const md = (t: number) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}` }

export function windowLabel(reset: number, W: number, isCurrent: boolean): string {
  return `${md(reset - W * 1000)} – ${md(reset)}${isCurrent ? L('（本窗口）', ' (current)') : ''}`
}

/** Caption under the burn-up: peak trend for multiple windows, peak for a single past window; the current window relies on chart and legend, no extra text */
export function overlayCaption(o: Overlay): string | null {
  if (o.entries.length > 1) {
    const first = Math.round(o.entries[0].series.peak * 100)
    const last = Math.round(o.entries[o.entries.length - 1].series.peak * 100)
    const used = o.entries.filter(e => e.series.peak >= 1).length
    const ran = used ? L(`，${used} 个窗口用完过`, `, ${used} ran out`) : ''
    const thinned = o.inRange > o.entries.length ? L(`（从 ${o.inRange} 个窗口里均匀取 ${o.entries.length} 个）`, ` (${o.entries.length} of ${o.inRange} windows, evenly spaced)`) : ''
    return L(`峰值 ${first}% → ${last}%`, `Peak ${first}% → ${last}%`) + ran + thinned
  }
  const f = o.focused
  if (f && !f.isCurrent) return L(`峰值 ${Math.round(f.series.peak * 100)}%`, `Peak ${Math.round(f.series.peak * 100)}%`)
  return null
}

export function legendDates(o: Overlay): { from: string; to: string } | null {
  if (o.entries.length < 2) return null
  return { from: md(o.entries[0].series.reset), to: md(o.entries[o.entries.length - 1].series.reset) }
}

// ---------- Sample storage ----------

/** Whether two observations are equivalent: same key set, usage diff < 0.001, reset time diff ≤ 5 s */
export function sameSample(a: Sample, b: Sample): boolean {
  const ka = Object.keys(a.w).sort()
  const kb = Object.keys(b.w).sort()
  if (ka.join() !== kb.join()) return false
  return ka.every(k => {
    const x = a.w[k]
    const y = b.w[k]
    if (Math.abs(x.u - y.u) >= 0.001) return false
    if ((x.r == null) !== (y.r == null)) return false
    return x.r == null || Math.abs(x.r - (y.r as number)) <= 5000
  })
}

/**
 * Append a sample: skip if equivalent to the latest one with the same key set and under 5 minutes apart; trim from the front past the cap.
 * Sources cover different keys (live session has only 5h/7d, local cache also has Fable), so dedup only works against the same source.
 */
export function appendSample(list: readonly Sample[], s: Sample, max = 8000): Sample[] {
  const sig = Object.keys(s.w).sort().join()
  let last: Sample | undefined
  for (let i = list.length - 1; i >= 0 && i >= list.length - 50; i--) {
    if (Object.keys(list[i].w).sort().join() === sig) { last = list[i]; break }
  }
  if (last && s.t - last.t < 300_000 && sameSample(last, s)) return list as Sample[]
  const out = [...list, s]
  out.sort((a, b) => a.t - b.t)
  return out.length > max ? out.slice(out.length - max) : out
}

/**
 * Merge two sample lists: samples at the same ms combine into one (the latter wins); then dedup by appendSample's rules —
 * when several sessions record the same reading at different ms, only the earliest within 5 minutes is kept.
 */
export function mergeSamples(a: readonly Sample[], b: readonly Sample[], max = 8000): Sample[] {
  const byT = new Map<number, Sample>()
  for (const s of a) byT.set(s.t, s)
  for (const s of b) {
    const prev = byT.get(s.t)
    byT.set(s.t, prev ? { t: s.t, w: { ...prev.w, ...s.w } } : s)
  }
  const sorted = [...byT.values()].sort((x, y) => x.t - y.t)
  const lastBySig = new Map<string, Sample>()
  const out: Sample[] = []
  for (const s of sorted) {
    const sig = Object.keys(s.w).sort().join()
    const last = lastBySig.get(sig)
    if (last && s.t - last.t < 300_000 && sameSample(last, s)) continue
    lastBySig.set(sig, s)
    out.push(s)
  }
  return out.length > max ? out.slice(out.length - max) : out
}

// ---------- Data source parsing ----------

function parseReset(v: unknown): number | undefined {
  if (typeof v === 'number' && v > 0) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    if (Number.isFinite(t)) return t
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n
  }
  return undefined
}

const pctOf = (raw: number) => Math.min(Math.max(raw, 0), 100)

export function quotaKey(kind: string | undefined, scopeName: string | undefined): string {
  if (kind === 'session') return 'five_hour'
  if (kind === 'weekly_all') return 'seven_day'
  if (kind === 'weekly_scoped') return scopeName ? 'weekly_' + scopeName.toLowerCase().replace(/ /g, '_') : 'weekly_scoped'
  return kind ?? 'unknown'
}

/** Parse an API-shaped usage response (top-level keys as fallback, limits[] takes precedence, incl. per-model quotas) */
export function parseUtilization(root: unknown): Record<string, Obs> {
  const out: Record<string, Obs> = {}
  if (!root || typeof root !== 'object') return out
  const obj = root as Record<string, unknown>
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const o = v as Record<string, unknown>
    const raw = typeof o.utilization === 'number' ? o.utilization : typeof o.percent === 'number' ? o.percent : null
    if (raw == null) continue
    out[k] = { u: pctOf(raw), r: parseReset(o.resets_at) }
  }
  for (const l of Array.isArray(obj.limits) ? obj.limits : []) {
    if (!l || typeof l !== 'object') continue
    const o = l as Record<string, unknown>
    if (typeof o.percent !== 'number') continue
    const scope = o.scope as { model?: { display_name?: unknown } } | undefined
    const name = typeof scope?.model?.display_name === 'string' ? scope.model.display_name : undefined
    const key = quotaKey(typeof o.kind === 'string' ? o.kind : undefined, name)
    out[key] = { u: pctOf(o.percent), r: parseReset(o.resets_at), ...(name ? { n: name } : {}) }
  }
  // If a per-model quota appears both at top level (seven_day_<x>) and in limits[] (weekly_<x>), keep only the limits[] one
  for (const k of Object.keys(out)) {
    if (k.startsWith('seven_day_') && out['weekly_' + k.slice('seven_day_'.length)]) delete out[k]
  }
  return out
}

/** cachedUsageUtilization in ~/.claude.json: the official reader uses a 1-hour TTL; expired counts as absent */
export function parseClaudeJsonCache(text: string, now: number): Sample | null {
  let root: unknown
  try { root = JSON.parse(text) } catch { return null }
  const c = (root as { cachedUsageUtilization?: { fetchedAtMs?: unknown; utilization?: unknown } })?.cachedUsageUtilization
  if (!c || typeof c.fetchedAtMs !== 'number') return null
  const age = now - c.fetchedAtMs
  if (age < 0 || age > 3600_000) return null
  const w = parseUtilization(c.utilization)
  return Object.keys(w).length ? { t: c.fetchedAtMs, w } : null
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Wall-clock time in a time zone → ms timestamp; uses the local zone when the runtime has no time zone data */
/** Common US time zone abbreviations → IANA names (Intl rejects abbreviations); Intl resolves DST for the location by date */
const TZ_ALIAS: Record<string, string> = {
  PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
  MST: 'America/Denver', MDT: 'America/Denver',
  CST: 'America/Chicago', CDT: 'America/Chicago',
  EST: 'America/New_York', EDT: 'America/New_York',
}

function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz?: string): number {
  const local = () => new Date(y, mo, d, h, mi).getTime()
  if (!tz) return local()
  try {
    const guess = Date.UTC(y, mo, d, h, mi)
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    const p: Record<string, string> = {}
    for (const part of fmt.formatToParts(new Date(guess))) p[part.type] = part.value
    const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute))
    return guess - (wall - guess)
  } catch {
    return local()
  }
}

/** Reset time in `/usage`: "Oct 7 at 5:59pm (Asia/Singapore)"; the date may be omitted (today); year is the nearest future one */
export function parseResetText(text: string, now: number): number | undefined {
  const m = /^(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i.exec(text.trim())
  // 12-hour format carries am/pm; 24-hour format must include minutes (17:59), so the 2 in "2h 30m" isn't read as an hour
  if (!m || (!m[6] && m[5] == null)) return undefined
  const h = m[6] ? (Number(m[4]) % 12) + (m[6].toLowerCase() === 'pm' ? 12 : 0) : Number(m[4])
  if (h > 23) return undefined
  const mi = Number(m[5] ?? 0)
  const tz = m[7] ? (TZ_ALIAS[m[7].trim().toUpperCase()] ?? m[7].trim()) : undefined
  // "Today" and "this year" use the time zone in parentheses: if the host zone is on a different date, the host would be off by a day
  const today = dateIn(now, tz)
  if (m[1]) {
    const mo = MONTHS.indexOf(m[1].toLowerCase())
    if (mo < 0) return undefined
    const d = Number(m[2])
    if (m[3]) return zonedToUtc(Number(m[3]), mo, d, h, mi, tz)
    const t = zonedToUtc(today.y, mo, d, h, mi, tz)
    // Only a date over half a year back is next year's ("Jan 2" seen in late Dec); a few days back is the past, left to the display to mark as reset
    return t < now - 180 * 86400_000 ? zonedToUtc(today.y + 1, mo, d, h, mi, tz) : t
  }
  const t = zonedToUtc(today.y, today.mo, today.d, h, mi, tz)
  return t < now ? t + 86400_000 : t
}

/** Year, month (0-based), day of now in a time zone; an unrecognized zone falls back to the host zone */
function dateIn(now: number, tz?: string): { y: number; mo: number; d: number } {
  if (tz) {
    try {
      const p: Record<string, string> = {}
      for (const part of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(now))) p[part.type] = part.value
      return { y: Number(p.year), mo: Number(p.month) - 1, d: Number(p.day) }
    } catch {}
  }
  const t = new Date(now)
  return { y: t.getFullYear(), mo: t.getMonth(), d: t.getDate() }
}

/**
 * Text output of `claude -p /usage` → one sample:
 * "Current session: 3% used · resets …" → five_hour; "Current week (all models)" → seven_day;
 * "Current week (Fable)" → weekly_fable (with display name). Returns null if unrecognized.
 */
export function parseUsageCommand(text: string, now: number): Sample | null {
  const w: Record<string, Obs> = {}
  // Strip color escapes and trailing whitespace before matching (\r counts as trailing whitespace)
  for (const raw of text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n')) {
    const line = raw.trimEnd()
    const m = /^\s*Current (session|week \(([^)]+)\)):\s*([\d.]+)%\s*used(?:\s*[·•-]\s*resets\s+(.+))?$/i.exec(line)
    if (!m) continue
    const scope = m[2]
    const key = !scope ? 'five_hour' : /^all models$/i.test(scope) ? 'seven_day' : quotaKey('weekly_scoped', scope)
    const r = m[4] ? parseResetText(m[4], now) : undefined
    w[key] = { u: Math.min(Math.max(Number(m[3]), 0), 100), ...(r != null ? { r } : {}), ...(scope && key.startsWith('weekly_') && key !== 'seven_day' ? { n: scope } : {}) }
  }
  return Object.keys(w).length ? { t: now, w } : null
}

/** Per-model weekly quota (e.g. weekly_fable): hints must include the model name */
export const isModelScoped = (key: string) => key.startsWith('weekly_') && key !== 'weekly_scoped'

/** Model id → family name (claude-fable-5-1 → fable), matching per-model quota weekly_<family> */
export function modelFamily(model: string | undefined): string | null {
  const m = /(fable|opus|sonnet|haiku)/i.exec(model ?? '')
  return m ? m[1].toLowerCase() : null
}

/** Time of the latest reply across local sessions: any = any model, byModel = per family */
export type Activity = { any?: number; byModel: Record<string, number> }

/**
 * When this quota was last used, taking the later of:
 * · the latest local reply (5-hour / 7-day: any model; per-model quota: that family's models) — the limit percentage is coarse,
 *   steady use may not raise it 1% in half an hour, so watching increases alone would misread it as unused;
 * · the last observed usage increase (covers use on other devices and on claude.ai).
 * If neither exists, return the earliest observation time as a lower bound.
 */
export function lastUsed(samples: readonly Sample[], key: string, activity?: Activity): { at: number; isLowerBound: boolean } | null {
  // Per-model quotas match local replies by family: weekly_fable and weekly_claude_fable both map to fable
  const act = isModelScoped(key) ? activity?.byModel[modelFamily(key) ?? key.slice('weekly_'.length)] : activity?.any
  const seen = lastIncrease(samples, key)
  if (act != null && (!seen || seen.isLowerBound || act >= seen.at)) return { at: act, isLowerBound: false }
  return seen
}

/**
 * Time of the last usage increase. Compared with the reading at the last counted increase, it must rise half a point: two sources of different precision
 * (session 64.2, cache 64) alternating won't count as an increase; on a window reset (a drop of over 5 points) restart from the new reading.
 */
function lastIncrease(samples: readonly Sample[], key: string): { at: number; isLowerBound: boolean } | null {
  let base: number | undefined
  let first: number | undefined
  let last: number | undefined
  for (const s of samples) {
    const o = s.w[key]
    if (!o) continue
    if (first == null) first = s.t
    if (base == null || o.u < base - 5) base = o.u
    else if (o.u >= base + 0.5) { last = s.t; base = o.u }
  }
  if (last != null) return { at: last, isLowerBound: false }
  return first != null ? { at: first, isLowerBound: true } : null
}

/** ~/.weektoken/samples.jsonl from the WeekToken macOS app: each line {t: seconds, rl: {key: {used_percentage, resets_at, display_name?}}} */
export function parseSamplesJsonl(text: string, nowMs = Date.now()): Sample[] {
  const out: Sample[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: { t?: unknown; rl?: unknown }
    try { row = JSON.parse(line) } catch { continue }
    if (typeof row.t !== 'number' || !row.rl || typeof row.rl !== 'object') continue
    // Convention is seconds; ms is accepted too. Drop rows with absurd times (before 2020 or after tomorrow)
    const t = row.t > 1e12 ? row.t : row.t * 1000
    if (t < 1_577_836_800_000 || t > nowMs + 86400_000) continue
    const w: Record<string, Obs> = {}
    for (const [k, v] of Object.entries(row.rl as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const o = v as Record<string, unknown>
      const used = typeof o.used_percentage === 'number' ? o.used_percentage : typeof o.used_percent === 'number' ? o.used_percent : null
      if (used == null) continue
      let r = parseReset(o.resets_at)
      if (r == null && typeof o.resets_in_seconds === 'number') r = t + o.resets_in_seconds * 1000
      w[k] = { u: pctOf(used), r, ...(typeof o.display_name === 'string' ? { n: o.display_name } : {}) }
    }
    if (Object.keys(w).length) out.push({ t, w })
  }
  return out.sort((a, b) => a.t - b.t)
}
