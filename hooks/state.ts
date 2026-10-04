// What the session knows, kept apart from what it does: the band's view, the
// runtime facts of this session, the shapes kept in the store, and the pure
// helpers around them. Functions that take $ cannot live here: the engine follows
// $ only into functions of the hooks module itself.
import type { EngineInterface, Timer } from 'claude-code'

import type { CodexAuth, CodexTask, LimitWindow, View } from '../types'

import { CONTEXT_HIDE, CONTEXT_SHOW, MIN } from './model'
import type { CodexSetting } from './model'

/**
 * After a failed ask: 2 minutes (just woken, the network may be a moment behind),
 * then 10, then 30 for every failure after that.
 */
export const RETRY_SOON_MS = 2 * MIN
export const RETRY_FIRST_MS = 10 * MIN
export const RETRY_LATER_MS = 30 * MIN

export const EMPTY: View = {
  claude: null,
  claudeError: null,
  codex: null,
  codexError: null,
  hasClaudeTried: false,
  hasCodexTried: false,
  hasCodex: false,
  codexMode: 'show',
  codexTasks: [],
  contextPercent: null,
  contextTokens: null,
  isContextShown: false,
  costUsd: null,
  lastTurnAt: null,
  now: 0,
  utcOffsetMin: 0,
}


/**
 * A stored time ahead of now by more than `max` was written before the clock went
 * back: it is not trusted (not as fresh, not as a reason to wait).
 */
export const isAhead = (t: number | undefined, now: number, max = 5 * MIN) => t !== undefined && t > now + max

/**
 * When a reading was last known current, which decides the newest among sessions.
 * Its `takenAt` can be older: the age of a window carried over from before.
 */
export const savedAt = (r: { takenAt: number; savedAt?: number }) => r.savedAt ?? r.takenAt

/** A window of this reading has reset since it was taken: its numbers are gone. */
export const isPastReset = (r: { fiveHour?: LimitWindow; weekly?: LimitWindow; takenAt: number } | null | undefined, now: number) =>
  !!r && [r.fiveHour, r.weekly].some(w => w?.resetsAt !== undefined && w.resetsAt <= now && w.resetsAt > r.takenAt)

export const sameTasks = (a: readonly CodexTask[], b: readonly CodexTask[]) =>
  a.length === b.length && a.every((t, i) => t.startedAt === b[i]?.startedAt)

export const retryAfter = (failures: number) =>
  (failures <= 1 ? RETRY_SOON_MS : failures === 2 ? RETRY_FIRST_MS : RETRY_LATER_MS) + Math.round(Math.random() * 3 * MIN)

/** The context and cost figures of a measurement or a `$.session.usage()` answer. */
export function withContext(v: View, context: { percent?: number; tokens?: number }, costUsd: number | undefined): View {
  const pct = context.percent ?? null
  return {
    ...v,
    contextPercent: pct,
    contextTokens: context.tokens ?? null,
    isContextShown: pct === null ? false : v.isContextShown ? pct >= CONTEXT_HIDE : pct >= CONTEXT_SHOW,
    costUsd: costUsd ?? v.costUsd,
  }
}

// ---------------------------------------------------------------------------
// Runtime (module variables start over on every reload; $.state and $.store stay)

/** The engine interface every hook receives as `$`. */
export type Engine = EngineInterface

export type ApiState = { error: string | null; nextAt?: number; failures?: number; stoppedAt?: number }

export type CodexState = {
  error: string | null
  nextAt?: number
  failures?: number
  /** How Codex was signed in at the last answer. */
  auth?: CodexAuth
  /** The last time Codex was asked anything, answered or not. */
  attemptAt?: number
  /** Shown again after being hidden: stays shown until then. */
  visibleUntil?: number
}

export type ScanEntry = { size: number; mtimeMs: number; lastKind: string; startedAt: number; isSubagent: boolean; isHeadKnown: boolean }

export const rt = {
  isStarted: false,
  /** The band has been drawn on the desktop app: this session is one to work for. */
  isOnDesktop: false,
  /** The setup that needs the desktop app (host probes, Codex) has run. */
  isSetUp: false,
  accountAt: 0,
  setting: 'auto' as CodexSetting,
  /** The last write to a Codex session log on this machine. */
  lastLocalUseAt: 0,
  /** False until the look back over the last 8 days has answered: until then, Codex counts as used. */
  isLastUseKnown: false,
  owner: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  /** The Claude account, or '' when it cannot be told: readings then stay in this session. */
  account: '',
  memory: new Map<string, unknown>(),
  home: '',
  codexHome: '',
  nodePath: '',
  codexPath: '',
  pathEnv: '',
  hasCodex: false,
  codexProbedAt: 0,
  utcOffsetMin: 0,
  offsetAt: 0,
  hasClaudeTried: false,
  hasCodexTried: false,
  isClaudeFetching: false,
  isCodexFetching: false,
  isScanning: false,
  scanCache: new Map<string, ScanEntry>(),
  lastCodexSeenMtime: 0,
  lastApiStatus: 'not asked yet',
  lastCodexStatus: 'not asked yet',
  tickTimer: null as Timer | null,
  /** Runs a tick now, with the session's own $ (a render's $ may not write state). */
  kick: null as (() => void) | null,
}

export const claudeKey = () => `claude:${rt.account}`
export const apiKey = () => `claude-api:${rt.account}`
// Codex keys are per CODEX_HOME: two homes are two Codex sign-ins.
export const codexKey = () => `codex:${rt.codexHome}`
export const codexStateKey = () => `codex-state:${rt.codexHome}`
