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
