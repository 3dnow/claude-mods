import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()

// 5 小时窗口过了 60%、用了 40%;7 天窗口过了 5/7、用了 64%
const LIMITS = [
  { kind: 'five_hour', percentUsed: 40, resetsAt: iso(NOW + 2 * 3600_000) },
  { kind: 'seven_day', percentUsed: 64, resetsAt: iso(NOW + 2 * 86400_000) },
]

const APPLE_ZH = '(\n    "zh-Hans-CN",\n    "en-CN"\n)\n'
const APPLE_EN = '(\n    "en-US"\n)\n'
// 本机 claude -p /usage 的输出(节选)
const USAGE_OUT = 'Current session: 3% used · resets Oct 3 at 10:00pm (UTC)\nCurrent week (all models): 64% used · resets Oct 5 at 12:00pm (UTC)\nCurrent week (Fable): 29% used · resets Oct 5 at 12:00pm (UTC)\n'

/**
 * 插件脚下的世界:时钟、存储在内存里;没有 HOME,不读任何本地文件。返回存储,好检查写进去的值。
 * 语言:Claude Code 的 language 设置取 setting(默认设成中文),系统首选语言取 apple。
 */
function world(on: any, setting = '中文', apple = APPLE_EN, env: Record<string, string> = {}, below?: unknown): Record<string, unknown> {
  const clock = mock.clock(on, { now: NOW })
  const toasts: string[] = []
  const stored: Record<string, unknown> = {}
  const gets: Record<string, number> = {}
  on('store.get', (_$: unknown, e: { key: string }) => { gets[e.key] = (gets[e.key] ?? 0) + 1; return { value: stored[e.key] } })
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => { stored[e.key] = e.value; return { value: undefined } })
  // 插件调用的引擎接口:测试以 { value } 应答;session.start 是事件,直接返回结果
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: (stored.__limits as unknown[] | undefined) ?? LIMITS } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  // 没设的环境变量是 undefined(和引擎一样),不是空串
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: env[e.name] }))
  on('config.list', () => ({ value: [{ key: 'language', label: 'Language', kind: 'text', value: (stored.__setting as string | undefined) ?? setting, provider: { kind: 'engine' }, isLocked: false }] }))
  on('config.set', (_$: unknown, e: { value: string }) => ({ value: e.value }))
  // /usage:__usageGate 是个 Promise 时等它再答(看「刷新中」),__usageFail 时失败
  on('process.run', async (_$: unknown, e: { argv: string[] }) => {
    if (e.argv[0] === 'defaults') return { value: { exitCode: 0, stdout: apple, stderr: '' } }
    if (e.argv.join(' ').includes('/usage')) {
      await (stored.__usageGate as Promise<void> | undefined)
      return { value: stored.__usageFail ? { exitCode: 1, stdout: '', stderr: 'boom' } : { exitCode: 0, stdout: (stored.__usageOut as string | undefined) ?? USAGE_OUT, stderr: '' } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
  on('fs.exists', () => ({ value: false }))
  const registered: string[] = []
  on('command.register', (_$: unknown, e: { name: string }) => { registered.push(e.name); return { value: { command: e.name } } })
  on('ui.toast', (_$: unknown, e: unknown) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  // 记下开着的面板:ui.open 加、ui.close 减,ui.panes 照实回答
  const openPanes = new Set<string>()
  on('ui.open', (_$: unknown, e: { id: string }) => { openPanes.add(e.id); return { value: { isPlaced: true } } })
  on('ui.close', (_$: unknown, e: { id: string }) => { openPanes.delete(e.id); return { value: undefined } })
  on('ui.panes', () => ({ value: [...openPanes].map(id => ({ id, title: 'WeekToken', isShown: true, isFocused: false, isPlaced: true })) }))
  stored.__openPanes = openPanes
  // 原生绘制的替身:插件交回 next(e) 时由它来画
  on('ui.render', { component: 'AbovePrompt' }, () => (below ?? { type: 'Box', props: { key: 'native-band' }, children: [] }) as any)
  stored.__toasts = toasts
  stored.__gets = gets
  stored.__clock = clock
  stored.__registered = registered
  return stored
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: {} }

for (const surface of ['desktop', 'terminal'] as const) {
  test(`输入框上方的横条在 ${surface} 上画得出来`, async ($, on) => {
    const stored = world(on)
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true } as any)
    const ui = await $.ui.mount({ plugin: 'weektoken', surface, component: 'AbovePrompt', props: BAND as any })
    // 默认显示最紧的配额:两个都在第 2 档(不会提前耗尽),按燃烧倍率 7 天 0.90× > 5 小时 0.67×
    const opened = JSON.stringify(await ui.drawn())
    expect(opened).not.toContain('band-open')
    expect(opened).toContain('7 天')
    expect(opened).toContain('已用 64%')
    expect(opened).toContain('已过 71%')
    // 不写配速状态、不放图钉;进度条只给高度,宽度随横条
    expect(opened).not.toContain('"· 富余"')
    expect(opened).not.toContain('📌')
    expect(opened).toContain('"wrap":"truncate-end"')
    if (surface === 'desktop') expect(opened).toContain('width=\\"100%\\"')
    // 进度条是普通图片,不是可交互的框:框在面板重画时会被宿主重新装载而闪
    if (surface === 'desktop') expect(opened).not.toContain('"isInteractive":true')
    expect(opened).not.toContain('用量落后')
    // 名字两侧的前后箭头:直接换成另一个配额,并记住
    expect(opened).toContain('"key":"band-next"')
    await ui.press({ key: 'band-next' } as any)
    const switched = JSON.stringify(await ui.drawn())
    expect(switched).toContain('5 小时')
    expect(switched).toContain('已用 40%')
    expect(stored.bandKey).toBe('five_hour')
    // 隐藏先问一句,告诉人从 /weektoken 回来;取消就原样
    await ui.press({ key: 'band-hide' } as any)
    const ask = JSON.stringify(await ui.drawn())
    expect(ask).toContain('/weektoken')
    expect(stored.band).not.toBe('hidden')
    await ui.press({ key: 'band-hide-no' } as any)
    expect(JSON.stringify(await ui.drawn())).toContain('"key":"band-next"')
    // 确认才隐藏:交回原生绘制,不占行
    await ui.press({ key: 'band-hide' } as any)
    await ui.press({ key: 'band-hide-yes' } as any)
    expect(JSON.stringify(await ui.drawn())).toContain('native-band')
    expect(stored.band).toBe('hidden')
  })

  test(`配速面板与用量轨迹在 ${surface} 上画得出来`, async ($, on) => {
    const stored = world(on)
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true } as any)
    const ui = await $.ui.mount({ plugin: 'weektoken', surface, component: 'Pane', requestId: 'weektoken', props: { bodyColumns: 60 } as any } as any)
    const pace = JSON.stringify(await ui.drawn())
    expect(pace).toContain('配速')
    expect(pace).toContain('用量落后 12 小时 28 分')
    expect(pace).toContain('隐藏横条')
    // 不再有阈值说明;标题后不画配额页码点
    expect(pace).not.toContain('超速 >')
    expect(pace).not.toContain('━━')
    // 面板里一个按钮切显示/隐藏,各按一下就切换
    await ui.press({ key: 'band-toggle' } as any)
    expect(stored.band).toBe('hidden')
    expect(JSON.stringify(await ui.drawn())).toContain('显示横条')
    await ui.press({ key: 'band-toggle' } as any)
    expect(stored.band).toBe('open')
    // 两个配额(5 小时、7 天):配速页圆环两侧有切换按钮
    expect(pace).toContain('"key":"next"')
    await ui.press({ key: 'tab-burnup' } as any)
    const burn = JSON.stringify(await ui.drawn())
    expect(burn).toContain('用量轨迹')
    // 用量轨迹页用下拉选配额(终端和桌面都有 Select)
    expect(burn).toContain('"key":"quota"')
    await ui.select({ key: 'quota', value: 'five_hour' } as any)
    const switched = JSON.stringify(await ui.drawn())
    expect(switched).toContain('5 小时会话额度')
    // 选项里仍有 7 天,但当前值换成了 5 小时
    expect(switched).toContain('"value":"five_hour"')
  })
}

test('Claude Code 没设语言、系统是英文:界面是英文', async ($, on) => {
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

test('Claude Code 没设语言、系统是中文:跟系统走中文', async ($, on) => {
  world(on, 'Default (English)', APPLE_ZH)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  expect(JSON.stringify(await ui.drawn())).toContain('已用 64%')
})

test('Claude Code 设成别的语言、系统是中文:设置优先,其他语言显示英文', async ($, on) => {
  world(on, 'japanese', APPLE_ZH)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: { bodyColumns: 60 } as any } as any)
  const pane = JSON.stringify(await ui.drawn())
  expect(pane).toContain('Pace')
  expect(pane).toContain('Refresh')
  // 和「7-day · Fable」一样首字母大写
  expect(pane).toContain('7-day · All models')
})

test('环境变量 WEEKTOKEN_LANG=zh 压过 Claude Code 的英文设置', async ($, on) => {
  world(on, 'English', APPLE_EN, { WEEKTOKEN_LANG: 'zh' })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  expect(JSON.stringify(await ui.drawn())).toContain('已用 64%')
})

test('点刷新会跑 /usage,补上 Fable 这类分模型配额', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: { bodyColumns: 60 } as any } as any)
  expect(JSON.stringify(await ui.drawn())).not.toContain('Fable')
  await ui.press({ key: 'refresh' } as any)
  await ui.press({ key: 'tab-burnup' } as any)
  const burn = JSON.stringify(await ui.drawn())
  // 下拉选项是短名:Fable / 全部模型 / 5 小时
  expect(burn).toContain('"label":"Fable"')
  expect(burn).toContain('"label":"全部模型"')
  expect(burn).toContain('"label":"5 小时"')
  expect(burn).toContain('↻ 刷新')
})

test('旧版钉住的配额沿用为横条显示的配额,旧的「收起」当作显示', async ($, on) => {
  const stored = world(on)
  stored.view = { key: null, pinned: 'five_hour' }
  stored.band = 'mini'
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  const band = JSON.stringify(await ui.drawn())
  expect(band).toContain('5 小时')
  expect(band).toContain('已用 40%')
})

test('装好后第一次会话说一声入口在哪,之后不再说', async ($, on) => {
  const stored = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const toasts = stored.__toasts as string[]
  expect(toasts.join('\n')).toContain('/weektoken')
  expect(stored.welcomed).toBe(true)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  expect(toasts.filter(t => t.includes('/weektoken')).length).toBe(1)
})

test('面板底部有作者署名', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: { bodyColumns: 60 } as any } as any)
  const pane = JSON.stringify(await ui.drawn())
  expect(pane).toContain('@mj0011sec')
  expect(pane).not.toContain('"type":"Link"')
})

test('新采样没改变横条显示的数字时,横条画的内容不变;数字变了才变', async ($, on) => {
  world(on)
  on('session.measure', (_$: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  // 按钮的句柄每次绘制都会换,比较前去掉
  const drawn = async () => JSON.stringify(await ui.drawn()).replace(/"handle":\d+/g, '')
  const before = await drawn()
  // 7 天 64.2%:取整后仍是 64%,横条不该变
  await $.session.measure({ context: { window: 200000 }, rateLimits: [LIMITS[0], { ...LIMITS[1], percentUsed: 64.2 }], changed: ['rateLimits'] } as any)
  expect(await drawn()).toBe(before)
  // 66%:变了
  await $.session.measure({ context: { window: 200000 }, rateLimits: [LIMITS[0], { ...LIMITS[1], percentUsed: 66 }], changed: ['rateLimits'] } as any)
  expect(await drawn()).toContain('已用 66%')
})

test('「上次使用」看本机的回复:一直在回复就不提示;Fable 只看 Fable 模型的回复', async ($, on) => {
  const stored = world(on)
  const clock = stored.__clock as { advance: (ms: number) => Promise<void> }
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: { bodyColumns: 60 } as any } as any)
  await ui.press({ key: 'refresh' } as any) // 补上 Fable
  const turn = (model: string) => $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer', usage: { model, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as any)
  // 40 分钟里一直在用 Opus,7 天的百分比一点没涨:不该说「上次使用」
  for (let i = 0; i < 4; i++) { await clock.advance(10 * 60_000); await turn('claude-opus-5-5') }
  expect(JSON.stringify(await ui.drawn())).not.toContain('上次使用')
  // 停 40 分钟:说 40 分前
  await clock.advance(40 * 60_000)
  await ui.press({ key: 'tab-pace' } as any)
  expect(JSON.stringify(await ui.drawn())).toContain('上次使用：40 分前')
  // 切到 Fable:这段时间只用了 Opus,从刷新拿到 Fable 起就没用过
  await ui.press({ key: 'tab-burnup' } as any)
  await ui.select({ key: 'quota', value: 'weekly_fable' } as any)
  expect(JSON.stringify(await ui.drawn())).toContain('至少 1 小时 20 分没用过 Fable')
})

test('几个会话同时开着:写采样前先并上别的会话刚写的,不把它冲掉', async ($, on) => {
  const stored = world(on)
  on('session.measure', (_$: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  // 另一个会话这时写进一条更晚的采样
  const other = { t: NOW + 30 * 60_000, w: { five_hour: { u: 41, r: NOW + 2 * 3600_000 } } }
  stored.samples = [...(stored.samples as unknown[]), other]
  // 本会话又记一条
  await $.session.measure({ context: { window: 200000 }, rateLimits: [{ ...LIMITS[0], percentUsed: 45 }, LIMITS[1]], changed: ['rateLimits'] } as any)
  const ts = (stored.samples as { t: number }[]).map(x => x.t)
  expect(ts).toContain(other.t)
  expect((stored.samples as { w: Record<string, { u: number }> }[]).some(x => x.w.five_hour?.u === 45)).toBe(true)
})

test('横条画完自己,把别的 mod 的横条接在下面', async ($, on) => {
  // 排在后面的(别的 mod / 引擎)画了一行
  world(on, '中文', APPLE_EN, {}, { type: 'Box', props: { key: 'other-mod' }, children: [{ type: 'Text', props: {}, children: ['other band'] }] })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  const band = JSON.stringify(await ui.drawn())
  expect(band).toContain('已用 64%')
  expect(band).toContain('other band')
})

test('/weektoken hide 和 show 直接隐藏、显示横条;不认识的参数给提示', async ($, on) => {
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

test('CLAUDE_MODS_DISABLE=weektoken:什么都不画,也不注册命令', async ($, on) => {
  const stored = world(on, '中文', APPLE_EN, { CLAUDE_MODS_DISABLE: 'other, weektoken' })
  const registered = stored.__registered as string[]
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  expect(JSON.stringify(await ui.drawn())).toContain('native-band')
  expect(registered).not.toContain('weektoken')
})

const PANE_PROPS = { bodyColumns: 60, isFocused: false, scroll: { offset: 0, bodyRows: 30 } }

test('刷新:进行中按钮写「刷新中…」,完成后复原;底部那行不插「已更新」;/usage 失败才提示', async ($, on) => {
  const stored = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  let open!: () => void
  stored.__usageGate = new Promise<void>(r => { open = r })
  const pressing = ui.press({ key: 'refresh' } as any)
  // 还在跑 /usage:按钮显示进行中,再点也不会再起一次
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
  // /usage 跑不出来:弹一句
  stored.__usageGate = undefined
  stored.__usageFail = true
  await ui.press({ key: 'refresh' } as any)
  expect((stored.__toasts as string[]).join('\n')).toContain('/usage')
})

test('新会话还没回复过(没有实时限额):点刷新用 /usage 补上 5 小时和 7 天', async ($, on) => {
  const stored = world(on)
  stored.__limits = []
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  expect(JSON.stringify(await ui.drawn())).toContain('还没有数据')
  await ui.press({ key: 'refresh' } as any)
  const keys = new Set((stored.samples as { w: Record<string, unknown> }[]).flatMap(s => Object.keys(s.w)))
  expect([...keys].sort()).toEqual(['five_hour', 'seven_day', 'weekly_fable'])
})

test('窗口已过重置时刻:横条写「已重置」,不再显示上一个窗口的用量', async ($, on) => {
  const stored = world(on)
  stored.__limits = [{ kind: 'seven_day', percentUsed: 64, resetsAt: iso(NOW - 60_000) }]
  stored.bandKey = 'seven_day'
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  const band = JSON.stringify(await ui.drawn())
  expect(band).toContain('已重置')
  expect(band).not.toContain('已用 64%')
})

test('终端变窄(面板停靠在旁边)时横条不折行:先去掉「已过」,再去掉进度条', async ($, on) => {
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

test('改了 Claude Code 的语言:横条换语言,命令说明也重新注册', async ($, on) => {
  const stored = world(on, '中文', APPLE_EN)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const ui = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  expect(JSON.stringify(await ui.drawn())).toContain('已用 64%')
  stored.__setting = 'English'
  await $.config.set({ key: 'language', value: 'English' } as any)
  // 设置原样交给引擎,稍后再探测语言
  await (stored.__clock as { advance: (ms: number) => Promise<void> }).advance(400)
  expect(JSON.stringify(await ui.drawn())).toContain('64% used')
  expect((stored.__registered as string[]).filter(n => n === 'weektoken').length).toBe(2)
})

test('每分钟并进别的会话的采样:存储的版本号没变就不读整份采样', async ($, on) => {
  const stored = world(on)
  const clock = stored.__clock as { advance: (ms: number) => Promise<void> }
  const gets = stored.__gets as Record<string, number>
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  await clock.advance(60_000)
  const before = gets.samples ?? 0
  await clock.advance(3 * 60_000)
  expect(gets.samples ?? 0).toBe(before)
  // 别的会话写了:版本号变了,下一分钟读进来
  const other = { t: NOW + 30 * 60_000, w: { five_hour: { u: 41, r: NOW + 2 * 3600_000 } } }
  stored.samples = [...(stored.samples as unknown[]), other]
  stored.samplesRev = 'other-session'
  await clock.advance(60_000)
  expect(gets.samples).toBe(before + 1)
})

test('横条和面板看同一个配额:任何一处切换,两边一起换', async ($, on) => {
  const stored = world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const band = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  const pane = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  // 都没选过:两边都显示最紧的 7 天
  expect(JSON.stringify(await band.drawn())).toContain('已用 64%')
  expect(JSON.stringify(await pane.drawn())).toContain('7 天 · 全部模型')
  // 横条上换到 5 小时:面板跟着换
  await band.press({ key: 'band-next' } as any)
  expect(JSON.stringify(await pane.drawn())).toContain('5 小时会话额度')
  // 面板里换回 7 天:横条跟着换,两边都记住
  await pane.press({ key: 'prev' } as any)
  expect(JSON.stringify(await band.drawn())).toContain('已用 64%')
  expect(stored.bandKey).toBe('seven_day')
  expect((stored.view as { key: string }).key).toBe('seven_day')
  // 用量轨迹页的下拉也一样
  await pane.press({ key: 'tab-burnup' } as any)
  await pane.select({ key: 'quota', value: 'five_hour' } as any)
  expect(JSON.stringify(await band.drawn())).toContain('已用 40%')
})

test('横条上名字那一格宽度固定:切换配额时两侧箭头不挪', async ($, on) => {
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

test('横条上的「详情」再按一下收起面板,按钮写「收起」', async ($, on) => {
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

test('桌面端横条:同一宽度下所有配额对「已过」的取舍一致,放不下就整段不显示', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const at = async (cols: number) => {
    const band = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND, bodyColumns: cols } as any })
    const seven = JSON.stringify(await band.drawn())
    await band.press({ key: 'band-next' } as any)
    const five = JSON.stringify(await band.drawn())
    await band.press({ key: 'band-prev' } as any)
    // 只看横条上那段字(进度条图片的替代文字里也有「已过」)
    return [seven.includes('"· 已过 '), five.includes('"· 已过 ')]
  }
  expect(await at(100)).toEqual([true, true])
  expect(await at(54)).toEqual([false, false])
})

test('用量轨迹「近一月」平时是普通图片,点「逐条查看」才换成可悬停的框;换范围就退出', async ($, on) => {
  const stored = world(on)
  // 上一个 7 天窗口(已结束)两条采样,峰值 30%;当前窗口一条
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
  // 「本窗口」没有逐条查看
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
  // 再按一下退出
  await pane.press({ key: 'explore' } as any)
  expect(JSON.stringify(await pane.drawn())).not.toContain('"isInteractive":true')
  // 换范围自动退出
  await pane.press({ key: 'explore' } as any)
  await pane.press({ key: 'range-all' } as any)
  expect(JSON.stringify(await pane.drawn())).not.toContain('"isInteractive":true')
})

test('配速页:三个读数画进圆环图里;没超速画同色余量斜线,超速段同色深一档加斜线;不再有光晕', async ($, on) => {
  const stored = world(on)
  on('session.measure', (_$: unknown, e: { changed: unknown }) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  const pane = await $.ui.mount({ plugin: 'weektoken', surface: 'desktop', component: 'Pane', requestId: 'weektoken', props: PANE_PROPS as any } as any)
  const under = JSON.stringify(await pane.drawn())
  // 读数在图里(小号标签在上、数字在下),原生文字那一行没了
  expect(under).toContain('>已用</text>')
  expect(under).toContain('>距重置</text>')
  expect(under).not.toContain('"已过"')
  expect(under).not.toContain('feGaussianBlur')
  expect(under).not.toContain('<animate')
  expect(under).toMatch(/stroke=\\"url\(#wtr[0-9a-z]+m\)\\"/)
  expect(under).not.toMatch(/url\(#wtr[0-9a-z]+x\)/)
  // 7 天用了 90%、时间才过 71%:超出的一段画成深色斜线
  stored.__limits = [{ kind: 'seven_day', percentUsed: 90, resetsAt: iso(NOW + 2 * 86400_000) }]
  await $.session.measure({ context: { window: 200000 }, rateLimits: stored.__limits, changed: ['rateLimits'] } as any)
  const over = JSON.stringify(await pane.drawn())
  expect(over).toMatch(/url\(#wtr[0-9a-z]+x\)/)
  expect(over).toContain('>90%</text>')
})
