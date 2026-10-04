// Readings from what the two usage sources answer, as pure functions so tests can
// feed them recorded replies. register.tsx does the asking.
import type { ClaudeReading, CodexReading, LimitWindow } from '../types'

import { HOUR, MIN, floor } from './model'

export const FIVE_HOURS = 5 * HOUR
export const WEEK = 7 * 24 * HOUR

/**
 * An ISO 8601 string or epoch seconds, as epoch milliseconds; NaN otherwise. A number
 * too large to be seconds (past the year 5000) is taken as milliseconds already.
 */
export function timeMs(t: unknown) {
  if (typeof t === 'string') return Date.parse(t)
  if (typeof t === 'number' && Number.isFinite(t)) return t > 1e11 ? t : t * 1000
  return NaN
}

export function windowFrom(pct: unknown, resetsAt: number, windowMs: number): LimitWindow | undefined {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return undefined
  return { percentUsed: pct, resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined, windowMs }
}

const isSpent = (w?: LimitWindow) => !!w && floor(w.percentUsed) >= 100

const isObject = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x)

/**
 * A window that is there but is not one: not an object (a list, a string), or an
 * object whose percentage is not a number. The reply changed shape. Absent or null
 * is not malformed: that is a window with no usage, or none on this plan.
 */
const isMalformed = (w: unknown, key: string) =>
  w !== undefined && w !== null && !(isObject(w) && typeof w[key] === 'number' && Number.isFinite(w[key]))

/**
 * The plan-usage reply (GET /api/oauth/usage): `five_hour` and `seven_day` are
 * `{ utilization: 0-100, resets_at: ISO }`, or null when the window has no usage,
 * which the official panel leaves out too. Its `limits[]` holds per-model weekly
 * limits only (`weekly_scoped`), which the band does not show.
 *
 * Null when the reply is not one: neither window is named at all, or a window is
 * there but its percentage is not a number (the shape changed: keep the last good
 * reading and back off, rather than show nothing as if it were fresh).
 */
export function parseClaudeUsage(body: unknown, now: number): ClaudeReading | null {
  if (!isObject(body) || !('five_hour' in body || 'seven_day' in body)) return null
  if (isMalformed(body.five_hour, 'utilization') || isMalformed(body.seven_day, 'utilization')) return null
  const fiveHour = windowFrom(body.five_hour?.utilization, timeMs(body.five_hour?.resets_at), FIVE_HOURS)
  const weekly = windowFrom(body.seven_day?.utilization, timeMs(body.seven_day?.resets_at), WEEK)
  return {
    fiveHour,
    weekly,
    isUsingCredits: (isSpent(fiveHour) || isSpent(weekly)) && body.extra_usage?.is_enabled === true,
    takenAt: now,
  }
}

type HeaderLimit = { kind: string; percentUsed: number; resetsAt?: string }

/**
 * A reading from the rate-limit headers of the last reply (session.measure). A
 * window the headers leave out keeps its last value, and then the reading keeps its
 * last time too: an old window must not pass for fresh. Only the plan-usage reply
 * knows about credits: the flag stays on while a window is still spent, never
 * turns on here.
 */
export function readingFromHeaders(prev: ClaudeReading | null, limits: readonly HeaderLimit[], now: number): ClaudeReading | null {
  const fh = limits.find(r => r.kind === 'five_hour')
  const wk = limits.find(r => r.kind === 'seven_day')
  if (!fh && !wk) return null
  const fiveHour = (fh && windowFrom(fh.percentUsed, timeMs(fh.resetsAt), FIVE_HOURS)) || prev?.fiveHour
  const weekly = (wk && windowFrom(wk.percentUsed, timeMs(wk.resetsAt), WEEK)) || prev?.weekly
  return {
    fiveHour,
    weekly,
    isUsingCredits: !!prev?.isUsingCredits && (isSpent(fiveHour) || isSpent(weekly)),
    takenAt: prev && (!fh || !wk) ? prev.takenAt : now,
    // Still the newest reading, for the other sessions to take, however old its windows.
    savedAt: now,
  }
}

const DAY_MINS = 24 * 60

/**
 * The Codex app-server's `account/rateLimits/read` result. `rateLimits` is the
 * account's general bucket; `rateLimitsByLimitId` adds model-specific ones, which
 * the band does not show. Its `primary` and `secondary` windows are told apart by
 * `windowDurationMins` alone: which slot holds the weekly one differs by plan, and
 * a window of unknown length is left out rather than given a wrong name.
 *
 * Null when the result has no bucket at all, or has windows of which none is one
 * the band knows (the shape changed: keep the last good reading). No windows at all
 * is a reading with none.
 */
export function parseCodexLimits(result: unknown, now: number): CodexReading | null {
  if (!isObject(result)) return null
  const bucket = isObject(result.rateLimits) ? result.rateLimits : result.rateLimitsByLimitId?.codex
  if (!isObject(bucket)) return null
  let fiveHour: LimitWindow | undefined
  let weekly: LimitWindow | undefined
  let monthly: LimitWindow | undefined
  for (const w of [bucket.primary, bucket.secondary]) {
    if (w !== undefined && w !== null && !isObject(w)) return null
    const mins = isObject(w) ? w.windowDurationMins : undefined
    if (typeof mins !== 'number' || !Number.isFinite(mins) || mins <= 0) continue
    const isWeekly = mins >= 6 * DAY_MINS && mins <= 8 * DAY_MINS
    const isMonthly = mins >= 28 * DAY_MINS && mins <= 31 * DAY_MINS
    const isFiveHour = mins >= 4 * 60 && mins <= 6 * 60
    // Only the windows the band has names for; any other length is left out. A
    // known window whose percentage is not a number means the reply changed shape.
    if ((isWeekly || isMonthly || isFiveHour) && isMalformed(w, 'usedPercent')) return null
    const one = windowFrom(w.usedPercent, timeMs(w.resetsAt), mins * MIN)
    if (!one) continue
    if (isWeekly) weekly ??= one
    else if (isMonthly) monthly ??= one
    else if (isFiveHour) fiveHour ??= one
  }
  // Some plans have a 30-day window in place of a weekly one: shown as the long window.
  const weeklyLabel = !weekly && monthly ? 'Monthly' : undefined
  weekly ??= monthly
  const credits = result.rateLimitResetCredits
  const passes =
    typeof credits?.availableCount === 'number'
      ? credits.availableCount
      : Array.isArray(credits?.credits)
        ? credits.credits.filter((c: any) => c?.status === 'available').length
        : 0
  const hasWindows = isObject(bucket.primary) || isObject(bucket.secondary)
  if (hasWindows && !fiveHour && !weekly) return null
  return {
    fiveHour,
    weekly,
    ...(weeklyLabel ? { weeklyLabel } : {}),
    isPassReady: (isSpent(fiveHour) || isSpent(weekly)) && passes > 0,
    takenAt: now,
  }
}
