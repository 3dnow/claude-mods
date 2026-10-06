/** One quota in an observation: usage 0–100, reset time (ms), server display name */
export type Obs = { u: number; r?: number; n?: string }
/** One sample: time (ms) + per-quota observations */
export type Sample = { t: number; w: Record<string, Obs> }

/** Pane view state: selected quota, tab, burn-up range and page offset */
export type PaneView = {
  key: string | null
  tab: 'pace' | 'burnup'
  range: 'current' | 'month' | 'all'
  offset: number
  /** Per-line inspection for "Last month / All": the chart becomes hoverable boxes; the hovered line shows its dates and peak */
  explore?: boolean
}

/** Band above the input box: shown / hidden (takes no row; restore from the pane) */
export type BandMode = 'open' | 'hidden'

/**
 * Everything the band draws, rounded to display precision (whole percent). Written only when it changes, so only then does the band redraw:
 * a new sample or passing time that leaves the display unchanged causes no redraw.
 */
export type BandShow = {
  key: string
  /** Display name from the server (per-model quotas) */
  n?: string
  /** All switchable quotas; the arrows step through them in this order */
  keys: string[]
  used: number | null
  elapsed: number | null
  /** The last observation's window is past its reset time: that usage is void and the band shows "reset" */
  ended?: boolean
  status: 'unknown' | 'early' | 'comfortable' | 'onPace' | 'overPace' | 'exhausted'
}

/** Time of the latest reply across local sessions: any = any model, byModel = per model family (fable / opus …) */
export type Activity = { any?: number; byModel: Record<string, number> }

/** UI language: Chinese / English */
export type Lang = 'zh' | 'en'

/** Manual refresh in progress (the refresh button shows "Refreshing…" from this); at is the start time. Older versions stored a receipt with text; no busy means idle */
export type Note = { busy?: boolean; at: number; text?: string } | null

declare module 'claude-code' {
  interface PluginState {
    weektoken: {
      samples: Sample[]
      view: PaneView
      note: Note
      band: BandMode
      /** Quota shown in the band: remembered once picked with the band's prev/next arrows; null = auto-show the tightest */
      bandKey: string | null
      bandShow: BandShow | null
      /** The band is asking "Hide the band?" */
      confirmHide: boolean
      /** Whether the pane is open (band button reads "Close" or "Details") */
      paneOpen: boolean
      lang: Lang
      activity: Activity
      /** Loaded version (from its own plugin.json), drawn after the pane's credit line */
      version: string
    }
  }
}
