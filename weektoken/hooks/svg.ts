// SVG 绘图:配速环、输入框上方的进度条、用量轨迹(burn-up,图例画在图内)。
// 几何与配色取自 WeekToken macOS 版(PaceRings / PaceBullet / BulletRenderer / BurnUpChart)。
// 深浅色:SVG 用 prefers-color-scheme 自适应,并声明 color-scheme: light dark——画在宿主沙箱框里的图
// 若不声明,框的配色方案对不上应用时会垫一块白底、里面还按浅色画(深色应用里实测如此)。
// 中性元素(轨道、网格、刻度字)用深浅背景都看得清的半透明灰。
// 每个 SVG 用由输入算出的唯一 id 给样式和渐变/滤镜做作用域:宿主无论把它当独立图片
// 还是内联进同一页面,彼此都不会串色。纯函数,只产出字符串。

import { legendDates, windowLabel, type Overlay, type OverlayEntry, type Pace, type Series, type Status } from './pace.ts'
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
  /** 环右边一列读数:小号标签在上、数字在下;accent 的那个用配额色。空数组只画环 */
  readings: { label: string; value: string; accent?: boolean }[]
}

/**
 * 配速环,和横条同一套画法(只用配额自己的色系):
 * · 外环 = 用量 U:配额色角向渐变;没超速时从已用到已过画同色淡斜线(余量);
 *   超速时超出时间的一段画同色深一档 + 浅斜线;用尽时那段换协调过的暖色。
 * · 内环 = 时间 T:中性灰细环。两环都细、间距收紧,把中间留给数字。
 * · 中心:数字和状态当成一块垂直居中,字号按内环里面的直径定。
 * · 右边一列读数,字号分层(原生 Text 只有一种字号)。
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
  // 斜线:45°、周期 5px、线宽 2px(同横条)
  const stripes = (id: string, back: string, backOp: number, line: string, lineOp: number) =>
    `<pattern id="${id}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="5" height="5" fill="${back}" fill-opacity="${backOp}"/><rect width="2" height="5" fill="${line}" fill-opacity="${lineOp}"/></pattern>`
  const parts: string[] = []
  parts.push(`<defs>${stripes(u + 'm', 'var(--id)', 0.1, 'var(--id)', 0.55)}${stripes(u + 'x', 'var(--deep)', 1, 'var(--id-s)', 0.35)}</defs>`)
  // 内环:时间
  parts.push(`<circle cx="${f(c)}" cy="${f(c)}" r="${f(rI)}" fill="none" stroke="var(--track)" stroke-width="${f(rwIn)}"/>`)
  if (T != null && T > 0.002) parts.push(`<path d="${arcPath(c, c, rI, 0, Math.min(T, 0.9999))}" fill="none" stroke="var(--time)" stroke-width="${f(rwIn)}" stroke-linecap="round"/>`)
  // 外环:轨道、余量、用量、超出
  parts.push(`<circle cx="${f(c)}" cy="${f(c)}" r="${f(rO)}" fill="none" stroke="var(--track)" stroke-width="${f(rw)}"/>`)
  if (T != null && T > U) parts.push(`<path d="${arcPath(c, c, rO, Math.max(0, U - 0.01), Math.min(T, 0.9999))}" fill="none" stroke="url(#${u}m)" stroke-width="${f(rw)}"/>`)
  const upto = over ? (T as number) : U
  if (upto > 0.002) {
    // 角向渐变用分段近似;深浅两套色值各画一组,按外观显示其一
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
  // 中心:数字 + 状态,当成一块垂直居中
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
  // 右边一列读数
  const LS = 10
  const VS = 22
  const rx = d + 24
  // 中文标签 10px 太小,放到 11px;宽度估算偏窄(% 和粗体数字更宽),留余量
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
  /** 逐条查看:画进可交互的框,鼠标移到哪条线上,那条加粗并标出日期和峰值,其余变淡 */
  interactive?: boolean
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
  // 只画成段的会一条都画不出来),窗口中途重置处仍断开。
  // 逐条查看时每个窗口一组:一圈看不见的宽感应线(好对准)、原来的线、悬停才出现的标签
  const hover = !!x.interactive
  const history = entries.slice(0, -1)
  const TF2 = 10.5
  // 标签统一画在最上层(不被后画的线压住),靠序号和自己那组对上
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
  // 感应线只管好对准(12px 宽),每 4px 留一个整数点就够,源码只多一成左右
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
    // 感应线沿用「接上空隙」的走法:采样稀疏、每段只有一个点时也能指到
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
  // 逐条查看的样式:悬停的那组加粗、标签出现,其余组变淡;标签不挡鼠标
  const hoverStyle = hover
    ? `<style>#${u}{--tip-bg:rgba(255,255,255,.96);--tip-fg:#1d1d1f;--tip-bd:rgba(0,0,0,.14)}` +
      `@media (prefers-color-scheme: dark){#${u}{--tip-bg:rgba(30,30,32,.94);--tip-fg:#f5f5f7;--tip-bd:rgba(255,255,255,.18)}}` +
      `#${u} .w .hit{fill:none;stroke:transparent;stroke-width:12;pointer-events:stroke}` +
      `#${u} .lbl{opacity:0;pointer-events:none}` + labels.map((_, i) => `#${u}:has(.w${i}:hover) .l${i}`).join(',') + `{opacity:1}` +
      `#${u} .w:hover .ln{stroke-opacity:1;stroke-width:2.6}#${u} .w:hover .gp{stroke-opacity:.85}#${u}:has(.w:hover) .w:not(:hover) .ln{stroke-opacity:.12}</style>`
    : ''
  return `${open(u, Wd, H)}${themeStyle(u, x.id)}${hoverStyle}<title>${esc(x.title)}</title>${p.join('')}</svg>`
}
