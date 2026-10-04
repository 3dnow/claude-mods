// SVG 绘图:配速环、输入框上方的进度条、用量轨迹(burn-up,图例画在图内)。
// 几何与配色取自 WeekToken macOS 版(PaceRings / PaceBullet / BulletRenderer / BurnUpChart)。
// 深浅色:SVG 用 prefers-color-scheme 自适应,并声明 color-scheme: light dark——画在宿主沙箱框里的图
// 若不声明,框的配色方案对不上应用时会垫一块白底、里面还按浅色画(深色应用里实测如此)。
// 中性元素(轨道、网格、刻度字)用深浅背景都看得清的半透明灰。
// 每个 SVG 用由输入算出的唯一 id 给样式和渐变/滤镜做作用域:宿主无论把它当独立图片
// 还是内联进同一页面,彼此都不会串色。纯函数,只产出字符串。

import { legendDates, type Overlay, type Pace, type Series, type Status } from './pace.ts'
import { STATUS, type Identity, type Tri } from './theme.ts'
import { harmonizeHue, hexToOklch, oklchToHex } from './color.ts'
import { getLang, L } from './i18n.ts'

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
const f = (n: number) => (Math.round(n * 100) / 100).toString()
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi)
const FONT = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif`

/** 由种类和输入算出的稳定 id:同样的图同样的 id,不同的图互不干扰 */
function uidOf(kind: string, data: unknown): string {
  const s = kind + JSON.stringify(data)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return `wt${kind}${(h >>> 0).toString(36)}`
}

/** 深浅两套中性色;identity 的深浅两版也一并挂成 CSS 变量;全部只作用于这一张图 */
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

/** 从 12 点钟方向顺时针,进度 p 处的坐标 */
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
  used: number | null // U(可能没有)
  elapsed: number | null // T
  status: Status
  id: Identity
  center: { kind: 'rate'; text: string } | { kind: 'pct'; text: string } | { kind: 'none' }
  label: string
  title: string
}

/** 配速环:外环 = 用量 U(深→亮的角向渐变,尖端最亮 + 端帽),内环 = 时间 T(状态色);超速时光晕呼吸 */
export function ringsSvg(x: RingsInput): string {
  const u = uidOf('r', x)
  const d = 156
  const pad = 14
  const size = d + pad * 2
  const c = size / 2
  const rw = 0.088 * d
  const rOuter = (d - rw) / 2
  const innerD = d - 2 * (2 * rw)
  const rwIn = 0.5 * rw
  const rInner = (innerD - rwIn) / 2
  const st = STATUS[x.status]
  const U = x.used == null ? 0 : clamp(x.used, 0, 1)
  const T = x.elapsed == null ? 0 : clamp(x.elapsed, 0, 1)
  const parts: string[] = []
  // 光晕(只有超速才呼吸)
  const pulse = x.status === 'overPace'
    ? `<animate attributeName="opacity" values=".75;1;.75" dur="3.2s" repeatCount="indefinite"/><animateTransform attributeName="transform" type="scale" additive="sum" values="1;1.06;1" dur="3.2s" repeatCount="indefinite"/>`
    : ''
  parts.push(`<defs><radialGradient id="${u}g"><stop offset="16%" stop-color="var(--id)" stop-opacity=".14"/><stop offset="100%" stop-color="var(--id)" stop-opacity="0"/></radialGradient><filter id="${u}b" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6"/></filter><filter id="${u}s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="3.5" flood-color="var(--id)" flood-opacity=".45"/></filter><linearGradient id="${u}t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--id)"/><stop offset="1" stop-color="var(--id-e)"/></linearGradient></defs>`)
  parts.push(`<g transform="translate(${f(c)} ${f(c)})"><g><circle r="${f(0.62 * d)}" fill="url(#${u}g)" filter="url(#${u}b)"/>${pulse}</g></g>`)
  // 内环:时间
  parts.push(`<circle cx="${f(c)}" cy="${f(c)}" r="${f(rInner)}" fill="none" stroke="var(--track)" stroke-width="${f(rwIn)}"/>`)
  if (T > 0.002) parts.push(`<path d="${arcPath(c, c, rInner, 0, Math.min(T, 0.9999))}" fill="none" stroke="${st.solid}" stroke-width="${f(rwIn)}" stroke-linecap="round"/>`)
  // 外环:用量(分段近似角向渐变,尖端最亮)
  parts.push(`<circle cx="${f(c)}" cy="${f(c)}" r="${f(rOuter)}" fill="none" stroke="var(--track)" stroke-width="${f(rw)}"/>`)
  if (U > 0.002) {
    const span = Math.max(0.02, Math.min(U, 0.9999))
    const n = Math.max(2, Math.ceil(span * 72))
    const segs: string[] = []
    for (let i = 0; i < n; i++) {
      const p0 = (span * i) / n
      const p1 = (span * (i + 1)) / n + (i < n - 1 ? 0.002 : 0)
      segs.push(`<path d="${arcPath(c, c, rOuter, p0, p1)}" fill="none" stroke="${mix(x.id.light.end, x.id.light.start, (i + 1) / n)}" stroke-width="${f(rw)}"/>`)
    }
    const [sx, sy] = polar(c, c, rOuter, 0)
    parts.push(`<g filter="url(#${u}s)">${segs.join('')}<circle cx="${f(sx)}" cy="${f(sy)}" r="${f(rw / 2)}" fill="${x.id.light.end}"/></g>`)
    if (U > 0.015) {
      const [ex, ey] = polar(c, c, rOuter, span)
      parts.push(`<circle cx="${f(ex)}" cy="${f(ey)}" r="${f(rw / 2)}" fill="${x.id.light.start}"/>`)
      parts.push(`<circle cx="${f(ex)}" cy="${f(ey - 0.16 * rw)}" r="${f(0.17 * rw)}" fill="#fff" fill-opacity=".5"/>`)
    }
  }
  // 中心:倍率 R / 用量百分比 / —,下面是状态标签
  if (x.center.kind === 'rate') {
    parts.push(`<text x="${f(c)}" y="${f(c + 6)}" text-anchor="middle" font-size="${f(0.215 * d)}" font-weight="600" fill="url(#${u}t)" style="font-variant-numeric:tabular-nums">${esc(x.center.text)}<tspan font-size="${f(0.13 * d)}" font-weight="500" fill="var(--id)" fill-opacity=".65" dx="1">×</tspan></text>`)
  } else {
    const t = x.center.kind === 'pct' ? x.center.text : '—'
    parts.push(`<text x="${f(c)}" y="${f(c + 6)}" text-anchor="middle" font-size="${f(0.2 * d)}" font-weight="600" fill="${x.center.kind === 'pct' ? 'var(--ink2)' : 'var(--ink3)'}" style="font-variant-numeric:tabular-nums">${esc(t)}</text>`)
  }
  parts.push(`<text x="${f(c)}" y="${f(c + 26)}" text-anchor="middle" font-size="${f(0.072 * d)}" font-weight="500" fill="var(--ink2)">${esc(x.label)}</text>`)
  return `${open(u, size, size)}${themeStyle(u, x.id)}<title>${esc(x.title)}</title>${parts.join('')}</svg>`
}

/**
 * 横条的进度条,照 Apple 健身圆环「超过了就同色深一档」的做法,只用配额自己的色系:
 * · 用得比时间慢:用量条后面、从已用到已过画同色淡斜线,是还剩的余量;
 * · 用得比时间快:超出时间的那段换成同色深一档(OKLCH 明度降 0.13),叠同色亮端的浅斜线;
 * · 用尽:那段实心暖色——柿子橙的色相按 Material 3 harmonize 朝配额颜色转,明度彩度对齐配额颜色。
 * 方法见 docs/COLOR-METHOD-2026-10-04.md。
 * width 给数字是定宽(收起时的小条);给 'fluid' 则宽度 100%、几何全用百分比,
 * 由宿主按横条剩余宽度拉伸,只变长不变形(圆角保持原样)。
 */
export function bandBarSvg(pace: Pace | null, used: number | null, status: Status, id: Identity, title: string, width: number | 'fluid' = 120): string {
  const u = uidOf('n', [pace?.used, pace?.elapsed, used, status, id, title, width])
  const fluid = width === 'fluid'
  const h = 14
  const bh = 8
  const y = (h - bh) / 2
  const r = bh / 2
  const st = STATUS[status]
  // 定宽时按像素算(含最小宽度),流式时按百分比
  const W = (frac: number, min = 0) => (fluid ? `${f(clamp(frac, 0, 1) * 100)}%` : f(Math.max(min, (width as number) * clamp(frac, 0, 1))))
  const X = (frac: number) => (fluid ? `${f(clamp(frac, 0, 1) * 100)}%` : f((width as number) * clamp(frac, 0, 1)))
  // 斜线:45°、周期 5px、线宽 2px
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
    // 余量:从已用画到已过,在用量条后面(用量条的圆头盖住接缝)
    if (T > U) parts.push(`<g clip-path="url(#${u}t)"><rect y="${y}" width="${X(T)}" height="${bh}" fill="url(#${u}m)"/></g>`)
    if (U > 0) {
      parts.push(`<rect y="${y}" width="${W(U, bh)}" height="${bh}" rx="${r}" fill="url(#${u}u)"/>`)
      // 超出:从已过画到已用,裁成用量条的形状,圆头不变
      if (U > T) {
        parts.push(`<clipPath id="${u}c"><rect y="${y}" width="${W(U, bh)}" height="${bh}" rx="${r}"/></clipPath>`)
        parts.push(`<g clip-path="url(#${u}c)"><rect x="${X(T)}" y="${y}" width="${X(U - T)}" height="${bh}" fill="${exhausted ? 'var(--warm)' : `url(#${u}x)`}"/></g>`)
      }
    }
  } else if (used != null && used > 0) {
    parts.push(`<rect y="${y}" width="${W(used, bh)}" height="${bh}" rx="${r}" fill="url(#${u}u)"/>`)
  }
  // 条很细,轨道要比面板里的深一些,才看得出整根有多长
  // 流式条画成只给高度的普通图片(不用可交互框,框会随面板重画而闪):根元素不声明宽度,几何全用百分比
  const ol = overTones(id.light)
  const od = overTones(id.dark)
  const track = `<style>#${u}{--track:rgba(0,0,0,.13);--deep:${ol.deep};--warm:${ol.warm}}@media (prefers-color-scheme: dark){#${u}{--track:rgba(255,255,255,.16);--deep:${od.deep};--warm:${od.warm}}}</style>`
  const head = fluid
    ? `<svg xmlns="http://www.w3.org/2000/svg" id="${u}" width="100%" height="${h}" style="display:block;overflow:visible;color-scheme:light dark;background:transparent">`
    : open(u, width as number, h)
  return `${head}${themeStyle(u, id)}${track}<title>${esc(title)}</title>${parts.join('')}</svg>`
}

/**
 * 面板右下角的署名:10px、半透明的一行小字(原生 Text 定不了字号,也没有比 dimColor 更淡的)。
 * textLength 钉住宽度,换了字体只改字距,不会挤出图外。
 */
export function creditSvg(text: string): string {
  const u = uidOf('c', text)
  const size = 10
  const w = Math.ceil(textWidth(text, size)) + 2
  const h = 14
  return `${open(u, w, h)}<style>:root{color-scheme:light dark;background:transparent}#${u} text{font-family:${FONT};fill:rgba(60,60,67,.42)}@media (prefers-color-scheme: dark){#${u} text{fill:rgba(235,235,245,.36)}}</style>` +
    `<title>${esc(text)}</title><text x="${w - 1}" y="10.5" font-size="${size}" text-anchor="end" textLength="${w - 2}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text></svg>`
}

/** 柿子橙的 OKLCH 色相:用尽时暖色的出发点,再朝配额颜色协调 */
const WARM_HUE = 32.68

/** 超出段的两个颜色:同色深一档(超速)、协调过的暖色(用尽),都由配额颜色算出 */
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
}

const f1 = (n: number) => (Math.round(n * 10) / 10).toString()

/** 把只隔着数据空隙(不是窗口中途重置)的相邻几段接成一条 */
function joinGaps(s: Series): Series['segments'] {
  const gapStarts = new Set(s.gaps.map(g => g.to))
  const out: Series['segments'] = []
  for (const seg of s.segments) {
    if (out.length && gapStarts.has(seg[0])) out[out.length - 1] = [...out[out.length - 1], ...seg]
    else out.push(seg)
  }
  return out
}

/** 估算文字宽度:中日韩字符按 1em,其余按 0.56em(图例换行用) */
const textWidth = (s: string, size: number) => [...s].reduce((a, ch) => a + (/[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch) ? size : size * 0.56), 0)

/**
 * 用量轨迹:x = 窗口内时间位置,y = 用量;理想配速对角虚线;历史窗口按新旧深浅叠画;当前窗口带外推与耗尽线。
 * 图例画在同一张图的底部,线型和说明一一对上;宽度按面板常见宽度定,缩放时字也够大。
 */
export function burnUpSvg(x: BurnUpInput): string {
  const u = uidOf('u', [x.width, x.W, x.status, x.id, x.title, getLang(), x.overlay.entries.map(e => [e.series.reset, e.series.segments.length, e.series.peak, e.recency])])
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
  // 网格
  for (let i = 1; i <= 3; i++) p.push(`<line x1="${left}" x2="${f(left + w)}" y1="${f(top + (h * i) / 4)}" y2="${f(top + (h * i) / 4)}" stroke="var(--grid)"/>`)
  for (let i = 1; i < Math.max(2, days); i++) {
    const gx = left + (w * i) / days
    if (gx < left + w - 0.5) p.push(`<line x1="${f(gx)}" x2="${f(gx)}" y1="${top}" y2="${f(top + h)}" stroke="var(--vgrid)"/>`)
  }
  p.push(`<rect x="${left}" y="${top}" width="${f(w)}" height="${f(h)}" fill="none" stroke="var(--grid)"/>`)
  // 刻度
  for (const v of [0, 50, 100]) p.push(`<text x="${left - 5}" y="${f(Y(v / 100) + 3.5)}" text-anchor="end" font-size="${TF}" fill="var(--ink3)">${v}%</text>`)
  const axisY = top + h + 14
  if (days > 1) {
    for (let dd = 0; dd <= days; dd++) p.push(`<text x="${f(clamp(left + (w * dd) / days, left + 12, left + w - 12))}" y="${f(axisY)}" text-anchor="middle" font-size="${TF}" fill="var(--ink3)">${L(`${dd}天`, `${dd}d`)}</text>`)
  } else {
    p.push(`<text x="${left}" y="${f(axisY)}" font-size="${TF}" fill="var(--ink3)">${L('开始', 'Start')}</text><text x="${f(left + w)}" y="${f(axisY)}" text-anchor="end" font-size="${TF}" fill="var(--ink3)">${L('重置', 'Reset')}</text>`)
  }
  // 理想配速对角线
  p.push(`<line x1="${f(X(0))}" y1="${f(Y(0))}" x2="${f(X(1))}" y2="${f(Y(1))}" stroke="var(--diag)" stroke-width="1.2" stroke-dasharray="4 4"/>`)
  // 同一像素列里最多留首尾两个点,坐标留一位小数:点再多,源码长度也有上限
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
  // 历史窗口:按新旧递增不透明度;隔着「无数据」的几段直接连起来(采样稀疏时每个点自成一段,
  // 只画成段的会一条都画不出来),窗口中途重置处仍断开
  entries.slice(0, -1).forEach(e => {
    const op = 0.4 + 0.52 * e.recency
    for (const run of joinGaps(e.series)) if (run.length >= 2) p.push(`<polyline points="${poly(run)}" fill="none" stroke="var(--id)" stroke-opacity="${f(op)}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`)
  })
  const fo = x.overlay.focused
  const cur = fo?.isCurrent ? fo.series : null
  if (fo) {
    const s = fo.series
    for (const m of s.midResets) p.push(`<line x1="${f(X(m.before.elapsed))}" x2="${f(X(m.before.elapsed))}" y1="${top}" y2="${f(top + h)}" stroke="var(--ink3)" stroke-dasharray="1 3"/>`)
    for (const g of s.gaps) p.push(`<line x1="${f(X(g.from.elapsed))}" y1="${f(Y(g.from.used))}" x2="${f(X(g.to.elapsed))}" y2="${f(Y(g.to.used))}" stroke="var(--id)" stroke-opacity=".3" stroke-width="1.5" stroke-dasharray="2 3"/>`)
    for (const seg of s.segments) if (seg.length >= 2) p.push(`<polyline points="${poly(seg)}" fill="none" stroke="var(--id)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`)
    if (cur) {
      if (cur.projection) p.push(`<line x1="${f(X(cur.projection.from.elapsed))}" y1="${f(Y(cur.projection.from.used))}" x2="${f(X(cur.projection.to.elapsed))}" y2="${f(Y(cur.projection.to.used))}" stroke="${st.solid}" stroke-opacity=".85" stroke-width="1.5" stroke-dasharray="5 3"/>`)
      const lastSeg = cur.segments[cur.segments.length - 1]
      const lp = lastSeg[lastSeg.length - 1]
      p.push(`<circle cx="${f(X(lp.elapsed))}" cy="${f(Y(lp.used))}" r="3.5" fill="var(--id)"/>`)
      if (cur.exhaustionAt != null) p.push(`<line x1="${f(X(cur.exhaustionAt))}" x2="${f(X(cur.exhaustionAt))}" y1="${top}" y2="${f(top + h)}" stroke="#D03B3B" stroke-opacity=".7" stroke-dasharray="2 2"/>`)
    }
  }
  // 图例:每项的线型与图里那条线一致
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
  return `${open(u, Wd, H)}${themeStyle(u, x.id)}<title>${esc(x.title)}</title>${p.join('')}</svg>`
}
