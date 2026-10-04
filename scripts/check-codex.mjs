// Checks, without a sign-in, that the installed Codex still has what usage-glance
// relies on: the app-server methods and reply fields the helper reads, and the
// session-log event names the Running status looks for (that format is not
// documented, so the strings in the binary are the only early warning).
// Usage: node scripts/check-codex.mjs <schema dir from `codex app-server generate-json-schema`>
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

const dir = process.argv[2]
let failed = false
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failed = true
}
const json = file => JSON.parse(readFileSync(join(dir, file), 'utf8'))
const props = (schema, name) => Object.keys((name ? schema.definitions?.[name] : schema)?.properties ?? {})
const has = (list, keys) => keys.every(k => list.includes(k))

const requests = readFileSync(join(dir, 'ClientRequest.json'), 'utf8')
for (const m of ['initialize', 'account/read', 'account/rateLimits/read']) check(requests.includes(`"${m}"`), `request ${m}`)

const account = json('v2/GetAccountResponse.json')
check(has(props(account), ['account', 'requiresOpenaiAuth']), 'account/read: account, requiresOpenaiAuth')
check(JSON.stringify(account.definitions?.Account ?? {}).includes('"chatgpt"'), 'account/read: an account of type chatgpt')

const limits = json('v2/GetAccountRateLimitsResponse.json')
check(has(props(limits), ['rateLimits', 'rateLimitsByLimitId', 'rateLimitResetCredits']), 'rateLimits/read: rateLimits, rateLimitsByLimitId, rateLimitResetCredits')
check(has(props(limits, 'RateLimitSnapshot'), ['primary', 'secondary']), 'rate-limit bucket: primary, secondary')
check(has(props(limits, 'RateLimitWindow'), ['usedPercent', 'windowDurationMins', 'resetsAt']), 'window: usedPercent, windowDurationMins, resetsAt')
check(props(limits, 'RateLimitResetCreditsSummary').includes('availableCount'), 'reset credits: availableCount')

// The native binary behind the `codex` command, found as the helper finds it.
const shim = execFileSync('/bin/sh', ['-c', 'command -v codex']).toString().trim()
let binary = shim
try {
  const scope = join(dirname(dirname(realpathSync(shim))), 'node_modules', '@openai')
  for (const name of readdirSync(scope).filter(n => n.startsWith('codex-'))) {
    for (const triple of readdirSync(join(scope, name, 'vendor'))) {
      const bin = join(scope, name, 'vendor', triple, 'bin', 'codex')
      if (existsSync(bin)) binary = bin
    }
  }
} catch {}
const bytes = readFileSync(binary)
for (const s of ['task_started', 'task_complete', 'turn_aborted', 'thread_source']) check(bytes.includes(s), `session-log event name ${s}`)

process.exit(failed ? 1 : 0)
