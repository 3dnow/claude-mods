// Pure functions: parsing, merging, inference, chart size limits. Calls hooks modules directly, bypassing the engine.
import { expect, test } from 'claude-code/testing'

import * as P from '../hooks/pace.ts'
import { burnUpSvg } from '../hooks/svg.ts'
import { identity } from '../hooks/theme.ts'

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)
const W5 = 18000

/** Continuous 5-hour samples: one every stepMin minutes, back-to-back windows, usage rising linearly to 70% in each */
function fiveHourHistory(stepMin: number, n = 8000): P.Sample[] {
  const out: P.Sample[] = []
  const t0 = NOW - n * stepMin * 60_000
  let start = t0
  for (let i = 0; i < n; i++) {
    const t = t0 + i * stepMin * 60_000
    if (t >= start + W5 * 1000) start = t
    out.push({ t, w: { five_hour: { u: Math.round(70 * ((t - start) / (W5 * 1000)) + 1), r: start + W5 * 1000 } } })
  }
  return out
}

const svgOf = (samples: P.Sample[], range: P.Range) =>
  burnUpSvg({ width: 360, overlay: P.buildOverlay('five_hour', samples, W5, range, 0, NOW), W: W5, status: 'onPace', id: identity('five_hour'), title: '5h' })

test('Burn-up chart: 8000 samples with range "all" stay under the Svg source size limit', () => {
  for (const step of [5, 10, 13, 14, 15]) {
    expect(svgOf(fiveHourHistory(step), 'all').length).toBeLessThan(131072)
  }
  const o = P.buildOverlay('five_hour', fiveHourHistory(14), W5, 'all', 0, NOW)
  expect(o.entries.length).toBeLessThanOrEqual(P.MAX_OVERLAY)
  expect(o.inRange).toBeGreaterThan(P.MAX_OVERLAY)
  expect(P.overlayCaption(o) ?? '').toContain(String(o.inRange))
})

test('Burn-up chart: past windows still draw lines when samples are sparse (gaps over 15 minutes)', () => {
  const svg = svgOf(fiveHourHistory(20, 2000), 'all')
  expect((svg.match(/<polyline/g) ?? []).length).toBeGreaterThan(10)
})

test('Same reading recorded by several sessions at different milliseconds merges into one sample', () => {
  const r = NOW + 3600_000
  const a = [{ t: NOW, w: { five_hour: { u: 40, r } } }]
  const b = [{ t: NOW + 37, w: { five_hour: { u: 40, r } } }]
  expect(P.mergeSamples(a, b).length).toBe(1)
  // Keep both if the reading changed or they are over 5 minutes apart
  expect(P.mergeSamples(a, [{ t: NOW + 37, w: { five_hour: { u: 41, r } } }]).length).toBe(2)
  expect(P.mergeSamples(a, [{ t: NOW + 6 * 60_000, w: { five_hour: { u: 40, r } } }]).length).toBe(2)
  // Different keys (session has only 5h/7d, cache also has Fable) are not duplicates
  expect(P.mergeSamples(a, [{ t: NOW + 37, w: { five_hour: { u: 40, r }, weekly_fable: { u: 3, r } } }]).length).toBe(2)
})

test('/usage reset time: "today" follows the parenthesized time zone, and a just-passed date does not roll to next year', () => {
  const now = Date.UTC(2026, 9, 3, 23, 30) // already 10-04 07:30 in Singapore
  expect(P.parseResetText('10:00pm (Asia/Singapore)', now)).toBe(Date.UTC(2026, 9, 4, 14, 0))
  expect(P.parseResetText('10:00pm (UTC)', Date.UTC(2026, 9, 3, 17, 30))).toBe(Date.UTC(2026, 9, 3, 22, 0))
  expect(P.parseResetText('Sep 30 at 5:00pm (UTC)', NOW)).toBe(Date.UTC(2026, 8, 30, 17, 0))
  expect(P.parseResetText('Jan 2 at 1:00am (UTC)', Date.UTC(2026, 11, 30))).toBe(Date.UTC(2027, 0, 2, 1, 0))
  expect(P.parseResetText('Oct 7 at 17:59 (UTC)', NOW)).toBe(Date.UTC(2026, 9, 7, 17, 59))
  expect(P.parseResetText('Oct 7 at 5:59pm (PDT)', NOW)).toBe(Date.UTC(2026, 9, 8, 0, 59))
  expect(P.parseResetText('12am (UTC)', NOW)).toBe(Date.UTC(2026, 9, 4, 0, 0))
  expect(P.parseResetText('in 2h 30m', NOW)).toBeUndefined()
})

test('/usage output: trailing whitespace and color escapes do not break parsing', () => {
  const s = P.parseUsageCommand('\x1b[1mCurrent session: 3% used  \x1b[0m\r\nCurrent week (Fable): 29% used · resets Oct 5 at 12:00pm (UTC)   \n', NOW)
  expect(s?.w.five_hour?.u).toBe(3)
  expect(s?.w.weekly_fable?.u).toBe(29)
  expect(s?.w.weekly_fable?.r).toBe(Date.UTC(2026, 9, 5, 12, 0))
})

test('"Last used": alternating readings from two sources with different precision are not a rise, only a real increase is', () => {
  const r = NOW + 86400_000
  const s = (t: number, u: number) => ({ t, w: { seven_day: { u, r } } })
  const flat = [s(NOW, 64.2), s(NOW + 60_000, 64), s(NOW + 120_000, 64.2)]
  expect(P.lastUsed(flat, 'seven_day')).toEqual({ at: NOW, isLowerBound: true })
  const rising = [...flat, s(NOW + 180_000, 65)]
  expect(P.lastUsed(rising, 'seven_day')).toEqual({ at: NOW + 180_000, isLowerBound: false })
})

test('"Last used": a prefixed quota key (weekly_claude_fable) still matches Fable model replies', () => {
  const samples = [{ t: NOW, w: { weekly_claude_fable: { u: 10, r: NOW + 86400_000 } } }]
  const act = { byModel: { fable: NOW + 600_000 } }
  expect(P.lastUsed(samples, 'weekly_claude_fable', act)).toEqual({ at: NOW + 600_000, isLowerBound: false })
})

test('macOS history: t in milliseconds is accepted, rows with implausible times are dropped', () => {
  const rows = [
    { t: NOW / 1000, rl: { five_hour: { used_percentage: 10 } } },
    { t: NOW + 60_000, rl: { five_hour: { used_percentage: 11 } } },
    { t: 1_000, rl: { five_hour: { used_percentage: 12 } } },
    { t: (NOW + 10 * 86400_000) / 1000, rl: { five_hour: { used_percentage: 13 } } },
  ]
  const out = P.parseSamplesJsonl(rows.map(r => JSON.stringify(r)).join('\n'), NOW)
  expect(out.map(s => s.t)).toEqual([NOW, NOW + 60_000])
})

test('Window length: a constant gap before first use after reset is not mistaken for a "W + gap" window', () => {
  // One sample every 20 minutes; after a reset, use resumes at the next sample and the new window starts there: jumps are always 5h 20m
  const samples: P.Sample[] = []
  let r = NOW + W5 * 1000
  for (let i = 0; i < 200; i++) {
    const t = NOW + i * 20 * 60_000
    if (t > r) r = t + W5 * 1000
    samples.push({ t, w: { five_hour: { u: 5, r } } })
  }
  expect(P.inferWindow('five_hour', samples).seconds).toBe(W5)
})

test('Local cache: a per-model quota given both at top level and in limits[] is kept only once', () => {
  const w = P.parseUtilization({
    seven_day_opus: { utilization: 12, resets_at: NOW + 86400_000 },
    limits: [{ kind: 'weekly_scoped', percent: 12, resets_at: NOW + 86400_000, scope: { model: { display_name: 'Opus' } } }],
  })
  expect(Object.keys(w).sort()).toEqual(['weekly_opus'])
})

test('Reading gap: the longest stretch of a window without a reading, up to now, once longer than the stale threshold', () => {
  const W7 = 7 * 86400
  const r = NOW + 2 * 86400_000
  const at = (h: number, u: number) => ({ t: NOW + h * 3600_000, w: { weekly_fable: { u, r: r + (h % 2 ? 300 : 0) } } })
  const stopped = [at(-72, 10), at(-60, 20), at(-48, 30)]
  expect(P.readingGap(stopped, 'weekly_fable', W7, NOW)).toEqual({ from: NOW - 48 * 3600_000, to: null, ms: 48 * 3600_000 })
  // Readings keep coming: no gap worth a word
  const steady = Array.from({ length: 40 }, (_, i) => at(-i, 50 - i))
  expect(P.readingGap(steady, 'weekly_fable', W7, NOW)).toBeNull()
  // A hole inside the window that has since filled
  const hole = [at(-72, 10), at(-71, 11), at(-20, 30), at(-1, 31)]
  expect(P.readingGap(hole, 'weekly_fable', W7, NOW)).toEqual({ from: NOW - 71 * 3600_000, to: NOW - 20 * 3600_000, ms: 51 * 3600_000 })
  expect(P.readingGap([], 'weekly_fable', W7, NOW)).toBeNull()
})

test('Thinning: the last 14 days whole, older samples one per period per set of windows, the reading before each reset kept', () => {
  const W7 = 7 * 86400_000
  const list: P.Sample[] = []
  for (let t = NOW - 90 * 86400_000; t <= NOW; t += 5 * 60_000) {
    const r = t - (t % W7) + W7
    list.push({ t, w: { seven_day: { u: Math.round(((t % W7) / W7) * 100), r } } })
  }
  const c = P.compactSamples(list, NOW)
  expect(c.length).toBeLessThan(list.length / 3)
  expect(c[0]!.t).toBe(list[0]!.t)
  expect(c.filter(s => s.t > NOW - 14 * 86400_000).length).toBe(list.filter(s => s.t > NOW - 14 * 86400_000).length)
  // Every window's last reading before its reset survives, so its peak does
  for (let i = 0; i + 1 < list.length; i++) {
    if (list[i]!.w.seven_day!.r !== list[i + 1]!.w.seven_day!.r) expect(c.some(s => s.t === list[i]!.t)).toBe(true)
  }
  // Within 30 to 45 days back, no more than one reading per 30 minutes
  const mid = c.filter(s => s.t < NOW - 30 * 86400_000 && s.t > NOW - 45 * 86400_000)
  expect(mid.length).toBeLessThanOrEqual(15 * 48 + 5)
})

test('Fitting a byte budget thins further before anything old is dropped', () => {
  const list: P.Sample[] = []
  const end = (t: number, W: number) => t - (t % W) + W
  for (let t = NOW - 200 * 86400_000; t <= NOW; t += 5 * 60_000) list.push({ t, w: { five_hour: { u: 1, r: end(t, 5 * 3600_000) }, seven_day: { u: 2, r: end(t, 7 * 86400_000) } } })
  const fit = P.fitSamples(list, NOW, 400_000)
  expect(JSON.stringify(fit).length).toBeLessThanOrEqual(400_000)
  expect(fit[0]!.t).toBe(list[0]!.t)
})


test('Quotas the usage endpoint stopped listing after their last reading are retired; listed again, they come back', () => {
  const H = 3600_000
  const samples: P.Sample[] = [
    { t: NOW - 6 * H, w: { five_hour: { u: 10, r: NOW - 2 * H }, seven_day: { u: 27, r: NOW + 3 * 86400_000 } } },
    { t: NOW - 1 * H, w: { seven_day: { u: 28, r: NOW + 3 * 86400_000 }, weekly_fable: { u: 25, r: NOW + 3 * 86400_000 } } },
  ]
  // Verified Ultra: the endpoint answers 7-day and Fable only, after the last 5-hour reading
  expect(P.retiredKeys(samples, { at: NOW, keys: ['seven_day', 'weekly_fable'] })).toEqual(['five_hour'])
  // A list older than the quota's last reading says nothing about it
  expect(P.retiredKeys(samples, { at: NOW - 7 * H, keys: ['seven_day'] })).toEqual([])
  // Listed again: back
  expect(P.retiredKeys(samples, { at: NOW, keys: ['five_hour', 'seven_day', 'weekly_fable'] })).toEqual([])
  // No list, or an empty one (an unreadable answer), retires nothing
  expect(P.retiredKeys(samples, null)).toEqual([])
  expect(P.retiredKeys(samples, { at: NOW, keys: [] })).toEqual([])
  // Only quotas the endpoint itself reports are judged
  const other: P.Sample[] = [{ t: NOW - 6 * H, w: { primary: { u: 5, r: NOW + H } } }]
  expect(P.retiredKeys(other, { at: NOW, keys: ['seven_day'] })).toEqual([])
})
