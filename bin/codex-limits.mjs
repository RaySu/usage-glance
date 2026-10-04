// Asks the local Codex app-server how the account is signed in, then, for a
// ChatGPT sign-in only, for its live rate limits, and prints one JSON line:
// { ok: true, result, account } or { ok: false, error, account, requiresOpenaiAuth }.
// `account` is { type, planType } or null (no sign-in); nothing else about the
// account is kept.
//
// The app-server quits on stdin EOF before it answers, so stdin stays open
// until the answer arrives. It also quits when this helper dies (its stdin
// pipe closes), so it cannot be left behind; the process group kill below is
// the second guard.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const TIMEOUT_MS = 10_000
/** The mod's own version, for the app-server's clientInfo. */
let version = '0.0.0'
try {
  version = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version ?? version
} catch {}
/** One JSON-RPC line is small; anything this long is not an answer. */
const MAX_BUFFER = 8 * 1024 * 1024

// The npm `codex` command is a node wrapper around a native binary. Starting
// the binary directly skips one node process (~50 MB). The mod passes the
// `codex` it found as the first argument; PATH is the fallback.
function codexBinary() {
  const given = process.argv[2]
  const dirs = given ? [dirname(given)] : (process.env.PATH ?? '').split(':')
  for (const dir of dirs) {
    const shim = join(dir, 'codex')
    if (!existsSync(shim)) continue
    try {
      const pkg = dirname(dirname(realpathSync(shim)))
      const scope = join(pkg, 'node_modules', '@openai')
      for (const name of readdirSync(scope)) {
        if (!name.startsWith('codex-')) continue
        const vendor = join(scope, name, 'vendor')
        for (const triple of readdirSync(vendor)) {
          const bin = join(vendor, triple, 'bin', 'codex')
          if (existsSync(bin)) return bin
        }
      }
    } catch {}
    return shim
  }
  return 'codex'
}

// Plugins and apps are not needed to read limits; left on, every start checks the
// person's plugin marketplaces over the network. Config overrides (not --disable)
// so a feature a later Codex renames is ignored rather than refused. Run from the
// home folder, away from any project's own Codex config.
const child = spawn(
  codexBinary(),
  ['app-server', '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false', '-c', 'features.apps=false'],
  { stdio: ['pipe', 'pipe', 'ignore'], detached: true, cwd: homedir() },
)
let buffer = ''
let isDone = false
let account = null

const finish = payload => {
  if (isDone) return
  isDone = true
  process.stdout.write(JSON.stringify(payload) + '\n')
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {}
  child.stdin.destroy()
  // One that ignores SIGTERM is not left behind either.
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
    process.exit(0)
  }, 300)
}

child.on('error', err => finish({ ok: false, error: `cannot start codex: ${err.message}` }))
// 'close', not 'exit': the last answer may still be in the pipe when the process ends.
child.on('close', code => finish({ ok: false, error: `codex app-server exited (${code})` }))

child.stdout.on('data', chunk => {
  buffer += chunk
  if (buffer.length > MAX_BUFFER) return finish({ ok: false, error: 'reply too long', account })
  let cut
  while ((cut = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, cut)
    buffer = buffer.slice(cut + 1)
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    // The server's own requests and notifications carry a method; only answers count.
    if (msg.method !== undefined) continue
    if (msg.id === 1 && msg.error) finish({ ok: false, error: msg.error.message ?? 'initialize failed' })
    if (msg.id === 3) {
      // A failed read says nothing about the sign-in: no `account`, so it is retried.
      if (msg.error) return finish({ ok: false, error: msg.error.message ?? 'account read failed' })
      const a = msg.result?.account
      account = a ? { type: a.type ?? null, planType: a.planType ?? null } : null
      // Signed out, or signed in some other way (an API key, Bedrock): there are no
      // ChatGPT plan limits to ask for.
      if (!a) return finish({ ok: false, error: 'not signed in', account, requiresOpenaiAuth: msg.result?.requiresOpenaiAuth ?? null })
      if (a.type !== 'chatgpt' && a.type !== 'chatgptAuthTokens') return finish({ ok: false, error: 'no ChatGPT plan', account })
      send({ id: 2, method: 'account/rateLimits/read' })
      continue
    }
    if (msg.id !== 2) continue
    if (msg.error) return finish({ ok: false, error: msg.error.message ?? 'request failed', account })
    // Only the limits leave this helper: the reply also names the account.
    const { rateLimits, rateLimitsByLimitId, rateLimitResetCredits } = msg.result ?? {}
    finish({ ok: true, result: { rateLimits, rateLimitsByLimitId, rateLimitResetCredits }, account })
  }
})

const send = msg => child.stdin.write(JSON.stringify(msg) + '\n')
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'usage-glance', version } } })
send({ method: 'initialized' })
// The limits are asked once the sign-in answer is in (see id 3 above).
send({ id: 3, method: 'account/read', params: { refreshToken: false } })

setTimeout(() => finish({ ok: false, error: 'timed out' }), TIMEOUT_MS).unref()
