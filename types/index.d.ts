/** One plan-limit window. Times are epoch milliseconds. */
export type LimitWindow = {
  percentUsed: number
  resetsAt?: number
  windowMs: number
}

export type ClaudeReading = {
  fiveHour?: LimitWindow
  weekly?: LimitWindow
  /** A plan limit is spent and paid usage credits are being drawn. */
  isUsingCredits: boolean
  /** When its oldest window was read: what "As of" and the refresh go by. */
  takenAt: number
  /** When it was last known current, if later than `takenAt` (a window carried over). */
  savedAt?: number
}

export type CodexReading = {
  fiveHour?: LimitWindow
  /** The long window: weekly, or for a plan that has one instead, monthly. */
  weekly?: LimitWindow
  /** 'Monthly' when the long window is a 30-day one. */
  weeklyLabel?: string
  /** A limit is spent and a free full reset is available. */
  isPassReady: boolean
  takenAt: number
}

/**
 * Whether the Codex group shows: `show`; `signedOut`, a note in place of the
 * numbers (signed out, but used here this week); `hidden` (unused, or turned off).
 */
export type CodexMode = 'show' | 'signedOut' | 'hidden'

/**
 * How Codex is signed in, from its own answer: with ChatGPT; `apiKey`, an API key
 * or another provider (Bedrock, a custom one), which have no ChatGPT plan limits;
 * or not at all.
 */
export type CodexAuth = 'chatgpt' | 'apiKey' | 'none'

/** A Codex task that has started and not finished. */
export type CodexTask = {
  startedAt: number
}

export type View = {
  claude: ClaudeReading | null
  /** Why the plan usage request keeps failing; null while it works. */
  claudeError: string | null
  codex: CodexReading | null
  codexError: string | null
  /** True once a Claude reading has been asked for: tells loading from unavailable. */
  hasClaudeTried: boolean
  /** True once Codex has been asked: tells loading from unavailable. */
  hasCodexTried: boolean
  /** False when this machine has no Codex: the Codex group is left out. */
  hasCodex: boolean
  codexMode: CodexMode
  codexTasks: CodexTask[]
  contextPercent: number | null
  contextTokens: number | null
  isContextShown: boolean
  costUsd: number | null
  lastTurnAt: number | null
  now: number
  /** Local UTC offset in minutes, from the host's `date +%z`. */
  utcOffsetMin: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-glance': {
      view: View
    }
  }
}
