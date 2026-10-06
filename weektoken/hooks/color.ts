// Color utils: sRGB ↔ OKLCH (Björn Ottosson's reference formulas), plus Material 3 hue harmonization. Pure functions.
// Used for the band's overrun segment ("same hue, one shade darker") and the exhausted "harmonized warm color", both derived from the quota's own color.

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
export function hexToOklch(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => toLin(v / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360]
}
export function oklchToHex(L: number, C: number, H: number): string {
  // Out of gamut: reduce chroma, keep lightness and hue
  for (let c = C; c >= 0; c -= 0.002) {
    const A = c * Math.cos((H * Math.PI) / 180), B = c * Math.sin((H * Math.PI) / 180)
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    if (rgb.every(v => v >= -0.0005 && v <= 1.0005)) return '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, toSrgb(Math.max(0, v)))) * 255).toString(16).padStart(2, '0')).join('')
  }
  return '#000000'
}
/** Material 3 harmonize: rotate hue toward the reference color, at most 15° (the smaller of half the angle between them and 15°); lightness and chroma unchanged */
export function harmonizeHue(h: number, toward: number): number {
  const diff = ((toward - h + 540) % 360) - 180
  return (h + Math.sign(diff) * Math.min(Math.abs(diff) * 0.5, 15) + 360) % 360
}
