import { describe, expect, mock, test } from 'claude-code/testing'

import type { On } from 'claude-code'

import { bandModel, codexMode, estimateCols } from '../hooks/model'
import type { View } from '../types'

const MIN = 60_000
const HOUR = 60 * MIN
// 2026-10-04 13:00 in UTC+8.
const NOW = Date.UTC(2026, 9, 4, 5, 0, 0)

const VIEW: View = {
  claude: {
    fiveHour: { percentUsed: 12, resetsAt: NOW + 3 * HOUR, windowMs: 5 * HOUR },
    weekly: { percentUsed: 77, resetsAt: NOW + 11 * HOUR + 50 * MIN, windowMs: 7 * 24 * HOUR },
    isUsingCredits: false,
    takenAt: NOW - MIN,
  },
  claudeError: null,
  codex: {
    weekly: { percentUsed: 46, resetsAt: NOW + 5 * 24 * HOUR + 17 * HOUR, windowMs: 7 * 24 * HOUR },
    isPassReady: false,
    takenAt: NOW - MIN,
  },
  codexError: null,
  hasClaudeTried: true,
  hasCodexTried: true,
  hasCodex: true,
  codexMode: 'show',
  codexTasks: [],
  contextPercent: 30,
  contextTokens: 60_000,
  isContextShown: false,
  costUsd: 20.52,
  lastTurnAt: NOW - MIN,
  now: NOW,
  utcOffsetMin: 480,
}

const model = (patch: Partial<View> = {}, cols = 95) => bandModel({ ...VIEW, ...patch }, cols)
const claude = (p: Partial<NonNullable<View['claude']>>) => ({ claude: { ...VIEW.claude!, ...p } })
const codex = (p: Partial<NonNullable<View['codex']>>) => ({ codex: { ...VIEW.codex!, ...p } })
const task = (agoMs: number) => ({ startedAt: NOW - agoMs })

describe('normal', () => {
  test('Claude weekly, cost and Codex weekly with countdowns', () => {
    const m = model()
    expect(m.claude.window).toMatchObject({ label: 'Weekly', pctText: '77%', level: 'warn', reset: '11h 50m' })
    expect(m.claude.cost).toBe('~$20.52')
    expect(m.claude.slot).toBe(null)
    expect(m.codex?.window).toMatchObject({ label: 'Weekly', pctText: '46%', level: 'ok', reset: '5d 17h' })
    expect(m.codex?.slot).toBe(null)
  })
})

describe('5-hour takeover', () => {
  test('the session window replaces Claude weekly at 90%', () => {
    const m = model(claude({ fiveHour: { percentUsed: 92, resetsAt: NOW + 40 * MIN, windowMs: 5 * HOUR } }))
    expect(m.claude.window).toMatchObject({ label: 'Session', pctText: '92%', reset: '40m' })
  })

  test('5h stays hidden below 89.5%, which still reads 89%', () => {
    const m = model(claude({ fiveHour: { percentUsed: 89.4, resetsAt: NOW + 40 * MIN, windowMs: 5 * HOUR } }))
    expect(m.claude.window?.label).toBe('Weekly')
  })

  test('the session window takes over at 89.6%, which reads 90%', () => {
    const m = model(claude({ fiveHour: { percentUsed: 89.6, resetsAt: NOW + 40 * MIN, windowMs: 5 * HOUR } }))
    expect(m.claude.window).toMatchObject({ label: 'Session', pctText: '90%' })
  })

  test('a spent weekly limit stays shown even when 5h passes 90%', () => {
    const m = model(
      claude({
        fiveHour: { percentUsed: 95, resetsAt: NOW + HOUR, windowMs: 5 * HOUR },
        weekly: { percentUsed: 100, resetsAt: NOW + 2 * HOUR, windowMs: 7 * 24 * HOUR },
      }),
    )
    expect(m.claude.window).toMatchObject({ label: 'Weekly', pctText: 'Limit reached', reset: '2h 0m' })
  })

  test('the same rule holds for Codex', () => {
    const m = model(codex({ fiveHour: { percentUsed: 93, resetsAt: NOW + 2 * HOUR, windowMs: 5 * HOUR } }))
    expect(m.codex?.window).toMatchObject({ label: '5h', pctText: '93%', reset: '2h 0m' })
    const quiet = model(codex({ fiveHour: { percentUsed: 40, resetsAt: NOW + 2 * HOUR, windowMs: 5 * HOUR } }))
    expect(quiet.codex?.window).toMatchObject({ label: 'Weekly', pctText: '46%' })
  })

  test('a Codex plan with only a 5h window shows it as 5h, never Weekly', () => {
    const m = model({ codex: { fiveHour: { percentUsed: 30, resetsAt: NOW + HOUR, windowMs: 5 * HOUR }, isPassReady: false, takenAt: NOW - MIN } })
    expect(m.codex?.window).toMatchObject({ label: '5h', pctText: '30%' })
  })

  test('a spent limit reads Limit reached', () => {
    const m = model(claude({ weekly: { percentUsed: 100, resetsAt: NOW + HOUR, windowMs: 7 * 24 * HOUR } }))
    expect(m.claude.window).toMatchObject({ pctText: 'Limit reached', level: 'full' })
  })

  test('99.6% is not rounded up to spent', () => {
    const m = model(claude({ weekly: { percentUsed: 99.6, resetsAt: NOW + HOUR, windowMs: 7 * 24 * HOUR } }))
    expect(m.claude.window).toMatchObject({ pctText: '99%', level: 'warn' })
  })

  test('amber follows the percentage shown: 74.5% reads 75% and is amber', () => {
    const m = model(claude({ weekly: { percentUsed: 74.5, resetsAt: NOW + HOUR, windowMs: 7 * 24 * HOUR } }))
    expect(m.claude.window).toMatchObject({ pctText: '75%', level: 'warn' })
    const below = model(claude({ weekly: { percentUsed: 74.4, resetsAt: NOW + HOUR, windowMs: 7 * 24 * HOUR } }))
    expect(below.claude.window).toMatchObject({ pctText: '74%', level: 'ok' })
  })

  test('under a minute to the reset reads <1m, not 0m', () => {
    const m = model(claude({ weekly: { percentUsed: 40, resetsAt: NOW + 30_000, windowMs: 7 * 24 * HOUR } }))
    expect(m.claude.window?.reset).toBe('<1m')
  })

  test('a reset long past with no new reading: no numbers, not "resetting" forever', () => {
    const m = model(claude({ fiveHour: undefined, weekly: { percentUsed: 40, resetsAt: NOW - 10 * MIN, windowMs: 7 * 24 * HOUR } }))
    expect(m.claude.window).toMatchObject({ pctText: '—', reset: '' })
  })

  test('a plan with no limits (Enterprise, Free): no window, the cost and context only', () => {
    const m = model({ claude: { isUsingCredits: false, takenAt: NOW - MIN }, contextPercent: 30 })
    expect(m.claude.window).toBe(null)
    expect(m.claude.cost).toBe('~$20.52')
    expect(m.claude.context?.text).toBe('Context 30%')
  })

  test('a plan with no limits is asked hourly: an old or failing reading is not "As of" or "Not updating"', () => {
    const m = model({ claude: { isUsingCredits: false, takenAt: NOW - 50 * MIN }, claudeError: 'HTTP 500', contextPercent: 30 })
    expect(m.claude.slot).toBe(null)
  })

  test('a Codex monthly window is named Monthly, and keeps its name when narrow', () => {
    const c = { weekly: { percentUsed: 20, resetsAt: NOW + 20 * 24 * HOUR, windowMs: 30 * 24 * HOUR }, weeklyLabel: 'Monthly', isPassReady: false, takenAt: NOW - MIN }
    expect(model({ codex: c }).codex?.window).toMatchObject({ label: 'Monthly', pctText: '20%' })
    expect(model({ codex: c }, 44).codex?.window.label).toBe('Monthly')
  })

  test('a weekly window long past its reset gives way to a session window still running', () => {
    const m = model(claude({ weekly: { percentUsed: 40, resetsAt: NOW - 10 * MIN, windowMs: 7 * 24 * HOUR } }))
    expect(m.claude.window).toMatchObject({ label: 'Session', pctText: '12%' })
  })

  test('a reset already past reads resetting', () => {
    const m = model(claude({ weekly: { percentUsed: 40, resetsAt: NOW - MIN, windowMs: 7 * 24 * HOUR } }))
    expect(m.claude.window?.reset).toBe('resetting')
  })
})

describe('Claude status after the cost', () => {
  test('using credits, cost still there', () => {
    const m = model(claude({ isUsingCredits: true }))
    expect(m.claude.slot).toEqual({ text: '! Using credits', tone: 'warn' })
    expect(m.claude.cost).toBe('~$20.52')
  })

  test("can't read once the request keeps failing and the reading is old", () => {
    expect(model({ ...claude({ takenAt: NOW - 40 * MIN }), claudeError: 'HTTP 500' }).claude.slot?.text).toBe('! Not updating')
  })

  test('a failing request with a fresh reading stays quiet', () => {
    expect(model({ claudeError: 'HTTP 500' }).claude.slot).toBe(null)
  })

  test('as of when the reading is older than 15 minutes', () => {
    expect(model(claude({ takenAt: NOW - 20 * MIN })).claude.slot).toEqual({ text: 'As of 12:40', tone: 'dim' })
  })

  test('cache cold after an hour idle', () => {
    expect(model({ lastTurnAt: NOW - 70 * MIN }).claude.slot?.text).toBe('Cache cold')
  })

  test('not cache cold before the hour is up', () => {
    expect(model({ lastTurnAt: NOW - 50 * MIN }).claude.slot).toBe(null)
  })

  test('context at 58% is dim, at 84% a warning', () => {
    expect(model({ contextPercent: 58, isContextShown: true }).claude.slot).toEqual({ text: 'Context 58%', tone: 'dim' })
    expect(model({ contextPercent: 84, isContextShown: true }).claude.slot).toEqual({ text: '! Context 84%', tone: 'warn' })
  })

  test('only the most severe status shows', () => {
    const m = model({ ...claude({ isUsingCredits: true }), contextPercent: 84, isContextShown: true })
    expect(m.claude.slot?.text).toBe('! Using credits')
  })
})

describe('Codex status', () => {
  test('one task running', () => {
    expect(model({ codexTasks: [task(3 * MIN)] }).codex?.slot?.text).toBe('Running 3m')
  })

  test('a task in its first minute reads Running', () => {
    expect(model({ codexTasks: [task(20_000)] }).codex?.slot?.text).toBe('Running')
  })

  test('several tasks', () => {
    expect(model({ codexTasks: [task(3 * MIN), task(MIN)] }).codex?.slot?.text).toBe('2 running')
  })

  test('as of outranks running once a due refresh was missed', () => {
    const m = model({ ...codex({ takenAt: NOW - 50 * MIN }), codexTasks: [task(3 * MIN)] })
    expect(m.codex?.slot?.text).toBe('As of 12:10')
  })

  test('an idle Codex reading of 20 minutes is not stale: it cannot have moved', () => {
    const m = model(codex({ takenAt: NOW - 20 * MIN }))
    expect(m.codex?.slot).toBe(null)
    expect(m.codex?.window.isStale).toBe(false)
  })

  test('reset pass ready', () => {
    expect(model(codex({ isPassReady: true })).codex?.slot).toEqual({ text: '! Reset pass ready', tone: 'warn' })
  })

  test("can't read with no reading at all", () => {
    expect(model({ codex: null, codexError: 'timed out' }).codex?.slot?.text).toBe('! Not updating')
  })

  test('no Codex on this machine leaves the group out', () => {
    expect(model({ hasCodex: false, codex: null }).codex).toBe(null)
  })
})

describe('edges', () => {
  test('no reading yet shows a dash, never 0%', () => {
    const m = model({ claude: null, codex: null })
    expect(m.claude.window?.pctText).toBe('—')
    expect(m.codex?.window.pctText).toBe('—')
  })

  test('before the first ask it reads Loading, not a dash', () => {
    const m = model({ claude: null, codex: null, hasClaudeTried: false, hasCodexTried: false })
    expect(m.claude.window?.pctText).toBe('Loading')
    expect(m.codex?.window.pctText).toBe('Loading')
  })

  test('an old reading is marked stale so its percentage is drawn dim', () => {
    expect(model(claude({ takenAt: NOW - 20 * MIN })).claude.window?.isStale).toBe(true)
    expect(model().claude.window?.isStale).toBe(false)
  })

  test('a narrow band drops countdowns before percentages', () => {
    const m = model({ codexTasks: [task(3 * MIN)] }, 60)
    expect(m.claude.window?.pctText).toBe('77%')
    expect(m.codex?.window.pctText).toBe('46%')
    expect(m.codex?.window.reset).toBe('')
  })

  test('a very narrow band drops the bars last', () => {
    const m = model({ contextPercent: 84, isContextShown: true, codexTasks: [task(3 * MIN)] }, 40)
    expect(m.tier.barPx).toBe(0)
    expect(m.claude.window?.reset).toBe('')
  })

  test('a wide band keeps the longest bars and every countdown', () => {
    const m = model({}, 140)
    expect(m.tier.barPx).toBe(72)
    expect(m.claude.window?.reset).toBe('11h 50m')
    expect(m.codex?.window.reset).toBe('5d 17h')
  })

  test('the current desktop width with a running task keeps Claude countdown', () => {
    const m = model({ contextPercent: 52, isContextShown: true, codexTasks: [task(3 * MIN)] }, 95)
    expect(m.claude.window?.reset).not.toBe('')
  })
})

describe('without Codex: Claude has the band to itself', () => {
  const alone = (patch: Partial<View> = {}, cols = 95) => model({ hasCodex: false, codex: null, ...patch }, cols)

  test('both windows, the cost and the context at all times', () => {
    const m = alone()
    expect(m.codex).toBe(null)
    expect(m.claude.session).toMatchObject({ label: 'Session', pctText: '12%', reset: '3h 0m' })
    expect(m.claude.window).toMatchObject({ label: 'Weekly', pctText: '77%', reset: '11h 50m' })
    expect(m.claude.cost).toBe('~$20.52')
    // 30% would stay hidden next to Codex; alone it is always there.
    expect(m.claude.context).toEqual({ text: 'Context 30%', tone: 'dim' })
    expect(m.claude.slot).toBe(null)
  })

  test('a full context turns amber and is not repeated in the status', () => {
    const m = alone({ contextPercent: 84, isContextShown: true })
    expect(m.claude.context).toEqual({ text: '! Context 84%', tone: 'warn' })
    expect(m.claude.slot).toBe(null)
  })

  test('other statuses still follow, after the context', () => {
    const m = alone(claude({ takenAt: NOW - 20 * MIN }))
    expect(m.claude.context?.text).toBe('Context 30%')
    expect(m.claude.slot?.text).toBe('As of 12:40')
  })

  test('the session window never takes over: both are there', () => {
    const m = alone(claude({ fiveHour: { percentUsed: 95, resetsAt: NOW + 40 * MIN, windowMs: 5 * HOUR } }))
    expect(m.claude.session).toMatchObject({ label: 'Session', pctText: '95%' })
    expect(m.claude.window?.label).toBe('Weekly')
  })

  test('no session reading: the weekly window alone', () => {
    const m = alone(claude({ fiveHour: undefined }))
    expect(m.claude.session).toBe(null)
    expect(m.claude.window?.label).toBe('Weekly')
  })

  test('a hidden Codex counts as none', () => {
    const m = model({ codexMode: 'hidden' })
    expect(m.codex).toBe(null)
    expect(m.claude.session?.label).toBe('Session')
  })

  test('at 44 columns both windows stay, on two lines: the numbers, then the cost and context', () => {
    const m = alone({}, 44)
    expect(m.isTwoLine).toBe(true)
    expect(m.claude.session).toMatchObject({ label: 'Session', pctText: '12%' })
    expect(m.claude.window).toMatchObject({ label: 'Weekly', pctText: '77%' })
    expect(m.claude.context?.text).toBe('Context 30%')
  })

  test('at 70 columns both windows still fit on one line', () => {
    const m = alone({}, 70)
    expect(m.isTwoLine).toBeFalsy()
    expect(m.claude.session).toMatchObject({ label: 'Session', pctText: '12%' })
    expect(m.claude.window).toMatchObject({ label: 'Weekly', pctText: '77%' })
  })

  test('crowded at 44 columns keeps the spent limit, its countdown and the warning', () => {
    const m = alone(
      {
        ...claude({ weekly: { percentUsed: 100, resetsAt: NOW + 2 * HOUR, windowMs: 7 * 24 * HOUR } }),
        contextPercent: 84,
        isContextShown: true,
      },
      44,
    )
    // Too much for one line: the numbers on one, the cost and the warning under them.
    expect(m.isTwoLine).toBe(true)
    expect(m.claude.window).toMatchObject({ pctText: 'Limit reached', reset: '2h 0m' })
    expect(m.claude.context?.text).toBe('! Context 84%')
    const e = estimateCols(m)
    expect(Math.max(e.claudeHead, e.claudeTail)).toBeLessThanOrEqual(Math.floor(44 * 1.14 * 1.04) - 6)
  })
})

describe('Codex signed out or unused', () => {
  const mode = (patch: Partial<Parameters<typeof codexMode>[0]> = {}) =>
    codexMode({
      setting: 'auto',
      auth: 'chatgpt',
      reading: { weekly: { percentUsed: 0, resetsAt: NOW + 3 * 24 * HOUR, windowMs: 7 * 24 * HOUR }, isPassReady: false, takenAt: NOW - HOUR },
      lastLocalUseAt: NOW - 10 * 24 * HOUR,
      visibleUntil: 0,
      now: NOW,
      ...patch,
    })

  test('unused here for a week and 0% this week: hidden', () => {
    expect(mode()).toBe('hidden')
  })

  test('used here this week: shown, whatever the percentage', () => {
    expect(mode({ lastLocalUseAt: NOW - 6 * 24 * HOUR })).toBe('show')
  })

  test('used elsewhere this week (above 0%): shown', () => {
    expect(mode({ reading: { weekly: { percentUsed: 3, windowMs: 7 * 24 * HOUR }, isPassReady: false, takenAt: NOW - HOUR } })).toBe('show')
  })

  test('the 5h window above 0 also counts as use', () => {
    const reading = {
      fiveHour: { percentUsed: 1, windowMs: 5 * HOUR },
      weekly: { percentUsed: 0, windowMs: 7 * 24 * HOUR },
      isPassReady: false,
      takenAt: NOW - HOUR,
    }
    expect(mode({ reading })).toBe('show')
  })

  test('an old reading or no weekly window cannot say unused', () => {
    expect(mode({ reading: { weekly: { percentUsed: 0, windowMs: 7 * 24 * HOUR }, isPassReady: false, takenAt: NOW - 8 * HOUR } })).toBe('show')
    expect(mode({ reading: { fiveHour: { percentUsed: 0, windowMs: 5 * HOUR }, isPassReady: false, takenAt: NOW - HOUR } })).toBe('show')
    expect(mode({ reading: null })).toBe('show')
  })

  test('a fresh reading with no windows at all is a plan without limits: hidden', () => {
    expect(mode({ reading: { isPassReady: false, takenAt: NOW - HOUR }, lastLocalUseAt: NOW })).toBe('hidden')
  })

  test('shown again a moment ago: held for the day', () => {
    expect(mode({ visibleUntil: NOW + HOUR })).toBe('show')
  })

  test('signed out after use this week: a note; long unused: hidden', () => {
    expect(mode({ auth: 'none', lastLocalUseAt: NOW - 2 * 24 * HOUR })).toBe('signedOut')
    expect(mode({ auth: 'none' })).toBe('hidden')
  })

  test('an API key has no plan limits: hidden', () => {
    expect(mode({ auth: 'apiKey', lastLocalUseAt: NOW })).toBe('hidden')
  })

  test('the setting overrides: always shows, never hides', () => {
    expect(mode({ setting: 'always' })).toBe('show')
    expect(mode({ setting: 'always', auth: 'none' })).toBe('signedOut')
    expect(mode({ setting: 'never', lastLocalUseAt: NOW })).toBe('hidden')
  })

  test('signed out draws a dim note in place of the numbers', () => {
    const m = model({ codexMode: 'signedOut', codexTasks: [task(MIN)] })
    expect(m.codex?.window).toMatchObject({ pctText: 'Signed out', isNote: true })
    expect(m.codex?.slot).toBe(null)
    // Codex is still on the band, so Claude keeps its single window.
    expect(m.claude.session).toBe(null)
  })
})

describe('the narrowest window (44 columns)', () => {
  test('normal: names and percentages, no Weekly labels', () => {
    const m = model({}, 44)
    expect(m.claude.window).toMatchObject({ label: '', pctText: '77%' })
    expect(m.codex?.window).toMatchObject({ label: '', pctText: '46%' })
  })

  test('Session keeps its label even here: it says which window this is', () => {
    const m = model(claude({ fiveHour: { percentUsed: 92, resetsAt: NOW + 40 * MIN, windowMs: 5 * HOUR } }), 44)
    expect(m.claude.window?.label).toBe('Session')
  })

  test('crowded: everything essential stays, on two lines', () => {
    const m = model(
      {
        ...claude({ weekly: { percentUsed: 100, resetsAt: NOW + 2 * HOUR, windowMs: 7 * 24 * HOUR } }),
        contextPercent: 84,
        isContextShown: true,
        codexTasks: [task(12 * MIN), task(MIN)],
      },
      44,
    )
    // One line cannot hold a spent limit, its countdown, a warning and Codex: two lines.
    expect(m.isTwoLine).toBe(true)
    expect(m.claude.window).toMatchObject({ pctText: 'Limit reached', reset: '2h 0m' })
    expect(m.claude.slot?.text).toBe('! Context 84%')
    expect(m.codex?.window.pctText).toBe('46%')
  })

  test('normal stays on one line', () => {
    expect(model({}, 44).isTwoLine).toBeFalsy()
  })
})

describe('matches the official panel', () => {
  test('percentages round like the official panel', () => {
    expect(model(claude({ weekly: { percentUsed: 77.6, resetsAt: NOW + HOUR, windowMs: 7 * 24 * HOUR } })).claude.window?.pctText).toBe('78%')
  })

  test('context rounds too: 59.7% reads 60%', () => {
    expect(model({ contextPercent: 59.7, isContextShown: true }).claude.slot?.text).toBe('Context 60%')
  })

  test('a spent limit keeps its countdown even when the band is crowded', () => {
    const m = model(
      {
        ...claude({ weekly: { percentUsed: 100, resetsAt: NOW + 2 * HOUR, windowMs: 7 * 24 * HOUR } }),
        contextPercent: 84,
        isContextShown: true,
        codexTasks: [task(12 * MIN), task(MIN)],
        costUsd: 128.4,
      },
      95,
    )
    expect(m.claude.window).toMatchObject({ pctText: 'Limit reached', reset: '2h 0m' })
  })

  test('a spent Codex limit with a reset pass keeps its countdown', () => {
    const m = model(codex({ weekly: { percentUsed: 100, resetsAt: NOW + 2 * 24 * HOUR, windowMs: 7 * 24 * HOUR }, isPassReady: true }), 60)
    expect(m.codex?.window.reset).toBe('2d 0h')
  })
})

type SessionLog = { name: string; size: number; ageMs: number }
type Host = {
  /** The plan-usage reply; without it Claude is not signed in and the request stops. */
  apiReply?: () => unknown
  codexReply?: string
  surfaces?: string[]
  hasNode?: boolean
  hasCodexCommand?: boolean
  hasCodexHome?: boolean
  isSignedIn?: boolean
  /** How Claude is signed in when there is a plan-usage reply: claude.ai (bearer) or an API key. */
  authKind?: 'bearer' | 'api-key'
  /** Today's Codex session logs, and what reading one answers (its path, and the byte it reads from). */
  logs?: () => SessionLog[]
  readLog?: (path: string, from: number) => string
}

/**
 * A host for a session start: node and codex on PATH, a ~/.codex folder, no
 * session logs and no Claude login (so the plan-usage request stops at once). The
 * Codex app-server answers 47% of the week unless told otherwise. Counts what the
 * mod asks for.
 */
function host(
  on: On,
  { apiReply, authKind = 'bearer', codexReply, surfaces = ['desktop'], hasNode = true, hasCodexCommand = true, hasCodexHome = true, isSignedIn = true, logs, readLog }: Host = {},
) {
  const asked = { codex: 0, authorize: 0, api: 0, login: 0, reads: [] as number[] }
  const today = '/h/.codex/sessions/2026/10/04'
  mock.env(on, { HOME: '/h', PATH: '/usr/bin' })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: surfaces }) as never)
  on('fs.exists', (_$, e) => ({
    value:
      !e.path.includes('/.nvm/') &&
        (hasNode || !e.path.endsWith('/node')) &&
        (hasCodexCommand || !e.path.endsWith('/codex')) &&
        (hasCodexHome || !e.path.endsWith('/.codex')),
  }))
  on('fs.read', () => ({ deny: 'no such file' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === '/bin/date') return { value: { exitCode: 0, stdout: '+0800\n', stderr: '' } } as never
    if (e.argv[1] === 'login') {
      asked.login += 1
      return { value: isSignedIn ? { exitCode: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'Not logged in\n' } } as never
    }
    if (e.argv[0] === '/bin/sh' && e.argv[2]?.includes('/usr/bin/find')) {
      // find -mmin -N, answered with `stat -f '%m %z %N'` lines, or the newest `%m` alone.
      const minutes = Number(e.argv[5])
      const recent = (logs?.() ?? []).filter(l => l.ageMs < minutes * MIN)
      const sec = (l: SessionLog) => Math.floor((NOW - l.ageMs) / 1000)
      const lines = e.argv[2].includes('sort -rn')
        ? recent.map(sec).sort((a, b) => b - a).slice(0, 1).map(String)
        : recent.map(l => `${sec(l)} ${l.size} ${today}/${l.name}`)
      return { value: { exitCode: 0, stdout: lines.join('\n') + (lines.length ? '\n' : ''), stderr: '' } } as never
    }
    if (e.argv[0] === '/bin/sh') {
      const from = Number(e.argv[2]?.includes('head -c') ? 0 : e.argv[5])
      asked.reads.push(from)
      return { value: { exitCode: 0, stdout: readLog?.(e.argv[4] ?? '', from) ?? '', stderr: '' } } as never
    }
    asked.codex += 1
    const result = { rateLimits: { limitId: 'codex', primary: { usedPercent: 47, windowDurationMins: 10080, resetsAt: Math.round((NOW + 5 * 24 * HOUR) / 1000) }, secondary: null } }
    const stdout = codexReply ?? JSON.stringify({ ok: true, result, account: { type: 'chatgpt', planType: 'pro' } })
    return { value: { exitCode: 0, stdout: stdout + '\n', stderr: '' } } as never
  })
  on('session.authorize', () => {
    asked.authorize += 1
    return { value: apiReply ? { handle: 'h', kind: authKind } : null } as never
  })
  on('http.fetch', () => {
    asked.api += 1
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(apiReply?.() ?? {}) } } as never
  })
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  return asked
}

// The drawing itself, through the engine: a session.measure feeds the view, then the
// band is mounted on the desktop surface, whose element table validates the tree.
describe('drawn on the desktop surface', () => {
  const props = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 95 } as never

  test('before a session start finds Codex, only Claude is drawn', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 1 }) as never)
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    await $.session.measure({
      context: { tokens: 60_000, window: 200_000, percent: 30 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 77, resetsAt: new Date(NOW + 11 * HOUR + 50 * MIN).toISOString() }],
      cost: { usd: 20.52 },
      changed: ['rateLimits'],
    } as never)
    const ui = await $.ui.mount({ plugin: 'usage-glance', surface: 'desktop', component: 'AbovePrompt', props })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toEqual(['Claude', 'Weekly', '77%', '11h 50m', '~$20.52', '·', 'Context 30%'])
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  })

  test('draws one line with the numbers and a divider', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 1 }) as never)
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    host(on)
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    await $.session.measure({
      context: { tokens: 60_000, window: 200_000, percent: 30 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 12, resetsAt: new Date(NOW + 3 * HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: 77, resetsAt: new Date(NOW + 11 * HOUR + 50 * MIN).toISOString() },
      ],
      cost: { usd: 20.52 },
      changed: ['rateLimits'],
    } as never)
    const ui = await $.ui.mount({ plugin: 'usage-glance', surface: 'desktop', component: 'AbovePrompt', props })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toContain('Claude')
    expect(texts).toContain('77%')
    expect(texts).toContain('~$20.52')
    expect(texts).toContain('│')
    expect(texts).toContain('Codex')
    expect(texts).toContain('47%')
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(2)
  })

  test('a failing Codex is asked again after 2, 10, then 30 minutes, never every minute', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    const asked = host(on, { codexReply: JSON.stringify({ ok: false, error: 'timed out' }) })
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    expect(asked.codex).toBe(1)
    await clock.advance(MIN)
    expect(asked.codex).toBe(1)
    // 2 minutes (plus up to 3 of jitter): the network may just be back after a wake.
    await clock.advance(5 * MIN)
    expect(asked.codex).toBe(2)
    await clock.advance(5 * MIN)
    expect(asked.codex).toBe(2)
    await clock.advance(10 * MIN)
    expect(asked.codex).toBe(3)
    // From the third failure on, half an hour each: the third ask came at 12 min at the
    // earliest (2 + 10, before jitter), so nothing more before 42 min.
    await clock.advance(15 * MIN)
    expect(asked.codex).toBe(3)
  })

  // Someone without Codex sees Claude alone: no divider, no Codex group, nothing
  // spawned, nothing read from Codex's folders, and no warning about it.
  for (const [why, setup] of [
    ['no codex command', { hasCodexCommand: false }],
    ['no ~/.codex folder', { hasCodexHome: false }],
    ['no node for the helper', { hasNode: false }],
  ] as const) {
    test(`with ${why}: Claude alone, nothing spawned`, async ($, on) => {
      const clock = mock.clock(on, { now: NOW })
      mock.store(on)
      on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 1 }) as never)
      on('session.measure', (_$, e) => ({ changed: e.changed }))
      const asked = host(on, setup)
      await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
      await clock.advance(1_000)
      await $.session.measure({
        context: { tokens: 60_000, window: 200_000, percent: 30 },
        rateLimits: [{ kind: 'seven_day', percentUsed: 77, resetsAt: new Date(NOW + 11 * HOUR + 50 * MIN).toISOString() }],
        cost: { usd: 20.52 },
        changed: ['rateLimits'],
      } as never)
      await clock.advance(3 * MIN)
      expect(asked.codex).toBe(0)
      expect(asked.reads).toEqual([])
      const ui = await $.ui.mount({ plugin: 'usage-glance', surface: 'desktop', component: 'AbovePrompt', props })
      const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
      // The minute tick read the cost again from the session ($0 on this host).
      expect(texts).toEqual(['Claude', 'Weekly', '77%', '11h 46m', '~$0.00'])
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
    })
  }

  test('/usage-glance says what Codex is missing', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    host(on, { hasCodexHome: false })
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    const done = $.command.run({ command: 'usage-glance', args: '' } as never)
    await clock.advance(1_000)
    const out = (await done) as { text?: string }
    expect(out.text).toContain('Codex   found, but not its folder (never run, or CODEX_HOME points elsewhere)')
    // What a bug report needs, and nothing private: no home folder, no account id.
    expect(out.text).toContain('For a bug report, include these lines:')
    expect(out.text).toContain('codex on PATH · node found · CODEX_HOME default · setting auto')
    expect(out.text).not.toContain('/h/')
  })

  test('with no Claude login the plan-usage request stops instead of retrying every minute', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    const asked = host(on)
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    expect(asked.authorize).toBe(1)
    await clock.advance(60 * MIN)
    expect(asked.authorize).toBe(1)
  })

  test('an API key has no plan limits: the plan-usage endpoint is never sent it', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    const asked = host(on, { apiReply: () => ({}), authKind: 'api-key' })
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(60 * MIN)
    expect(asked.authorize).toBe(1)
    expect(asked.api).toBe(0)
  })

  test('/clear keeps Codex and the time zone, and reads the cost again', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 1 }) as never)
    on('classic.SessionStart', () => ({}) as never)
    host(on)
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    await $.classic.SessionStart({ source: 'clear' } as never)
    await clock.advance(1_000)
    const ui = await $.ui.mount({ plugin: 'usage-glance', surface: 'desktop', component: 'AbovePrompt', props })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toContain('Codex')
    expect(texts).toContain('47%')
    expect(texts).toContain('~$0.00')
  })

  test('a Codex task in progress reads Running; subagents and finished tasks do not', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 1 }) as never)
    const event = (kind: string, at: number) => `{"timestamp":"${new Date(at).toISOString()}","ordinal":1,"type":"event_msg","payload":{"type":"${kind}"`
    let size = 100_000
    let isDone = false
    const asked = host(on, {
      logs: () => [
        { name: 'rollout-a.jsonl', size, ageMs: 20_000 },
        { name: 'rollout-sub.jsonl', size: 5_000, ageMs: 20_000 },
        { name: 'rollout-old.jsonl', size: 9_000, ageMs: 2 * HOUR },
      ],
      readLog: (path, from) =>
        path.endsWith('sub.jsonl')
          ? `{"type":"session_meta","payload":{"thread_source":"subagent"}}\n${event('task_started', NOW - MIN)}`
          : from === 0
            ? `{"type":"session_meta","payload":{"originator":"codex_exec"}}\n${event('task_started', NOW - 3 * MIN)}`
            : isDone
              ? event('task_complete', NOW)
              : '',
    })
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    const ui = await $.ui.mount({ plugin: 'usage-glance', surface: 'desktop', component: 'AbovePrompt', props })
    expect(await ui.find({ type: 'Text', text: 'Running 3m' })).not.toBe(undefined)
    // The file grows and the task finishes: only the new part is read.
    size = 120_000
    isDone = true
    await clock.advance(MIN)
    const ui2 = await $.ui.mount({ plugin: 'usage-glance', surface: 'desktop', component: 'AbovePrompt', props })
    expect(await ui2.find({ type: 'Text', text: 'Running 4m' })).toBe(undefined)
    expect((await ui2.findAll({ type: 'Text' })).map(t => t.text).some(t => t.startsWith('Running'))).toBe(false)
    // Whole reads of the two live files, then the grown one from a little before its old end; the
    // two-hour-old file and the unchanged subagent are not read again.
    expect([...asked.reads].sort((x, y) => x - y)).toEqual([0, 0, 100_000 - 8 * 1024 + 1])
  })

  test('subagents do not crowd out the task that spawned them', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 1 }) as never)
    const event = (kind: string, at: number) => `{"timestamp":"${new Date(at).toISOString()}","ordinal":1,"type":"event_msg","payload":{"type":"${kind}"`
    const subs = Array.from({ length: 8 }, (_, i) => ({ name: `rollout-sub${i}.jsonl`, size: 5_000, ageMs: 10_000 + i }))
    host(on, {
      logs: () => [...subs, { name: 'rollout-main.jsonl', size: 50_000, ageMs: 40_000 }],
      readLog: path =>
        path.includes('sub')
          ? `{"type":"session_meta","payload":{"thread_source":"subagent"}}\n${event('task_started', NOW - MIN)}`
          : `{"type":"session_meta","payload":{"thread_source":"user"}}\n${event('task_started', NOW - 5 * MIN)}`,
    })
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    const ui = await $.ui.mount({ plugin: 'usage-glance', surface: 'desktop', component: 'AbovePrompt', props })
    expect(await ui.find({ type: 'Text', text: 'Running 5m' })).not.toBe(undefined)
  })

  test('more subagents than one scan reads still let the task that spawned them be found', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 1 }) as never)
    const event = (kind: string, at: number) => `{"timestamp":"${new Date(at).toISOString()}","ordinal":1,"type":"event_msg","payload":{"type":"${kind}"`
    const subs = Array.from({ length: 48 }, (_, i) => ({ name: `rollout-sub${i}.jsonl`, size: 5_000, ageMs: 10_000 + i }))
    const asked = host(on, {
      logs: () => [...subs, { name: 'rollout-main.jsonl', size: 50_000, ageMs: 40_000 }],
      readLog: path =>
        path.includes('sub')
          ? `{"type":"session_meta","payload":{"thread_source":"subagent"}}\n${event('task_started', NOW - MIN)}`
          : `{"type":"session_meta","payload":{"thread_source":"user"}}\n${event('task_started', NOW - 5 * MIN)}`,
    })
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    await clock.advance(3 * MIN)
    const ui = await $.ui.mount({ plugin: 'usage-glance', surface: 'desktop', component: 'AbovePrompt', props })
    expect((await ui.findAll({ type: 'Text' })).some(t => t.text?.startsWith('Running'))).toBe(true)
    // Each subagent log is read once, not again every other minute.
    expect(asked.reads.length).toBeLessThanOrEqual(49)
  })

  test('a log caught with its first line half written is read whole again', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 1 }) as never)
    const event = (kind: string, at: number) => `{"timestamp":"${new Date(at).toISOString()}","ordinal":1,"type":"event_msg","payload":{"type":"${kind}"`
    let size = 0
    host(on, {
      logs: () => [{ name: 'rollout-sub.jsonl', size, ageMs: 5_000 }],
      // First scan: the file was just created and its first line is not written yet.
      readLog: () => (size === 0 ? '' : `{"type":"session_meta","payload":{"x":1,"thread_source":"subagent"}}\n${event('task_started', NOW - MIN)}`),
    })
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    size = 30_000
    await clock.advance(MIN)
    const ui = await $.ui.mount({ plugin: 'usage-glance', surface: 'desktop', component: 'AbovePrompt', props })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts.some(t => t.startsWith('Running'))).toBe(false)
  })

  const signedOutReply = JSON.stringify({ ok: false, error: 'codex account authentication required to read rate limits', account: null })

  test('signed out after use this week: a quiet note, and no more app-server spawns', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 1 }) as never)
    const asked = host(on, {
      codexReply: signedOutReply,
      isSignedIn: false,
      logs: () => [{ name: 'rollout-old.jsonl', size: 9_000, ageMs: 2 * 24 * HOUR }],
    })
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    expect(asked.codex).toBe(1)
    const ui = await $.ui.mount({ plugin: 'usage-glance', surface: 'desktop', component: 'AbovePrompt', props })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toContain('Signed out')
    expect(texts).not.toContain('! Not updating')
    await clock.advance(3 * HOUR)
    expect(asked.codex).toBe(1)
    // After 6 hours it looks again, with the quick `codex login status` only.
    await clock.advance(4 * HOUR)
    expect(asked.codex).toBe(1)
    expect(asked.login).toBe(1)
  })

  test('signed out and unused for long: Codex is hidden', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 1 }) as never)
    host(on, { codexReply: signedOutReply, isSignedIn: false, logs: () => [] })
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    const ui = await $.ui.mount({ plugin: 'usage-glance', surface: 'desktop', component: 'AbovePrompt', props })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).not.toContain('Codex')
    expect(texts).not.toContain('│')
  })

  test('a measurement with no new reply (the context alone) does not refresh the limits', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 1 }) as never)
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    host(on)
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    const measure = (pct: number, changed: string[]) =>
      $.session.measure({
        context: { tokens: 1_000, window: 200_000, percent: 1 },
        rateLimits: [
          { kind: 'five_hour', percentUsed: 10, resetsAt: new Date(NOW + 3 * HOUR).toISOString() },
          { kind: 'seven_day', percentUsed: pct, resetsAt: new Date(NOW + 11 * HOUR).toISOString() },
        ],
        changed,
      } as never)
    await measure(77, ['rateLimits'])
    await clock.advance(20 * MIN)
    // After /clear: only the context moved; the limits are the old reply's.
    await measure(77, ['context'])
    const ui = await $.ui.mount({ plugin: 'usage-glance', surface: 'desktop', component: 'AbovePrompt', props })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    // 20 minutes on, the reading is still the old one: "As of", not passed off as fresh.
    expect(texts.some(t => t.startsWith('As of'))).toBe(true)
  })

  test('signed out, then a session log is written: Codex is asked again within minutes', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    let size = 9_000
    let ageMs = 2 * 24 * HOUR
    const asked = host(on, {
      codexReply: signedOutReply,
      isSignedIn: false,
      logs: () => [{ name: 'rollout-a.jsonl', size, ageMs }],
      readLog: () => '',
    })
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    const before = asked.login
    // The person signs in and uses Codex: a log is written now.
    size = 20_000
    ageMs = 0
    await clock.advance(6 * MIN)
    expect(asked.login).toBeGreaterThan(before)
  })

  test('the desktop app reports a non-interactive session with no surfaces: drawing there still starts the work', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 1 }) as never)
    const asked = host(on, { surfaces: [] })
    await $.session.start({ cwd: '/w', surface: null, isInteractive: false } as never)
    await clock.advance(5 * MIN)
    expect(asked.codex).toBe(0)
    await $.ui.mount({ plugin: 'usage-glance', surface: 'desktop', component: 'AbovePrompt', props })
    await clock.advance(1_000)
    expect(asked.codex).toBe(1)
  })

  test('opened in a terminal only: no polling, no Codex, nothing spawned', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    const asked = host(on, { surfaces: ['terminal'] })
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    await clock.advance(30 * MIN)
    expect(asked.codex).toBe(0)
    expect(asked.authorize).toBe(0)
    expect(asked.reads).toEqual([])
  })

  test('Codex signed in with an API key: no plan limits, the group is hidden', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 1 }) as never)
    host(on, {
      codexReply: JSON.stringify({ ok: false, error: 'no ChatGPT plan', account: { type: 'apiKey', planType: null } }),
      logs: () => [{ name: 'rollout-a.jsonl', size: 9_000, ageMs: HOUR }],
      readLog: () => '',
    })
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    const ui = await $.ui.mount({ plugin: 'usage-glance', surface: 'desktop', component: 'AbovePrompt', props })
    expect(await ui.find({ type: 'Text', text: 'Codex' })).toBe(undefined)
  })

  test('Claude: right after a window resets, the plan usage is asked at once, not 10 minutes later', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    let resetAt = NOW + 3 * MIN
    const asked = host(on, {
      apiReply: () => ({
        five_hour: { utilization: 40, resets_at: new Date(resetAt).toISOString() },
        seven_day: { utilization: 60, resets_at: new Date(NOW + 3 * 24 * HOUR).toISOString() },
      }),
    })
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    expect(asked.api).toBe(1)
    resetAt = NOW + 5 * HOUR
    // The session window resets at +3 min; the next regular ask would be at +10 min.
    await clock.advance(4 * MIN)
    expect(asked.api).toBe(2)
  })

  test('Codex: right after a window resets, the limits are asked at once', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    const asked = host(on, {
      codexReply: JSON.stringify({
        ok: true,
        account: { type: 'chatgpt', planType: 'plus' },
        result: { rateLimits: { primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: Math.round((NOW + 3 * MIN) / 1000) }, secondary: null } },
      }),
    })
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    expect(asked.codex).toBe(1)
    await clock.advance(4 * MIN)
    expect(asked.codex).toBe(2)
  })

  test('Codex limit spent: asked every 5 minutes, so a reset pass shows soon', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    mock.store(on)
    const asked = host(on, {
      codexReply: JSON.stringify({
        ok: true,
        account: { type: 'chatgpt', planType: 'pro' },
        result: { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: Math.round((NOW + 2 * 24 * HOUR) / 1000) }, secondary: null } },
      }),
    })
    await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
    await clock.advance(1_000)
    expect(asked.codex).toBe(1)
    // Idle and unspent, the next ask would be in 30 minutes.
    await clock.advance(7 * MIN)
    expect(asked.codex).toBe(2)
  })

  test('yields the band to a survey', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 1 }) as never)
    const ui = await $.ui.mount({
      plugin: 'usage-glance',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: { hasSurvey: true, isWorking: false, maxRows: 12, bodyColumns: 95 } as never,
    })
    expect(await ui.find({ type: 'Text', text: 'Claude' })).toBe(undefined)
  })
})
