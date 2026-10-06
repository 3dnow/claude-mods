// WeekToken mod
//
// Pace: whether usage is running fast or slow relative to elapsed time.
//   · A band above the prompt: ‹ name › · used · elapsed + a bar that scales with width. Shows the tightest quota by default;
//     the prev/next arrows beside the name switch quota and remember it; once hidden it takes no row, restore from the pane.
//   · /weektoken opens the pane: quota arrows beside the title, pace rings with used/elapsed/reset, commentary, burn-up
//   Data: the session's own rateLimits (5-hour / 7-day, updated on every reply) + Claude Code's local usage cache
//   ~/.claude.json (incl. per-model quotas such as Fable) + history samples from WeekToken for macOS (read-only import).

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Activity, BandMode, BandShow, Note, PaneView, Sample } from '../types'
import { L, langFromAppleLanguages, langFromEnv, langFromSetting, setLang, type Lang } from './i18n.ts'
import * as P from './pace.ts'
import { identity, identityText, statusText, STATUS } from './theme.ts'
import { bandBarSvg, burnUpSvg, creditSvg, ringsSvg } from './svg.ts'

const PANE = 'weektoken'
const DEFAULT_VIEW: PaneView = { key: null, tab: 'pace', range: 'current', offset: 0 }

const samplesA = atom({ plugin: 'weektoken', key: 'samples' } as const, [] as Sample[])
const viewA = atom({ plugin: 'weektoken', key: 'view' } as const, DEFAULT_VIEW)
const noteA = atom({ plugin: 'weektoken', key: 'note' } as const, null as Note)
const bandA = atom({ plugin: 'weektoken', key: 'band' } as const, 'open' as BandMode)
const confirmHideA = atom({ plugin: 'weektoken', key: 'confirmHide' } as const, false)
// Quota being viewed (shared by band and pane; written together with view.key on switch, see selectQuota)
const bandKeyA = atom({ plugin: 'weektoken', key: 'bandKey' } as const, null as string | null)
const bandShowA = atom({ plugin: 'weektoken', key: 'bandShow' } as const, null as BandShow | null)
const activityA = atom({ plugin: 'weektoken', key: 'activity' } as const, { byModel: {} } as Activity)
// Whether the pane is open: the band button reads "Close" or "Details" from this
const paneOpenA = atom({ plugin: 'weektoken', key: 'paneOpen' } as const, false)
/** Loaded version: read from our own plugin.json at session start, drawn after the credit */
const versionA = atom({ plugin: 'weektoken', key: 'version' } as const, '')
const AUTHOR = { x: 'mj0011sec' }

// CLAUDE_MODS_DISABLE=all, or weektoken in the comma list: all hooks pass through and no command is registered
let disabled = false
async function readDisabled($: any): Promise<boolean> {
  const raw = ((await $.env.get('CLAUDE_MODS_DISABLE')) ?? '').toLowerCase()
  disabled = raw.split(',').map((v: string) => v.trim()).some((v: string) => v === 'all' || v === 'weektoken')
  return disabled
}
const langA = atom({ plugin: 'weektoken', key: 'lang' } as const, 'en' as Lang)

// ======================================================================
// Model: derive each quota's display state, the bottleneck and the pane's selected quota from samples
// ======================================================================

type QuotaRow = {
  key: string
  obs?: P.Obs
  at?: number
  len: P.WindowLength
  d: P.Display
  name: string
  full: string
}

type Model = { keys: string[]; rows: Record<string, QuotaRow>; band: string | null; selected: string | null }

function buildModel(samples: readonly Sample[], view: PaneView, now: number, bandKey: string | null = null): Model {
  const keys = P.discoveredKeys(samples)
  const rows: Record<string, QuotaRow> = {}
  for (const k of keys) {
    const lo = P.latestObs(samples, k)
    const len = P.inferWindow(k, samples)
    rows[k] = {
      key: k,
      obs: lo?.obs,
      at: lo?.at,
      len,
      // No downgrade by data age: unused means unchanged, so old data still yields a pace (the footer says how long it's been idle)
      d: P.display(lo?.obs, len.seconds, now),
      name: P.displayName(k, lo?.obs.n),
      full: P.fullName(k, lo?.obs.n),
    }
  }
  const bottleneck = P.pickBottleneck(keys.map(k => ({ key: k, pace: rows[k].d.kind === 'pace' ? rows[k].d.pace : null })))
  // Band: show the quota picked with the band arrows, otherwise the tightest one
  const band = bandKey && rows[bandKey] ? bandKey : bottleneck
  // Pane and band show the same quota (both written on switch); if none was picked, both show the tightest
  const selected = view.key && rows[view.key] ? view.key : (band ?? keys[0] ?? null)
  return { keys, rows, band, selected }
}

/** What the band draws, rounded to display precision; null if it can't be computed (band falls back to native rendering) */
function bandShowOf(samples: readonly Sample[], bandKey: string | null, now: number): BandShow | null {
  if (!samples.length) return null
  const m = buildModel(samples, DEFAULT_VIEW, now, bandKey)
  const row = m.band ? m.rows[m.band] : undefined
  if (!row) return null
  // Last observed window is past its reset time: that usage is void, so the band says "reset" until the next reply brings a new window
  const ended = row.d.kind === 'usageOnly' && row.d.reason.kind === 'windowEnded'
  const used = ended ? null : P.displayUsed(row.d)
  return {
    key: row.key,
    ...(row.obs?.n ? { n: row.obs.n } : {}),
    ...(ended ? { ended: true } : {}),
    keys: m.keys,
    used: used == null ? null : Math.round(used * 100),
    elapsed: row.d.kind === 'pace' ? Math.round(row.d.pace.elapsed * 100) : null,
    status: P.displayStatus(row.d),
  }
}

// ======================================================================
// Data collection
// ======================================================================

type RateLimitLike = { kind: string; percentUsed: number; resetsAt?: string }

async function recordRateLimits($: any, list: readonly RateLimitLike[] | undefined, t: number): Promise<boolean> {
  const w: Record<string, P.Obs> = {}
  for (const rl of list ?? []) {
    if (rl.kind !== 'five_hour' && rl.kind !== 'seven_day') continue
    const r = rl.resetsAt ? Date.parse(rl.resetsAt) : NaN
    w[rl.kind] = { u: Math.min(Math.max(rl.percentUsed, 0), 100), ...(Number.isFinite(r) ? { r } : {}) }
  }
  if (!Object.keys(w).length) return false
  return addSample($, { t, w })
}

async function addSample($: any, s: Sample): Promise<boolean> {
  let changed = false
  await update($, samplesA, list => {
    const next = P.appendSample(list ?? [], s)
    changed = next !== list
    return next
  })
  if (changed) {
    await persistSamples($)
    await refreshBand($)
  }
  return changed
}

/**
 * Merge with what's stored before writing back: with several sessions open, each writing its full list would clobber samples another session just recorded.
 * Other sessions' samples are merged into this one too. Read-merge-write isn't atomic; an occasional collision just lands one write later, since each session merges again on its next write.
 */
async function persistSamples($: any): Promise<void> {
  const stored = await $.store.get('samples')
  const mine = (await read($, samplesA)) ?? []
  let merged = P.mergeSamples(Array.isArray(stored) ? (stored as Sample[]) : [], mine)
  try {
    await $.store.set('samples', merged)
  } catch {
    // Storage is size-capped (4 MiB per plugin): if the write fails, drop the oldest quarter and retry once
    merged = merged.slice(Math.floor(merged.length / 4))
    await $.store.set('samples', merged)
  }
  // Small revision tag: other sessions check it every minute and skip reading the full samples if unchanged
  lastSeenRev = `${merged.length}:${merged[merged.length - 1]?.t ?? 0}`
  await $.store.set('samplesRev', lastSeenRev)
  if (merged.length !== mine.length) await update($, samplesA, () => merged)
}

let lastSeenRev: string | null = null

/** Merge samples other sessions stored into this session (no write-back); touch state only if something is new */
async function adoptStoredSamples($: any): Promise<boolean> {
  const rev = await $.store.get('samplesRev')
  if (typeof rev === 'string' && rev === lastSeenRev) return false
  const stored = await $.store.get('samples')
  if (!Array.isArray(stored)) return false
  lastSeenRev = typeof rev === 'string' ? rev : null
  const mine = (await read($, samplesA)) ?? []
  const merged = P.mergeSamples(stored as Sample[], mine)
  if (merged.length === mine.length) return false
  await update($, samplesA, () => merged)
  return true
}

const mergeActivity = (a: Activity, b: Activity): Activity => {
  const byModel: Record<string, number> = { ...(a.byModel ?? {}) }
  for (const [k, t] of Object.entries(b.byModel ?? {})) byModel[k] = Math.max(byModel[k] ?? 0, t)
  return { any: Math.max(a.any ?? 0, b.any ?? 0) || undefined, byModel }
}

/** Record a reply (incl. subagents): any model counts toward 5-hour / 7-day; a model also counts toward its family's per-model quota */
async function recordActivity($: any, model: string | undefined): Promise<void> {
  const now = await $.clock.now()
  const fam = P.modelFamily(model)
  await update($, activityA, a => mergeActivity(a ?? { byModel: {} }, { any: now, byModel: fam ? { [fam]: now } : {} }))
  // Other sessions write too: merge with the stored value before saving, keeping the later time
  const stored = ((await $.store.get('activity')) as Activity | undefined) ?? { byModel: {} }
  await $.store.set('activity', mergeActivity(stored, await read($, activityA)))
}

/** A tree that draws nothing: null, empty string, or only empty Box/Text */
function isBlank(node: any): boolean {
  if (node == null || node === false || node === '') return true
  if (Array.isArray(node)) return node.every(isBlank)
  if (typeof node === 'string') return node.trim() === ''
  if (typeof node === 'object' && (node.type === 'Box' || node.type === 'Text')) return isBlank(node.children ?? node.props?.children)
  return false
}

/** Recompute what the band draws; skip the write if unchanged, so no redraw */
async function refreshBand($: any): Promise<void> {
  const next = bandShowOf((await read($, samplesA)) ?? [], (await read($, bandKeyA)) ?? null, await $.clock.now())
  const cur = (await read($, bandShowA)) ?? null
  if (JSON.stringify(next) === JSON.stringify(cur)) return
  await update($, bandShowA, () => next)
}

async function sampleSession($: any): Promise<boolean> {
  const u = await $.session.usage()
  return recordRateLimits($, u.rateLimits, await $.clock.now())
}

let cacheMtime = -1

async function expandHome($: any, p: string): Promise<string> {
  if (!p.startsWith('~/')) return p
  const home = await $.env.get('HOME')
  return home ? home + p.slice(1) : p
}

/** Claude Code's local usage cache (incl. per-model quotas); not re-parsed if the file is unchanged */
async function sampleCache($: any, force = false): Promise<boolean> {
  const path = await expandHome($, '~/.claude.json')
  if (!(await $.fs.exists(path))) return false
  const st = await $.fs.stat(path)
  if (!force && st.mtimeMs === cacheMtime) return false
  cacheMtime = st.mtimeMs
  let text: string | null = null
  try {
    text = await $.fs.read(path)
  } catch {
    text = await extractCacheWithPerl($, path) // Read fails over 4 MiB: extract just the cache section
  }
  if (!text) return false
  const s = P.parseClaudeJsonCache(text, await $.clock.now())
  return s ? addSample($, s) : false
}

async function extractCacheWithPerl($: any, path: string): Promise<string | null> {
  // -0777: slurp the whole file; program and regex are fixed text, the path is passed to perl as an argument, no shell
  try {
    const r = await $.process.run(['perl', '-0777', '-ne', 'print $1 if /"cachedUsageUtilization"\\s*:\\s*(\\{(?:[^{}"]++|"(?:\\\\.|[^"\\\\])*+"|(?1))*\\})/', path], { timeoutMs: 15_000 })
    if (r.exitCode === 0 && r.stdout.trim().startsWith('{')) return `{"cachedUsageUtilization":${r.stdout.trim()}}`
  } catch {}
  return null
}

/** History from WeekToken for macOS (read-only); default location, override with WEEKTOKEN_HISTORY, empty string disables import. Skipped if the file is unchanged; returns the count newly imported */
async function importHistory($: any): Promise<number> {
  const file = ((await $.env.get('WEEKTOKEN_HISTORY')) ?? '~/.weektoken/samples.jsonl').trim()
  if (!file) return 0
  const path = await expandHome($, file)
  if (!(await $.fs.exists(path))) return 0
  const st = await $.fs.stat(path)
  if ((await $.store.get('historyMtime')) === st.mtimeMs) return 0
  const r = await $.process.run(['tail', '-n', '8000', path], { timeoutMs: 15_000 })
  if (r.exitCode !== 0) return 0
  const imported = P.parseSamplesJsonl(r.stdout, await $.clock.now())
  let added = 0
  await update($, samplesA, list => {
    const merged = P.mergeSamples(list ?? [], imported)
    added = merged.length - (list ?? []).length
    return merged
  })
  await persistSamples($)
  await $.store.set('historyMtime', st.mtimeMs)
  if (added) await refreshBand($)
  return added
}

async function loadState($: any): Promise<void> {
  const stored = await $.store.get('samples')
  const list = Array.isArray(stored) ? (stored as Sample[]) : []
  await update($, samplesA, cur => P.mergeSamples(list, cur ?? []))
  const v = (await $.store.get('view')) as { key?: string | null; bandKey?: string | null; pinned?: string | null } | undefined
  // Band and pane show the same quota. Older versions stored them separately (the band's earlier in view.bandKey / view.pinned); on mismatch the band's wins
  const bk = (await $.store.get('bandKey')) ?? v?.bandKey ?? v?.pinned ?? null
  const k = typeof bk === 'string' ? bk : typeof v?.key === 'string' ? v.key : null
  if (k) {
    await update($, bandKeyA, () => k)
    await update($, viewA, cur => ({ ...(cur ?? DEFAULT_VIEW), key: k }))
  }
  const act = (await $.store.get('activity')) as Activity | undefined
  if (act && typeof act === 'object') await update($, activityA, cur => mergeActivity(cur ?? { byModel: {} }, act))
  const band = await $.store.get('band')
  // Older versions also had "collapsed" (mini); now always treated as shown
  if (band === 'hidden' || band === 'open' || band === 'mini') await update($, bandA, () => (band === 'hidden' ? 'hidden' : 'open'))
}

/**
 * Local claude's /usage: the only fresh source of per-model quotas (Fable etc.). A local command: no model call, no quota spent,
 * no session record; it scans local sessions for the usage breakdown, about 10 s, so it only runs on manual refresh.
 * The command is fixed text; claude is found by name. Processes started by the desktop app may not have it on PATH,
 * so a few common install locations are appended to the existing PATH (env.PATH is used for program lookup, verified).
 */
async function usagePath($: any): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  const extra = home ? [`${home}/.local/bin`, `${home}/.claude/local`] : []
  return [(await $.env.get('PATH')) ?? '/usr/bin:/bin', ...extra, '/opt/homebrew/bin', '/usr/local/bin'].join(':')
}

/** Run /usage and record a sample; ok = output received and recognized */
async function sampleUsageCommand($: any): Promise<{ ok: boolean; changed: boolean }> {
  const r = await $.process.run(['claude', '-p', '--no-session-persistence', '/usage'], { timeoutMs: 60_000, env: { PATH: await usagePath($) } })
  if (r.exitCode !== 0) return { ok: false, changed: false }
  const s = P.parseUsageCommand(r.stdout, await $.clock.now())
  if (!s) return { ok: false, changed: false }
  return { ok: true, changed: await addFresh($, s) }
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/**
 * The same figures /usage shows, straight from Anthropic's usage endpoint and through the host:
 * $.session.authorize() answers a handle, and the engine attaches the session's own login to the request
 * (first-party hosts only), so the mod never sees the credential. About half a second, where starting a whole
 * `claude -p /usage` takes 7-9 s. Null without a subscription login or when the answer can't be read;
 * refresh then falls back to the command.
 */
async function sampleUsageApi($: any): Promise<{ ok: boolean; changed: boolean } | null> {
  const auth = await $.session.authorize()
  if (!auth?.handle || auth.kind !== 'bearer') return null
  const r = await $.http.fetch(USAGE_URL, { auth: auth.handle, headers: { 'anthropic-beta': 'oauth-2025-04-20' } })
  if (!r.ok) return null
  let w: Record<string, P.Obs>
  try { w = P.parseUtilization(JSON.parse(r.text)) } catch { return null }
  if (!Object.keys(w).length) return null
  return { ok: true, changed: await addFresh($, { t: await $.clock.now(), w }) }
}

/** Records a fresh account-wide reading. For 5-hour / 7-day the session's own values (second precision) win; use these only if there's no local reading within 10 minutes (new session, no reply yet) */
async function addFresh($: any, s: Sample): Promise<boolean> {
  const samples = (await read($, samplesA)) ?? []
  const w: Record<string, P.Obs> = {}
  for (const [k, o] of Object.entries(s.w)) {
    if (P.isModelScoped(k)) w[k] = o
    else if (k === 'five_hour' || k === 'seven_day') {
      const lo = P.latestObs(samples, k)
      if (!lo || s.t - lo.at > 10 * 60_000) w[k] = o
    }
  }
  return Object.keys(w).length ? addSample($, { t: s.t, w }) : false
}

/** Manual refresh "in progress": kept in state so the button shows "Refreshing…"; treated as done after 90 s (subprocess timeout is 60 s) */
const isBusy = (note: Note, now: number) => !!note?.busy && now - note.at < 90_000

async function refreshAll($: any, manual: boolean): Promise<void> {
  if (manual) {
    const now = await $.clock.now()
    if (isBusy(await read($, noteA), now)) return
    await update($, noteA, () => ({ busy: true, at: now }))
  }
  try {
    try { await sampleSession($) } catch {}
    try { await sampleCache($, true) } catch {}
    try { await importHistory($) } catch {}
    if (!manual) return
    // The usage endpoint first (about half a second); starting `claude -p /usage` only if that isn't available
    let ok = false
    try { ok = (await sampleUsageApi($))?.ok ?? false } catch {}
    if (!ok) try { ok = (await sampleUsageCommand($)).ok } catch {}
    // Nothing on success (footer and chart update themselves); notify only when /usage fails
    if (!ok) $.ui.toast(L('没能运行 claude /usage:Fable 等分模型配额这次没更新', "Couldn't run claude /usage: per-model quotas such as Fable weren't updated"), { timeoutMs: 8_000 })
  } finally {
    if (manual) await update($, noteA, () => null)
  }
}

// ======================================================================
// UI language: WEEKTOKEN_LANG (zh / en) → Claude Code's language setting → system language (macOS preferred languages, then LC_ALL/LC_MESSAGES/LANG) → English
// ======================================================================

async function detectLang($: any): Promise<Lang> {
  const forced = ((await $.env.get('WEEKTOKEN_LANG')) ?? '').trim().toLowerCase()
  if (forced === 'zh' || forced === 'en') return forced
  try {
    const row = (await $.config.list()).find((r: { key: string }) => r.key === 'language')
    const l = langFromSetting(row?.value)
    if (l) return l
  } catch {}
  // macOS "system language" is the preferred-languages list; LANG is only the terminal env and may differ in processes started by the desktop app. Linux has no defaults, falls through to LANG
  try {
    const r = await $.process.run(['defaults', 'read', '-g', 'AppleLanguages'], { timeoutMs: 5_000 })
    const l = r.exitCode === 0 ? langFromAppleLanguages(r.stdout) : null
    if (l) return l
  } catch {}
  return langFromEnv(await $.env.get('LC_ALL')) ?? langFromEnv(await $.env.get('LC_MESSAGES')) ?? langFromEnv(await $.env.get('LANG')) ?? 'en'
}

/** Detect language; skip the write if unchanged (a write redraws band and pane). Returns whether it changed */
async function refreshLang($: any): Promise<boolean> {
  const l = await detectLang($)
  setLang(l)
  if ((await read($, langA)) === l) return false
  await update($, langA, () => l)
  return true
}

/** Sync language before drawing: after a module reload the variable resets to default, but the value in $.state remains */
async function useLang($: any): Promise<void> {
  setLang((await read($, langA)) ?? 'en')
}

// ======================================================================
// Pane and band actions
// ======================================================================

async function openPane($: any): Promise<void> {
  await $.ui.open({ id: PANE, title: 'WeekToken' })
  await update($, paneOpenA, () => true)
  await update($, viewA, v => ({ ...(v ?? DEFAULT_VIEW), explore: false }))
}

/** Band "Details": close the pane if it's open and in front, otherwise open it (or bring it to front). Asks the engine on press, not stored state */
async function togglePane($: any): Promise<void> {
  const pane = (await $.ui.panes()).find((p: { id: string; isShown: boolean }) => p.id === PANE)
  if (pane?.isShown) {
    await $.ui.close({ id: PANE })
    await update($, paneOpenA, () => false)
  } else await openPane($)
}

/** Sync whether the pane is actually open into state (session start, after reload) */
async function syncPaneOpen($: any): Promise<void> {
  const open = (await $.ui.panes()).some((p: { id: string }) => p.id === PANE)
  if ((await read($, paneOpenA)) !== open) await update($, paneOpenA, () => open)
}

async function setView($: any, fn: (v: PaneView) => PaneView): Promise<void> {
  await update($, viewA, v => fn(v ?? DEFAULT_VIEW))
  const v = await read($, viewA)
  await $.store.set('view', { key: v.key })
}

/**
 * Switch quota: band and pane show the same one. Band arrows, pane side buttons and the burn-up dropdown all go through here; both switch and it's remembered.
 * (Stored separately earlier because switching on the band made the pane's frame flicker; with the pace ring and bar now plain images it no longer does, so they're unified)
 */
async function selectQuota($: any, k: string): Promise<void> {
  await update($, bandKeyA, () => k)
  await update($, viewA, v => ({ ...(v ?? DEFAULT_VIEW), key: k, offset: 0, explore: false }))
  await $.store.set('bandKey', k)
  await $.store.set('view', { key: k })
  await refreshBand($)
}

async function stepKey($: any, keys: readonly string[], sel: string, offset: number): Promise<void> {
  const k = P.neighbor(sel, keys, offset)
  if (k) await selectQuota($, k)
}

async function setBand($: any, mode: BandMode): Promise<void> {
  await update($, bandA, () => mode)
  await $.store.set('band', mode)
}

/** Show/hide in the pane: read current state on press and flip it, not the render-time snapshot */
async function toggleBandHidden($: any): Promise<void> {
  const cur = (await read($, bandA)) ?? 'open'
  await setBand($, cur === 'hidden' ? 'open' : 'hidden')
}

/** Band "Hide" asks first: once hidden the band has no entry point, so tell the user to come back via /weektoken; dropped after 8 s without an answer */
let confirmTimer: { cancel: () => void } | null = null

async function askHideBand($: any): Promise<void> {
  confirmTimer?.cancel()
  await update($, confirmHideA, () => true)
  confirmTimer = $.clock.after(8000, () => { void update($, confirmHideA, () => false).catch(() => {}) })
}

async function answerHideBand($: any, hide: boolean): Promise<void> {
  confirmTimer?.cancel()
  confirmTimer = null
  await update($, confirmHideA, () => false)
  if (hide) await setBand($, 'hidden')
}

/** Band prev/next arrows: switch quota, the pane follows */
async function stepBand($: any, keys: readonly string[], cur: string, offset: number): Promise<void> {
  await stepKey($, keys, cur, offset)
}

// When the desktop pane doesn't have the keyboard (focus in the prompt), the first click only hands focus to the pane: the engine sends ui.focus, no ui.press.
// Measured: with focus, a click is "ui.press → ui.focus ~70ms later"; without focus, only ui.focus.
// So when drawing the pane, record each button's action by key; if ui.focus lands on a button with no ui.press before or after, press it once on its behalf.
// Events can't tell a click from Tab: if the pane already had the keyboard (only then do Tab / arrow keys move focus), don't press.
// "Already had" comes from the last render's e.props.isFocused: the pane redraws with false when focus leaves (confirmed in device logs);
// $.ui.panes() already reports "focused" inside ui.focus, even on the first click after blur, so it's unusable. Desktop only.
const paneActions = new Map<string, () => unknown>()
let paneSurface = 'desktop'
let paneFocusedAtRender = false
let lastPanePress: { el: string; at: number } | null = null

/** Register a pane button's action (for the substitute press); errors are swallowed, no unhandled rejections */
function paneAct(key: string, fn: () => unknown): () => Promise<void> {
  const run = () => Promise.resolve().then(fn).then(() => {}, () => {})
  paneActions.set(key, run)
  return run
}

// ======================================================================
// Rendering: the band above the prompt
// ======================================================================

const STATUS_DIM = new Set(['early', 'unknown'])
const SVG_MAX = 120_000

/** Async action fired by a click: errors are swallowed, no unhandled rejections */
const quiet = (p: Promise<unknown>) => { void p.catch(() => {}) }

/**
 * Draw an SVG. Small and interactive images get explicit width/height (interactive ones sit in a sandboxed iframe and otherwise stretch to the full row);
 * wide charts are fluid: no width/height, natural width, shrunk to pane width at most (a size wider than the pane gets scaled down as a bitmap and blurs)
 */
function pic($: any, e: any, source: string, alt: string, opts: { isInteractive?: boolean; fluid?: boolean; fillHeight?: number } = {}) {
  const { Svg } = $.ui.resolve(e)
  if (opts.fluid) return <Svg source={source} alt={alt} />
  // Plain image with height only: the SVG declares no width (width="100%") and uses percentage geometry, so width follows the cell up to the image default 300px,
  // stretching without distortion. No interactive frame: the host reloads it, flickering, whenever the same plugin redraws elsewhere (the pane) (confirmed on device)
  if (opts.fillHeight) return <Svg source={source} alt={alt} height={opts.fillHeight} />
  const m = /^<svg[^>]*?\swidth="([\d.]+)"\s+height="([\d.]+)"/.exec(source)
  const size = m ? { width: Number(m[1]), height: Number(m[2]) } : {}
  return opts.isInteractive
    ? <Svg source={source} alt={alt} {...size} isInteractive />
    : <Svg source={source} alt={alt} {...size} />
}

/** Text bullet for the terminal: usage blocks + time marker */
function termBar($: any, e: any, key: string, used: number | null, elapsed: number | null, st: P.Status, width: number) {
  const { Text } = $.ui.resolve(e)
  const nU = Math.round((used ?? 0) * width)
  const mark = elapsed == null ? -1 : Math.min(width - 1, Math.floor(elapsed * width))
  const runs: { text: string; color?: string; dim?: boolean }[] = []
  const push = (ch: string, color?: string, dim?: boolean) => {
    const last = runs[runs.length - 1]
    if (last && last.color === color && last.dim === dim) last.text += ch
    else runs.push({ text: ch, color, dim })
  }
  for (let i = 0; i < width; i++) {
    if (i === mark) push('│', STATUS[st].solid)
    else if (i < nU) push('█', identityText(key))
    else push('░', undefined, true)
  }
  return (
    <Text>
      {runs.map(r => <Text color={r.color} dimColor={r.dim}>{r.text}</Text>)}
    </Text>
  )
}

const termBarOf = ($: any, e: any, row: QuotaRow, width: number) =>
  termBar($, e, row.key, P.displayUsed(row.d), row.d.kind === 'pace' ? row.d.pace.elapsed : null, P.displayStatus(row.d), width)

/**
 * The band's text line: ‹ name › · used · elapsed. One non-wrapping Text per segment (nested Text wraps on desktop);
 * name and used don't shrink, elapsed is truncated first. Pace status is shown by the bar color, not text.
 * With multiple quotas, prev/next arrows flank the name and on hover take the color of the quota they switch to.
 */
const bandTexts = (show: BandShow) => ({
  name: P.displayName(show.key, show.n),
  used: show.ended ? L('· 已重置', '· reset') : show.used != null ? L(`· 已用 ${show.used}%`, `· ${show.used}% used`) : null,
  elapsed: show.elapsed != null ? L(`· 已过 ${show.elapsed}%`, `· ${show.elapsed}% elapsed`) : null,
  details: L('详情', 'Details'),
  closeDetails: L('收起', 'Close'),
  hide: L('隐藏', 'Hide'),
})

/** Terminal cell width: CJK and full-width characters take two cells */
const cells = (s: string) => [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0)

/**
 * Width of the band's name cell: sized to the longest quota name, name centered. Switching quotas moves neither the arrows nor the text after them.
 * Counted in character cells; desktop fonts are proportional but a cell is slightly wider than a typical glyph, so no extra margin (with it the title looks too wide)
 */
const bandNameWidth = (show: BandShow, _term: boolean) =>
  Math.max(...show.keys.map(k => cells(P.displayName(k, k === show.key ? show.n : undefined))), cells(P.displayName(show.key, show.n)))

/**
 * Terminal band layout: text at its actual width, the bar takes the remaining cells (max 48).
 * Under 8 cells, drop the "elapsed" segment first; still short, skip the bar. Never let the line wrap to two.
 */
/**
 * Band layout: the bar takes the remaining cells; when short, drop the "elapsed" segment first, then skip the bar (terminal).
 * "Does it fit" assumes the worst case: longest quota name, widest reading such as "100%", the longer of the two button labels.
 * Depends only on band width, not the current quota's numbers, so all quotas behave the same at a given width; none shows in full while another is cut to "elap…".
 * Terminal counts exact character cells; on desktop fonts are proportional and native buttons have padding, so arrows and buttons use estimated cells and the bar keeps at least BAR_MIN.
 */
const BAR_MIN = 6
function bandLayout(show: BandShow, cols: number, term: boolean): { bar: number; withElapsed: boolean } {
  const t = bandTexts(show)
  const used = cells(L('· 已用 100%', '· 100% used'))
  const elapsed = cells(L('· 已过 100%', '· 100% elapsed'))
  const buttons = Math.max(cells(t.details), cells(t.closeDetails)) + cells(t.hide)
  const width = (withElapsed: boolean) => {
    // Name plus both arrows form one group: terminal "h: ❮" / "l: ❯" are 4 cells each, one space apart; desktop native buttons have padding, 3 cells each, no spaces
    const arrows = show.keys.length > 1 ? (term ? 4 + 4 + 2 : 3 + 3) : 0
    const parts = [bandNameWidth(show, term) + arrows, used, ...(withElapsed ? [elapsed] : [])]
    const line = parts.reduce((a, b) => a + b, 0) + parts.length - 1
    // Terminal: one space between line, bar, spacer, Details and Hide; the engine draws " [-]" last, plus one more cell;
    // Desktop: 2 cells of padding per button, one space between line, bar and the two buttons
    return line + buttons + (term ? 4 + 5 : 4 + 3)
  }
  if (!term) return { bar: 1, withElapsed: !!t.elapsed && width(true) + BAR_MIN <= cols }
  for (const withElapsed of [true, false]) {
    const bar = Math.min(48, cols - width(withElapsed) - 1)
    if (bar >= 8 || (!withElapsed && bar >= 4)) return { bar, withElapsed: withElapsed && t.elapsed != null }
  }
  return { bar: 0, withElapsed: false }
}

function bandLine($: any, e: any, show: BandShow, withElapsed = true) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const term = e.surface === 'terminal'
  const t = bandTexts(show)
  const canSwitch = show.keys.length > 1
  const arrow = (offset: -1 | 1) => (
    <Box key={offset < 0 ? 'band-sw-prev' : 'band-sw-next'} flexShrink={0}>
      <Button
        key={offset < 0 ? 'band-prev' : 'band-next'}
        label={offset < 0 ? '❮' : '❯'}
        plain
        {...(term ? { hotkey: offset < 0 ? 'h' : 'l' } : {})}
        hover={{ color: identityText(P.neighbor(show.key, show.keys, offset) as string), bold: true }}
        onPress={() => quiet(stepBand($, show.keys, show.key, offset))}
      />
    </Box>
  )
  return (
    <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1} minWidth={0} overflow="hidden">
      {/* Arrows and name as one group; desktop native buttons have their own padding, so no gap inside, keeping the title from getting too wide */}
      <Box flexDirection="row" alignItems="center" gap={term ? 1 : 0} flexShrink={0}>
        {canSwitch ? arrow(-1) : null}
        <Box flexShrink={0} width={bandNameWidth(show, term)} justifyContent="center"><Text color={identityText(show.key)} wrap="truncate-end">{t.name}</Text></Box>
        {canSwitch ? arrow(1) : null}
      </Box>
      {t.used ? (
        <Box flexShrink={0}><Text color={show.ended ? undefined : identityText(show.key)} dimColor={!!show.ended} bold={!show.ended} wrap="truncate-end">{t.used}</Text></Box>
      ) : null}
      {t.elapsed && withElapsed ? (
        <Box flexShrink={100} minWidth={0}><Text dimColor wrap="truncate-end">{t.elapsed}</Text></Box>
      ) : null}
    </Box>
  )
}

function drawConfirmHide($: any, e: any) {
  const { Box, Text, Button } = $.ui.resolve(e)
  return (
    <Box flexDirection="row" alignItems="center" gap={1}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">{L('隐藏横条？之后输入 /weektoken show 可恢复', 'Hide the band? Type /weektoken show to bring it back')}</Text>
      </Box>
      <Button key="band-hide-yes" label={L('隐藏', 'Hide')} variant="primary" onPress={() => quiet(answerHideBand($, true))} />
      <Button key="band-hide-no" label={L('取消', 'Cancel')} onPress={() => quiet(answerHideBand($, false))} />
    </Box>
  )
}

function drawBand($: any, e: any, show: BandShow, paneOpen = false) {
  const { Box, Button } = $.ui.resolve(e)
  const term = e.surface === 'terminal'
  const used = show.used == null ? null : show.used / 100
  const elapsed = show.elapsed == null ? null : show.elapsed / 100
  const full = P.fullName(show.key, show.n)
  const label = show.ended ? L(`${full}：窗口已重置`, `${full}: window has reset`)
    : show.used == null ? full
    : show.elapsed == null ? L(`${full}：已用 ${show.used}%`, `${full}: ${show.used}% used`)
    : L(`${full}：已用 ${show.used}%，已过 ${show.elapsed}%`, `${full}: ${show.used}% used, ${show.elapsed}% elapsed`)
  const t = bandTexts(show)
  // One text line + bar; details go in the pane, restore from the pane after hiding.
  // Desktop: text is laid out at its own width first, the bar grows from 0 into the remaining space (at least BAR_MIN cells); if "elapsed" doesn't fit, the whole segment is hidden (see bandLayout).
  // Terminal: the bar is fixed-width text, sized from bodyColumns (the conversation column's width when the pane is docked beside it)
  const lay = bandLayout(show, e.props?.bodyColumns ?? (term ? 80 : 120), term)
  const pace = used != null && elapsed != null ? ({ used, elapsed } as P.Pace) : null
  return (
    <Box flexDirection="row" alignItems="center" gap={1}>
      {bandLine($, e, show, lay.withElapsed)}
      {term ? (
        lay.bar > 0 ? <Box flexShrink={0}>{termBar($, e, show.key, used, elapsed, show.status, lay.bar)}</Box> : null
      ) : (
        <Box width={0} flexGrow={1} flexShrink={1} minWidth={BAR_MIN}>
          {pic($, e, bandBarSvg(pace, used, show.status, identity(show.key), label, 'fluid'), label, { fillHeight: 14 })}
        </Box>
      )}
      {term ? <Box flexGrow={1} /> : null}
      <Button key="open" label={paneOpen ? t.closeDetails : t.details} plain dimColor onPress={() => quiet(togglePane($))} />
      <Button key="band-hide" label={t.hide} plain dimColor role="dismiss" onPress={() => quiet(askHideBand($))} />
    </Box>
  )
}

// ======================================================================
// Rendering: pane
// ======================================================================

/** Pane footer note: when this quota has been unused for over half an hour, say how long ago it was last used (refresh progress shows on the Refresh button, not this line) */
function noteLine(row: QuotaRow | undefined, samples: readonly Sample[], activity: Activity, now: number): string | null {
  if (!row) return null
  const lu = P.lastUsed(samples, row.key, activity)
  if (!lu) return null
  const age = (now - lu.at) / 1000
  if (age < 1800) return null
  const d = P.formatDuration(age)
  const who = P.isModelScoped(row.key) ? row.name : null
  if (lu.isLowerBound) return who ? L(`至少 ${d}没用过 ${who}`, `${who} unused for ${d}+`) : L(`至少 ${d}没有用量`, `No usage for ${d}+`)
  return who ? L(`上次使用 ${who}：${d}前`, `Last used ${who} ${d} ago`) : L(`上次使用：${d}前`, `Last used ${d} ago`)
}

function trendOf(samples: readonly Sample[], row: QuotaRow): P.Trend | null {
  if (row.d.kind !== 'pace' || row.obs?.r == null) return null
  return P.buildSeries(row.key, row.obs.r, samples, row.len.seconds)?.trend ?? null
}

const trendText = (t: P.Trend): string =>
  L({ accelerating: '↗ 最近在加速', easing: '↘ 最近在缓下来', steady: '→ 速度稳定' }, { accelerating: '↗ Speeding up lately', easing: '↘ Slowing down lately', steady: '→ Steady pace' })[t]

function drawEmpty($: any, e: any) {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      <Text bold>{L('还没有数据', 'No data yet')}</Text>
      <Text dimColor wrap="wrap">{L('等这个会话收到第一条回复，或点「刷新」', "Waiting for this session's first reply, or press Refresh")}</Text>
    </Box>
  )
}

function drawPaceTab($: any, e: any, samples: readonly Sample[], m: Model, row: QuotaRow) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const term = e.surface === 'terminal'
  const d = row.d
  const st = P.displayStatus(d)
  const pace = d.kind === 'pace' ? d.pace : null
  const used = P.displayUsed(d)
  const id = identity(row.key)
  const label = P.accessibilityLabel(d, row.full)
  const second = pace ? P.forecast(pace) : P.displayDetail(d)
  const trend = trendOf(samples, row)
  // Trend is only supplementary, no extra color (amber and the quota blue are near-complementary and look cheapest together)
  const trendLine = trend && trend !== 'steady' ? <Text dimColor>{trendText(trend)}</Text> : null
  const showBadge = !P.isVerifiedByData(row.len.source)
  const canSwitch = m.keys.length > 1
  const target = (offset: number) => P.neighbor(row.key, m.keys, offset) as string
  // Readings rounded, matching the band
  const metrics = pace
    ? [
        { v: `${Math.round(pace.used * 100)}%`, l: L('已用', 'Used'), accent: true },
        { v: `${Math.round(pace.elapsed * 100)}%`, l: L('已过', 'Elapsed') },
        { v: P.formatDuration(pace.timeToReset), l: L('距重置', 'Resets in') },
      ]
    : d.kind === 'usageOnly' ? [{ v: `${Math.round(d.obs.u)}%`, l: L('已用', 'Used'), accent: true }] : []

  if (term) {
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          {termBarOf($, e, row, 30)}
          <Text color={STATUS_DIM.has(st) ? undefined : statusText(st)} bold>{pace?.burnRate != null ? `${pace.burnRate.toFixed(2)}×` : P.menuBarText(d).trim()}</Text>
          <Text dimColor>{P.displayLabel(d)}</Text>
        </Box>
        <Text bold>{P.displayHeadline(d)}</Text>
        {second ? <Text dimColor wrap="wrap">{second}</Text> : null}
        {trendLine}
        <Text>{metrics.map(x => `${x.l} ${x.v}`).join('   ')}</Text>
        {showBadge ? <Text dimColor>？{P.windowNote(row.len)}</Text> : null}
        {canSwitch ? (
          <Box flexDirection="row" gap={2}>
            <Button key="prev" label={`‹ ${m.rows[target(-1)]?.full ?? ''}`} hotkey="h" onPress={paneAct('prev', () => stepKey($, m.keys, row.key, -1))} />
            <Button key="next" label={`${m.rows[target(1)]?.full ?? ''} ›`} hotkey="l" onPress={paneAct('next', () => stepKey($, m.keys, row.key, 1))} />
          </Box>
        ) : null}
      </Box>
    )
  }

  const center = pace && pace.burnRate != null
    ? { kind: 'rate' as const, text: pace.burnRate.toFixed(2) }
    : d.kind === 'usageOnly' ? { kind: 'pct' as const, text: `${Math.round(d.obs.u)}%` } : { kind: 'none' as const }
  return (
    <Box flexDirection="column" alignItems="center" gap={2}>
      {/* Quota-switch arrows flank the title (see drawPane); this row holds only the image, centered */}
      <Box flexDirection="row" justifyContent="center" width="100%">
        {pic($, e, ringsSvg({ used, elapsed: pace?.elapsed ?? null, status: st, id, center, label: P.displayLabel(d), title: label, readings: pace ? metrics.map(x => ({ label: x.l.toUpperCase(), value: x.v, accent: !!x.accent })) : [] }), label)}
      </Box>
      <Box flexDirection="column" alignItems="center">
        <Text bold>{P.displayHeadline(d)}</Text>
        {second ? <Text dimColor wrap="wrap">{second}</Text> : null}
        {trendLine}
      </Box>
      {showBadge ? <Text dimColor>？{P.windowNote(row.len)}</Text> : null}
    </Box>
  )
}

function drawBurnUpTab($: any, e: any, samples: readonly Sample[], m: Model, row: QuotaRow, view: PaneView, now: number) {
  const { Box, Text, Button, Select } = $.ui.resolve(e)
  const o = P.buildOverlay(row.key, samples, row.len.seconds, view.range, view.offset, now)
  const ranges: P.Range[] = ['current', 'month', 'all']
  // Desktop already has arrows beside the title, so none here; terminal uses a dropdown; surfaces without Select (mobile) fall back to prev/next buttons
  const quotaPick = m.keys.length < 2 || e.surface !== 'terminal' ? null : Select ? (
    <Select key="quota" options={m.keys.map(k => ({ value: k, label: P.pickName(k, m.rows[k].obs?.n) }))} value={row.key} onSelect={(k: string) => quiet(selectQuota($, k))} />
  ) : (
    <Box flexDirection="row" gap={1}>
      <Button key="prev" label="‹" onPress={paneAct('prev', () => stepKey($, m.keys, row.key, -1))} />
      <Button key="next" label="›" onPress={paneAct('next', () => stepKey($, m.keys, row.key, 1))} />
    </Box>
  )
  const rangeRow = (
    <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
      {quotaPick}
      {ranges.map(r => (
        <Button key={`range-${r}`} label={P.rangeLabel(r)} variant={view.range === r ? 'primary' : 'secondary'} onPress={paneAct(`range-${r}`, () => setView($, v => ({ ...v, range: r, offset: 0, explore: false })))} />
      ))}
    </Box>
  )
  const focused = o.focused
  const canOlder = view.range === 'current' && view.offset < o.totalWindows - 1
  const canNewer = view.range === 'current' && view.offset > 0
  const nav = view.range === 'current' && focused ? (
    <Box flexDirection="row" alignItems="center" gap={1}>
      {canOlder ? <Button key="older" label={L('‹ 更早', '‹ Older')} onPress={paneAct('older', () => setView($, v => ({ ...v, offset: v.offset + 1 })))} /> : null}
      <Text dimColor>{P.windowLabel(focused.series.reset, row.len.seconds, focused.isCurrent)}</Text>
      {canNewer ? <Button key="newer" label={L('更近 ›', 'Newer ›')} onPress={paneAct('newer', () => setView($, v => ({ ...v, offset: v.offset - 1 })))} /> : null}
    </Box>
  ) : null
  if (!o.entries.length) {
    return (
      <Box flexDirection="column" gap={1}>
        {rangeRow}
        <Text dimColor wrap="wrap">{L('这个窗口的采样还不够画趋势', 'Not enough samples in this window yet')}</Text>
      </Box>
    )
  }
  // "Last month / All" is normally a plain image (no flicker on band or pane redraws); hovering the chart reveals "Inspect lines" at top left,
  // and only clicking it swaps in the hoverable frame: the line under the pointer goes bold with its date and peak, the rest fade
  const W = row.len.seconds
  const caption = P.overlayCaption(o)
  if (e.surface === 'terminal') {
    const s = focused!.series
    return (
      <Box flexDirection="column" gap={1}>
        {rangeRow}
        {nav}
        <Text>{L(`峰值 ${Math.round(s.peak * 100)}%`, `Peak ${Math.round(s.peak * 100)}%`)}</Text>
        {caption ? <Text dimColor wrap="wrap">{caption}</Text> : null}
        <Text dimColor>{L('(曲线图在桌面端显示)', '(The chart shows in the desktop app)')}</Text>
      </Box>
    )
  }
  const title = L(`${row.full} 用量轨迹`, `${row.full} burn-up`)
  const input = { width: 360, overlay: o, W, status: P.displayStatus(row.d), id: identity(row.key), title }
  const plain = burnUpSvg(input)
  // The hoverable version adds hit lines and labels; if it exceeds the cap, no inspect mode, the plain chart draws as usual
  const live = view.range !== 'current' && o.entries.length > 1 ? burnUpSvg({ ...input, interactive: true }) : null
  const canExplore = live != null && live.length <= SVG_MAX
  const exploring = canExplore && !!view.explore
  const svg = exploring && live ? live : plain
  const alt = caption ? `${title}. ${caption}` : title
  // Svg source is capped at 131072 chars; over that the engine rejects the whole tree. Overlays are already limited, this is a final backstop
  if (svg.length > SVG_MAX) {
    return (
      <Box flexDirection="column" gap={1}>
        {rangeRow}
        {nav}
        <Text dimColor wrap="wrap">{L('这个范围的数据太多，画不下：换「本窗口」或「近一月」看', 'Too much data to draw for this range: try This window or Last month')}</Text>
      </Box>
    )
  }
  const toggle = (
    <Button
      key="explore"
      label={exploring ? L('✓ 完成', '✓ Done') : L('⤢ 逐条查看', '⤢ Inspect lines')}
      variant={exploring ? 'primary' : 'secondary'}
      onPress={paneAct('explore', () => setView($, v => ({ ...v, explore: !exploring })))}
    />
  )
  const chart = canExplore ? (
    <Box key="chart" flexDirection="column">
      {exploring ? pic($, e, svg, alt, { isInteractive: true }) : pic($, e, svg, alt, { fluid: true })}
      <Box position="absolute" top={0} left={4} {...(exploring ? {} : { display: 'none', hover: { display: 'flex' } })}>{toggle}</Box>
    </Box>
  ) : pic($, e, svg, alt, { fluid: true })
  return (
    <Box flexDirection="column" gap={1}>
      {rangeRow}
      {nav}
      {chart}
      {exploring ? <Text dimColor wrap="wrap">{L('鼠标指到一条线上，看它是哪个窗口、峰值多少', 'Point at a line to see its window and peak')}</Text> : null}
      {caption ? <Text dimColor wrap="wrap">{caption}</Text> : null}
    </Box>
  )
}

/** Credit: bottom-right of the pane, the X handle, one line of 10px translucent text (drawn as an image; not clickable) */
// Version read at pane render (reading versionA also redraws the pane once it's written)
let paneVersion = ''

function credit($: any, e: any) {
  const { Box, Text } = $.ui.resolve(e)
  const handle = `@${AUTHOR.x}${paneVersion ? ` · v${paneVersion}` : ''}`
  return (
    <Box flexDirection="row" justifyContent="flex-end">
      {e.surface === 'terminal' ? <Text dimColor>{handle}</Text> : pic($, e, creditSvg(handle), handle)}
    </Box>
  )
}

function drawPane($: any, e: any, samples: readonly Sample[], activity: Activity, view: PaneView, note: Note, band: BandMode, m: Model, now: number) {
  const { Box, Text, Button } = $.ui.resolve(e)
  // At least as tall as the pane body (row count from the host; Box sizes are in rows on every surface); the spacer before the credit pushes it to the bottom
  const fill = e.props?.scroll?.bodyRows ? Math.max(1, e.props.scroll.bodyRows) : '100%'
  paneActions.clear()
  paneSurface = e.surface
  paneFocusedAtRender = !!e.props?.isFocused
  const term = e.surface === 'terminal'
  const sel = m.selected
  const row = sel ? m.rows[sel] : undefined
  const nl = noteLine(row, samples, activity, now)
  const busy = isBusy(note, now)
  const footer = (
    <Box flexDirection="row" alignItems="center" gap={1}>
      {nl ? <Text dimColor wrap="truncate-end">{nl}</Text> : null}
      <Box flexGrow={1} />
      <Button key="band-toggle" label={band === 'hidden' ? L('⊕ 显示横条', '⊕ Show band') : L('⊖ 隐藏横条', '⊖ Hide band')} onPress={paneAct('band-toggle', () => toggleBandHidden($))} />
      <Button key="refresh" label={busy ? L('↻ 刷新中…', '↻ Refreshing…') : L('↻ 刷新', '↻ Refresh')} {...(term ? { hotkey: 'r' } : {})} onPress={paneAct('refresh', () => refreshAll($, true))} />
    </Box>
  )
  if (!row) {
    return (
      <Box flexDirection="column" gap={term ? 1 : 2} paddingX={1} minHeight={fill}>
        {drawEmpty($, e)}
        {footer}
        <Box flexGrow={1} />
        {credit($, e)}
      </Box>
    )
  }
  // Desktop: quota-switch arrows flank the title, as on the band; the name cell is sized to the longest quota name so arrows don't move on switch.
  // (Arrows used to sit at both ends of the ring row; once readings moved into the image it grew 50% wider and squeezed the arrows against the ring)
  // The terminal pace tab has its own named buttons (h / l), so no title arrows
  const headArrows = !term && m.keys.length > 1
  const headArrow = (offset: -1 | 1) => {
    const name = offset < 0 ? 'prev' : 'next'
    return (
      <Box key={`sw-${name}`} flexShrink={0}>
        <Button
          key={name}
          label={offset < 0 ? '❮' : '❯'}
          plain
          hover={{ color: identityText(P.neighbor(row.key, m.keys, offset) as string), bold: true }}
          onPress={paneAct(name, () => stepKey($, m.keys, row.key, offset))}
        />
      </Box>
    )
  }
  const title = <Text color={identityText(row.key)} bold wrap="truncate-end">{row.full}</Text>
  const header = headArrows ? (
    <Box flexDirection="row" alignItems="center">
      {headArrow(-1)}
      <Box flexShrink={0} width={Math.max(...m.keys.map(k => cells(m.rows[k].full)))} justifyContent="center">{title}</Box>
      {headArrow(1)}
    </Box>
  ) : (
    <Box flexDirection="row" alignItems="center" gap={1}>{title}</Box>
  )
  const tabs = (
    <Box flexDirection="row" gap={1}>
      <Button key="tab-pace" label={L('配速', 'Pace')} {...(term ? { hotkey: '1' } : {})} variant={view.tab === 'pace' ? 'primary' : 'secondary'} onPress={paneAct('tab-pace', () => setView($, v => ({ ...v, tab: 'pace', explore: false })))} />
      <Button key="tab-burnup" label={L('用量轨迹', 'Burn-up')} {...(term ? { hotkey: '2' } : {})} variant={view.tab === 'burnup' ? 'primary' : 'secondary'} onPress={paneAct('tab-burnup', () => setView($, v => ({ ...v, tab: 'burnup', explore: false })))} />
    </Box>
  )
  return (
    <Box flexDirection="column" gap={term ? 1 : 2} paddingX={1} minHeight={fill}>
      {header}
      {tabs}
      {view.tab === 'burnup' ? drawBurnUpTab($, e, samples, m, row, view, now) : drawPaceTab($, e, samples, m, row)}
      {footer}
      <Box flexGrow={1} />
      {credit($, e)}
    </Box>
  )
}

// ======================================================================
// Hooks
// ======================================================================


const commandSpec = () => ({
  name: 'weektoken',
  description: L('打开 WeekToken 配速面板;show / hide 显示或隐藏横条', 'Open the WeekToken pace pane; show / hide the band'),
  argumentHint: '[show | hide]',
  immediate: true,
})

// Timer handles: on another session.start in the same environment (enable, process restart), cancel the old ones first so they don't stack
let timers: { cancel: () => void }[] = []

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (await readDisabled($)) return next(e)
    try {
      const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: unknown }
      if (typeof manifest.version === 'string') await update($, versionA, () => manifest.version as string)
    } catch {}
    try { await refreshLang($) } catch {}
    await $.command.register(commandSpec())
    // "Refreshing" / "confirm hide" left from before the reload will never be cleared otherwise
    try { await update($, noteA, () => null) } catch {}
    try { await update($, confirmHideA, () => false) } catch {}
    try { await loadState($) } catch {}
    try { await importHistory($) } catch {}
    try { await sampleSession($) } catch {}
    try { await sampleCache($) } catch {}
    try { await refreshBand($) } catch {}
    try { await syncPaneOpen($) } catch {}
    // First run after install: say what the band is, when data shows up, and where the entry point is
    if ((await $.store.get('welcomed')) !== true) {
      await $.store.set('welcomed', true)
      $.ui.toast(L(
        'WeekToken 已启用：输入框上方显示用量配速，5 小时 / 7 天的数据在第一条回复后出现。输入 /weektoken 看详情和历史，/weektoken hide 隐藏横条',
        'WeekToken is on: the band above the prompt shows your usage pace; 5-hour and 7-day figures appear after the first reply. Type /weektoken for details and history, /weektoken hide to hide the band',
      ), { timeoutMs: 15_000 })
    }
    for (const t of timers) t.cancel()
    timers = [
      $.clock.every(5 * 60_000, () => { void sampleCache($).catch(() => {}) }),
      $.clock.every(10 * 60_000, () => { void importHistory($).catch(() => {}) }),
      // Every minute: merge samples recorded by other sessions; "elapsed %" moves with time, so recompute the band, writing nothing if the display is unchanged
      $.clock.every(60_000, () => { void adoptStoredSamples($).then(() => refreshBand($)).catch(() => {}) }),
    ]
    return next(e)
  })

  // Every reply uses quota (subagents too): record time and model to determine "last used"
  on('turn.complete', async ($, e, next) => {
    if (disabled) return next(e)
    try { if (e.usage) await recordActivity($, e.usage.model) } catch {}
    return next(e)
  })

  // After each reply, record a sample whenever the officially reported limit windows change (≥ 1 percentage point)
  on('session.measure', async ($, e, next) => {
    if (disabled) return next(e)
    try { await recordRateLimits($, e.rateLimits, await $.clock.now()) } catch {}
    return next(e)
  })

  on('command.run', { command: 'weektoken' }, async ($, e) => {
    await useLang($)
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'show') {
      await setBand($, 'open')
      await refreshBand($)
      return { text: L('横条已显示', 'Band shown') }
    }
    if (arg === 'hide') {
      await setBand($, 'hidden')
      return { text: L('横条已隐藏，输入 /weektoken show 恢复', 'Band hidden; type /weektoken show to bring it back') }
    }
    if (arg) return { text: L(`不认识的参数「${arg}」：可以用 show、hide，不带参数则打开面板`, `Unknown argument "${arg}": use show or hide, or nothing to open the pane`) }
    await refreshAll($, false)
    await openPane($)
    return { text: L('WeekToken 配速面板已打开', 'WeekToken pace pane opened') }
  })

  // Workaround for the pane's first click only taking focus (see paneActions): record every press on the pane…
  on('ui.press', async ($, e, next) => {
    if (disabled || e.plugin !== 'weektoken') return next(e)
    const at = await $.clock.now()
    if (e.component === 'Pane') lastPanePress = { el: e.element, at }
    return next(e)
  })
  // …if focus lands on a button with no press before or after, and the pane didn't have the keyboard, press it once on its behalf
  on('ui.focus', async ($, e, next) => {
    const el = e.element
    if (disabled || e.plugin !== 'weektoken' || e.component !== 'Pane' || !el || e.origin.kind !== 'person' || paneSurface === 'terminal') return next(e)
    const hadKeyboard = paneFocusedAtRender
    const r = await next(e)
    const at = await $.clock.now()
    const pressed = (since: number) => lastPanePress != null && lastPanePress.el === el && lastPanePress.at >= since
    // Pane already had the keyboard: Tab / arrow keys moving focus, or a click that brings its own ui.press. Don't press in either case
    if (hadKeyboard || pressed(at - 300)) return r
    $.clock.after(250, () => {
      if (pressed(at)) return // arrived on its own afterwards
      const act = paneActions.get(el)
      if (!act) return
      void act()
    })
    return r
  })

  // Claude Code's language changed in /config: pass the setting to the engine unchanged, re-detect shortly after (once the new value applies);
  // band and pane redraw accordingly, and the command description switches language too
  on('config.set', { key: 'language' }, async ($, e, next) => {
    if (!disabled) $.clock.after(300, () => { void refreshLang($).then(changed => (changed ? $.command.register(commandSpec()) : undefined)).catch(() => {}) })
    return next(e)
  })

  // The band reads only these: shown/hidden, confirm prompt, language, content to draw (already rounded). Not samples or pane state.
  // After drawing itself it appends what later mods and the engine draw below, without blocking them (same wrapping Box whether or not anything is below)
  // When the pane closes (band "Close", the pane's ×, unload) the band button reverts to "Details"; the close passes through to the engine unchanged
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (!disabled) { try { await update($, paneOpenA, () => false) } catch {} }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (disabled || e.props.hasSurvey) return next(e)
    if (((await read($, bandA)) ?? 'open') === 'hidden') return next(e)
    await useLang($)
    const show = (await read($, confirmHideA)) ? 'confirm' : await read($, bandShowA)
    if (!show) return next(e)
    const ours = show === 'confirm' ? drawConfirmHide($, e) : drawBand($, e, show, !!(await read($, paneOpenA)))
    const below = await next(e)
    const { Box } = $.ui.resolve(e)
    return <Box flexDirection="column">{ours}{isBlank(below) ? null : below}</Box>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const samples = (await read($, samplesA)) ?? []
    const view = (await read($, viewA)) ?? DEFAULT_VIEW
    const note = await read($, noteA)
    const band = (await read($, bandA)) ?? 'open'
    await useLang($)
    const now = await $.clock.now()
    const activity = (await read($, activityA)) ?? { byModel: {} }
    const bandKey = (await read($, bandKeyA)) ?? null
    paneVersion = (await read($, versionA)) ?? ''
    return drawPane($, e, samples, activity, view, note, band, buildModel(samples, view, now, bandKey), now)
  })
}
