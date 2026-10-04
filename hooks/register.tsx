// usage-glance: Claude and Codex plan limits in one quiet line above the prompt of
// the Claude desktop app. Everything that talks to the engine lives in this module
// (the engine follows $ only into its own functions); what the band shows is decided
// in model.ts, replies are read in parse.ts, and state.ts holds what the session knows.
import { atom, read, update } from 'claude-code'
import type { Elements, Register, RenderElement } from 'claude-code'

import type { ClaudeReading, CodexAuth, CodexReading, CodexTask, LimitWindow, View } from '../types'

import { HOUR, MIN, WAKE_HOLD_MS, bandModel, clock, codexMode, countdown, floor, pad, pctShown } from './model'
import type { Slot, WindowModel } from './model'
import { parseClaudeUsage, parseCodexLimits, readingFromHeaders } from './parse'
import {
  EMPTY,
  RETRY_LATER_MS,
  apiKey,
  claudeKey,
  codexKey,
  codexStateKey,
  isAhead,
  isPastReset,
  retryAfter,
  rt,
  sameTasks,
  savedAt,
  withContext,
} from './state'
import type { ApiState, CodexState, Engine, ScanEntry } from './state'

// The engine reads which state a module uses from the module itself, so the atom is declared here.
const view = atom({ plugin: 'usage-glance', key: 'view' } as const, EMPTY)

// -----------------------------------------------------------------------------
// Constants

const TICK_MS = MIN
const CLAUDE_API_EVERY_MS = 10 * MIN
const CODEX_IDLE_EVERY_MS = 30 * MIN
const CODEX_ACTIVE_EVERY_MS = 5 * MIN
/** A plan with no limits (Enterprise, Free) has little to read: once an hour. */
const CLAUDE_API_NO_LIMITS_EVERY_MS = HOUR
/** A plan-usage request that cannot work (no login, refused) is tried again after this, or at the next session start. */
const STOPPED_RETRY_MS = 6 * HOUR
const CODEX_PROBE_EVERY_MS = 3 * HOUR
/** While Codex is hidden or signed out: how often to look again. */
const CODEX_HIDDEN_EVERY_MS = 6 * HOUR
const OFFSET_EVERY_MS = HOUR
/**
 * A task whose log has been silent this long no longer counts as running: a long
 * tool call can be quiet for minutes, a crashed task never writes its end.
 */
const RUNNING_QUIET_MS = 30 * MIN
/** How far back the start looks for the last use of Codex here: past the 7-day rule. */
const LOCAL_USE_LOOKBACK_MS = 8 * 24 * HOUR
/** No scan looks at more than this many session logs (those written in the last 30 minutes). */
const SCAN_READS = 24
/** A first line shorter than this was cut off mid-write: whether it is a subagent is not known yet. */
const HEAD_BYTES = 4000
/** Rereading a little before where the last read ended catches an event line written in two parts. */
const SCAN_OVERLAP = 8 * 1024
const LEASE_MS = MIN
/** Signed out but a session log was just written: look again this soon, at most. */
const CODEX_SIGNIN_RECHECK_MS = 5 * MIN
/** A cold read looks for the last task event in this much of the file's end first: under the 4 MiB a process read holds. */
const TAIL_BYTES = 3 * 1024 * 1024

const CLAUDE_USAGE_PAGE = 'https://claude.ai/settings/usage'
const CODEX_USAGE_PAGE = 'https://chatgpt.com/codex/settings/usage'

// --- cross-session store -----------------------------------------------------

/**
 * Claude keys are per account. With no account known they are kept in this
 * session only, never under a key another account could share.
 */
async function claudeGet($: Engine, key: string) {
  return rt.account ? $.store.get(key) : rt.memory.get(key)
}

async function claudeSet($: Engine, key: string, value: unknown) {
  if (rt.account) await $.store.set(key, value)
  else rt.memory.set(key, value)
}

/**
 * One session at a time does a shared ask; the lease expires by itself. The store
 * has no compare-and-set, so two sessions can, rarely, both ask: harmless.
 */
async function takeLease($: Engine, name: string) {
  const now = await $.clock.now()
  const held = (await $.store.get(`lease:${name}`)) as { owner: string; until: number } | undefined
  if (held && held.owner !== rt.owner && held.until > now && !isAhead(held.until, now, LEASE_MS)) return false
  await $.store.set(`lease:${name}`, { owner: rt.owner, until: now + LEASE_MS })
  await $.clock.sleep(30)
  const after = (await $.store.get(`lease:${name}`)) as { owner: string } | undefined
  return after?.owner === rt.owner
}

async function readCodexState($: Engine) {
  return ((await $.store.get(codexStateKey())) ?? { error: null }) as CodexState
}

/** Merges into the shared Codex state, so one write never drops another's fields. */
async function setCodexState($: Engine, patch: Partial<CodexState>) {
  await $.store.set(codexStateKey(), { ...(await readCodexState($)), ...patch })
}

async function holdsLease($: Engine, name: string) {
  const held = (await $.store.get(`lease:${name}`)) as { owner: string } | undefined
  return held?.owner === rt.owner
}

async function saveClaude($: Engine, reading: ClaudeReading) {
  const stored = (await claudeGet($, claudeKey())) as ClaudeReading | undefined
  if (!stored || savedAt(stored) < savedAt(reading) || isAhead(savedAt(stored), savedAt(reading)))
    await claudeSet($, claudeKey(), reading)
}

/** Takes whatever newer readings other sessions saved. */
async function adopt($: Engine) {
  const claude = (await claudeGet($, claudeKey())) as ClaudeReading | undefined
  const api = (await claudeGet($, apiKey())) as ApiState | undefined
  const codex = (await $.store.get(codexKey())) as CodexReading | undefined
  const codexState = (await $.store.get(codexStateKey())) as CodexState | undefined
  const v = await read($, view)
  const now = await $.clock.now()
  // Newer wins; a reading from ahead of the clock (it went back) neither wins nor holds.
  const newer = <T extends { takenAt: number; savedAt?: number }>(stored: T | undefined, mine: T | null) =>
    stored && !isAhead(savedAt(stored), now) && (!mine || savedAt(stored) > savedAt(mine) || isAhead(savedAt(mine), now))
      ? stored
      : mine
  const fresh = {
    claude: newer(claude, v.claude),
    claudeError: api ? api.error ?? null : v.claudeError,
    codex: newer(codex, v.codex),
    codexError: codexState ? codexState.error ?? null : v.codexError,
    hasClaudeTried: rt.hasClaudeTried,
    hasCodexTried: rt.hasCodexTried,
  }
  // Writing the same values would still redraw the band; skip it.
  const isSame = (Object.keys(fresh) as (keyof typeof fresh)[]).every(k => fresh[k] === v[k])
  if (!isSame) await update($, view, x => ({ ...x, ...fresh }))
}

// --- host facts --------------------------------------------------------------

/** Local UTC offset from the host clock, since the module has no time zone of its own. */
async function refreshOffset($: Engine) {
  rt.offsetAt = await $.clock.now()
  try {
    const z = (await $.process.run(['/bin/date', '+%z'], { timeoutMs: 3_000 })).stdout.trim()
    const m = /^([+-])(\d\d)(\d\d)$/.exec(z)
    if (m) rt.utcOffsetMin = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
  } catch {}
  if ((await read($, view)).utcOffsetMin !== rt.utcOffsetMin) await update($, view, v => ({ ...v, utcOffsetMin: rt.utcOffsetMin }))
}

/**
 * An app started from the Dock may have a short PATH: add the usual install places,
 * the Node version managers' included.
 */
async function setUpPath($: Engine) {
  rt.home = (await $.env.get('HOME')) ?? ''
  rt.codexHome = (await $.env.get('CODEX_HOME')) || `${rt.home}/.codex`
  const path = (await $.env.get('PATH')) ?? ''
  const home = rt.home
  const nvm = `${home}/.nvm/versions/node`
  const nvmBins = (await $.fs.exists(nvm))
    ? (await $.fs.list(nvm)).filter(d => d.kind === 'dir').map(d => `${nvm}/${d.name}/bin`).sort().reverse()
    : []
  const usual = ['/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/bin`, `${home}/.volta/bin`, `${home}/.asdf/shims`, `${home}/.bun/bin`, `${home}/.npm-global/bin`]
  const fnm = [`${home}/.local/share/fnm/aliases/default/bin`, `${home}/Library/Application Support/fnm/aliases/default/bin`]
  rt.pathEnv = [...new Set([...path.split(':'), ...usual, ...nvmBins, ...fnm])].filter(Boolean).join(':')
}

async function findOnPath($: Engine, name: string) {
  for (const dir of rt.pathEnv.split(':')) {
    if (dir && (await $.fs.exists(`${dir}/${name}`))) return `${dir}/${name}`
  }
  return ''
}

/**
 * Codex counts as installed when its home folder exists and both `codex` and `node`
 * (the helper is a node script) can be found. Anything less leaves the Codex group
 * out instead of showing a Codex that can never update.
 */
async function probeCodex($: Engine) {
  rt.codexProbedAt = await $.clock.now()
  rt.nodePath = await findOnPath($, 'node')
  rt.codexPath = await findOnPath($, 'codex')
  // Without the CLI, the Codex that ships inside the ChatGPT app.
  for (const app of ['/Applications', `${rt.home}/Applications`]) {
    const bundled = `${app}/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`
    if (!rt.codexPath && (await $.fs.exists(bundled))) rt.codexPath = bundled
  }
  // The log scan runs the macOS command-line tools; without them (Windows) Codex is left out.
  let hasTools = true
  for (const tool of ['/usr/bin/find', '/usr/bin/stat', '/usr/bin/head', '/usr/bin/tail', '/usr/bin/grep']) {
    if (!(await $.fs.exists(tool))) hasTools = false
  }
  rt.hasCodex =
    rt.setting !== 'never' && hasTools && !!rt.nodePath && !!rt.codexPath && (await $.fs.exists(rt.codexHome))
  // A Codex found is drawn once its mode is known (refreshCodexMode); one lost goes now.
  if (!rt.hasCodex) await refreshCodexMode($, rt.codexProbedAt)
}

/**
 * The Claude account, '' when signed out, or undefined when it cannot be told now:
 * the config file missing, caught mid-write, or too large to read (4 MiB). Not being
 * able to tell is not a change of account.
 */
async function findAccount($: Engine): Promise<string | undefined> {
  const fromEnv = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
  if (fromEnv) return fromEnv
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || rt.home
  try {
    const cfg = JSON.parse(await $.fs.read(`${dir}/.claude.json`)) as { oauthAccount?: { accountUuid?: string } }
    return cfg.oauthAccount?.accountUuid ?? ''
  } catch {
    return undefined
  }
}

// --- Claude: pushed by the engine --------------------------------------------

async function takeMeasure(
  $: Engine,
  m: {
    rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
    context: { tokens?: number; percent?: number }
    cost?: { usd: number }
    changed: readonly string[]
  },
) {
  // A window these headers leave out is kept from the newest reading any session saved.
  await adopt($)
  const now = await $.clock.now()
  // The rate limits ride on replies. A measurement with no new reply (the context
  // alone moved, as after /clear) repeats old ones: they must not pass for fresh.
  const isNewReply = m.changed.includes('rateLimits') || m.changed.includes('cost')
  let reading: ClaudeReading | null = null
  await update($, view, v => {
    reading = isNewReply ? readingFromHeaders(v.claude, m.rateLimits, now) : null
    return withContext({ ...v, claude: reading ?? v.claude, now }, m.context, m.cost?.usd)
  })
  if (reading) await saveClaude($, reading)
}

// --- Claude: the plan usage request the app itself makes ---------------------

async function fetchClaude($: Engine, isForced = false) {
  if (rt.isClaudeFetching) return
  rt.isClaudeFetching = true
  let now = 0
  let failures = 0
  // An answer belongs to the account that asked: if it changes meanwhile (a /login),
  // nothing of this request is written.
  const account = rt.account
  const setState = async (s: ApiState) => {
    if (rt.account === account) await claudeSet($, apiKey(), s)
  }
  const fail = async (status: string, error: string | null, wait?: number) => {
    rt.lastApiStatus = status
    failures += 1
    await setState({ error, failures, nextAt: now + (wait ?? retryAfter(failures)) })
  }
  try {
    now = await $.clock.now()
    const last = (await claudeGet($, claudeKey())) as ClaudeReading | undefined
    // By hand: not more than every 30 s, and never through a rate-limit wait.
    const state0 = ((await claudeGet($, apiKey())) ?? { error: null }) as ApiState
    if (isForced && last && now - last.takenAt < 30_000 && !isAhead(last.takenAt, now)) return
    if (isForced && state0.error === 'Rate limited' && (state0.nextAt ?? 0) > now) return
    // Right after a reset the old numbers are gone: ask at once, unless failures are
    // being waited out.
    const hasReset = isPastReset(last, now)
    const isDue = (s: ApiState) =>
      isForced ||
      ((s.stoppedAt === undefined || now - s.stoppedAt >= STOPPED_RETRY_MS || isAhead(s.stoppedAt, now)) &&
        ((s.nextAt ?? 0) <= now || isAhead(s.nextAt, now, 12 * HOUR) || (hasReset && !s.failures)))
    if (!isDue(state0)) return
    // While replies keep the reading fresh (their rate-limit headers), the plan-usage
    // endpoint has nothing to add but credits, which only it reports: ask it when the
    // reading has gone old, a window has reset, or while a limit is spent.
    const isSpent = [last?.fiveHour, last?.weekly].some(w => w && floor(w.percentUsed) >= 100)
    if (!isForced && !hasReset && last && now - last.takenAt < CLAUDE_API_EVERY_MS && !isAhead(last.takenAt, now) && !isSpent) return
    if (rt.account && !(await takeLease($, `claude-api:${rt.account}`))) return
    // Another session may have just asked: look again now that the lease is ours.
    const state = ((await claudeGet($, apiKey())) ?? { error: null }) as ApiState
    if (!isDue(state)) return
    failures = state.failures ?? 0
    const auth = await $.session.authorize()
    // Plan limits come with a claude.ai sign-in; an API key has none to read.
    if (auth?.kind !== 'bearer') {
      rt.lastApiStatus = auth ? 'signed in with an API key: no plan limits' : 'no first-party login'
      await setState({ error: null, stoppedAt: now })
      return
    }
    // A slow authorize can outlast the lease: send only while it is still ours.
    if (rt.account && !(await holdsLease($, `claude-api:${rt.account}`))) return
    const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
    })
    if (res.status === 401 || res.status === 403) {
      rt.lastApiStatus = `http ${res.status}: paused for 6 hours or until a new chat`
      await setState({ error: 'Sign in again', stoppedAt: now })
      return
    }
    if (res.status === 429) {
      const after = Number(res.headers['retry-after'])
      // A block can last an hour: 30 minutes the first time, an hour after that.
      const wait = Math.max(state.failures ? 2 * RETRY_LATER_MS : RETRY_LATER_MS, Number.isFinite(after) ? after * 1000 : 0)
      return await fail('http 429: backing off', 'Rate limited', wait)
    }
    if (!res.ok) return await fail(`http ${res.status}`, `HTTP ${res.status}`)
    let reading: ClaudeReading | null = null
    try {
      reading = parseClaudeUsage(JSON.parse(res.text), now)
    } catch {}
    if (!reading) return await fail('reply was not a usage reply', 'Unreadable reply')
    rt.lastApiStatus = `ok at ${clock(now, now, rt.utcOffsetMin)}`
    const every = reading.fiveHour || reading.weekly ? CLAUDE_API_EVERY_MS : CLAUDE_API_NO_LIMITS_EVERY_MS
    await setState({ error: null, nextAt: now + every + Math.round(Math.random() * 3 * MIN) })
    if (rt.account === account) await saveClaude($, reading)
  } catch (err) {
    // Offline, a timeout: wait like any other failure, never ask again every minute.
    try {
      await fail(`failed: ${(err as Error)?.message}`, 'Network error')
    } catch {}
  } finally {
    rt.isClaudeFetching = false
    rt.hasClaudeTried = true
    await adopt($).catch(() => {})
  }
}

// --- Codex: limits through the local app-server ------------------------------

async function fetchCodex($: Engine, isForced = false) {
  if (rt.isCodexFetching || !rt.hasCodex) return
  rt.isCodexFetching = true
  let now = 0
  let failures = 0
  const fail = async (error: string) => {
    rt.lastCodexStatus = error
    failures += 1
    await setCodexState($, { error, failures, nextAt: now + retryAfter(failures), attemptAt: now })
  }
  try {
    now = await $.clock.now()
    const isDue = (s: CodexState) => isForced || (s.nextAt ?? 0) <= now || isAhead(s.nextAt, now, 12 * HOUR)
    if (!isDue(await readCodexState($))) return
    if (!(await takeLease($, codexKey()))) return
    // Another session may have just asked: look again now that the lease is ours.
    const state = await readCodexState($)
    const last = (await $.store.get(codexKey())) as CodexReading | undefined
    const recent = last && !isAhead(last.takenAt, now) ? now - last.takenAt : Infinity
    if (!isDue(state) || recent < (isForced ? 30_000 : MIN)) return
    failures = state.failures ?? 0
    const run = await $.process.run([rt.nodePath, `${$.plugin.root}/bin/codex-limits.mjs`, rt.codexPath], {
      env: { PATH: rt.pathEnv },
      timeoutMs: 15_000,
    })
    let out: { ok: boolean; error?: string; result?: unknown; account?: { type?: string } | null; requiresOpenaiAuth?: boolean | null }
    try {
      out = JSON.parse(run.stdout.trim().split('\n').pop() ?? '')
    } catch {
      out = { ok: false, error: run.stderr.slice(0, 200) || 'no reply' }
    }
    if (!out.ok && /^cannot start codex/.test(out.error ?? '')) {
      // Found on PATH but cannot run (a broken install): treat as no Codex until the next probe.
      rt.lastCodexStatus = out.error ?? ''
      rt.hasCodex = false
      rt.codexProbedAt = now
      return
    }
    // No account: signed out, unless Codex needs no OpenAI sign-in at all (a custom
    // provider). Any account but ChatGPT (an API key, Bedrock) has no plan limits.
    const type = out.account?.type
    let auth: CodexAuth | undefined =
      out.account === null
        ? out.requiresOpenaiAuth === false
          ? 'apiKey'
          : 'none'
        : type === 'chatgpt' || type === 'chatgptAuthTokens'
          ? 'chatgpt'
          : type
            ? 'apiKey'
            : undefined
    if (!out.ok && auth === undefined && /authentication required|not logged in|sign in/i.test(out.error ?? '')) auth = 'none'
    // Not a failure to retry: there is nothing to read until the sign-in changes.
    if (auth === 'none' || auth === 'apiKey') {
      rt.lastCodexStatus = auth === 'none' ? 'signed out' : 'signed in without a ChatGPT plan: no plan limits'
      await setCodexState($, { auth, error: null, failures: 0, nextAt: 0, attemptAt: now })
      return
    }
    if (!out.ok) return await fail(out.error ?? 'failed')
    const reading = parseCodexLimits(out.result, now)
    if (!reading) return await fail('unreadable reply')
    rt.lastCodexStatus = `ok at ${clock(now, now, rt.utcOffsetMin)}`
    await $.store.set(codexKey(), reading)
    await setCodexState($, { auth: auth ?? 'chatgpt', error: null, failures: 0, nextAt: 0, attemptAt: now })
  } catch (err) {
    try {
      await fail(`failed: ${(err as Error)?.message}`)
    } catch {}
  } finally {
    rt.isCodexFetching = false
    rt.hasCodexTried = true
    await adopt($).catch(() => {})
    // What the answer said (signed out, an API key, 0% or not, a broken install) shows
    // at once, not at the next tick.
    await refreshCodexMode($, now || (await $.clock.now())).catch(() => {})
  }
}

/**
 * `codex login status`: a quick answer (no app-server) to whether Codex is signed in,
 * for looking again while it is signed out. Undefined when it cannot tell.
 */
async function checkLogin($: Engine): Promise<CodexAuth | undefined> {
  try {
    const run = await $.process.run([rt.codexPath, 'login', 'status'], { env: { PATH: rt.pathEnv }, timeoutMs: 10_000 })
    const text = `${run.stdout}\n${run.stderr}`
    if (/not logged in/i.test(text)) return 'none'
    if (run.exitCode === 0) return /api key/i.test(text) ? 'apiKey' : 'chatgpt'
  } catch {}
  return undefined
}

/** Signed out, or hidden: look again every 6 hours, cheaply first. */
async function recheckQuietCodex($: Engine, now: number) {
  await setCodexState($, { attemptAt: now })
  const auth = await checkLogin($)
  if (auth === undefined) return
  await setCodexState($, { auth })
  // Signed in with ChatGPT: the limits say whether it is in use elsewhere.
  if (auth === 'chatgpt') await fetchCodex($, true)
}

/**
 * Whether the Codex group shows, written in one go with whether Codex is here at all,
 * so a Codex that is to stay hidden never shows for a moment first.
 */
async function refreshCodexMode($: Engine, now: number) {
  const v = await read($, view)
  let mode = v.codexMode
  if (rt.hasCodex) {
    const state = await readCodexState($)
    mode = codexMode({
      setting: rt.setting,
      auth: state.auth,
      reading: v.codex,
      // Not known yet is not "unused for a week": nothing is hidden on a guess.
      lastLocalUseAt: rt.isLastUseKnown ? rt.lastLocalUseAt : now,
      visibleUntil: isAhead(state.visibleUntil, now, WAKE_HOLD_MS) ? 0 : state.visibleUntil ?? 0,
      now,
    })
    // Back from hidden: hold it a day, so a quiet spell or a reset does not flap it.
    if (v.codexMode === 'hidden' && mode === 'show') await setCodexState($, { visibleUntil: now + WAKE_HOLD_MS })
  }
  if (mode === v.codexMode && rt.hasCodex === v.hasCodex) return
  await update($, view, x => ({ ...x, codexMode: mode, hasCodex: rt.hasCodex }))
}

// --- Codex: tasks in progress, from its session logs -------------------------

/**
 * `stat` lines, in `format`, for the session logs written in the last `ms`, from
 * anywhere under sessions/: a resumed old conversation keeps writing the file of the
 * day it began. Each tool is run directly with its arguments, never through a shell.
 */
async function statRollouts($: Engine, ms: number, format: string) {
  const run = await $.process.run(
    [
      '/usr/bin/find',
      `${rt.codexHome}/sessions`,
      '-name',
      'rollout-*.jsonl',
      '-mmin',
      `-${Math.ceil(ms / MIN)}`,
      '-exec',
      '/usr/bin/stat',
      '-f',
      format,
      '{}',
      '+',
    ],
    { timeoutMs: 10_000 },
  )
  return run.stdout.split('\n')
}

/** The session logs written in the last `ms`, newest first. */
async function findRollouts($: Engine, ms: number) {
  const files: { path: string; mtimeMs: number; size: number }[] = []
  for (const line of await statRollouts($, ms, '%m %z %N')) {
    const m = /^(\d+) (\d+) (.+)$/.exec(line)
    if (m) files.push({ mtimeMs: Number(m[1]) * 1000, size: Number(m[2]), path: m[3]! })
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** The newest session-log write in the last `ms`, or 0. */
async function newestRollout($: Engine, ms: number) {
  let newest = 0
  for (const line of await statRollouts($, ms, '%m')) {
    const sec = Number(line)
    if (line && Number.isFinite(sec) && sec * 1000 > newest) newest = sec * 1000
  }
  return newest
}

/** A task event line, as grep finds it in a whole file and as the scan reads it from a part. */
const TASK_EVENTS = '^\\{"timestamp":"[^"]+",[^{]{0,200}\\{"type":"(task_started|task_complete|turn_aborted)"'
const TASK_EVENT_LINE = new RegExp(TASK_EVENTS, 'gm')

/** Applies the task events found in `text`, in order, to `entry`. */
function applyEvents(entry: ScanEntry, text: string) {
  for (const m of text.matchAll(TASK_EVENT_LINE)) {
    entry.lastKind = m[1]!
    if (m[1] === 'task_started') entry.startedAt = Date.parse(/"timestamp":"([^"]+)"/.exec(m[0])?.[1] ?? '')
  }
}

/**
 * The last task events of a whole file: from its end first, and the whole file only
 * when the end has none (session logs reach hundreds of MB).
 */
async function readLastEvents($: Engine, path: string, entry: ScanEntry) {
  const end = await $.process.run(['/usr/bin/tail', '-c', String(TAIL_BYTES), path], { timeoutMs: 5_000 })
  const before = entry.lastKind
  entry.lastKind = ''
  applyEvents(entry, end.stdout)
  if (entry.lastKind) return
  const all = await $.process.run(['/usr/bin/grep', '-o', '-E', TASK_EVENTS, path], { timeoutMs: 5_000 })
  applyEvents(entry, all.stdout)
  if (!entry.lastKind) entry.lastKind = before
}

/**
 * Reads a session file's task events from byte `from` on: the whole file the first
 * time (with its first line, which tells a subagent apart), then only what was added.
 */
async function readEvents($: Engine, path: string, from: number, prev: ScanEntry): Promise<ScanEntry> {
  const entry = { ...prev }
  if (from > 0) {
    const added = await $.process.run(['/usr/bin/tail', '-c', `+${from + 1}`, path], { timeoutMs: 5_000 })
    // Grown by more than one read holds: the end is what counts, read as a whole file's.
    if (added.isStdoutTruncated) await readLastEvents($, path, entry)
    else applyEvents(entry, added.stdout)
    return entry
  }
  const head = (await $.process.run(['/usr/bin/head', '-c', String(HEAD_BYTES), path], { timeoutMs: 5_000 })).stdout
  // A subagent a Codex task spawned is part of that task, not a task of its own. The
  // first line can be caught half written; it is read again until it is whole.
  entry.isSubagent = /"thread_source":"subagent"/.test(head)
  entry.isHeadKnown = entry.isSubagent || head.includes('\n') || head.length >= HEAD_BYTES
  if (!entry.isSubagent) await readLastEvents($, path, entry)
  return entry
}

/** The Codex tasks running now; null while an earlier scan is still going. */
async function scanCodex($: Engine): Promise<{ newest: number; tasks: CodexTask[] } | null> {
  if (rt.isScanning) return null
  rt.isScanning = true
  try {
    const files = await findRollouts($, RUNNING_QUIET_MS)
    // Logs already known to be subagents' go last, so they never crowd out a main one.
    const isSub = (path: string) => rt.scanCache.get(path)?.isSubagent === true
    const recent = [...files.filter(f => !isSub(f.path)), ...files.filter(f => isSub(f.path))].slice(0, SCAN_READS)
    const cache = new Map<string, ScanEntry>()
    const tasks: CodexTask[] = []
    for (const f of recent) {
      const prev = rt.scanCache.get(f.path)
      let entry: ScanEntry
      if (prev && f.size === prev.size && f.mtimeMs === prev.mtimeMs) entry = prev
      // New, replaced, shrunk, or its first line still half written: read it whole.
      else if (!prev || !prev.isHeadKnown || f.size <= prev.size)
        entry = await readEvents($, f.path, 0, { size: 0, mtimeMs: 0, lastKind: '', startedAt: NaN, isSubagent: false, isHeadKnown: false })
      else entry = await readEvents($, f.path, Math.max(1, prev.size - SCAN_OVERLAP), prev)
      entry.size = f.size
      entry.mtimeMs = f.mtimeMs
      cache.set(f.path, entry)
      if (entry.isSubagent) continue
      if (entry.lastKind === 'task_started' && Number.isFinite(entry.startedAt)) tasks.push({ startedAt: entry.startedAt })
    }
    // A log known to be a subagent's stays known while it is still being written, read
    // this round or not: otherwise many subagents would take turns pushing each other
    // back into the reads and crowd out the task that spawned them.
    for (const f of files) {
      const prev = rt.scanCache.get(f.path)
      if (prev?.isSubagent && !cache.has(f.path)) cache.set(f.path, prev)
    }
    // Only files still being written stay cached; one that wakes up again is read whole.
    rt.scanCache = cache
    return { newest: files[0]?.mtimeMs ?? 0, tasks }
  } finally {
    rt.isScanning = false
  }
}

/**
 * One session scans for all: the result is shared through the store for a little
 * under a minute, so ten open sessions do not scan ten times.
 */
async function sharedScan($: Engine, now: number): Promise<{ newest: number; tasks: CodexTask[] } | null> {
  const key = `codex-scan:${rt.codexHome}`
  const shared = (await $.store.get(key)) as { at: number; newest: number; tasks: CodexTask[] } | undefined
  if (shared && now - shared.at < 50_000 && !isAhead(shared.at, now)) return shared
  if (!(await takeLease($, key))) return shared ?? null
  const scan = await scanCodex($)
  if (scan) await $.store.set(key, { at: now, ...scan })
  return scan
}

// --- the minute tick ---------------------------------------------------------

/** A failure goes to the debug log (`claude --debug`), never to the transcript. */
function logFailure($: Engine, where: string, err: unknown) {
  $.ui.log(`${where} failed: ${(err as Error)?.message ?? err}`, { to: 'debug' })
}

/** The minute timer; a failure is logged, never swallowed. */
async function safeTick($: Engine) {
  try {
    await tick($)
  } catch (err) {
    logFailure($, 'tick', err)
  }
}

async function tick($: Engine) {
  // Nothing is drawn outside the desktop app (a terminal, an IDE, a -p run): no work
  // either. Checked every minute, since the app can attach to a session later.
  if (!rt.isOnDesktop) {
    rt.isOnDesktop = (await $.session.surfaces()).includes('desktop')
    if (!rt.isOnDesktop) return
  }
  if (!rt.isSetUp) await setUp($)
  const now = await $.clock.now()
  // Redraw for the countdowns first, whatever fails below.
  await update($, view, x => ({ ...x, now }))
  if (now - rt.offsetAt >= OFFSET_EVERY_MS) await refreshOffset($)
  if (now - rt.accountAt >= OFFSET_EVERY_MS) await refreshAccount($)
  try {
    // Context and cost move during a long turn; session.measure only lands when it ends.
    // The rate limits are left alone: their age decides "As of".
    const usage = await $.session.usage()
    const cur = await read($, view)
    const next = withContext(cur, usage.context, usage.cost?.usd)
    // Every write redraws the band: write only what changed.
    const isSame =
      next.contextPercent === cur.contextPercent &&
      next.contextTokens === cur.contextTokens &&
      next.isContextShown === cur.isContextShown &&
      next.costUsd === cur.costUsd
    if (!isSame) await update($, view, x => withContext(x, usage.context, usage.cost?.usd))
  } catch (err) {
    logFailure($, 'reading the session usage', err)
  }
  await adopt($)
  void fetchClaude($)
  await tickCodex($, now)
}

/**
 * The minute's Codex work: the log scan, whether to show Codex, and whether to ask
 * for its limits now.
 */
async function tickCodex($: Engine, now: number) {
  if (!rt.hasCodex && now - rt.codexProbedAt >= CODEX_PROBE_EVERY_MS) await setUpCodex($)
  if (!rt.hasCodex) return
  if (!rt.isLastUseKnown) await lookBack($)
  // A scan that fails (a timeout) must not stop the limits from refreshing below.
  const scan = await sharedScan($, now).catch(() => null)
  const v = await read($, view)
  const wasRunning = v.codexTasks.length > 0
  if (scan) {
    rt.lastLocalUseAt = Math.max(rt.lastLocalUseAt, scan.newest)
    if (!sameTasks(scan.tasks, v.codexTasks)) await update($, view, x => ({ ...x, codexTasks: scan.tasks }))
  }
  await refreshCodexMode($, now)
  const state = await readCodexState($)
  const mode = (await read($, view)).codexMode
  if (state.auth === 'none' || mode !== 'show') {
    // A new session-log write means Codex is in use: signed out, it was signed in to
    // write it; hidden for a reply with no windows, that reply may have been a passing
    // one. Look again soon, not in 6 hours. A write seen during the wait still counts
    // once the wait is over. An API key has no plan limits to wait for.
    const isActive = !!scan && scan.newest > rt.lastCodexSeenMtime
    const since = isAhead(state.attemptAt, now) ? Infinity : now - (state.attemptAt ?? 0)
    if (since >= CODEX_HIDDEN_EVERY_MS || (isActive && state.auth !== 'apiKey' && since >= CODEX_SIGNIN_RECHECK_MS)) {
      if (scan) rt.lastCodexSeenMtime = Math.max(rt.lastCodexSeenMtime, scan.newest)
      void recheckQuietCodex($, now).then(() => refreshCodexMode($, now))
    }
    return
  }
  // Without a scan (it failed, or another session's is not in yet) there is no news of
  // activity, but the reading still ages, resets and can be spent.
  const codexAge = v.codex && !isAhead(v.codex.takenAt, now) ? now - v.codex.takenAt : Infinity
  const hasNewActivity = !!scan && scan.newest > rt.lastCodexSeenMtime
  // A running task writes its log every minute; ask at most every 5 min meanwhile,
  // then once as soon as it finishes.
  const isFinished = !!scan && wasRunning && scan.tasks.length === 0
  const isActiveDue = hasNewActivity && codexAge > CODEX_ACTIVE_EVERY_MS
  // A spent limit can come back early (a reset pass used in the Codex app): look often.
  const isSpent = [v.codex?.fiveHour, v.codex?.weekly].some(w => w && floor(w.percentUsed) >= 100)
  const isSpentDue = isSpent && codexAge > CODEX_ACTIVE_EVERY_MS
  if (isActiveDue || isSpentDue || isFinished || codexAge > CODEX_IDLE_EVERY_MS || isPastReset(v.codex, now)) {
    if (scan) rt.lastCodexSeenMtime = scan.newest
    void fetchCodex($)
  }
}

// --- starting up -------------------------------------------------------------

/** Re-reads the Claude account: a /login to another account must not mix two accounts' readings. */
async function refreshAccount($: Engine) {
  rt.accountAt = await $.clock.now()
  const account = await findAccount($)
  if (account === undefined || account === rt.account) return
  rt.account = account
  await update($, view, v => ({ ...v, claude: null, claudeError: null }))
  await adopt($)
}

/** What only the desktop app needs: host probes, Codex, the first readings. */
async function setUp($: Engine) {
  rt.isSetUp = true
  await refreshOffset($)
  await setUpCodex($)
}

/** The last use of Codex here, back past the 7-day rule; a find that times out is tried again next minute. */
async function lookBack($: Engine) {
  try {
    rt.lastLocalUseAt = Math.max(rt.lastLocalUseAt, await newestRollout($, LOCAL_USE_LOOKBACK_MS))
    rt.isLastUseKnown = true
  } catch {}
}

/** Is Codex installed, signed in, used here? */
async function setUpCodex($: Engine) {
  await probeCodex($)
  if (!rt.hasCodex) return
  const now = await $.clock.now()
  await lookBack($)
  // A new session looks again at a signed-out Codex: the person may have signed in.
  if ((await readCodexState($)).auth === 'none') {
    const auth = await checkLogin($)
    if (auth) await setCodexState($, { auth, attemptAt: now })
  }
  await refreshCodexMode($, now)
}

async function start($: Engine) {
  await setUpPath($)
  rt.account = (await findAccount($)) ?? rt.account
  rt.accountAt = await $.clock.now()
  rt.isSetUp = false
  // A new session tries a stopped plan-usage request again: the person may have signed in since.
  const api = (await claudeGet($, apiKey())) as ApiState | undefined
  if (api?.stoppedAt !== undefined) await claudeSet($, apiKey(), { error: api.error })
  const now = await $.clock.now()
  const usage = await $.session.usage()
  await update($, view, v => withContext({ ...v, now }, usage.context, usage.cost?.usd))
  await adopt($)
  // The engine's snapshot holds the limits of whichever reply came last, maybe long
  // ago: shown only while nothing better is stored, dated to the session's start so it
  // reads "As of", and never saved.
  if (!(await read($, view)).claude) {
    const r = readingFromHeaders(null, usage.rateLimits, usage.startedAt)
    if (r) await update($, view, v => (v.claude ? v : { ...v, claude: r }))
  }
  rt.tickTimer?.cancel()
  rt.tickTimer = $.clock.every(TICK_MS, () => void safeTick($))
  // Drawing may not write state: the tick a draw asks for runs just after it.
  rt.kick = () => void $.clock.after(0, () => void safeTick($))
  rt.isStarted = true
  void safeTick($)
}

// --- /usage-glance -----------------------------------------------------------

/**
 * What /usage-glance prints: the numbers, then what a bug report needs. No account
 * ids, and the home folder written as ~.
 */
async function report($: Engine) {
  const v = await read($, view)
  const now = await $.clock.now()
  const at = (t: number) => clock(t, now, v.utcOffsetMin)
  const age = (t: number | undefined) => (!t ? 'none' : now - t < MIN ? 'just taken' : `${countdown(now - t)} old`)
  const line = (name: string, w?: LimitWindow) =>
    w ? `${name} ${pctShown(w.percentUsed)}%${w.resetsAt ? `, resets ${at(w.resetsAt)}` : ''}` : `${name} —`
  let version = '?'
  try {
    version = (JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }).version ?? '?'
  } catch {}
  const engine = await $.session
    .version()
    .then(x => x.version)
    .catch(() => '?')
  const api = ((await claudeGet($, apiKey())) ?? { error: null }) as ApiState
  const auth = (await readCodexState($)).auth ?? '?'
  const off = Math.abs(v.utcOffsetMin)
  const zone = `UTC${v.utcOffsetMin < 0 ? '-' : '+'}${pad(Math.floor(off / 60))}:${pad(off % 60)}`
  const codexAt = !rt.codexPath ? 'not found' : rt.codexPath.includes('/ChatGPT.app/') ? 'in the ChatGPT app' : 'on PATH'
  // Why there is no Codex group: the first thing it needs that is missing.
  const missing =
    rt.setting === 'never'
      ? 'turned off in the settings'
      : !rt.codexPath
        ? 'not found on this machine'
        : !rt.nodePath
          ? 'found, but not node, which reads its limits'
          : !(await $.fs.exists(rt.codexHome))
            ? 'found, but not its folder (never run, or CODEX_HOME points elsewhere)'
            : 'found, but not the macOS command-line tools it needs'
  const codexLine = !v.hasCodex
    ? missing
    : [
        line('5h', v.codex?.fiveHour),
        line(v.codex?.weeklyLabel ?? 'Weekly', v.codex?.weekly),
        ...(v.codexTasks.length ? [`${v.codexTasks.length} running`] : []),
        ...(v.codexMode === 'signedOut' ? ['signed out'] : []),
        ...(v.codexMode === 'hidden' ? ['hidden on the band: signed out, no ChatGPT plan, or unused here for a week'] : []),
      ].join(' · ')
  const text = [
    `Claude  ${line('Session', v.claude?.fiveHour)} · ${line('Weekly', v.claude?.weekly)}${
      v.costUsd !== null ? ` · this chat ~$${v.costUsd.toFixed(2)} at API prices` : ''
    }`,
    `Codex   ${codexLine}`,
    `Usage pages: ${CLAUDE_USAGE_PAGE} · ${CODEX_USAGE_PAGE}`,
    '',
    'For a bug report, include these lines:',
    `  usage-glance ${version} · Claude Code ${engine} · desktop ${rt.isOnDesktop ? 'yes' : 'no'} · ${zone}`,
    `  Claude: reading ${age(v.claude?.takenAt)} · plan usage ${rt.lastApiStatus}${api.failures ? ` (${api.failures} failures)` : ''}${
      api.nextAt && api.nextAt > now ? ` · next ask ${at(api.nextAt)}` : ''
    } · account ${rt.account ? 'known' : 'unknown'}`,
    `  Codex: ${
      rt.hasCodex ? `signed in: ${auth} · reading ${age(v.codex?.takenAt)} · request ${rt.lastCodexStatus} · ` : ''
    }codex ${codexAt} · node ${rt.nodePath ? 'found' : 'not found'} · CODEX_HOME ${
      rt.codexHome === `${rt.home}/.codex` ? 'default' : 'custom'
    } · setting ${rt.setting}`,
  ].join('\n')
  return rt.home ? text.split(rt.home).join('~') : text
}

// --- drawing -----------------------------------------------------------------

/**
 * The line itself, from the view and the desktop app's elements: no engine calls, so
 * the render hook reads what it needs and hands it over. `theirs` is what the mods
 * beneath drew in the band, if anything.
 */
function drawBand(ui: Elements['desktop'], v: View, bodyColumns: number, theirs: RenderElement) {
  const { Box, Text, Svg } = ui
  const m = bandModel(v, bodyColumns)

  const bar = (w: WindowModel, px: number) => {
    const pct = w.percentUsed === null ? 0 : Math.min(100, Math.max(0, w.percentUsed))
    const fill = pct > 0 ? Math.max((pct / 100) * px, 6) : 0
    const tickX = w.elapsed === null ? null : Math.min(px - 1, Math.max(1, w.elapsed * px))
    const track = w.level === 'none' ? 'z' : w.level === 'warn' ? 'tw' : w.level === 'full' ? 'tf' : 't'
    const ink = w.level === 'warn' ? 'fw' : w.level === 'full' ? 'ff' : 'f'
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="12" viewBox="0 0 ${px} 12">
<style>.t{fill:#D6E4F7}.f{fill:#3B7DD8}.tw{fill:#F7E0B0}.fw{fill:#EFA530}.tf{fill:#F6D5D5}.ff{fill:#D64545}.z{fill:#E4E1DA}.k{fill:#24221F;opacity:.5}
@media (prefers-color-scheme:dark){.t{fill:#1E3654}.f{fill:#5B9BEA}.tw{fill:#4A3613}.fw{fill:#F0B04A}.tf{fill:#4A1E1E}.ff{fill:#EF6B6B}.z{fill:#3A3833}.k{fill:#ECEAE4}}</style>
<rect class="${track}" x="0" y="3" width="${px}" height="6" rx="3"/>
${fill > 0 ? `<rect class="${ink}" x="0" y="3" width="${fill.toFixed(1)}" height="6" rx="3"/>` : ''}
${tickX !== null ? `<rect class="k" x="${(tickX - 0.75).toFixed(2)}" y="0" width="1.5" height="12" rx="0.75"/>` : ''}
</svg>`
    const alt =
      w.percentUsed === null
        ? 'no reading yet'
        : `${pctShown(w.percentUsed)}% used${w.elapsed !== null ? `, ${Math.round(w.elapsed * 100)}% of the window has passed` : ''}`
    return <Svg source={source} alt={alt} width={px} height={12} />
  }

  const windowEl = (w: WindowModel) =>
    w.isNote ? (
      <Text dimColor>{w.pctText}</Text>
    ) : (
      <Box flexDirection="row" alignItems="center" columnGap={1} flexGrow={0} flexShrink={0}>
        {w.label ? <Text dimColor>{w.label}</Text> : null}
        {m.tier.barPx ? bar(w, m.tier.barPx) : null}
        {/* Percentages stay black; the bar carries the warning. A spent limit reads
            "Limit reached" in red, since it is blocking, not a number. */}
        {w.level === 'full' ? (
          <Text bold color="error">
            {w.pctText}
          </Text>
        ) : w.isStale || w.level === 'none' ? (
          // An old reading, or none yet: dim, so it does not pass for a live number.
          <Text bold dimColor>
            {w.pctText}
          </Text>
        ) : (
          <Text bold>{w.pctText}</Text>
        )}
        {w.reset ? <Text dimColor>{w.reset}</Text> : null}
      </Box>
    )

  const slotEl = (slot: Slot | null) =>
    !slot ? null : slot.tone === 'warn' ? <Text color="warning">{slot.text}</Text> : <Text dimColor>{slot.text}</Text>

  // Claude alone on two lines: its numbers, then its cost and statuses under them.
  const isSplit = !!m.isTwoLine && !m.codex
  const claudeHead = (
    <Box flexDirection="row" alignItems="center" columnGap={2} flexGrow={0} flexShrink={0}>
      {/* The name sits one gap from its window, as close as the window's own parts. */}
      <Box flexDirection="row" alignItems="center" columnGap={1} flexGrow={0} flexShrink={0}>
        <Text>Claude</Text>
        {m.claude.session ? windowEl(m.claude.session) : m.claude.window ? windowEl(m.claude.window) : null}
      </Box>
      {m.claude.session && m.claude.window ? windowEl(m.claude.window) : null}
    </Box>
  )
  const c = m.claude
  const claudeTail = (
    <Box flexDirection="row" alignItems="center" columnGap={2} flexGrow={0} flexShrink={0}>
      {c.cost ? <Text dimColor>{c.cost}</Text> : null}
      {c.context && (c.cost || !isSplit) ? <Text dimColor>·</Text> : null}
      {slotEl(c.context)}
      {c.slot && (c.cost || c.context || !isSplit) ? <Text dimColor>·</Text> : null}
      {slotEl(c.slot)}
    </Box>
  )
  const hasTail = !!(c.cost || c.context || c.slot)
  const claudeGroup = (
    <Box
      flexDirection={isSplit ? 'column' : 'row'}
      alignItems={isSplit ? 'flex-start' : 'center'}
      columnGap={2}
      flexGrow={0}
      flexShrink={0}
    >
      {claudeHead}
      {hasTail ? claudeTail : null}
    </Box>
  )
  // With no other mod in the band, next(e) is the engine's empty placeholder; stacking
  // it under our line would leave a blank row.
  const hasTheirs = !!theirs && theirs.type !== 'engine'
  const band = (
    // The desktop app gives row children equal shares unless told otherwise, which
    // split the band in halves and wrapped the text; every group keeps its own width.
    <Box
      flexDirection={m.isTwoLine ? 'column' : 'row'}
      alignItems={m.isTwoLine ? 'flex-start' : 'center'}
      justifyContent="flex-start"
      columnGap={4}
      paddingX={1}
    >
      {claudeGroup}
      {/* A 1-px Svg with an empty alt was not drawn on the desktop app; a dim glyph is. */}
      {m.codex && !m.isTwoLine ? <Text dimColor>│</Text> : null}
      {m.codex ? (
        <Box flexDirection="row" alignItems="center" columnGap={2} flexGrow={0} flexShrink={0}>
          <Box flexDirection="row" alignItems="center" columnGap={1} flexGrow={0} flexShrink={0}>
            <Text>Codex</Text>
            {windowEl(m.codex.window)}
          </Box>
          {slotEl(m.codex.slot)}
        </Box>
      ) : null}
    </Box>
  )
  return hasTheirs ? (
    <Box flexDirection="column" rowGap={1}>
      {band}
      {theirs}
    </Box>
  ) : (
    band
  )
}

// -----------------------------------------------------------------------------
// The module

export const register: Register = (on, options) => {
  rt.setting = options.codex === 'always' || options.codex === 'never' ? options.codex : 'auto'

  // --- events ----------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await $.command.register({
        name: 'usage-glance',
        description: 'Refresh the usage band and print its numbers',
        immediate: true,
      })
      await start($)
    } catch (err) {
      logFailure($, 'starting', err)
    }
    return started
  })

  // /clear, /resume and /branch reset $.state without a new session.start.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    const done = await next(e)
    try {
      // A reload fires session.start again; this covers a host that would not.
      if (!rt.isStarted) await start($)
      await refreshAccount($)
      const usage = await $.session.usage()
      const now = await $.clock.now()
      await update($, view, () =>
        withContext({ ...EMPTY, utcOffsetMin: rt.utcOffsetMin, now }, usage.context, usage.cost?.usd),
      )
      await adopt($)
      await refreshCodexMode($, now)
    } catch (err) {
      logFailure($, 'starting over after /clear, /resume or /branch', err)
    }
    return done
  })

  on('session.measure', async ($, e, next) => {
    try {
      await takeMeasure($, e)
    } catch (err) {
      logFailure($, 'reading a measurement', err)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, view, v => ({ ...v, lastTurnAt: now, now }))
    return next(e)
  })

  on('command.run', { command: 'usage-glance' }, async $ => {
    if (!rt.isStarted) await start($)
    // Asked for by hand, so it answers anywhere, the terminal included.
    if (!rt.isSetUp) await setUp($)
    await Promise.all([fetchClaude($, true), fetchCodex($, true)])
    return { text: await report($) }
  })

  // --- drawing -----------------------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)
    if (!rt.isOnDesktop) {
      // Drawn on the desktop app: the minute work can start now, not at the next tick.
      rt.isOnDesktop = true
      rt.kick?.()
    }
    try {
      // Countdowns use the time of this draw, not the last tick's.
      const v: View = { ...(await read($, view)), now: await $.clock.now() }
      const ui = $.ui.resolve(e)
      return drawBand(ui, v, e.props.bodyColumns, await next(e))
    } catch (err) {
      logFailure($, 'drawing the band', err)
      return next(e)
    }
  })
}
