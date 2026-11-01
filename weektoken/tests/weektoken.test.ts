import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()

// 5-hour window 60% elapsed, 40% used; 7-day window 5/7 elapsed, 64% used
const LIMITS = [
  { kind: 'five_hour', percentUsed: 40, resetsAt: iso(NOW + 2 * 3600_000) },
  { kind: 'seven_day', percentUsed: 64, resetsAt: iso(NOW + 2 * 86400_000) },
]

const APPLE_ZH = '(\n    "zh-Hans-CN",\n    "en-CN"\n)\n'
const APPLE_EN = '(\n    "en-US"\n)\n'
// Output of local claude -p /usage (excerpt)
const USAGE_OUT = 'Current session: 3% used · resets Oct 3 at 10:00pm (UTC)\nCurrent week (all models): 64% used · resets Oct 5 at 12:00pm (UTC)\nCurrent week (Fable): 29% used · resets Oct 5 at 12:00pm (UTC)\n'

/**
 * The world under the plugin: clock and store in memory; no HOME, no local files read. Returns the store so written values can be checked.
 * Language: the Claude Code language setting comes from setting (defaults to Chinese), system preferred languages from apple.
 */
function world(on: any, setting = '中文', apple = APPLE_EN, env: Record<string, string> = {}, below?: unknown): Record<string, unknown> {
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  const stored: Record<string, unknown> = {}
  const gets: Record<string, number> = {}
  on('store.get', (_$: unknown, e: { key: string }) => { gets[e.key] = (gets[e.key] ?? 0) + 1; return { value: stored[e.key] } })
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => { stored[e.key] = e.value; return { value: undefined } })
  // Engine APIs the plugin calls: the test answers with { value }; session.start is an event and returns its result directly
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: (stored.__limits as unknown[] | undefined) ?? LIMITS } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  // Unset env vars are undefined (same as the engine), not empty strings
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: env[e.name] }))
  on('config.list', () => ({ value: [{ key: 'language', label: 'Language', kind: 'text', value: (stored.__setting as string | undefined) ?? setting, provider: { kind: 'engine' }, isLocked: false }] }))
  on('config.set', (_$: unknown, e: { value: string }) => ({ value: e.value }))
  // /usage: if __usageGate is a Promise, wait for it before answering (to see "refreshing"); fail when __usageFail is set
  on('process.run', async (_$: unknown, e: { argv: string[] }) => {
    if (e.argv[0] === 'defaults') return { value: { exitCode: 0, stdout: apple, stderr: '' } }
    if (e.argv.join(' ').includes('/usage')) {
      stored.__claudeRuns = ((stored.__claudeRuns as number | undefined) ?? 0) + 1
      await (stored.__usageGate as Promise<void> | undefined)
      return { value: stored.__usageFail ? { exitCode: 1, stdout: '', stderr: 'boom' } : { exitCode: 0, stdout: (stored.__usageOut as string | undefined) ?? USAGE_OUT, stderr: '' } }
    }
    const files = stored.__files as Record<string, string> | undefined
    if (e.argv[0] === 'tail' && files?.[e.argv[e.argv.length - 1]!] != null) {
      const lines = files[e.argv[e.argv.length - 1]!]!.split('\n').filter(Boolean)
      const n = Number(e.argv[2])
      return { value: { exitCode: 0, stdout: lines.slice(-n).join('\n') + '\n', stderr: '' } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
  // Files are absent unless a test puts them in __files (path → content, mtime 1)
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: !!(stored.__files as Record<string, string> | undefined)?.[e.path] }))
  const registered: string[] = []
  on('command.register', (_$: unknown, e: { name: string }) => { registered.push(e.name); return { value: { command: e.name } } })
  on('ui.toast', (_$: unknown, e: unknown) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  // Track open panes: ui.open adds, ui.close removes, ui.panes reports them as-is
  const openPanes = new Set<string>()
  on('ui.open', (_$: unknown, e: { id: string }) => { openPanes.add(e.id); return { value: { isPlaced: true } } })
  on('ui.close', (_$: unknown, e: { id: string }) => { openPanes.delete(e.id); return { value: undefined } })
  on('ui.panes', () => ({ value: [...openPanes].map(id => ({ id, title: 'WeekToken', isShown: true, isFocused: false, isPlaced: true })) }))
  stored.__openPanes = openPanes
  // Stand-in for native rendering: draws when the plugin hands back next(e)
  on('ui.render', { component: 'AbovePrompt' }, () => (below ?? { type: 'Box', props: { key: 'native-band' }, children: [] }) as any)
  stored.__toasts = toasts
  stored.__gets = gets
  stored.__clock = clock
  stored.__registered = registered
  return stored
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: {} }

for (const surface of ['desktop', 'terminal'] as const) {
  test(`Band above the prompt renders on ${surface}`, async ($, on) => {
    const stored = world(on)
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true } as any)
    const ui = await $.ui.mount({ plugin: 'weektoken', surface, component: 'AbovePrompt', props: BAND as any })
    // Tightest quota shown by default: both in tier 2 (no early run-out), ranked by burn rate 7-day 0.90× > 5-hour 0.67×
    const opened = JSON.stringify(await ui.drawn())
    expect(opened).not.toContain('band-open')
    expect(opened).toContain('7 天')
    expect(opened).toContain('已用 64%')
    expect(opened).toContain('已过 71%')
    // No pace status, no pin; progress bar sets only height, width follows the band
    expect(opened).not.toContain('"· 富余"')
    expect(opened).not.toContain('📌')
    expect(opened).toContain('"wrap":"truncate-end"')
    if (surface === 'desktop') expect(opened).toContain('width=\\"100%\\"')
    // Progress bar is a plain image, not an interactive frame: the host remounts frames on pane redraw and they flicker
    if (surface === 'desktop') expect(opened).not.toContain('"isInteractive":true')
    expect(opened).not.toContain('用量落后')
    // Prev/next arrows beside the name: switch straight to another quota and remember it
    expect(opened).toContain('"key":"band-next"')
    await ui.press({ key: 'band-next' } as any)
    const switched = JSON.stringify(await ui.drawn())
    expect(switched).toContain('5 小时')
    expect(switched).toContain('已用 40%')
    expect(stored.bandKey).toBe('five_hour')
    // Hiding asks first and points to /weektoken to bring it back; cancel leaves it as is
    await ui.press({ key: 'band-hide' } as any)
    const ask = JSON.stringify(await ui.drawn())
    expect(ask).toContain('/weektoken')
    expect(stored.band).not.toBe('hidden')
    await ui.press({ key: 'band-hide-no' } as any)
    expect(JSON.stringify(await ui.drawn())).toContain('"key":"band-next"')
    // Hide only on confirm: hand back to native rendering, taking no rows
    await ui.press({ key: 'band-hide' } as any)
    await ui.press({ key: 'band-hide-yes' } as any)
    expect(JSON.stringify(await ui.drawn())).toContain('native-band')
    expect(stored.band).toBe('hidden')
  })

  test(`Pace pane and burn-up chart render on ${surface}`, async ($, on) => {
    const stored = world(on)
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true } as any)
    const ui = await $.ui.mount({ plugin: 'weektoken', surface, component: 'Pane', requestId: 'weektoken', props: { bodyColumns: 60 } as any } as any)
    const pace = JSON.stringify(await ui.drawn())
    expect(pace).toContain('配速')
    expect(pace).toContain('用量落后 12 小时 28 分')
    expect(pace).toContain('隐藏横条')
    // No threshold legend; no quota page dots after the title
    expect(pace).not.toContain('超速 >')
    expect(pace).not.toContain('━━')
    // One pane button toggles show/hide; each press switches
    await ui.press({ key: 'band-toggle' } as any)
    expect(stored.band).toBe('hidden')
    expect(JSON.stringify(await ui.drawn())).toContain('显示横条')
    await ui.press({ key: 'band-toggle' } as any)
    expect(stored.band).toBe('open')
    // Two quotas (5-hour, 7-day): switch buttons present (desktop beside the title, terminal below the pace page)
    expect(pace).toContain('"key":"next"')
    await ui.press({ key: 'tab-burnup' } as any)
    const burn = JSON.stringify(await ui.drawn())
    expect(burn).toContain('用量轨迹')
    if (surface === 'terminal') {
      // Terminal burn-up page picks the quota from a dropdown
      expect(burn).toContain('"key":"quota"')
      await ui.select({ key: 'quota', value: 'five_hour' } as any)
      const switched = JSON.stringify(await ui.drawn())
      expect(switched).toContain('5 小时会话额度')
      // Options still include 7-day, but the current value is now 5-hour
      expect(switched).toContain('"value":"five_hour"')
    } else {
      // Desktop uses the arrows beside the title, also on the burn-up page
      await ui.press({ key: 'next' } as any)
      expect(JSON.stringify(await ui.drawn())).toContain('5 小时会话额度')
    }
  })
}

test('Claude Code language unset, system English: UI is English', async ($, on) => {
  world(on, 'Default (English)', APPLE_EN)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  const opened = JSON.stringify(await ui.drawn())
  expect(opened).toContain('"7-day"')
  expect(opened).toContain('64% used')
  expect(opened).toContain('71% elapsed')
  expect(opened).not.toContain('"· Under pace"')
  expect(opened).not.toContain('已用')
})

test('Claude Code language unset, system Chinese: UI follows the system in Chinese', async ($, on) => {
  world(on, 'Default (English)', APPLE_ZH)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  expect(JSON.stringify(await ui.drawn())).toContain('已用 64%')
})

test('Claude Code set to another language, system Chinese: setting wins and other languages show English', async ($, on) => {
  world(on, 'japanese', APPLE_ZH)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: { bodyColumns: 60 } as any } as any)
  const pane = JSON.stringify(await ui.drawn())
  expect(pane).toContain('Pace')
  expect(pane).toContain('Refresh')
  // Capitalized like "7-day · Fable"
  expect(pane).toContain('7-day · All models')
})

test('WEEKTOKEN_LANG=zh env var overrides the English Claude Code setting', async ($, on) => {
  world(on, 'English', APPLE_EN, { WEEKTOKEN_LANG: 'zh' })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  expect(JSON.stringify(await ui.drawn())).toContain('已用 64%')
})

test('Refresh runs /usage and adds per-model quotas such as Fable', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  // Terminal: burn-up dropdown gains Fable, options use short names
  const term = await $.ui.mount({ plugin: 'weektoken', surface: 'terminal', component: 'Pane', requestId: 'weektoken', props: { bodyColumns: 60 } as any } as any)
  expect(JSON.stringify(await term.drawn())).not.toContain('Fable')
  await term.press({ key: 'refresh' } as any)
  await term.press({ key: 'tab-burnup' } as any)
  const burn = JSON.stringify(await term.drawn())
  expect(burn).toContain('"label":"Fable"')
  expect(burn).toContain('"label":"全部模型"')
  expect(burn).toContain('"label":"5 小时"')
  expect(burn).toContain('↻ 刷新')
  // Desktop: arrows beside the title can reach Fable
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: { bodyColumns: 60 } as any } as any)
  let seen = false
  for (let i = 0; i < 3 && !seen; i++) { await ui.press({ key: 'next' } as any); seen = JSON.stringify(await ui.drawn()).includes('Fable') }
  expect(seen).toBe(true)
})

test('Legacy pinned quota carries over as the band quota, and legacy "collapsed" is treated as shown', async ($, on) => {
  const stored = world(on)
  stored.view = { key: null, pinned: 'five_hour' }
  stored.band = 'mini'
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  const band = JSON.stringify(await ui.drawn())
  expect(band).toContain('5 小时')
  expect(band).toContain('已用 40%')
})

test('First session after install announces the entry point once, then never again', async ($, on) => {
  const stored = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const toasts = stored.__toasts as string[]
  expect(toasts.join('\n')).toContain('/weektoken')
  expect(stored.welcomed).toBe(true)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  expect(toasts.filter(t => t.includes('/weektoken')).length).toBe(1)
})

test('Pane footer shows the author credit', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: { bodyColumns: 60 } as any } as any)
  const pane = JSON.stringify(await ui.drawn())
  expect(pane).toContain('@mj0011sec')
  expect(pane).not.toContain('"type":"Link"')
})

test('Band output is unchanged when a new sample leaves its displayed numbers the same, and changes only when they change', async ($, on) => {
  world(on)
  on('session.measure', (_$: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  // Button handles change on every draw; strip them before comparing
  const drawn = async () => JSON.stringify(await ui.drawn()).replace(/"handle":\d+/g, '')
  const before = await drawn()
  // 7-day 64.2%: still 64% after rounding, band must not change
  await $.session.measure({ context: { window: 200000 }, rateLimits: [LIMITS[0], { ...LIMITS[1], percentUsed: 64.2 }], changed: ['rateLimits'] } as any)
  expect(await drawn()).toBe(before)
  // 66%: changed
  await $.session.measure({ context: { window: 200000 }, rateLimits: [LIMITS[0], { ...LIMITS[1], percentUsed: 66 }], changed: ['rateLimits'] } as any)
  expect(await drawn()).toContain('已用 66%')
})

test('"Last used" follows local replies: no hint while replies keep coming; Fable counts only Fable model replies', async ($, on) => {
  const stored = world(on)
  const clock = stored.__clock as { advance: (ms: number) => Promise<void> }
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: { bodyColumns: 60 } as any } as any)
  await ui.press({ key: 'refresh' } as any) // adds Fable
  const turn = (model: string) => $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer', usage: { model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any)
  // Opus in use for 40 minutes while the 7-day percent did not move: no "last used"
  for (let i = 0; i < 4; i++) { await clock.advance(10 * 60_000); await turn('claude-opus-5-5') }
  expect(JSON.stringify(await ui.drawn())).not.toContain('上次使用')
  // Idle 40 minutes: says 40 minutes ago
  await clock.advance(40 * 60_000)
  await ui.press({ key: 'tab-pace' } as any)
  expect(JSON.stringify(await ui.drawn())).toContain('上次使用：40 分前')
  // Switch to Fable: only Opus was used, so Fable is unused since refresh fetched it
  // Use the arrows beside the title to reach Fable
  for (let i = 0; i < 3 && (stored.view as { key?: string } | undefined)?.key !== 'weekly_fable'; i++) await ui.press({ key: 'next' } as any)
  expect((stored.view as { key: string }).key).toBe('weekly_fable')
  expect(JSON.stringify(await ui.drawn())).toContain('至少 1 小时 20 分没用过 Fable')
})

test('With several sessions open, writing samples first merges what others just wrote instead of overwriting it', async ($, on) => {
  const stored = world(on)
  on('session.measure', (_$: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  // Another session writes a later sample meanwhile
  const other = { t: NOW + 30 * 60_000, w: { five_hour: { u: 41, r: NOW + 2 * 3600_000 } } }
  stored.samples = [...(stored.samples as unknown[]), other]
  // This session records one more
  await $.session.measure({ context: { window: 200000 }, rateLimits: [{ ...LIMITS[0], percentUsed: 45 }, LIMITS[1]], changed: ['rateLimits'] } as any)
  const ts = (stored.samples as { t: number }[]).map(x => x.t)
  expect(ts).toContain(other.t)
  expect((stored.samples as { w: Record<string, { u: number }> }[]).some(x => x.w.five_hour?.u === 45)).toBe(true)
})

test('Band draws itself and then appends the bands of other mods below', async ($, on) => {
  // Next in line (another mod / the engine) draws one row
  world(on, '中文', APPLE_EN, {}, { type: 'Box', props: { key: 'other-mod' }, children: [{ type: 'Text', props: {}, children: ['other band'] }] })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  const band = JSON.stringify(await ui.drawn())
  expect(band).toContain('已用 64%')
  expect(band).toContain('other band')
})

test('/weektoken hide and show hide or show the band directly; unknown arguments get a hint', async ($, on) => {
  const stored = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  const hid = await $.command.run({ command: 'weektoken', args: 'hide' } as any)
  expect(JSON.stringify(hid)).toContain('/weektoken show')
  expect(stored.band).toBe('hidden')
  expect(JSON.stringify(await ui.drawn())).toContain('native-band')
  await $.command.run({ command: 'weektoken', args: 'show' } as any)
  expect(stored.band).toBe('open')
  expect(JSON.stringify(await ui.drawn())).toContain('已用 64%')
  expect(JSON.stringify(await $.command.run({ command: 'weektoken', args: 'foo' } as any))).toContain('show')
})

test('CLAUDE_MODS_DISABLE=weektoken: draws nothing and registers no command', async ($, on) => {
  const stored = world(on, '中文', APPLE_EN, { CLAUDE_MODS_DISABLE: 'other, weektoken' })
  const registered = stored.__registered as string[]
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  expect(JSON.stringify(await ui.drawn())).toContain('native-band')
  expect(registered).not.toContain('weektoken')
})

const PANE_PROPS = { bodyColumns: 60, isFocused: false, scroll: { offset: 0, bodyRows: 30 } }

test('Refresh: button reads "refreshing…" while running and resets after; no "updated" in the footer; toast only when /usage fails', async ($, on) => {
  const stored = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  let open!: () => void
  stored.__usageGate = new Promise<void>(r => { open = r })
  const pressing = ui.press({ key: 'refresh' } as any)
  // /usage still running: button shows in progress, pressing again starts no second run
  for (let i = 0; i < 20 && !JSON.stringify(await ui.drawn()).includes('刷新中'); i++) await (stored.__clock as { advance: (ms: number) => Promise<void> }).advance(1)
  expect(JSON.stringify(await ui.drawn())).toContain('↻ 刷新中…')
  open()
  await pressing
  const after = JSON.stringify(await ui.drawn())
  expect(after).toContain('↻ 刷新')
  expect(after).not.toContain('刷新中')
  expect(after).not.toContain('已更新')
  expect(after).not.toContain('已是最新')
  expect((stored.__toasts as string[]).join('\n')).not.toContain('/usage')
  // /usage fails: show a toast
  stored.__usageGate = undefined
  stored.__usageFail = true
  await ui.press({ key: 'refresh' } as any)
  expect((stored.__toasts as string[]).join('\n')).toContain('/usage')
})

test('New session with no replies yet (no live limits): refresh fills in 5-hour and 7-day via /usage', async ($, on) => {
  const stored = world(on)
  stored.__limits = []
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  expect(JSON.stringify(await ui.drawn())).toContain('还没有数据')
  await ui.press({ key: 'refresh' } as any)
  const keys = new Set((stored.samples as { w: Record<string, unknown> }[]).flatMap(s => Object.keys(s.w)))
  expect([...keys].sort()).toEqual(['five_hour', 'seven_day', 'weekly_fable'])
})

test('Window past its reset time: band says "reset" and stops showing the previous window usage', async ($, on) => {
  const stored = world(on)
  stored.__limits = [{ kind: 'seven_day', percentUsed: 64, resetsAt: iso(NOW - 60_000) }]
  stored.bandKey = 'seven_day'
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  const band = JSON.stringify(await ui.drawn())
  expect(band).toContain('已重置')
  expect(band).not.toContain('已用 64%')
})

test('Band does not wrap when the terminal narrows (pane docked beside it): drops "elapsed" first, then the progress bar', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  const at = async (cols: number) => {
    const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: cols } as any })
    return JSON.stringify(await ui.drawn())
  }
  const wide = await at(100)
  expect(wide).toContain('已过 71%')
  expect(wide).toContain('░')
  const mid = await at(60)
  expect(mid).not.toContain('已过')
  expect(mid).toContain('░')
  const narrow = await at(45)
  expect(narrow).toContain('已用 64%')
  expect(narrow).not.toContain('░')
})

test('Changing the Claude Code language switches the band language and re-registers the command description', async ($, on) => {
  const stored = world(on, '中文', APPLE_EN)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  expect(JSON.stringify(await ui.drawn())).toContain('已用 64%')
  stored.__setting = 'English'
  await $.config.set({ key: 'language', value: 'English' } as any)
  // Setting passes through to the engine; language is re-detected shortly after
  await (stored.__clock as { advance: (ms: number) => Promise<void> }).advance(400)
  expect(JSON.stringify(await ui.drawn())).toContain('64% used')
  expect((stored.__registered as string[]).filter(n => n === 'weektoken').length).toBe(2)
})

test('Per-minute merge of samples from other sessions skips the full read when the stored revision is unchanged', async ($, on) => {
  const stored = world(on)
  const clock = stored.__clock as { advance: (ms: number) => Promise<void> }
  const gets = stored.__gets as Record<string, number>
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  await clock.advance(60_000)
  const before = gets.samples ?? 0
  await clock.advance(3 * 60_000)
  expect(gets.samples ?? 0).toBe(before)
  // Another session wrote: revision changed, read in on the next minute
  const other = { t: NOW + 30 * 60_000, w: { five_hour: { u: 41, r: NOW + 2 * 3600_000 } } }
  stored.samples = [...(stored.samples as unknown[]), other]
  stored.samplesRev = 'other-session'
  await clock.advance(60_000)
  expect(gets.samples).toBe(before + 1)
})

test('Band and pane always show the same quota: switching in either switches both', async ($, on) => {
  const stored = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const band = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  const pane = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  // Nothing chosen yet: both show the tightest quota, 7-day
  expect(JSON.stringify(await band.drawn())).toContain('已用 64%')
  expect(JSON.stringify(await pane.drawn())).toContain('7 天 · 全部模型')
  // Switch to 5-hour on the band: pane follows
  await band.press({ key: 'band-next' } as any)
  expect(JSON.stringify(await pane.drawn())).toContain('5 小时会话额度')
  // Switch back to 7-day in the pane: band follows, both remember
  await pane.press({ key: 'prev' } as any)
  expect(JSON.stringify(await band.drawn())).toContain('已用 64%')
  expect(stored.bandKey).toBe('seven_day')
  expect((stored.view as { key: string }).key).toBe('seven_day')
  // Same for the arrows on the burn-up page
  await pane.press({ key: 'tab-burnup' } as any)
  await pane.press({ key: 'next' } as any)
  expect(JSON.stringify(await band.drawn())).toContain('已用 40%')
})

test('Band name cell has a fixed width so the arrows stay put when switching quotas', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const band = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  const nameBox = async () => {
    const tree = JSON.stringify(await band.drawn())
    return tree.match(/"width":(\d+),"justifyContent":"center"/)?.[1]
  }
  const before = await nameBox()
  expect(before).toBeDefined()
  await band.press({ key: 'band-next' } as any)
  expect(JSON.stringify(await band.drawn())).toContain('5 小时')
  expect(await nameBox()).toBe(before)
})

test('Band "details" button closes the pane on a second press and reads "collapse" while open', async ($, on) => {
  const stored = world(on)
  const open = stored.__openPanes as Set<string>
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const band = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  expect(JSON.stringify(await band.drawn())).toContain('"label":"详情"')
  await band.press({ key: 'open' } as any)
  expect(open.has('weektoken')).toBe(true)
  expect(JSON.stringify(await band.drawn())).toContain('"label":"收起"')
  await band.press({ key: 'open' } as any)
  expect(open.has('weektoken')).toBe(false)
  expect(JSON.stringify(await band.drawn())).toContain('"label":"详情"')
})

test('Desktop band: at a given width all quotas agree on showing "elapsed", dropping the whole segment when it does not fit', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const at = async (cols: number) => {
    const band = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND, bodyColumns: cols } as any })
    const seven = JSON.stringify(await band.drawn())
    await band.press({ key: 'band-next' } as any)
    const five = JSON.stringify(await band.drawn())
    await band.press({ key: 'band-prev' } as any)
    // Check only the band text (the progress bar image alt text also contains "elapsed")
    return [seven.includes('"· 已过 '), five.includes('"· 已过 ')]
  }
  expect(await at(100)).toEqual([true, true])
  expect(await at(54)).toEqual([false, false])
})

test('Burn-up "past month" is a plain image until "explore" swaps in a hoverable frame; changing range exits it', async ($, on) => {
  const stored = world(on)
  // Previous 7-day window (ended) has two samples peaking at 30%; current window has one
  const prevReset = NOW + 2 * 86400_000 - 7 * 86400_000
  const curReset = NOW + 2 * 86400_000
  stored.samples = [
    { t: NOW - 8 * 86400_000, w: { seven_day: { u: 10, r: prevReset } } },
    { t: NOW - 6 * 86400_000, w: { seven_day: { u: 30, r: prevReset } } },
    { t: NOW - 1 * 86400_000, w: { seven_day: { u: 50, r: curReset } } },
  ]
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const pane = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  await pane.press({ key: 'tab-burnup' } as any)
  // "This window" has no explore
  expect(JSON.stringify(await pane.drawn())).not.toContain('"key":"explore"')
  await pane.press({ key: 'range-month' } as any)
  const still = JSON.stringify(await pane.drawn())
  expect(still).toContain('"key":"explore"')
  expect(still).toContain('⤢ 逐条查看')
  expect(still).toContain('"display":"none"')
  expect(still).not.toContain('"isInteractive":true')
  expect(still).not.toContain('class=\\"w ')
  await pane.press({ key: 'explore' } as any)
  const live = JSON.stringify(await pane.drawn())
  expect(live).toContain('"isInteractive":true')
  expect(live).toContain('class=\\"w w0\\"')
  expect(live).toContain('峰值 30%')
  expect(live).toContain('✓ 完成')
  expect(live).not.toContain('"display":"none"')
  // Press again to exit
  await pane.press({ key: 'explore' } as any)
  expect(JSON.stringify(await pane.drawn())).not.toContain('"isInteractive":true')
  // Changing range exits automatically
  await pane.press({ key: 'explore' } as any)
  await pane.press({ key: 'range-all' } as any)
  expect(JSON.stringify(await pane.drawn())).not.toContain('"isInteractive":true')
})

test('Pace page: three readings drawn inside the ring; under pace gets same-hue headroom hatching, over pace a one-step darker hatched segment; no glow', async ($, on) => {
  const stored = world(on)
  on('session.measure', (_$: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const pane = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  const under = JSON.stringify(await pane.drawn())
  // Readings are inside the chart (small label above, number below); the native text row is gone
  expect(under).toContain('>已用</text>')
  expect(under).toContain('>距重置</text>')
  expect(under).not.toContain('"已过"')
  expect(under).not.toContain('feGaussianBlur')
  expect(under).not.toContain('<animate')
  expect(under).toMatch(/stroke=\\"url\(#wtr[0-9a-z]+m\)\\"/)
  expect(under).not.toMatch(/url\(#wtr[0-9a-z]+x\)/)
  // 7-day at 90% used with only 71% elapsed: the excess is drawn as dark hatching
  stored.__limits = [{ kind: 'seven_day', percentUsed: 90, resetsAt: iso(NOW + 2 * 86400_000) }]
  await $.session.measure({ context: { window: 200000 }, rateLimits: stored.__limits, changed: ['rateLimits'] } as any)
  const over = JSON.stringify(await pane.drawn())
  expect(over).toMatch(/url\(#wtr[0-9a-z]+x\)/)
  expect(over).toContain('>90%</text>')
})

test('Desktop pane: switch arrows beside the title (like the band), fixed-width name cell; ring row holds only the chart', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const pane = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  const tree = await pane.drawn() as any
  const header = tree.children[0]
  const json = JSON.stringify(header)
  expect(json).toContain('"key":"prev"')
  expect(json).toContain('"key":"next"')
  expect(json).toContain('7 天 · 全部模型')
  // Name cell width comes from the longest quota name and stays the same after switching
  const width = (h: any) => h.children.find((c: any) => c.type === 'Box' && typeof c.props?.width === 'number')?.props.width
  const w0 = width(header)
  expect(w0).toBeGreaterThan(0)
  await pane.press({ key: 'next' } as any)
  const after = (await pane.drawn() as any).children[0]
  expect(JSON.stringify(after)).toContain('5 小时')
  expect(width(after)).toBe(w0)
  // Ring row no longer has buttons around it; burn-up page has no separate quota dropdown
  const all = JSON.stringify(await pane.drawn())
  expect(all.match(/"key":"prev"/g)?.length).toBe(1)
  await pane.press({ key: 'tab-burnup' } as any)
  expect(JSON.stringify(await pane.drawn())).not.toContain('"key":"quota"')
})

test('Pane bottom-right credit is followed by the version (from its own plugin.json)', async ($, on) => {
  world(on)
  on('fs.read', (_$: unknown, e: { path: string }) => ({ value: e.path.endsWith('/.claude-plugin/plugin.json') ? JSON.stringify({ name: 'weektoken', version: '9.8.7' }) : '' }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const pane = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  expect(JSON.stringify(await pane.drawn())).toContain('@mj0011sec · v9.8.7')
  const term = await $.ui.mount({ plugin: 'weektoken', surface: 'terminal', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  expect(JSON.stringify(await term.drawn())).toContain('@mj0011sec · v9.8.7')
})

test('Desktop pane leaves two blank rows between layers (title, tabs, ring, text, footer buttons); terminal still leaves one', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const pane = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  const root = await pane.drawn() as any
  expect(root.props.gap).toBe(2)
  // Between the ring and the text below it on the pace page
  const pace = root.children.find((c: any) => c.props?.alignItems === 'center' && c.props?.flexDirection === 'column')
  expect(pace.props.gap).toBe(2)
  const term = await $.ui.mount({ plugin: 'weektoken', surface: 'terminal', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  expect((await term.drawn() as any).props.gap).toBe(1)
})

const API_USAGE = {
  five_hour: { utilization: 41, resets_at: new Date(NOW + 2 * 3600_000).toISOString() },
  seven_day: { utilization: 65, resets_at: new Date(NOW + 2 * 86400_000).toISOString() },
  limits: [
    { kind: 'session', percent: 41, resets_at: new Date(NOW + 2 * 3600_000).toISOString() },
    { kind: 'weekly_all', percent: 65, resets_at: new Date(NOW + 2 * 86400_000).toISOString() },
    { kind: 'weekly_scoped', percent: 33, resets_at: new Date(NOW + 2 * 86400_000).toISOString(), scope: { model: { display_name: 'Fable' } } },
  ],
}

test('Refresh reads usage from the usage endpoint through the session login, without starting claude', async ($, on) => {
  const stored = world(on)
  const fetched: { url: string; auth?: string }[] = []
  on('session.authorize', () => ({ value: { handle: 'h1', kind: 'bearer' } }))
  on('http.fetch', (_$: unknown, e: { url: string; init?: { auth?: string } }) => {
    fetched.push({ url: e.url, auth: e.init?.auth })
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(API_USAGE) } }
  })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const pane = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  await pane.press({ key: 'refresh' } as any)
  expect(fetched).toEqual([{ url: 'https://api.anthropic.com/api/oauth/usage', auth: 'h1' }])
  expect(stored.__claudeRuns ?? 0).toBe(0)
  const fable = (stored.samples as { w: Record<string, { u: number }> }[]).find(s => s.w.weekly_fable)
  expect(fable?.w.weekly_fable.u).toBe(33)
})

test('Refresh falls back to claude /usage when the usage endpoint fails', async ($, on) => {
  const stored = world(on)
  on('session.authorize', () => ({ value: { handle: 'h1', kind: 'bearer' } }))
  on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: 'oops' } }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const pane = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  await pane.press({ key: 'refresh' } as any)
  expect(stored.__claudeRuns).toBe(1)
  expect((stored.samples as { w: Record<string, unknown> }[]).some(s => s.w.weekly_fable)).toBe(true)
})

const clockOf = (stored: Record<string, unknown>) => stored.__clock as { advance: (ms: number) => Promise<void> }
const usageApi = (on: any, fetched: string[], answer = () => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(API_USAGE) })) => {
  on('session.authorize', () => ({ value: { handle: 'h1', kind: 'bearer' } }))
  on('http.fetch', (_$: unknown, e: { url: string }) => { fetched.push(e.url); return { value: answer() } })
}

test('With no refresh pressed and nothing else running /usage, the usage endpoint is read every 15 minutes, Fable included', async ($, on) => {
  const stored = world(on)
  const fetched: string[] = []
  usageApi(on, fetched)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  await clockOf(stored).advance(60_000)
  expect(fetched.length).toBe(1)
  expect((stored.samples as { w: Record<string, unknown> }[]).some(s => s.w.weekly_fable)).toBe(true)
  await clockOf(stored).advance(15 * 60_000)
  expect(fetched.length).toBe(2)
  expect(stored.__claudeRuns ?? 0).toBe(0)
})

// A verified Ultra account: no 5-hour limit, so the endpoint and the session's own limits carry 7-day and Fable only
const ULTRA_USAGE = {
  five_hour: null,
  seven_day: { utilization: 28, resets_at: new Date(NOW + 2 * 86400_000).toISOString() },
  limits: [
    { kind: 'weekly_all', percent: 28, resets_at: new Date(NOW + 2 * 86400_000).toISOString() },
    { kind: 'weekly_scoped', percent: 25, resets_at: new Date(NOW + 2 * 86400_000).toISOString(), scope: { model: { display_name: 'Fable' } } },
  ],
}

test('A quota the usage endpoint stops listing (5-hour on Ultra) leaves the band and pane, and comes back when listed again', async ($, on) => {
  const stored = world(on)
  const fetched: string[] = []
  let answer: unknown = ULTRA_USAGE
  usageApi(on, fetched, () => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(answer) }))
  // The last 5-hour reading is from before the plan changed; the band was set to it
  stored.samples = [{ t: NOW - 6 * 3600_000, w: { five_hour: { u: 10, r: NOW - 2 * 3600_000 }, seven_day: { u: 27, r: NOW + 2 * 86400_000 } } }]
  stored.bandKey = 'five_hour'
  stored.__limits = [{ kind: 'seven_day', percentUsed: 28, resetsAt: iso(NOW + 2 * 86400_000) }]
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const band = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  // Before the endpoint answers, the old 5-hour reading is still what the band was set to
  expect(JSON.stringify(await band.drawn())).toContain('5 小时')
  await clockOf(stored).advance(60_000)
  expect(fetched.length).toBe(1)
  expect(stored.listed).toEqual({ at: NOW + 20_000, keys: ['seven_day', 'weekly_fable'] })
  const shown = JSON.stringify(await band.drawn())
  expect(shown).not.toContain('5 小时')
  expect(shown).toContain('7 天')
  // The pick is kept, so the band goes back to 5-hour if the plan has it again
  expect(stored.bandKey).toBe('five_hour')
  const pane = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('用量接口已不再返回')
  expect(drawn).not.toContain('5 小时会话额度 ›')

  answer = API_USAGE
  await clockOf(stored).advance(15 * 60_000)
  expect(fetched.length).toBe(2)
  expect(JSON.stringify(await band.drawn())).toContain('5 小时')
  expect(JSON.stringify(await pane.drawn())).not.toContain('用量接口已不再返回')
})

test('Sessions share the schedule: a read another session made moments ago is not repeated', async ($, on) => {
  const stored = world(on)
  const fetched: string[] = []
  usageApi(on, fetched)
  stored.usageFetch = { at: NOW, backoffUntil: 0 }
  stored.listed = { at: NOW + 500, keys: ['five_hour', 'seven_day', 'weekly_fable'] }
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  await clockOf(stored).advance(60_000)
  expect(fetched.length).toBe(0)
  await clockOf(stored).advance(15 * 60_000)
  expect(fetched.length).toBe(1)
})

test('A recent read that left no quota list (a session on an older version made it) is made again', async ($, on) => {
  const stored = world(on)
  const fetched: string[] = []
  usageApi(on, fetched)
  stored.usageFetch = { at: NOW, backoffUntil: 0 }
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  await clockOf(stored).advance(60_000)
  expect(fetched.length).toBe(1)
  expect((stored.listed as { keys: string[] }).keys).toEqual(['five_hour', 'seven_day', 'weekly_fable'])
  // Now with a list, the shared schedule holds again
  await clockOf(stored).advance(5 * 60_000)
  expect(fetched.length).toBe(1)
})

test('A failing usage endpoint is left alone for an hour', async ($, on) => {
  const stored = world(on)
  const fetched: string[] = []
  usageApi(on, fetched, () => ({ status: 429, ok: false, headers: {}, text: 'slow down' }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  await clockOf(stored).advance(60_000)
  expect(fetched.length).toBe(1)
  await clockOf(stored).advance(30 * 60_000)
  expect(fetched.length).toBe(1)
  await clockOf(stored).advance(45 * 60_000)
  expect(fetched.length).toBe(2)
})

test('Burn-up says so when a quota has had no reading for a long stretch of this window, instead of a quietly short line', async ($, on) => {
  const stored = world(on)
  const r = NOW + 2 * 86400_000
  const samples: unknown[] = []
  for (let t = NOW - 5 * 86400_000; t <= NOW - 2 * 86400_000; t += 3600_000) samples.push({ t, w: { weekly_fable: { u: Math.round((t - (NOW - 5 * 86400_000)) / 86400_000 * 10), r, n: 'Fable' } } })
  stored.samples = samples
  stored.bandKey = 'weekly_fable'
  stored.view = { key: 'weekly_fable' }
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  await ui.drawn()
  await ui.press({ key: 'tab-burnup' } as any)
  const burn = JSON.stringify(await ui.drawn())
  expect(burn).toContain('之后没有新读数')
  expect(burn).toContain('2 天')
})

test('Writing samples keeps the oldest history: older samples are thinned, not cut at a fixed count', async ($, on) => {
  const stored = world(on)
  const samples: unknown[] = []
  // 100 days, one reading every 15 minutes: 9600 samples, more than the old cap of 8000
  for (let t = NOW - 100 * 86400_000; t < NOW - 3600_000; t += 15 * 60_000) samples.push({ t, w: { seven_day: { u: 10 + Math.round(((t / 60_000) % 10080) / 200), r: t - (t % (7 * 86400_000)) + 7 * 86400_000 } } })
  stored.samples = samples
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  await clockOf(stored).advance(61_000)
  const kept = stored.samples as { t: number }[]
  expect(kept[0]!.t).toBe((samples[0] as { t: number }).t)
  expect(kept.length).toBeLessThan(samples.length)
  // The last two weeks are kept whole
  const recent = (samples as { t: number }[]).filter(x => x.t > NOW - 13 * 86400_000).length
  expect(kept.filter(x => x.t > NOW - 13 * 86400_000 && x.t < NOW - 1800_000).length).toBe(recent)
})

test('The whole history file of the macOS app is imported once, not only its last 8000 lines', async ($, on) => {
  const stored = world(on, '中文', APPLE_EN, { HOME: '/home/u' })
  const rows: string[] = []
  for (let i = 0; i < 9000; i++) {
    const t = (NOW - (9000 - i) * 10 * 60_000) / 1000
    rows.push(JSON.stringify({ t, rl: { seven_day: { used_percentage: (i % 100), resets_at: t + 3600 } } }))
  }
  stored.__files = { '/home/u/.weektoken/samples.jsonl': rows.join('\n') }
  // Imported before by an earlier version, at the same file time: the full import still happens once
  stored.historyMtime = 1
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  await clockOf(stored).advance(1_000)
  const first = (stored.samples as { t: number }[])[0]!.t
  expect(first).toBe(NOW - 9000 * 10 * 60_000)
})

