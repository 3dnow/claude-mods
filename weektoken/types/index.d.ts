/** 一次观测里的一个配额:用量 0–100,重置时刻(毫秒),服务端显示名 */
export type Obs = { u: number; r?: number; n?: string }
/** 一次采样:时间(毫秒)+ 各配额的观测 */
export type Sample = { t: number; w: Record<string, Obs> }

/** 面板的视图状态:看哪个配额、哪个标签页、轨迹的范围与翻页 */
export type PaneView = {
  key: string | null
  tab: 'pace' | 'burnup'
  range: 'current' | 'month' | 'all'
  offset: number
  /** 「近一月 / 全部」的逐条查看:图换成可悬停的框,指到哪条线就标出它的日期和峰值 */
  explore?: boolean
}

/** 输入框上方横条:显示 / 隐藏(不占行,从面板恢复) */
export type BandMode = 'open' | 'hidden'

/**
 * 横条画出来的全部内容,按显示精度取整(整数百分比)。只有它变了才写,横条才重画:
 * 新采样或时间流逝若没让显示变化,就不重画。
 */
export type BandShow = {
  key: string
  /** 服务端给的显示名(分模型配额) */
  n?: string
  /** 可切换的全部配额,箭头按这个顺序走 */
  keys: string[]
  used: number | null
  elapsed: number | null
  /** 最后一次观测的窗口已过重置时刻:那时的用量作废,横条写「已重置」 */
  ended?: boolean
  status: 'unknown' | 'early' | 'comfortable' | 'onPace' | 'overPace' | 'exhausted'
}

/** 本机各会话里最近一次回复的时刻:any = 任何模型,byModel = 按模型家族(fable / opus …) */
export type Activity = { any?: number; byModel: Record<string, number> }

/** 界面语言:中文 / 英文 */
export type Lang = 'zh' | 'en'

/** 手动刷新进行中(刷新按钮据此显示「刷新中…」),at 是开始时刻。旧版存过带 text 的回执,没有 busy 就当空闲 */
export type Note = { busy?: boolean; at: number; text?: string } | null

declare module 'claude-code' {
  interface PluginState {
    weektoken: {
      samples: Sample[]
      view: PaneView
      note: Note
      band: BandMode
      /** 横条显示的配额:用横条上的前后箭头选过就记住;null = 自动显示最紧的 */
      bandKey: string | null
      bandShow: BandShow | null
      /** 横条正在问「确定隐藏吗」 */
      confirmHide: boolean
      /** 面板开着没有(横条按钮写「收起」还是「详情」) */
      paneOpen: boolean
      lang: Lang
      activity: Activity
      /** 载入的版本号(取自自己的 plugin.json),画在面板署名后面 */
      version: string
    }
  }
}
