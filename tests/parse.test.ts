import { describe, expect, test } from 'claude-code/testing'

import { parseClaudeUsage, parseCodexLimits, readingFromHeaders } from '../hooks/parse'

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = Date.UTC(2026, 9, 4, 5, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()
const secs = (ms: number) => Math.round(ms / 1000)

describe('the Claude plan-usage reply', () => {
  const reply = {
    five_hour: { utilization: 12, resets_at: iso(NOW + 3 * HOUR) },
    seven_day: { utilization: 77, resets_at: iso(NOW + 11 * HOUR) },
    seven_day_opus: null,
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 0, utilization: null },
    limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 40, resets_at: iso(NOW + 11 * HOUR), scope: { model: { display_name: 'Opus' } } }],
  }

  test('reads both windows; per-model limits[] are left alone', () => {
    const r = parseClaudeUsage(reply, NOW)
    expect(r?.fiveHour).toEqual({ percentUsed: 12, resetsAt: NOW + 3 * HOUR, windowMs: 5 * HOUR })
    expect(r?.weekly).toMatchObject({ percentUsed: 77, resetsAt: NOW + 11 * HOUR })
    expect(r?.takenAt).toBe(NOW)
  })

  test('credits only count once a window is spent', () => {
    expect(parseClaudeUsage(reply, NOW)?.isUsingCredits).toBe(false)
    const spent = { ...reply, seven_day: { utilization: 100, resets_at: iso(NOW + HOUR) } }
    expect(parseClaudeUsage(spent, NOW)?.isUsingCredits).toBe(true)
    const off = { ...spent, extra_usage: { is_enabled: false } }
    expect(parseClaudeUsage(off, NOW)?.isUsingCredits).toBe(false)
  })

  test('a window with no usage (null) is left out, as the official panel does', () => {
    const r = parseClaudeUsage({ ...reply, five_hour: null }, NOW)
    expect(r?.fiveHour).toBe(undefined)
    expect(r?.weekly?.percentUsed).toBe(77)
  })

  test('a reset time in epoch seconds works too', () => {
    const r = parseClaudeUsage({ seven_day: { utilization: 5, resets_at: secs(NOW + HOUR) } }, NOW)
    expect(r?.weekly?.resetsAt).toBe(NOW + HOUR)
  })

  test('a window whose percentage is not a number means the reply changed: refused', () => {
    expect(parseClaudeUsage({ ...reply, seven_day: { utilization: '77', resets_at: iso(NOW) } }, NOW)).toBe(null)
    expect(parseClaudeUsage({ ...reply, five_hour: { used: 12 } }, NOW)).toBe(null)
  })

  test('a window that is not an object (a list, a string) is refused, never read as no limits', () => {
    expect(parseClaudeUsage({ ...reply, five_hour: [], seven_day: null }, NOW)).toBe(null)
    expect(parseClaudeUsage({ ...reply, seven_day: '77' }, NOW)).toBe(null)
  })

  test('something that is not a usage reply is refused', () => {
    expect(parseClaudeUsage({ error: { type: 'not_found' } }, NOW)).toBe(null)
    expect(parseClaudeUsage([], NOW)).toBe(null)
    expect(parseClaudeUsage('nope', NOW)).toBe(null)
  })
})

describe('the rate-limit headers of a reply', () => {
  const prev = {
    fiveHour: { percentUsed: 30, resetsAt: NOW + HOUR, windowMs: 5 * HOUR },
    weekly: { percentUsed: 100, resetsAt: NOW + 2 * HOUR, windowMs: 7 * 24 * HOUR },
    isUsingCredits: true,
    takenAt: NOW - 20 * MIN,
  }

  test('a window the headers leave out keeps its last value, and the reading its last time', () => {
    const r = readingFromHeaders(prev, [{ kind: 'five_hour', percentUsed: 35, resetsAt: iso(NOW + HOUR) }], NOW)
    expect(r?.fiveHour?.percentUsed).toBe(35)
    expect(r?.weekly).toBe(prev.weekly)
    // The weekly figure is 20 minutes old: the reading must not pass for fresh. It is
    // still the newest one, for the other sessions to take.
    expect(r?.takenAt).toBe(prev.takenAt)
    expect(r?.savedAt).toBe(NOW)
  })

  test('both windows in the headers: a fresh reading', () => {
    const both = [
      { kind: 'five_hour', percentUsed: 35, resetsAt: iso(NOW + HOUR) },
      { kind: 'seven_day', percentUsed: 100, resetsAt: iso(NOW + 2 * HOUR) },
    ]
    expect(readingFromHeaders(prev, both, NOW)?.takenAt).toBe(NOW)
  })

  test('credits stay on while a window is spent and go off once none is', () => {
    expect(readingFromHeaders(prev, [{ kind: 'five_hour', percentUsed: 35 }], NOW)?.isUsingCredits).toBe(true)
    const reset = [{ kind: 'seven_day', percentUsed: 2, resetsAt: iso(NOW + 7 * 24 * HOUR) }]
    expect(readingFromHeaders(prev, reset, NOW)?.isUsingCredits).toBe(false)
  })

  test('headers never turn credits on', () => {
    const spent = [{ kind: 'seven_day', percentUsed: 100, resetsAt: iso(NOW + HOUR) }]
    expect(readingFromHeaders(null, spent, NOW)?.isUsingCredits).toBe(false)
  })

  test('no Claude windows at all (a gateway spend limit) is no reading', () => {
    expect(readingFromHeaders(prev, [{ kind: 'spend_limit', percentUsed: 50 }], NOW)).toBe(null)
  })
})

describe('the Codex rate limits', () => {
  const bucket = (primary: unknown, secondary: unknown = null) => ({ limitId: 'codex', primary, secondary, planType: 'pro' })
  const weeklyWin = { usedPercent: 47, windowDurationMins: 10080, resetsAt: secs(NOW + 5 * 24 * HOUR) }
  const fiveWin = { usedPercent: 12, windowDurationMins: 300, resetsAt: secs(NOW + 2 * HOUR) }

  test('a plan with the weekly window only, in primary', () => {
    const r = parseCodexLimits({ rateLimits: bucket(weeklyWin), rateLimitResetCredits: { availableCount: 3 } }, NOW)
    expect(r?.weekly).toEqual({ percentUsed: 47, resetsAt: NOW + 5 * 24 * HOUR, windowMs: 7 * 24 * HOUR })
    expect(r?.fiveHour).toBe(undefined)
    expect(r?.isPassReady).toBe(false)
  })

  test('a plan with both: told apart by length, not by slot', () => {
    const r = parseCodexLimits({ rateLimits: bucket(fiveWin, weeklyWin) }, NOW)
    expect(r?.fiveHour).toMatchObject({ percentUsed: 12, windowMs: 5 * HOUR })
    expect(r?.weekly?.percentUsed).toBe(47)
    const swapped = parseCodexLimits({ rateLimits: bucket(weeklyWin, fiveWin) }, NOW)
    expect(swapped?.fiveHour?.percentUsed).toBe(12)
    expect(swapped?.weekly?.percentUsed).toBe(47)
  })

  test('only windows of unknown length: refused, so the last good reading stays', () => {
    expect(parseCodexLimits({ rateLimits: bucket({ usedPercent: 80, resetsAt: secs(NOW + HOUR) }) }, NOW)).toBe(null)
    for (const mins of [15, 60, 0, -60, 1440, 90 * 24 * 60]) {
      const r = parseCodexLimits({ rateLimits: bucket({ usedPercent: 80, windowDurationMins: mins, resetsAt: secs(NOW + HOUR) }) }, NOW)
      expect([mins, r]).toEqual([mins, null])
    }
  })

  test('a 30-day window in place of a weekly one is the long window, named Monthly', () => {
    const r = parseCodexLimits({ rateLimits: bucket({ usedPercent: 20, windowDurationMins: 43200, resetsAt: secs(NOW + 24 * 24 * HOUR) }) }, NOW)
    expect(r?.weekly).toMatchObject({ percentUsed: 20, windowMs: 30 * 24 * HOUR })
    expect(r?.weeklyLabel).toBe('Monthly')
    expect(r?.fiveHour).toBe(undefined)
  })

  test('a weekly window wins over a monthly one', () => {
    const monthly = { usedPercent: 20, windowDurationMins: 43200, resetsAt: secs(NOW + 24 * 24 * HOUR) }
    const r = parseCodexLimits({ rateLimits: bucket(monthly, weeklyWin) }, NOW)
    expect(r?.weekly?.percentUsed).toBe(47)
    expect(r?.weeklyLabel).toBe(undefined)
  })

  test('an unknown window beside a known one is left out, never misnamed', () => {
    const r = parseCodexLimits({ rateLimits: bucket({ usedPercent: 80, windowDurationMins: 60, resetsAt: secs(NOW + HOUR) }, weeklyWin) }, NOW)
    expect(r?.fiveHour).toBe(undefined)
    expect(r?.weekly?.percentUsed).toBe(47)
  })

  test('no windows at all is a reading with none', () => {
    const r = parseCodexLimits({ rateLimits: bucket(null, null) }, NOW)
    expect(r).not.toBe(null)
    expect(r?.weekly).toBe(undefined)
  })

  test('model-specific buckets do not stand in for the account one', () => {
    const r = parseCodexLimits(
      {
        rateLimits: bucket(weeklyWin),
        rateLimitsByLimitId: { codex: bucket(weeklyWin), codex_other: { limitId: 'codex_other', primary: { ...weeklyWin, usedPercent: 99 } } },
      },
      NOW,
    )
    expect(r?.weekly?.percentUsed).toBe(47)
  })

  test('falls back to the codex bucket by id', () => {
    expect(parseCodexLimits({ rateLimitsByLimitId: { codex: bucket(weeklyWin) } }, NOW)?.weekly?.percentUsed).toBe(47)
  })

  test('a reset pass is ready once a limit is spent and a pass is left', () => {
    const spent = { ...weeklyWin, usedPercent: 100 }
    expect(parseCodexLimits({ rateLimits: bucket(spent), rateLimitResetCredits: { availableCount: 1 } }, NOW)?.isPassReady).toBe(true)
    expect(parseCodexLimits({ rateLimits: bucket(spent), rateLimitResetCredits: { availableCount: 0 } }, NOW)?.isPassReady).toBe(false)
    const listed = { credits: [{ status: 'available' }, { status: 'used' }] }
    expect(parseCodexLimits({ rateLimits: bucket(spent), rateLimitResetCredits: listed }, NOW)?.isPassReady).toBe(true)
  })

  test('a known window whose percentage is not a number is refused', () => {
    expect(parseCodexLimits({ rateLimits: bucket({ ...weeklyWin, usedPercent: '47' }) }, NOW)).toBe(null)
  })

  test('a window that is not an object is refused, never read as no windows', () => {
    expect(parseCodexLimits({ rateLimits: { primary: [], secondary: null } }, NOW)).toBe(null)
    expect(parseCodexLimits({ rateLimits: { primary: 'weekly' } }, NOW)).toBe(null)
  })

  test('a reset time in milliseconds, not seconds, is still read right', () => {
    const r = parseCodexLimits({ rateLimits: bucket({ ...weeklyWin, resetsAt: NOW + 2 * HOUR }) }, NOW)
    expect(r?.weekly?.resetsAt).toBe(NOW + 2 * HOUR)
  })

  test('no bucket at all is no reading', () => {
    expect(parseCodexLimits({ ordinaryUsageAllowed: true }, NOW)).toBe(null)
    expect(parseCodexLimits(null, NOW)).toBe(null)
  })
})
