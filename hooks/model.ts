// What the band shows, decided from the view alone: no engine calls, so tests
// can feed it any state. register.tsx draws the result.
import type { CodexAuth, CodexMode, CodexReading, LimitWindow, View } from '../types'

export const MIN = 60_000
export const HOUR = 60 * MIN

export const STALE_AFTER_MS = 15 * MIN
// Codex is asked every 30 min while idle, and its usage cannot move then, so a Codex
// reading is only stale once a due refresh has been missed.
export const CODEX_STALE_AFTER_MS = 45 * MIN
export const CANT_READ_AFTER_MS = 30 * MIN
export const CONTEXT_SHOW = 50
export const CONTEXT_HIDE = 45
export const CONTEXT_WARN = 80
export const LIMIT_WARN = 75
export const FIVE_HOUR_TAKEOVER = 90
/** How long the prompt cache lives on a subscription. */
export const CACHE_TTL_MS = HOUR
/** Codex unused here this long (one weekly window) may be hidden. */
export const DORMANT_AFTER_MS = 7 * 24 * HOUR
/** Once Codex shows again, it stays a day before it may be hidden again: no flapping. */
export const WAKE_HOLD_MS = 24 * HOUR
/** Only a reading this recent can say Codex is unused; an older one may predate the use. */
export const DECIDING_READING_MS = 7 * HOUR
/**
 * A window this long past its reset time and still not read again: its numbers say
 * nothing any more. Drawn as no reading, as Claude's own status line drops it.
 */
export const RESET_GRACE_MS = 5 * MIN

const isExpired = (w: LimitWindow, now: number) => w.resetsAt !== undefined && now - w.resetsAt > RESET_GRACE_MS

export const floor = (n: number) => Math.max(0, Math.floor(n))

export const elapsedFraction = (w: LimitWindow, now: number) =>
  w.resetsAt === undefined ? null : Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / w.windowMs))

/** Rounds as the official usage panel does, but never shows 100% before a limit is spent. */
export const pctShown = (n: number) => {
  const r = Math.round(n)
  return r >= 100 && floor(n) < 100 ? 99 : Math.max(0, r)
}

export type Level = 'ok' | 'warn' | 'full'

/** Spent only once it truly is (99.6% is not); amber from the percentage shown, so 74.5% reads 75% and is amber. */
export const level = (pct: number): Level => (floor(pct) >= 100 ? 'full' : pctShown(pct) >= LIMIT_WARN ? 'warn' : 'ok')

export function countdown(ms: number) {
  if (ms <= 0) return 'now'
  const m = Math.floor(ms / MIN)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const pad = (n: number) => String(n).padStart(2, '0')

/** Local wall-clock time without Intl: shift by the host offset, read as UTC. */
export function clock(ts: number, now: number, offsetMin: number) {
  const at = new Date(ts + offsetMin * MIN)
  const today = new Date(now + offsetMin * MIN)
  const hm = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`
  const dayDiff = Math.round(
    (Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) -
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) /
      (24 * HOUR),
  )
  if (dayDiff === 0) return hm
  if (dayDiff === 1) return `tomorrow ${hm}`
  return `${DAYS[at.getUTCDay()]} ${hm}`
}

/**
 * How the line shrinks to fit: each step drops a little more. The percentages and
 * the warning statuses never go; on the narrowest window (about 44 columns) the
 * "Weekly" labels, the cost and the dim statuses go last, in that order.
 */
const FULL = { labels: true, cost: true, dimSlots: true } as const
export const TIERS = [
  { barPx: 72, resets: 'all', ...FULL },
  { barPx: 56, resets: 'all', ...FULL },
  { barPx: 40, resets: 'all', ...FULL },
  { barPx: 28, resets: 'all', ...FULL },
  { barPx: 28, resets: 'claude', ...FULL },
  { barPx: 28, resets: 'none', ...FULL },
  { barPx: 0, resets: 'none', ...FULL },
  { barPx: 0, resets: 'none', labels: false, cost: true, dimSlots: true },
  { barPx: 0, resets: 'none', labels: false, cost: false, dimSlots: true },
  { barPx: 0, resets: 'none', labels: false, cost: false, dimSlots: false },
] as const

export type Tier = (typeof TIERS)[number]

const PX_PER_COL = 7.7

export type Slot = { text: string; tone: 'warn' | 'dim' }

export type WindowModel = {
  label: string
  /** '77%', 'Limit reached', 'Loading' before the first ask, or '—' with no reading. */
  pctText: string
  level: Level | 'none'
  /** The reading is old: the percentage is drawn dim so it does not pass for live. */
  isStale: boolean
  /** A word in place of the numbers ("Signed out"): no bar, drawn dim. */
  isNote: boolean
  /** The countdown, or '' when this tier leaves it out. */
  reset: string
  percentUsed: number | null
  elapsed: number | null
}

export type BandModel = {
  tier: Tier
  /** Claude and Codex on lines of their own: only when one line cannot hold the essentials. */
  isTwoLine?: boolean
  claude: {
    /** The session window, drawn before `window` when Claude has the band to itself. */
    session: WindowModel | null
    /** Null for a plan with no limits (Enterprise, Free): the cost and context alone. */
    window: WindowModel | null
    cost: string
    /** The context, at all times when Claude has the band to itself. */
    context: Slot | null
    slot: Slot | null
  }
  codex: { window: WindowModel; slot: Slot | null } | null
}

export type CodexSetting = 'auto' | 'always' | 'never'

/**
 * Whether the Codex group shows. `auto` hides it for someone who has Codex but no
 * longer uses it: signed out with no use here for a week, signed in with an API key
 * (no plan limits), or a week with no use here and a fresh reading at 0%.
 */
export function codexMode(i: {
  setting: CodexSetting
  auth: CodexAuth | undefined
  reading: CodexReading | null
  /** The last write to a Codex session log on this machine; 0 for none in a week. */
  lastLocalUseAt: number
  /** Shown again recently: stays shown until then. */
  visibleUntil: number
  now: number
}): CodexMode {
  if (i.setting === 'never') return 'hidden'
  const isUsedHere = i.now - i.lastLocalUseAt < DORMANT_AFTER_MS
  // Signed out after recent use is most likely an expired login: say so.
  if (i.auth === 'none') return isUsedHere || i.setting === 'always' ? 'signedOut' : 'hidden'
  if (i.setting === 'always') return 'show'
  if (i.auth === 'apiKey') return 'hidden'
  // A fresh reading with no windows at all: a plan without limits (credits only).
  const fresh = !!i.reading && i.now - i.reading.takenAt < DECIDING_READING_MS
  if (fresh && !i.reading?.weekly && !i.reading?.fiveHour) return 'hidden'
  if (isUsedHere || i.now < i.visibleUntil) return 'show'
  // Use elsewhere (the web, another computer) leaves no log here, so only a fresh
  // reading at 0% says unused; a missing weekly window is unknown, not 0.
  const r = i.reading
  const isIdle =
    !!r && i.now - r.takenAt < DECIDING_READING_MS && !!r.weekly && r.weekly.percentUsed === 0 && (r.fiveHour?.percentUsed ?? 0) === 0
  return isIdle ? 'hidden' : 'show'
}

/** The context as a status of its own: amber with "!" from 80%, by the number shown. */
export function contextNote(v: View): Slot | null {
  if (v.contextPercent === null) return null
  const n = Math.round(v.contextPercent)
  return n >= CONTEXT_WARN ? { text: `! Context ${n}%`, tone: 'warn' } : { text: `Context ${n}%`, tone: 'dim' }
}

/**
 * The status after Claude's cost: one item, the most severe. With the context
 * shown on its own (`isContextApart`), it is left out of here.
 */
export function claudeSlot(v: View, isContextApart = false): Slot | null {
  const c = v.claude
  const now = v.now
  const age = c ? now - c.takenAt : Infinity
  // A plan with no limits has no numbers that could be old.
  const hasNumbers = !c || !!c.fiveHour || !!c.weekly
  if (c?.isUsingCredits) return { text: '! Using credits', tone: 'warn' }
  if (hasNumbers && v.claudeError && age > CANT_READ_AFTER_MS) return { text: '! Not updating', tone: 'warn' }
  if (!isContextApart && v.isContextShown && (v.contextPercent ?? 0) >= CONTEXT_WARN)
    return { text: `! Context ${Math.round(v.contextPercent ?? 0)}%`, tone: 'warn' }
  if (c && hasNumbers && age > STALE_AFTER_MS) return { text: `As of ${clock(c.takenAt, now, v.utcOffsetMin)}`, tone: 'dim' }
  if (v.lastTurnAt !== null && (v.contextTokens ?? 0) > 0 && now - v.lastTurnAt > CACHE_TTL_MS)
    return { text: 'Cache cold', tone: 'dim' }
  if (!isContextApart && v.isContextShown) return { text: `Context ${Math.round(v.contextPercent ?? 0)}%`, tone: 'dim' }
  return null
}

/** The status after Codex: one item, the most severe; empty by default. */
export function codexSlot(v: View): Slot | null {
  const c = v.codex
  const now = v.now
  const age = c ? now - c.takenAt : Infinity
  if (v.codexError && (!c || age > CANT_READ_AFTER_MS)) return { text: '! Not updating', tone: 'warn' }
  if (c?.isPassReady) return { text: '! Reset pass ready', tone: 'warn' }
  if (c && age > CODEX_STALE_AFTER_MS) return { text: `As of ${clock(c.takenAt, now, v.utcOffsetMin)}`, tone: 'dim' }
  const [first] = v.codexTasks
  if (v.codexTasks.length === 1 && first) {
    const ran = now - first.startedAt
    return { text: ran < MIN ? 'Running' : `Running ${countdown(ran)}`, tone: 'dim' }
  }
  if (v.codexTasks.length > 1) return { text: `${v.codexTasks.length} running`, tone: 'dim' }
  return null
}

function windowModel(
  label: string,
  w: LimitWindow | undefined,
  now: number,
  /** Whether this tier draws the countdown. */
  hasCountdown: boolean,
  isStale: boolean,
  hasTried: boolean,
): WindowModel {
  if (!w || isExpired(w, now))
    return { label, pctText: hasTried || w ? '—' : 'Loading', level: 'none', reset: '', percentUsed: null, elapsed: null, isStale: false, isNote: false }
  const lv = level(w.percentUsed)
  // A spent limit always keeps its countdown: when it comes back is the point.
  const reset =
    !(hasCountdown || lv === 'full') || w.resetsAt === undefined ? '' : w.resetsAt <= now ? 'resetting' : countdown(w.resetsAt - now)
  return {
    label,
    pctText: lv === 'full' ? 'Limit reached' : `${pctShown(w.percentUsed)}%`,
    level: lv,
    reset,
    percentUsed: w.percentUsed,
    elapsed: elapsedFraction(w, now),
    isStale,
    isNote: false,
  }
}

const SIGNED_OUT: WindowModel = { label: '', pctText: 'Signed out', level: 'none', reset: '', percentUsed: null, elapsed: null, isStale: false, isNote: true }

/**
 * Weekly is the limit that matters day to day; the 5-hour window only takes its
 * place once it is nearly spent, or while there is no weekly reading (none, or one
 * long past its reset). Same rule for both. `shortLabel` is each product's own name
 * for its short window: Claude's usage panel calls it the session limit, Codex the
 * 5h limit.
 */
export function shownWindow(
  r: { fiveHour?: LimitWindow; weekly?: LimitWindow; weeklyLabel?: string } | null,
  shortLabel: string,
  now: number,
) {
  const fh = r?.fiveHour && !isExpired(r.fiveHour, now) ? r.fiveHour : undefined
  const wk = r?.weekly && !isExpired(r.weekly, now) ? r.weekly : undefined
  // A spent weekly limit is what stops you, whatever the 5-hour window says. Otherwise
  // by the percentage shown, as the amber is: 89.6% reads 90% and takes over.
  const isWeeklySpent = !!wk && floor(wk.percentUsed) >= 100
  const isFiveHour = !!fh && !isWeeklySpent && (pctShown(fh.percentUsed) >= FIVE_HOUR_TAKEOVER || !wk)
  return isFiveHour ? { label: shortLabel, w: fh, isFiveHour } : { label: r?.weeklyLabel ?? 'Weekly', w: r?.weekly, isFiveHour }
}

/** A rough width of each product's group, in band columns: text length plus the gaps. */
export function estimateCols(m: BandModel) {
  const win = (w: WindowModel) =>
    (w.label ? w.label.length + 1 : 0) +
    w.pctText.length +
    3 +
    (m.tier.barPx && !w.isNote ? Math.ceil(m.tier.barPx / PX_PER_COL) + 1 : 0) +
    (w.reset ? w.reset.length + 1 : 0)
  // Claude's name and windows, then its cost and statuses: on a line each when split.
  const claudeHead =
    'Claude'.length + 1 + (m.claude.session ? win(m.claude.session) + 2 : 0) + (m.claude.window ? win(m.claude.window) : 0)
  const claudeTail =
    (m.claude.cost ? m.claude.cost.length + 3 : 0) +
    (m.claude.context ? m.claude.context.text.length + 5 : 0) +
    (m.claude.slot ? m.claude.slot.text.length + 5 : 0)
  const codex = m.codex ? 'Codex'.length + 1 + win(m.codex.window) + (m.codex.slot ? m.codex.slot.text.length + 3 : 0) : 0
  return { claude: claudeHead + claudeTail, claudeHead, claudeTail, codex }
}

export function bandModel(v: View, bodyColumns: number): BandModel {
  const isCodexShown = v.hasCodex && v.codexMode !== 'hidden'
  const isSignedOut = v.codexMode === 'signedOut'
  // Claude alone has the room for both of its windows and, at all times, the context.
  const isClaudeAlone = !isCodexShown
  // A reading with no windows: a plan without limits (Enterprise, Free).
  const hasNoLimits = !!v.claude && !v.claude.fiveHour && !v.claude.weekly
  const canShowBoth = isClaudeAlone && !!v.claude?.weekly && !!v.claude?.fiveHour
  const codexW = shownWindow(v.codex, '5h', v.now)
  // "~" marks the cost as an estimate at API prices, not a charge.
  const cost = v.costUsd !== null ? `~$${v.costUsd.toFixed(2)}` : ''
  const isContextApart = isClaudeAlone || hasNoLimits
  const cSlot = claudeSlot(v, isContextApart)
  const context = isContextApart ? contextNote(v) : null
  const xSlot = isCodexShown && !isSignedOut ? codexSlot(v) : null
  const isClaudeStale = !!v.claude && v.now - v.claude.takenAt > STALE_AFTER_MS
  const isCodexStale = !!v.codex && v.now - v.codex.takenAt > CODEX_STALE_AFTER_MS

  const slotFor = (slot: Slot | null, t: Tier) => (slot && (t.dimSlots || slot.tone === 'warn') ? slot : null)
  const build = (t: Tier, isBoth: boolean): BandModel => {
    const claudeW = isBoth ? { label: 'Weekly', w: v.claude?.weekly, isFiveHour: false } : shownWindow(v.claude, 'Session', v.now)
    // Two windows side by side always keep their names: two bare numbers would not say which is which.
    const label = (l: string) => (t.labels || l !== 'Weekly' || isBoth ? l : '')
    return {
      tier: t,
      claude: {
        session: isBoth
          ? windowModel(label('Session'), v.claude?.fiveHour, v.now, t.resets !== 'none', isClaudeStale, v.hasClaudeTried)
          : null,
        window: hasNoLimits
          ? null
          : windowModel(label(claudeW.label), claudeW.w, v.now, t.resets !== 'none', isClaudeStale, v.hasClaudeTried),
        cost: t.cost ? cost : '',
        context,
        slot: slotFor(cSlot, t),
      },
      codex: isCodexShown
        ? {
            window: isSignedOut
              ? SIGNED_OUT
              : windowModel(label(codexW.label), codexW.w, v.now, t.resets === 'all', isCodexStale, v.hasCodexTried),
            slot: slotFor(xSlot, t),
          }
        : null,
    }
  }

  // bodyColumns is wider than this estimate counts: calibrated on screenshots of
  // the desktop app (one estimated column draws about 0.86 of a band column), with a
  // margin, since a line that overflows is clipped at the right edge. Claude alone
  // (no divider) draws about 5% narrower than estimated, measured on 28 screenshots;
  // it gets that back, less a margin.
  const room = Math.floor(bodyColumns * 1.14 * (isClaudeAlone ? 1.04 : 1)) - 6
  const fits = (m: BandModel, isTwoLine: boolean) => {
    const e = estimateCols(m)
    if (!isTwoLine) return e.claude + (m.codex ? 6 + e.codex : 0) <= room
    // Two lines: with Codex, a product on each; Claude alone, its numbers on one and
    // its cost and statuses on the other.
    return (m.codex ? Math.max(e.claude, e.codex) : Math.max(e.claudeHead, e.claudeTail)) <= room
  }
  // Claude alone keeps both its windows, on two lines if it must, before it drops
  // one; and rather than drop a percentage or a warning, any band takes two lines.
  for (const isBoth of canShowBoth ? [true, false] : [false]) {
    for (const isTwoLine of [false, true]) {
      for (const t of TIERS) {
        const m = build(t, isBoth)
        if (fits(m, isTwoLine)) return isTwoLine ? { ...m, isTwoLine } : m
      }
    }
  }
  return { ...build(TIERS[TIERS.length - 1]!, false), isTwoLine: true }
}
