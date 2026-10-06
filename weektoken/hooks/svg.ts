// SVG drawing: pace rings, the progress bar above the input box, usage trace (burn-up, legend drawn inside the chart).
// Geometry and colors taken from the WeekToken macOS app (PaceRings / PaceBullet / BulletRenderer / BurnUpChart).
// Light/dark: SVG adapts via prefers-color-scheme and declares color-scheme: light dark — a chart in the host sandbox frame
// without it gets a white backdrop and light-mode drawing when the frame's scheme doesn't match the app (observed in dark app).
// Neutral elements (track, grid, tick labels) use translucent gray readable on both light and dark backgrounds.
// Each SVG scopes styles and gradients/filters with a unique id derived from its input: whether the host treats it as a standalone image
// or inlines it into the same page, colors never leak between charts. Pure functions, output strings only.

import { legendDates, windowLabel, type Overlay, type OverlayEntry, type Pace, type Series, type Status } from './pace.ts'
import { STATUS, type Identity, type Tri } from './theme.ts'
import { harmonizeHue, hexToOklch, oklchToHex } from './color.ts'
import { getLang, L } from './i18n.ts'

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
const f = (n: number) => (Math.round(n * 100) / 100).toString()
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi)
const FONT = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif`

/** Stable id derived from kind and input: same chart, same id; different charts never collide */
function uidOf(kind: string, data: unknown): string {
  const s = kind + JSON.stringify(data)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return `wt${kind}${(h >>> 0).toString(36)}`
}

/** Light and dark neutral palettes; identity's light/dark variants also set as CSS vars; all scoped to this chart only */
function themeStyle(uid: string, id?: Identity): string {
  const idVars = (t: 'light' | 'dark') => (id ? `--id-s:${id[t].start};--id-e:${id[t].end};--id:${id[t].solid};` : '')
  return `<style>
:root{color-scheme:light dark;background:transparent}
#${uid}{color-scheme:light dark;--track:rgba(0,0,0,.07);--grid:rgba(0,0,0,.06);--vgrid:rgba(0,0,0,.06);--diag:rgba(0,0,0,.28);--ink2:rgba(60,60,67,.62);--ink3:rgba(60,60,67,.42);--tshadow:rgba(0,0,0,.22);--mark:rgba(0,0,0,.75);${idVars('light')}}
@media (prefers-color-scheme: dark){#${uid}{--track:rgba(255,255,255,.08);--grid:rgba(255,255,255,.07);--vgrid:rgba(255,255,255,.11);--diag:rgba(255,255,255,.42);--ink2:rgba(235,235,245,.62);--ink3:rgba(235,235,245,.42);--tshadow:rgba(255,255,255,.34);--mark:rgba(255,255,255,.9);${idVars('dark')}}}
#${uid} text{font-family:${FONT}}
</style>`
}

const open = (uid: string, w: number, h: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" id="${uid}" width="${f(w)}" height="${f(h)}" viewBox="0 0 ${f(w)} ${f(h)}" style="color-scheme:light dark;background:transparent">`

/** Coordinates at progress p, clockwise from 12 o'clock */
function polar(cx: number, cy: number, r: number, p: number): [number, number] {
  const a = 2 * Math.PI * p - Math.PI / 2
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

function arcPath(cx: number, cy: number, r: number, p0: number, p1: number): string {
  const [x0, y0] = polar(cx, cy, r, p0)
  const [x1, y1] = polar(cx, cy, r, p1)
  const large = p1 - p0 > 0.5 ? 1 : 0
  return `M${f(x0)} ${f(y0)}A${f(r)} ${f(r)} 0 ${large} 1 ${f(x1)} ${f(y1)}`
}

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0')
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`
}

export type RingsInput = {
  used: number | null // U (may be absent)
  elapsed: number | null // T
  status: Status
  id: Identity
  center: { kind: 'rate'; text: string } | { kind: 'pct'; text: string } | { kind: 'none' }
  label: string
  title: string
  /** Column of readings right of the ring: small label above, number below; the accent one uses the quota color. Empty array draws the ring only */
  readings: { label: string; value: string; accent?: boolean }[]
}

/**
 * Pace rings, drawn the same way as the band bar (quota's own color family only):
 * · Outer ring = usage U: angular gradient in quota color; under pace, faint same-hue stripes from used to elapsed (headroom);
 *   over pace, the part past elapsed is one shade deeper + light stripes; when exhausted, that part uses the harmonized warm color.
 * · Inner ring = time T: thin neutral gray ring. Both rings thin with tight spacing, leaving the center for numbers.
 * · Center: number and status vertically centered as one block; font size based on the inner ring's inside diameter.
 * · Column of readings on the right, with tiered font sizes (native Text has only one size).
 */
export function ringsSvg(x: RingsInput): string {
  const u = uidOf('r', x)
  const d = 156
  const c = d / 2
  const rw = 0.075 * d
  const gap = 0.03 * d
  const rwIn = 0.035 * d
  const rO = (d - rw) / 2
  const rI = rO - rw / 2 - gap - rwIn / 2
  const Di = 2 * (rI - rwIn / 2) * 0.92
  const U = x.used == null ? 0 : clamp(x.used, 0, 1)
  const T = x.elapsed == null ? null : clamp(x.elapsed, 0, 1)
  const over = T != null && U > T
  const exhausted = x.status === 'exhausted'
  // Stripes: 45°, 5px period, 2px line width (same as band bar)
  const stripes = (id: string, back: string, backOp: number, line: string, lineOp: number) =>
    `<pattern id="${id}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="5" height="5" fill="${back}" fill-opacity="${backOp}"/><rect width="2" height="5" fill="${line}" fill-opacity="${lineOp}"/></pattern>`
  const parts: string[] = []
  parts.push(`<defs>${stripes(u + 'm', 'var(--id)', 0.1, 'var(--id)', 0.55)}${stripes(u + 'x', 'var(--deep)', 1, 'var(--id-s)', 0.35)}</defs>`)
  // Inner ring: time
  parts.push(`<circle cx="${f(c)}" cy="${f(c)}" r="${f(rI)}" fill="none" stroke="var(--track)" stroke-width="${f(rwIn)}"/>`)
  if (T != null && T > 0.002) parts.push(`<path d="${arcPath(c, c, rI, 0, Math.min(T, 0.9999))}" fill="none" stroke="var(--time)" stroke-width="${f(rwIn)}" stroke-linecap="round"/>`)
  // Outer ring: track, headroom, usage, overage
  parts.push(`<circle cx="${f(c)}" cy="${f(c)}" r="${f(rO)}" fill="none" stroke="var(--track)" stroke-width="${f(rw)}"/>`)
  if (T != null && T > U) parts.push(`<path d="${arcPath(c, c, rO, Math.max(0, U - 0.01), Math.min(T, 0.9999))}" fill="none" stroke="url(#${u}m)" stroke-width="${f(rw)}"/>`)
  const upto = over ? (T as number) : U
  if (upto > 0.002) {
    // Angular gradient approximated by segments; one group each for light and dark colors, one shown per appearance
    const n = Math.max(2, Math.ceil(upto * 72))
    const grad = (t: Tri, cls: string) => {
      const segs: string[] = []
      for (let i = 0; i < n; i++) {
        const p0 = (upto * i) / n
        const p1 = (upto * (i + 1)) / n + (i < n - 1 ? 0.002 : 0)
        segs.push(`<path d="${arcPath(c, c, rO, p0, Math.min(p1, 0.9999))}" fill="none" stroke="${mix(t.end, t.start, (i + 1) / n)}" stroke-width="${f(rw)}"/>`)
      }
      return `<g class="${cls}">${segs.join('')}</g>`
    }
    parts.push(grad(x.id.light, 'lt'), grad(x.id.dark, 'dk'))
    const [sx, sy] = polar(c, c, rO, 0)
    parts.push(`<circle cx="${f(sx)}" cy="${f(sy)}" r="${f(rw / 2)}" fill="var(--id-e)"/>`)
    if (!over) {
      const [ex, ey] = polar(c, c, rO, Math.min(upto, 0.9999))
      parts.push(`<circle cx="${f(ex)}" cy="${f(ey)}" r="${f(rw / 2)}" fill="var(--id-s)"/>`)
    }
  }
  if (over) {
    const paint = exhausted ? 'var(--warm)' : `url(#${u}x)`
    parts.push(`<path d="${arcPath(c, c, rO, T as number, Math.min(U, 0.9999))}" fill="none" stroke="${paint}" stroke-width="${f(rw)}"/>`)
    if (U < 0.999) {
      const [ex, ey] = polar(c, c, rO, U)
      parts.push(`<circle cx="${f(ex)}" cy="${f(ey)}" r="${f(rw / 2)}" fill="${paint}"/>`)
    }
  }
  // Center: number + status, vertically centered as one block
  const em = 0.25 * Di
  const lf = Math.max(10, 0.1 * Di)
  const lead = 0.07 * Di
  const nb = c - (0.72 * em + lead + 0.72 * lf) / 2 + 0.72 * em
  if (x.center.kind === 'rate') {
    parts.push(`<text x="${f(c)}" y="${f(nb)}" text-anchor="middle" font-size="${f(em)}" font-weight="600" fill="var(--ink)" style="font-variant-numeric:tabular-nums;letter-spacing:-.02em">${esc(x.center.text)}<tspan font-size="${f(em * 0.55)}" font-weight="500" fill="var(--ink3)" dx="1.5">×</tspan></text>`)
  } else {
    const t = x.center.kind === 'pct' ? x.center.text : '—'
    parts.push(`<text x="${f(c)}" y="${f(nb)}" text-anchor="middle" font-size="${f(em)}" font-weight="600" fill="${x.center.kind === 'pct' ? 'var(--ink)' : 'var(--ink3)'}" style="font-variant-numeric:tabular-nums;letter-spacing:-.02em">${esc(t)}</text>`)
  }
  parts.push(`<text x="${f(c)}" y="${f(nb + lead + 0.72 * lf)}" text-anchor="middle" font-size="${f(lf)}" font-weight="500" fill="var(--ink2)">${esc(x.label)}</text>`)
  // Column of readings on the right
  const LS = 10
  const VS = 22
  const rx = d + 24
  // Chinese labels too small at 10px, use 11px; width estimate runs narrow (% and bold digits are wider), so pad it
  const lsOf = (t: string) => (/[\u2E80-\u9FFF]/.test(t) ? 11 : LS)
  const colW = x.readings.reduce((a, r) => Math.max(a, textWidth(r.value, VS) * 1.15, textWidth(r.label, lsOf(r.label)) * 1.2), 0) + 6
  const step = 46
  const top = (d - (x.readings.length * step - 8)) / 2
  x.readings.forEach((r, i) => {
    const y = top + i * step
    const col = r.accent ? (exhausted ? 'var(--warm)' : 'var(--id)') : 'var(--ink)'
    parts.push(`<text x="${f(rx)}" y="${f(y + 9)}" font-size="${lsOf(r.label)}" font-weight="600" fill="var(--ink3)" style="letter-spacing:.09em">${esc(r.label)}</text>` +
      `<text x="${f(rx)}" y="${f(y + 33)}" font-size="${VS}" font-weight="600" fill="${col}" style="font-variant-numeric:tabular-nums;letter-spacing:-.01em">${esc(r.value)}</text>`)
  })
  const W = x.readings.length ? Math.ceil(rx + colW) : d
  const ol = overTones(x.id.light)
  const od = overTones(x.id.dark)
  const vars = `<style>#${u}{--ink:#1d1d1f;--time:#8E8E93;--deep:${ol.deep};--warm:${ol.warm}}#${u} .dk{display:none}` +
    `@media (prefers-color-scheme: dark){#${u}{--ink:#f5f5f7;--deep:${od.deep};--warm:${od.warm}}#${u} .lt{display:none}#${u} .dk{display:inline}}</style>`
  return `${open(u, W, d)}${themeStyle(u, x.id)}${vars}<title>${esc(x.title)}</title>${parts.join('')}</svg>`
}

/**
 * Band progress bar, following Apple Fitness rings' "past the goal = one shade deeper", quota's own color family only:
 * · Using slower than time: faint same-hue stripes behind the usage bar from used to elapsed, the remaining headroom;
 * · Using faster than time: the part past elapsed turns one shade deeper (OKLCH lightness down 0.13), with light stripes in the bright-end hue;
 * · Exhausted: that part is solid warm — persimmon hue rotated toward the quota color via Material 3 harmonize, lightness/chroma matched to it.
 * Method: see docs/COLOR-METHOD-2026-10-04.md.
 * A numeric width is fixed (the small collapsed bar); 'fluid' gives 100% width with all geometry in percent,
 * stretched by the host to the band's remaining width: only lengthens, never distorts (corner radii unchanged).
 */
export function bandBarSvg(pace: Pace | null, used: number | null, status: Status, id: Identity, title: string, width: number | 'fluid' = 120): string {
  const u = uidOf('n', [pace?.used, pace?.elapsed, used, status, id, title, width])
  const fluid = width === 'fluid'
  const h = 14
  const bh = 8
  const y = (h - bh) / 2
  const r = bh / 2
  const st = STATUS[status]
  // Fixed width: pixels (with minimum width); fluid: percent
  const W = (frac: number, min = 0) => (fluid ? `${f(clamp(frac, 0, 1) * 100)}%` : f(Math.max(min, (width as number) * clamp(frac, 0, 1))))
  const X = (frac: number) => (fluid ? `${f(clamp(frac, 0, 1) * 100)}%` : f((width as number) * clamp(frac, 0, 1)))
  // Stripes: 45°, 5px period, 2px line width
  const stripes = (id: string, back: string, backOp: number, line: string, lineOp: number) =>
    `<pattern id="${id}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="5" height="5" fill="${back}" fill-opacity="${backOp}"/><rect width="2" height="5" fill="${line}" fill-opacity="${lineOp}"/></pattern>`
  const exhausted = status === 'exhausted'
  const parts: string[] = []
  parts.push(`<defs><linearGradient id="${u}u" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="var(--id-e)"/><stop offset="1" stop-color="var(--id-s)"/></linearGradient>` +
    stripes(u + 'm', 'var(--id)', 0.1, 'var(--id)', 0.55) +
    stripes(u + 'x', 'var(--deep)', 1, 'var(--id-s)', 0.35) +
    `<clipPath id="${u}t"><rect y="${y}" width="${fluid ? '100%' : width}" height="${bh}" rx="${r}"/></clipPath></defs>`)
  parts.push(`<rect y="${y}" width="${fluid ? '100%' : width}" height="${bh}" rx="${r}" fill="var(--track)"/>`)
  if (pace) {
    const T = clamp(pace.elapsed, 0, 1)
    const U = clamp(pace.used, 0, 1)
    // Headroom: from used to elapsed, behind the usage bar (its round cap hides the seam)
    if (T > U) parts.push(`<g clip-path="url(#${u}t)"><rect y="${y}" width="${X(T)}" height="${bh}" fill="url(#${u}m)"/></g>`)
    if (U > 0) {
      parts.push(`<rect y="${y}" width="${W(U, bh)}" height="${bh}" rx="${r}" fill="url(#${u}u)"/>`)
      // Overage: from elapsed to used, clipped to the usage bar's shape, round cap kept
      if (U > T) {
        parts.push(`<clipPath id="${u}c"><rect y="${y}" width="${W(U, bh)}" height="${bh}" rx="${r}"/></clipPath>`)
        parts.push(`<g clip-path="url(#${u}c)"><rect x="${X(T)}" y="${y}" width="${X(U - T)}" height="${bh}" fill="${exhausted ? 'var(--warm)' : `url(#${u}x)`}"/></g>`)
      }
    }
  } else if (used != null && used > 0) {
    parts.push(`<rect y="${y}" width="${W(used, bh)}" height="${bh}" rx="${r}" fill="url(#${u}u)"/>`)
  }
  // Bar is thin, so the track is darker than in the panel to show the full length
  // Fluid bar is a plain height-only image (no interactive frame, it flickers on panel redraw): root declares no width, all geometry in percent
  const ol = overTones(id.light)
  const od = overTones(id.dark)
  const track = `<style>#${u}{--track:rgba(0,0,0,.13);--deep:${ol.deep};--warm:${ol.warm}}@media (prefers-color-scheme: dark){#${u}{--track:rgba(255,255,255,.16);--deep:${od.deep};--warm:${od.warm}}}</style>`
  const head = fluid
    ? `<svg xmlns="http://www.w3.org/2000/svg" id="${u}" width="100%" height="${h}" style="display:block;overflow:visible;color-scheme:light dark;background:transparent">`
    : open(u, width as number, h)
  return `${head}${themeStyle(u, id)}${track}<title>${esc(title)}</title>${parts.join('')}</svg>`
}

/**
 * Credit line at the panel's bottom-right: one line of 10px translucent text (native Text can't set font size, and nothing is fainter than dimColor).
 * textLength pins the width; a different font only changes spacing and never overflows the image.
 */
export function creditSvg(text: string): string {
  const u = uidOf('c', text)
  const size = 10
  const w = Math.ceil(textWidth(text, size)) + 2
  const h = 14
  return `${open(u, w, h)}<style>:root{color-scheme:light dark;background:transparent}#${u} text{font-family:${FONT};fill:rgba(60,60,67,.42)}@media (prefers-color-scheme: dark){#${u} text{fill:rgba(235,235,245,.36)}}</style>` +
    `<title>${esc(text)}</title><text x="${w - 1}" y="10.5" font-size="${size}" text-anchor="end" textLength="${w - 2}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text></svg>`
}

/** OKLCH hue of persimmon orange: starting point for the exhausted warm color, then harmonized toward the quota color */
const WARM_HUE = 32.68

/** Two colors for the overage part: one shade deeper (over pace) and harmonized warm (exhausted), both derived from the quota color */
function overTones(t: Tri): { deep: string; warm: string } {
  const [L, C, H] = hexToOklch(t.solid)
  return {
    deep: oklchToHex(Math.max(0.3, L - 0.13), C * 1.05, H),
    warm: oklchToHex(L - 0.02, Math.max(C, 0.15), harmonizeHue(WARM_HUE, H)),
  }
}

export type BurnUpInput = {
  width: number
  overlay: Overlay
  W: number
  status: Status
  id: Identity
  title: string
  /** Per-line inspection: drawn in an interactive frame; the hovered line thickens and shows its date and peak, others fade */
  interactive?: boolean
}

const f1 = (n: number) => (Math.round(n * 10) / 10).toString()

/** Join adjacent segments separated only by data gaps (not mid-window resets) into one */
function joinGaps(s: Series): Series['segments'] {
  const gapStarts = new Set(s.gaps.map(g => g.to))
  const out: Series['segments'] = []
  for (const seg of s.segments) {
    if (out.length && gapStarts.has(seg[0])) out[out.length - 1] = [...out[out.length - 1], ...seg]
    else out.push(seg)
  }
  return out
}

/** Estimate text width: CJK chars at 1em, others at 0.56em (for legend wrapping) */
const textWidth = (s: string, size: number) => [...s].reduce((a, ch) => a + (/[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? size : size * 0.56), 0)

/**
 * Usage trace: x = time position in window, y = usage; dashed diagonal for ideal pace; past windows overlaid, opacity by recency; current window has projection and exhaustion line.
 * Legend drawn at the bottom of the same chart, line styles matched one-to-one with labels; width set to the panel's usual width so text stays legible when scaled.
 */
export function burnUpSvg(x: BurnUpInput): string {
  const u = uidOf('u', [x.width, x.W, x.status, x.id, x.title, getLang(), x.overlay.entries.map(e => [e.series.reset, e.series.segments.length, e.series.peak, e.recency]), !!x.interactive])
  const Wd = x.width
  const left = 32
  const right = 8
  const top = 8
  const h = 150
  const w = Wd - left - right
  const X = (e: number) => left + w * clamp(e, 0, 1)
  const Y = (v: number) => top + h * (1 - clamp(v, 0, 1))
  const days = Math.max(1, Math.round(x.W / 86400))
  const st = STATUS[x.status]
  const TF = 10
  const p: string[] = []
  p.push(`<defs><linearGradient id="${u}r" x1="0" x2="1"><stop offset="0" stop-color="var(--id)" stop-opacity=".22"/><stop offset="1" stop-color="var(--id)"/></linearGradient></defs>`)
  // Grid
  for (let i = 1; i <= 3; i++) p.push(`<line x1="${left}" x2="${f(left + w)}" y1="${f(top + (h * i) / 4)}" y2="${f(top + (h * i) / 4)}" stroke="var(--grid)"/>`)
  for (let i = 1; i < Math.max(2, days); i++) {
    const gx = left + (w * i) / days
    if (gx < left + w - 0.5) p.push(`<line x1="${f(gx)}" x2="${f(gx)}" y1="${top}" y2="${f(top + h)}" stroke="var(--vgrid)"/>`)
  }
  p.push(`<rect x="${left}" y="${top}" width="${f(w)}" height="${f(h)}" fill="none" stroke="var(--grid)"/>`)
  // Ticks
  for (const v of [0, 50, 100]) p.push(`<text x="${left - 5}" y="${f(Y(v / 100) + 3.5)}" text-anchor="end" font-size="${TF}" fill="var(--ink3)">${v}%</text>`)
  const axisY = top + h + 14
  if (days > 1) {
    for (let dd = 0; dd <= days; dd++) p.push(`<text x="${f(clamp(left + (w * dd) / days, left + 12, left + w - 12))}" y="${f(axisY)}" text-anchor="middle" font-size="${TF}" fill="var(--ink3)">${L(`${dd}天`, `${dd}d`)}</text>`)
  } else {
    p.push(`<text x="${left}" y="${f(axisY)}" font-size="${TF}" fill="var(--ink3)">${L('开始', 'Start')}</text><text x="${f(left + w)}" y="${f(axisY)}" text-anchor="end" font-size="${TF}" fill="var(--ink3)">${L('重置', 'Reset')}</text>`)
  }
  // Ideal pace diagonal
  p.push(`<line x1="${f(X(0))}" y1="${f(Y(0))}" x2="${f(X(1))}" y2="${f(Y(1))}" stroke="var(--diag)" stroke-width="1.2" stroke-dasharray="4 4"/>`)
  // Keep at most first and last points per pixel column, coordinates to one decimal: source length stays bounded however many points
  const poly = (pts: { elapsed: number; used: number }[]) => {
    const kept: { x: number; y: number; col: number }[] = []
    for (const q of pts) {
      const pt = { x: X(q.elapsed), y: Y(q.used), col: Math.round(X(q.elapsed)) }
      const n = kept.length
      if (n >= 2 && kept[n - 1].col === pt.col && kept[n - 2].col === pt.col) kept[n - 1] = pt
      else kept.push(pt)
    }
    return kept.map(k => `${f1(k.x)},${f1(k.y)}`).join(' ')
  }
  const entries = x.overlay.entries
  // Past windows: opacity rises with recency; segments separated by "no data" are joined directly (with sparse sampling each point is its own segment,
  // so drawing only multi-point segments would draw nothing); still broken at mid-window resets.
  // With per-line inspection, one group per window: an invisible wide hit line (easy to target), the original line, a hover-only label
  const hover = !!x.interactive
  const history = entries.slice(0, -1)
  const TF2 = 10.5
  // Labels all drawn on the top layer (not covered by later lines), matched to their group by index
  const labels: string[] = []
  let gi = 0
  const tag = (e: OverlayEntry, lp: { elapsed: number; used: number }) => {
    const text = `${windowLabel(e.series.reset, x.W, e.isCurrent)} · ${L('峰值', 'peak')} ${Math.round(e.series.peak * 100)}%`
    const pw = textWidth(text, TF2) + 16
    const px = clamp(X(lp.elapsed) - pw - 6, left, Wd - right - pw)
    const py = clamp(Y(lp.used) - 26, top, top + h - 18)
    labels.push(`<g class="lbl l${gi}"><rect x="${f(px)}" y="${f(py)}" width="${f(pw)}" height="18" rx="9" fill="var(--tip-bg)" stroke="var(--tip-bd)"/>` +
      `<text x="${f(px + pw / 2)}" y="${f(py + 12.5)}" text-anchor="middle" font-size="${TF2}" fill="var(--tip-fg)">${esc(text)}</text></g>`)
    return `w w${gi++}`
  }
  const lastPoint = (runs: { elapsed: number; used: number }[][]) => { const r = runs[runs.length - 1]; return r[r.length - 1] }
  // Hit lines only need to be easy to target (12px wide); one integer point per 4px is enough, adding only ~10% to source size
  const coarse = (pts: { elapsed: number; used: number }[]) => {
    const out: string[] = []
    let col = NaN
    pts.forEach((q, i) => {
      const c = Math.round(X(q.elapsed) / 4)
      if (c !== col || i === pts.length - 1) { out.push(`${Math.round(X(q.elapsed))},${Math.round(Y(q.used))}`); col = c }
    })
    return out.join(' ')
  }
  const hits = (runs: { elapsed: number; used: number }[][]) => runs.map(run => `<polyline class="hit" points="${coarse(run)}"/>`).join('')
  history.forEach(e => {
    const op = 0.4 + 0.52 * e.recency
    const runs = joinGaps(e.series).filter(run => run.length >= 2).map(run => ({ run, pts: poly(run) }))
    const lines = runs.map(({ pts }) => `<polyline class="ln" points="${pts}" fill="none" stroke="var(--id)" stroke-opacity="${f(op)}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`).join('')
    if (!hover || !runs.length) { p.push(lines); return }
    p.push(`<g class="${tag(e, lastPoint(runs.map(r => r.run)))}">${hits(runs.map(r => r.run))}${lines}</g>`)
  })
  const fo = x.overlay.focused
  const cur = fo?.isCurrent ? fo.series : null
  if (fo) {
    const s = fo.series
    for (const m of s.midResets) p.push(`<line x1="${f(X(m.before.elapsed))}" x2="${f(X(m.before.elapsed))}" y1="${top}" y2="${f(top + h)}" stroke="var(--ink3)" stroke-dasharray="1 3"/>`)
    const gapLines = s.gaps.map(g => `<line class="gp" x1="${f(X(g.from.elapsed))}" y1="${f(Y(g.from.used))}" x2="${f(X(g.to.elapsed))}" y2="${f(Y(g.to.used))}" stroke="var(--id)" stroke-opacity=".3" stroke-width="1.5" stroke-dasharray="2 3"/>`).join('')
    const segs = s.segments.filter(seg => seg.length >= 2).map(seg => ({ seg, pts: poly(seg) }))
    const lines = segs.map(({ pts }) => `<polyline class="ln" points="${pts}" fill="none" stroke="var(--id)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`).join('')
    // Hit lines reuse the "join gaps" path: still targetable when sampling is sparse and each segment has one point
    const joined = joinGaps(s).filter(run => run.length >= 2)
    if (hover && joined.length) p.push(`<g class="${tag(fo, lastPoint(joined))}">${hits(joined)}${gapLines}${lines}</g>`)
    else p.push(gapLines, lines)
    if (cur) {
      if (cur.projection) p.push(`<line x1="${f(X(cur.projection.from.elapsed))}" y1="${f(Y(cur.projection.from.used))}" x2="${f(X(cur.projection.to.elapsed))}" y2="${f(Y(cur.projection.to.used))}" stroke="${st.solid}" stroke-opacity=".85" stroke-width="1.5" stroke-dasharray="5 3"/>`)
      const lastSeg = cur.segments[cur.segments.length - 1]
      const lp = lastSeg[lastSeg.length - 1]
      p.push(`<circle cx="${f(X(lp.elapsed))}" cy="${f(Y(lp.used))}" r="3.5" fill="var(--id)"/>`)
      if (cur.exhaustionAt != null) p.push(`<line x1="${f(X(cur.exhaustionAt))}" x2="${f(X(cur.exhaustionAt))}" y1="${top}" y2="${f(top + h)}" stroke="#D03B3B" stroke-opacity=".7" stroke-dasharray="2 2"/>`)
    }
  }
  p.push(...labels)
  // Legend: each item's line style matches its line in the chart
  const items: { mark: string; text: string }[] = []
  const dates = legendDates(x.overlay)
  if (dates) items.push({ mark: `<rect y="2" width="16" height="4" rx="2" fill="url(#${u}r)"/>`, text: `${dates.from} → ${dates.to}` })
  else items.push({ mark: `<line x1="0" y1="4" x2="16" y2="4" stroke="var(--id)" stroke-width="2.2" stroke-linecap="round"/>`, text: L('用量', 'Usage') })
  items.push({ mark: `<line x1="0" y1="4" x2="16" y2="4" stroke="var(--diag)" stroke-width="1.2" stroke-dasharray="4 3"/>`, text: L('匀速线', 'Even pace') })
  if (cur?.projection) items.push({ mark: `<line x1="0" y1="4" x2="16" y2="4" stroke="${st.solid}" stroke-opacity=".85" stroke-width="1.5" stroke-dasharray="5 3"/>`, text: L('按近期速度', 'Recent rate') })
  if (cur?.exhaustionAt != null) items.push({ mark: `<line x1="8" y1="-1" x2="8" y2="9" stroke="#D03B3B" stroke-opacity=".7" stroke-dasharray="2 2"/>`, text: L('用完', 'Runs out') })
  if (fo?.series.gaps.length) items.push({ mark: `<line x1="0" y1="4" x2="16" y2="4" stroke="var(--id)" stroke-opacity=".3" stroke-width="1.5" stroke-dasharray="2 3"/>`, text: L('无数据', 'No data') })
  const LF = 11
  let lx = left
  let ly = axisY + 20
  for (const it of items) {
    const iw = 21 + textWidth(it.text, LF)
    if (lx > left && lx + iw > Wd - right) { lx = left; ly += 17 }
    p.push(`<g transform="translate(${f(lx)},${f(ly - 8)})">${it.mark}</g><text x="${f(lx + 21)}" y="${f(ly)}" font-size="${LF}" fill="var(--ink2)">${esc(it.text)}</text>`)
    lx += iw + 12
  }
  const H = ly + 5
  // Per-line inspection styles: hovered group thickens and shows its label, other groups fade; labels don't block the pointer
  const hoverStyle = hover
    ? `<style>#${u}{--tip-bg:rgba(255,255,255,.96);--tip-fg:#1d1d1f;--tip-bd:rgba(0,0,0,.14)}` +
      `@media (prefers-color-scheme: dark){#${u}{--tip-bg:rgba(30,30,32,.94);--tip-fg:#f5f5f7;--tip-bd:rgba(255,255,255,.18)}}` +
      `#${u} .w .hit{fill:none;stroke:transparent;stroke-width:12;pointer-events:stroke}` +
      `#${u} .lbl{opacity:0;pointer-events:none}` + labels.map((_, i) => `#${u}:has(.w${i}:hover) .l${i}`).join(',') + `{opacity:1}` +
      `#${u} .w:hover .ln{stroke-opacity:1;stroke-width:2.6}#${u} .w:hover .gp{stroke-opacity:.85}#${u}:has(.w:hover) .w:not(:hover) .ln{stroke-opacity:.12}</style>`
    : ''
  return `${open(u, Wd, H)}${themeStyle(u, x.id)}${hoverStyle}<title>${esc(x.title)}</title>${p.join('')}</svg>`
}
