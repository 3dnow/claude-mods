// WeekToken mod
//
// 配速:相对于时间,用得算快还是算慢。
//   · 输入框上方一条:‹ 名字 › · 已用 · 已过 + 随宽度伸缩的进度条。默认显示最紧的配额,
//     名字两侧的前后箭头直接换成别的配额并记住;「隐藏」后不占行,从面板恢复。
//   · /weektoken 打开面板:配速环(两侧切配额)、解说、已用/已过/重置、用量轨迹
//   数据:会话自己的 rateLimits(5 小时 / 7 天,每次回复更新)+ Claude Code 本地用量缓存
//   ~/.claude.json(含 Fable 等分模型配额)+ WeekToken macOS 版的历史采样(只读导入)。

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Activity, BandMode, BandShow, Note, PaneView, Sample } from '../types'
import { L, langFromAppleLanguages, langFromEnv, langFromSetting, setLang, type Lang } from './i18n.ts'
import * as P from './pace.ts'
import { identity, identityText, statusText, STATUS } from './theme.ts'
import { bandBarSvg, burnUpSvg, creditSvg, ringsSvg } from './svg.ts'

const PANE = 'weektoken'
const DEFAULT_VIEW: PaneView = { key: null, tab: 'pace', range: 'current', offset: 0 }
const ORANGE = '#FF9500'

const samplesA = atom({ plugin: 'weektoken', key: 'samples' } as const, [] as Sample[])
const viewA = atom({ plugin: 'weektoken', key: 'view' } as const, DEFAULT_VIEW)
const noteA = atom({ plugin: 'weektoken', key: 'note' } as const, null as Note)
const bandA = atom({ plugin: 'weektoken', key: 'band' } as const, 'open' as BandMode)
const confirmHideA = atom({ plugin: 'weektoken', key: 'confirmHide' } as const, false)
// 当前看的配额(横条和面板共用,切换时和 view.key 一起写,见 selectQuota)
const bandKeyA = atom({ plugin: 'weektoken', key: 'bandKey' } as const, null as string | null)
const bandShowA = atom({ plugin: 'weektoken', key: 'bandShow' } as const, null as BandShow | null)
const activityA = atom({ plugin: 'weektoken', key: 'activity' } as const, { byModel: {} } as Activity)
// 面板开着没有:横条上的按钮据此写「收起」或「详情」
const paneOpenA = atom({ plugin: 'weektoken', key: 'paneOpen' } as const, false)
const AUTHOR = { x: 'mj0011sec' }

// CLAUDE_MODS_DISABLE=all,或逗号列表里有 weektoken:所有钩子放行,也不注册命令
let disabled = false
async function readDisabled($: any): Promise<boolean> {
  const raw = ((await $.env.get('CLAUDE_MODS_DISABLE')) ?? '').toLowerCase()
  disabled = raw.split(',').map((v: string) => v.trim()).some((v: string) => v === 'all' || v === 'weektoken')
  return disabled
}
const langA = atom({ plugin: 'weektoken', key: 'lang' } as const, 'en' as Lang)

// ======================================================================
// 模型:由采样算出每个配额的显示状态、瓶颈和面板选中的配额
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
      // 不按数据新旧降级:没用就不会变,旧数据照样能算配速(底部另说多久没用了)
      d: P.display(lo?.obs, len.seconds, now),
      name: P.displayName(k, lo?.obs.n),
      full: P.fullName(k, lo?.obs.n),
    }
  }
  const bottleneck = P.pickBottleneck(keys.map(k => ({ key: k, pace: rows[k].d.kind === 'pace' ? rows[k].d.pace : null })))
  // 横条:用横条上的箭头选过就显示选的那个,否则自动显示最紧的
  const band = bandKey && rows[bandKey] ? bandKey : bottleneck
  // 面板和横条看同一个配额(切换时两边一起写);都没选过就一起显示最紧的
  const selected = view.key && rows[view.key] ? view.key : (band ?? keys[0] ?? null)
  return { keys, rows, band, selected }
}

/** 横条要画的东西,按显示精度取整;算不出就是 null(横条交回原生绘制) */
function bandShowOf(samples: readonly Sample[], bandKey: string | null, now: number): BandShow | null {
  if (!samples.length) return null
  const m = buildModel(samples, DEFAULT_VIEW, now, bandKey)
  const row = m.band ? m.rows[m.band] : undefined
  if (!row) return null
  // 最后一次观测的窗口已经过了重置时刻:那时的用量已作废,横条写「已重置」,等下一次回复带来新窗口
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
// 取数
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
 * 写回存储前先和已存的合并:几个会话同时开着,各自整份写会把别的会话刚记的采样冲掉。
 * 合并后别的会话的采样也并进本会话。读-并-写不是原子的,偶尔撞车也只是晚一次补上:每个会话下次写时还会再并。
 */
async function persistSamples($: any): Promise<void> {
  const stored = await $.store.get('samples')
  const mine = (await read($, samplesA)) ?? []
  let merged = P.mergeSamples(Array.isArray(stored) ? (stored as Sample[]) : [], mine)
  try {
    await $.store.set('samples', merged)
  } catch {
    // 存储有大小上限(每个插件 4 MiB):写不进就裁掉最旧的四分之一再写一次
    merged = merged.slice(Math.floor(merged.length / 4))
    await $.store.set('samples', merged)
  }
  // 小小的版本号:别的会话每分钟先看它,没变就不必把整份采样读过去
  lastSeenRev = `${merged.length}:${merged[merged.length - 1]?.t ?? 0}`
  await $.store.set('samplesRev', lastSeenRev)
  if (merged.length !== mine.length) await update($, samplesA, () => merged)
}

let lastSeenRev: string | null = null

/** 把别的会话写进存储的采样并进本会话(不写回);有新的才动状态 */
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

/** 记一次回复(含子代理):任何模型都算用了 5 小时 / 7 天,对应家族的模型算用了它的分模型配额 */
async function recordActivity($: any, model: string | undefined): Promise<void> {
  const now = await $.clock.now()
  const fam = P.modelFamily(model)
  await update($, activityA, a => mergeActivity(a ?? { byModel: {} }, { any: now, byModel: fam ? { [fam]: now } : {} }))
  // 别的会话也在写:存之前和已存的合并,取较晚的
  const stored = ((await $.store.get('activity')) as Activity | undefined) ?? { byModel: {} }
  await $.store.set('activity', mergeActivity(stored, await read($, activityA)))
}

/** 什么都不画的树:空、空字符串、只有空 Box/Text */
function isBlank(node: any): boolean {
  if (node == null || node === false || node === '') return true
  if (Array.isArray(node)) return node.every(isBlank)
  if (typeof node === 'string') return node.trim() === ''
  if (typeof node === 'object' && (node.type === 'Box' || node.type === 'Text')) return isBlank(node.children ?? node.props?.children)
  return false
}

/** 重算横条要画的东西;和现在一样就不写——不写就不重画 */
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

/** Claude Code 的本地用量缓存(含分模型配额);文件没变就不再解析 */
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
    text = await extractCacheWithPerl($, path) // 超过 4 MiB 读不进来时,只抽缓存那一段
  }
  if (!text) return false
  const s = P.parseClaudeJsonCache(text, await $.clock.now())
  return s ? addSample($, s) : false
}

async function extractCacheWithPerl($: any, path: string): Promise<string | null> {
  // -0777:整个文件读进来;程序和正则是固定文本,路径作为参数直接交给 perl,不经过 shell
  try {
    const r = await $.process.run(['perl', '-0777', '-ne', 'print $1 if /"cachedUsageUtilization"\\s*:\\s*(\\{(?:[^{}"]++|"(?:\\\\.|[^"\\\\])*+"|(?1))*\\})/', path], { timeoutMs: 15_000 })
    if (r.exitCode === 0 && r.stdout.trim().startsWith('{')) return `{"cachedUsageUtilization":${r.stdout.trim()}}`
  } catch {}
  return null
}

/** WeekToken macOS 版的历史(只读);默认位置,WEEKTOKEN_HISTORY 可改,设成空串就不导入。文件没变就不再导入,返回新导入的条数 */
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
  // 横条和面板看同一个配额。旧版两边分开存过(横条的更早存在 view.bandKey / view.pinned),对不上时以横条的为准
  const bk = (await $.store.get('bandKey')) ?? v?.bandKey ?? v?.pinned ?? null
  const k = typeof bk === 'string' ? bk : typeof v?.key === 'string' ? v.key : null
  if (k) {
    await update($, bandKeyA, () => k)
    await update($, viewA, cur => ({ ...(cur ?? DEFAULT_VIEW), key: k }))
  }
  const act = (await $.store.get('activity')) as Activity | undefined
  if (act && typeof act === 'object') await update($, activityA, cur => mergeActivity(cur ?? { byModel: {} }, act))
  const band = await $.store.get('band')
  // 旧版还有「收起」(mini),现在一律当作显示
  if (band === 'hidden' || band === 'open' || band === 'mini') await update($, bandA, () => (band === 'hidden' ? 'hidden' : 'open'))
}

/**
 * 本机 claude 的 /usage:分模型配额(Fable 等)唯一的新鲜来源。本地命令,不调模型、不耗额度、
 * 不留会话记录;要扫本机会话算用量构成,约 10 秒,所以只在手动刷新时跑。
 * 命令是固定文本,按名字找 claude。桌面端起的进程 PATH 里未必有它,
 * 所以在原有 PATH 后面接上几个常见安装位置(env.PATH 会用来查找程序,已实测)。
 */
async function usagePath($: any): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  const extra = home ? [`${home}/.local/bin`, `${home}/.claude/local`] : []
  return [(await $.env.get('PATH')) ?? '/usr/bin:/bin', ...extra, '/opt/homebrew/bin', '/usr/local/bin'].join(':')
}

/** 跑 /usage 并记一次采样;ok = 拿到并认出了输出 */
async function sampleUsageCommand($: any): Promise<{ ok: boolean; changed: boolean }> {
  const r = await $.process.run(['claude', '-p', '--no-session-persistence', '/usage'], { timeoutMs: 60_000, env: { PATH: await usagePath($) } })
  if (r.exitCode !== 0) return { ok: false, changed: false }
  const s = P.parseUsageCommand(r.stdout, await $.clock.now())
  if (!s) return { ok: false, changed: false }
  // 5 小时 / 7 天以会话自带的(精确到秒)为准;本地 10 分钟内没有更新的读数时(新会话还没回复过)才用这里的
  const samples = (await read($, samplesA)) ?? []
  const w: Record<string, P.Obs> = {}
  for (const [k, o] of Object.entries(s.w)) {
    if (P.isModelScoped(k)) w[k] = o
    else if (k === 'five_hour' || k === 'seven_day') {
      const lo = P.latestObs(samples, k)
      if (!lo || s.t - lo.at > 10 * 60_000) w[k] = o
    }
  }
  return { ok: true, changed: Object.keys(w).length ? await addSample($, { t: s.t, w }) : false }
}

/** 手动刷新的「进行中」:存在状态里,按钮据此显示「刷新中…」;超过 90 秒(子进程超时 60 秒)当作已结束 */
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
    let ok = false
    try { ok = (await sampleUsageCommand($)).ok } catch {}
    // 成功不另说(底部那行和图会自己更新);只有 /usage 跑不出来才提示
    if (!ok) $.ui.toast(L('没能运行 claude /usage:Fable 等分模型配额这次没更新', "Couldn't run claude /usage: per-model quotas such as Fable weren't updated"), { timeoutMs: 8_000 })
  } finally {
    if (manual) await update($, noteA, () => null)
  }
}

// ======================================================================
// 界面语言:WEEKTOKEN_LANG(zh / en)→ Claude Code 的 language 设置 → 系统语言(macOS 首选语言,其次 LC_ALL/LC_MESSAGES/LANG)→ 英文
// ======================================================================

async function detectLang($: any): Promise<Lang> {
  const forced = ((await $.env.get('WEEKTOKEN_LANG')) ?? '').trim().toLowerCase()
  if (forced === 'zh' || forced === 'en') return forced
  try {
    const row = (await $.config.list()).find((r: { key: string }) => r.key === 'language')
    const l = langFromSetting(row?.value)
    if (l) return l
  } catch {}
  // macOS 的「系统语言」是首选语言列表;LANG 只是终端环境,桌面端起的进程里可能另有其值。Linux 没有 defaults,落到 LANG
  try {
    const r = await $.process.run(['defaults', 'read', '-g', 'AppleLanguages'], { timeoutMs: 5_000 })
    const l = r.exitCode === 0 ? langFromAppleLanguages(r.stdout) : null
    if (l) return l
  } catch {}
  return langFromEnv(await $.env.get('LC_ALL')) ?? langFromEnv(await $.env.get('LC_MESSAGES')) ?? langFromEnv(await $.env.get('LANG')) ?? 'en'
}

/** 探测语言;和现在一样就不写(写了横条和面板都会重画)。返回是否变了 */
async function refreshLang($: any): Promise<boolean> {
  const l = await detectLang($)
  setLang(l)
  if ((await read($, langA)) === l) return false
  await update($, langA, () => l)
  return true
}

/** 绘制前对齐语言:模块重载后变量回到默认,而 $.state 里的值还在 */
async function useLang($: any): Promise<void> {
  setLang((await read($, langA)) ?? 'en')
}

// ======================================================================
// 面板与横条的动作
// ======================================================================

async function openPane($: any): Promise<void> {
  await $.ui.open({ id: PANE, title: 'WeekToken' })
  await update($, paneOpenA, () => true)
}

/** 横条上的「详情」:面板开着且在最前面就收起,否则打开(或切到最前面)。按下时问引擎,不靠记的状态 */
async function togglePane($: any): Promise<void> {
  const pane = (await $.ui.panes()).find((p: { id: string; isShown: boolean }) => p.id === PANE)
  if (pane?.isShown) {
    await $.ui.close({ id: PANE })
    await update($, paneOpenA, () => false)
  } else await openPane($)
}

/** 面板实际开着没有,对齐到状态里(会话开始、重载后) */
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
 * 换配额:横条和面板看同一个。横条的箭头、面板两侧的按钮、用量轨迹的下拉,都走这里,两边一起换并记住。
 * (早先分开存,是因为横条一换面板里的框就闪;配速环和进度条都改成普通图片后不再闪,可以合一)
 */
async function selectQuota($: any, k: string): Promise<void> {
  await update($, bandKeyA, () => k)
  await update($, viewA, v => ({ ...(v ?? DEFAULT_VIEW), key: k, offset: 0 }))
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

/** 面板里的显示/隐藏:按下时读当前状态再翻转,不依赖绘制时的快照 */
async function toggleBandHidden($: any): Promise<void> {
  const cur = (await read($, bandA)) ?? 'open'
  await setBand($, cur === 'hidden' ? 'open' : 'hidden')
}

/** 横条上的「隐藏」先问一句:隐藏后横条上再没有入口,要告诉人从 /weektoken 回来;8 秒不理就作罢 */
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

/** 横条上的前后箭头:换配额,面板跟着一起换 */
async function stepBand($: any, keys: readonly string[], cur: string, offset: number): Promise<void> {
  await stepKey($, keys, cur, offset)
}

// 桌面端的面板没拿到键盘时(焦点在输入框),第一次点击只把焦点交给面板:引擎只发 ui.focus,不发 ui.press。
// 实测:有焦点时一次点击是「ui.press → 约 70ms 后 ui.focus」;没焦点时只有 ui.focus。
// 所以绘制面板时按按钮的 key 记下它的动作;ui.focus 落到按钮上、前后都没等到它的 ui.press,就替它按一次。
// 事件里分不出点击和 Tab:面板本来就有键盘时(Tab / 方向键只在这时走焦点)不替它按。
// 「本来就有」看上一次绘制的 e.props.isFocused:焦点离开时面板会重画成 false(真机日志实证);
// $.ui.panes() 在 ui.focus 里已经报告「有焦点」,哪怕是失焦后的第一次点击,不能用。只在桌面端这样做。
const paneActions = new Map<string, () => unknown>()
let paneSurface = 'desktop'
let paneFocusedAtRender = false
let lastPanePress: { el: string; at: number } | null = null

/** 登记面板按钮的动作(补按用);出错只吞掉,不留未处理的拒绝 */
function paneAct(key: string, fn: () => unknown): () => Promise<void> {
  const run = () => Promise.resolve().then(fn).then(() => {}, () => {})
  paneActions.set(key, run)
  return run
}

// ======================================================================
// 绘制:输入框上方的横条
// ======================================================================

const STATUS_DIM = new Set(['early', 'unknown'])
const SVG_MAX = 120_000

/** 点击触发的异步动作:出错只吞掉,不留未处理的拒绝 */
const quiet = (p: Promise<unknown>) => { void p.catch(() => {}) }

/**
 * 画一张 SVG。小图和可交互的图显式给宽高(可交互的图在沙箱 iframe 里,不给会被拉满整行);
 * 宽图表 fluid:不给宽高,按自身宽度、最多缩到面板宽(给了比面板宽的尺寸,会被当成位图缩小而发糊)
 */
function pic($: any, e: any, source: string, alt: string, opts: { isInteractive?: boolean; fluid?: boolean; fillHeight?: number } = {}) {
  const { Svg } = $.ui.resolve(e)
  if (opts.fluid) return <Svg source={source} alt={alt} />
  // 只给高度的普通图片:SVG 不声明宽度(width="100%")、几何全用百分比,宽度随格子、最多到图片默认的 300px,
  // 只变长不变形。不用可交互框:框在同一插件的别处(面板)重画时会被宿主重新装载而闪一下(真机实证)
  if (opts.fillHeight) return <Svg source={source} alt={alt} height={opts.fillHeight} />
  const m = /^<svg[^>]*?\swidth="([\d.]+)"\s+height="([\d.]+)"/.exec(source)
  const size = m ? { width: Number(m[1]), height: Number(m[2]) } : {}
  return opts.isInteractive
    ? <Svg source={source} alt={alt} {...size} isInteractive />
    : <Svg source={source} alt={alt} {...size} />
}

/** 终端里的文字版 bullet:用量块 + 时间竖线 */
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
 * 横条上的一行字:‹ 名字 › · 已用 · 已过。每段一个不折行的 Text(嵌套的 Text 在桌面端会折行);
 * 名字和已用不缩,已过最先被截掉。配速状态看进度条的颜色,不再写字。
 * 有多个配额时名字两侧是前后箭头,悬停染成要切到的那个配额的颜色。
 */
const bandTexts = (show: BandShow) => ({
  name: P.displayName(show.key, show.n),
  used: show.ended ? L('· 已重置', '· reset') : show.used != null ? L(`· 已用 ${show.used}%`, `· ${show.used}% used`) : null,
  elapsed: show.elapsed != null ? L(`· 已过 ${show.elapsed}%`, `· ${show.elapsed}% elapsed`) : null,
  details: L('详情', 'Details'),
  closeDetails: L('收起', 'Close'),
  hide: L('隐藏', 'Hide'),
})

/** 终端里占几格:中日韩和全角字符两格 */
const cells = (s: string) => [...s].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0)

/**
 * 横条上名字那一格的宽度:按所有配额里最长的名字算,名字居中。切换配额时两侧箭头和后面的字都不挪。
 * 终端按字符格精确算;桌面端字体不等宽,多留一格余量
 */
const bandNameWidth = (show: BandShow, term: boolean) =>
  Math.max(...show.keys.map(k => cells(P.displayName(k, k === show.key ? show.n : undefined))), cells(P.displayName(show.key, show.n))) + (term ? 0 : 1)

/**
 * 终端横条的排法:文字照实际宽度排,进度条吃剩下的格子(最多 48)。
 * 不够 8 格先去掉「已过」那段,还不够就不画进度条——绝不让这一行折成两行。
 */
function termBandLayout(show: BandShow, cols: number): { bar: number; withElapsed: boolean } {
  const t = bandTexts(show)
  const width = (withElapsed: boolean) => {
    const parts = [bandNameWidth(show, true), ...[t.used, withElapsed ? t.elapsed : null].filter((s): s is string => !!s).map(cells)]
    if (show.keys.length > 1) parts.push(4, 4) // 「h: ❮」「l: ❯」
    const line = parts.reduce((a, b) => a + b, 0) + parts.length - 1
    // 行、进度条、撑开的空白、详情、隐藏之间各空一格;引擎在最后画收起标记「 [-]」,再留一格余量
    return line + cells(t.details) + cells(t.hide) + 4 + 5
  }
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
      {canSwitch ? arrow(-1) : null}
      <Box flexShrink={0} width={bandNameWidth(show, term)} justifyContent="center"><Text color={identityText(show.key)} wrap="truncate-end">{t.name}</Text></Box>
      {canSwitch ? arrow(1) : null}
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
  // 一行字 + 进度条;详情进面板,隐藏后从面板恢复。
  // 桌面端:字先按自身宽度排好,进度条从 0 起只吃剩下的空间(至少占横条的 15%);再窄,才轮到字从「已过」那段开始截。
  // 终端:进度条是定宽的字,按 bodyColumns(面板停靠在旁边时是对话那一栏的宽度)算好再排
  const lay = term ? termBandLayout(show, e.props?.bodyColumns ?? 80) : { bar: 1, withElapsed: true }
  const pace = used != null && elapsed != null ? ({ used, elapsed } as P.Pace) : null
  return (
    <Box flexDirection="row" alignItems="center" gap={1}>
      {bandLine($, e, show, lay.withElapsed)}
      {term ? (
        lay.bar > 0 ? <Box flexShrink={0}>{termBar($, e, show.key, used, elapsed, show.status, lay.bar)}</Box> : null
      ) : (
        <Box width={0} flexGrow={1} flexShrink={1} minWidth="15%">
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
// 绘制:面板
// ======================================================================

/** 面板底部的提示:这个配额超过半小时没用时,说上次用是多久前(刷新的进行中显示在刷新按钮上,不占这一行) */
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

/**
 * 配速页的切换按钮。mod 里只有 Button 收得到点击,而且它的外观是宿主的;
 * 自己画的外框点不到,所以用原生按钮本身:整块可点,粗箭头 + 空格撑宽,悬停时箭头染成目标配额的身份色。
 */
function switchButton($: any, e: any, m: Model, key: string, offset: -1 | 1) {
  const { Box, Button } = $.ui.resolve(e)
  const tint = identityText(P.neighbor(key, m.keys, offset) as string)
  const name = offset < 0 ? 'prev' : 'next'
  return (
    <Box key={`sw-${name}`}>
      <Button key={name} label={offset < 0 ? '\u2003❮\u2003' : '\u2003❯\u2003'} hover={{ color: tint, bold: true }} onPress={paneAct(name, () => stepKey($, m.keys, key, offset))} />
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
  const trendLine = trend && trend !== 'steady'
    ? <Text color={trend === 'accelerating' ? STATUS.overPace.solid : undefined} dimColor={trend !== 'accelerating'}>{trendText(trend)}</Text>
    : null
  const showBadge = !P.isVerifiedByData(row.len.source)
  const canSwitch = m.keys.length > 1
  const target = (offset: number) => P.neighbor(row.key, m.keys, offset) as string
  const metrics = pace
    ? [
        { v: `${(pace.used * 100).toFixed(1)}%`, l: L('已用', 'Used'), c: identityText(row.key) },
        { v: `${(pace.elapsed * 100).toFixed(1)}%`, l: L('已过', 'Elapsed'), c: undefined },
        { v: P.formatDuration(pace.timeToReset), l: L('后重置', 'Resets in'), c: undefined },
      ]
    : d.kind === 'usageOnly' ? [{ v: `${d.obs.u.toFixed(1)}%`, l: L('已用', 'Used'), c: undefined }] : []

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
        {showBadge ? <Text color={ORANGE}>？{P.windowNote(row.len)}</Text> : null}
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
    <Box flexDirection="column" alignItems="center" gap={1}>
      {/* 左右切换配额:推到这一行的两端,位置固定、不贴圆环(贴着会被辉光吃掉) */}
      <Box flexDirection="row" alignItems="center" width="100%">
        {canSwitch ? switchButton($, e, m, row.key, -1) : null}
        <Box flexGrow={1} />
        {pic($, e, ringsSvg({ used, elapsed: pace?.elapsed ?? null, status: st, id, center, label: P.displayLabel(d), title: label }), label)}
        <Box flexGrow={1} />
        {canSwitch ? switchButton($, e, m, row.key, 1) : null}
      </Box>
      <Box flexDirection="column" alignItems="center">
        <Text bold>{P.displayHeadline(d)}</Text>
        {second ? <Text dimColor wrap="wrap">{second}</Text> : null}
        {trendLine}
      </Box>
      {metrics.length ? (
        <Box flexDirection="row" gap={3} justifyContent="center">
          {metrics.map(x => (
            <Box flexDirection="column" alignItems="center">
              <Text color={x.c} bold>{x.v}</Text>
              <Text dimColor>{x.l}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
      {showBadge ? <Text color={ORANGE}>？{P.windowNote(row.len)}</Text> : null}
    </Box>
  )
}

function drawBurnUpTab($: any, e: any, samples: readonly Sample[], m: Model, row: QuotaRow, view: PaneView, now: number) {
  const { Box, Text, Button, Select } = $.ui.resolve(e)
  const o = P.buildOverlay(row.key, samples, row.len.seconds, view.range, view.offset, now)
  const ranges: P.Range[] = ['current', 'month', 'all']
  // 选配额用下拉;没有 Select 的表面(手机)退回左右按钮
  const quotaPick = m.keys.length < 2 ? null : Select ? (
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
        <Button key={`range-${r}`} label={P.rangeLabel(r)} variant={view.range === r ? 'primary' : 'secondary'} onPress={paneAct(`range-${r}`, () => setView($, v => ({ ...v, range: r, offset: 0 })))} />
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
  const svg = burnUpSvg({ width: 360, overlay: o, W: row.len.seconds, status: P.displayStatus(row.d), id: identity(row.key), title })
  return (
    <Box flexDirection="column" gap={1}>
      {rangeRow}
      {nav}
      {/* Svg 源码上限 131072 字符,超了整棵树会被引擎拒绝;叠画已限量,这里再兜一次底 */}
      {svg.length <= SVG_MAX ? pic($, e, svg, caption ? `${title}. ${caption}` : title, { fluid: true }) : (
        <Text dimColor wrap="wrap">{L('这个范围的数据太多，画不下：换「本窗口」或「近一月」看', 'Too much data to draw for this range: try This window or Last month')}</Text>
      )}
      {caption ? <Text dimColor wrap="wrap">{caption}</Text> : null}
    </Box>
  )
}

/** 署名:面板最底下右下角,推特账号,一行 10px 的半透明小字(画成图;不需要点) */
function credit($: any, e: any) {
  const { Box, Text } = $.ui.resolve(e)
  const handle = `@${AUTHOR.x}`
  return (
    <Box flexDirection="row" justifyContent="flex-end">
      {e.surface === 'terminal' ? <Text dimColor>{handle}</Text> : pic($, e, creditSvg(handle), handle)}
    </Box>
  )
}

function drawPane($: any, e: any, samples: readonly Sample[], activity: Activity, view: PaneView, note: Note, band: BandMode, m: Model, now: number) {
  const { Box, Text, Button } = $.ui.resolve(e)
  // 至少和面板正文一样高(宿主给的行数;Box 的尺寸在各个界面上都按行算),署名前的空白把它推到最底下
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
      <Box flexDirection="column" gap={1} paddingX={1} minHeight={fill}>
        {drawEmpty($, e)}
        {footer}
        <Box flexGrow={1} />
        {credit($, e)}
      </Box>
    )
  }
  const header = (
    <Box flexDirection="row" alignItems="center" gap={1}>
      <Text color={identityText(row.key)} bold wrap="truncate-end">{row.full}</Text>
    </Box>
  )
  const tabs = (
    <Box flexDirection="row" gap={1}>
      <Button key="tab-pace" label={L('配速', 'Pace')} {...(term ? { hotkey: '1' } : {})} variant={view.tab === 'pace' ? 'primary' : 'secondary'} onPress={paneAct('tab-pace', () => setView($, v => ({ ...v, tab: 'pace' })))} />
      <Button key="tab-burnup" label={L('用量轨迹', 'Burn-up')} {...(term ? { hotkey: '2' } : {})} variant={view.tab === 'burnup' ? 'primary' : 'secondary'} onPress={paneAct('tab-burnup', () => setView($, v => ({ ...v, tab: 'burnup' })))} />
    </Box>
  )
  return (
    <Box flexDirection="column" gap={1} paddingX={1} minHeight={fill}>
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
// 钩子
// ======================================================================


const commandSpec = () => ({
  name: 'weektoken',
  description: L('打开 WeekToken 配速面板;show / hide 显示或隐藏横条', 'Open the WeekToken pace pane; show / hide the band'),
  argumentHint: '[show | hide]',
  immediate: true,
})

// 定时器的句柄:同一环境里再收到 session.start(启用、进程重启)时先停掉旧的,不叠加
let timers: { cancel: () => void }[] = []

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (await readDisabled($)) return next(e)
    try { await refreshLang($) } catch {}
    await $.command.register(commandSpec())
    // 重载前留下的「刷新中」「确认隐藏」不会再有人收尾
    try { await update($, noteA, () => null) } catch {}
    try { await update($, confirmHideA, () => false) } catch {}
    try { await loadState($) } catch {}
    try { await importHistory($) } catch {}
    try { await sampleSession($) } catch {}
    try { await sampleCache($) } catch {}
    try { await refreshBand($) } catch {}
    try { await syncPaneOpen($) } catch {}
    // 装好后第一次:说一声横条是什么、数据什么时候出来、入口在哪
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
      // 每分钟:并进别的会话记的采样;「已过 %」随时间走,重算横条,显示没变就什么都不写
      $.clock.every(60_000, () => { void adoptStoredSamples($).then(() => refreshBand($)).catch(() => {}) }),
    ]
    return next(e)
  })

  // 每轮回复都在用额度(子代理也算):记下时刻和模型,判断「上次使用」
  on('turn.complete', async ($, e, next) => {
    if (disabled) return next(e)
    try { if (e.usage) await recordActivity($, e.usage.model) } catch {}
    return next(e)
  })

  // 每次回复后官方报的限额窗口一变(≥ 1 个百分点),就记一次采样
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

  // 面板第一次点击只拿焦点的补救(说明见 paneActions):记下面板上的每次按下……
  on('ui.press', async ($, e, next) => {
    if (disabled || e.plugin !== 'weektoken') return next(e)
    const at = await $.clock.now()
    if (e.component === 'Pane') lastPanePress = { el: e.element, at }
    return next(e)
  })
  // ……焦点落到按钮上、前后都没等到它的按下,而面板之前并没有键盘,就替它按一次
  on('ui.focus', async ($, e, next) => {
    const el = e.element
    if (disabled || e.plugin !== 'weektoken' || e.component !== 'Pane' || !el || e.origin.kind !== 'person' || paneSurface === 'terminal') return next(e)
    const hadKeyboard = paneFocusedAtRender
    const r = await next(e)
    const at = await $.clock.now()
    const pressed = (since: number) => lastPanePress != null && lastPanePress.el === el && lastPanePress.at >= since
    // 面板本来就有键盘:Tab / 方向键在走焦点,或者一次自带 ui.press 的点击——都不替它按
    if (hadKeyboard || pressed(at - 300)) return r
    $.clock.after(250, () => {
      if (pressed(at)) return // 随后自己到了
      const act = paneActions.get(el)
      if (!act) return
      void act()
    })
    return r
  })

  // 在 /config 里改了 Claude Code 的语言:设置原样交给引擎,稍后(新值已生效)重新探测,
  // 横条和面板随之重画,命令说明也换成新语言
  on('config.set', { key: 'language' }, async ($, e, next) => {
    if (!disabled) $.clock.after(300, () => { void refreshLang($).then(changed => (changed ? $.command.register(commandSpec()) : undefined)).catch(() => {}) })
    return next(e)
  })

  // 横条只读这几样:显示/隐藏、确认提示、语言、要画的内容(已取整)。采样和面板状态都不读。
  // 画完自己,把排在后面的 mod 和引擎自己要画的接在下面,不挡别人(下面有没有东西都包同一个 Box)
  // 面板关掉时(横条上「收起」、面板的 ×、卸载)横条按钮改回「详情」;关闭原样交给引擎
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
    return drawPane($, e, samples, activity, view, note, band, buildModel(samples, view, now, bandKey), now)
  })
}
