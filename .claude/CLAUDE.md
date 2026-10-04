# usage-glance

A Claude Code mod (a plugin of function hooks) that draws Claude and Codex plan limits in one line above the prompt of the Claude desktop app's Code tab. README.md describes it for users; this file is for working on it.

## Commands

```bash
claude plugin validate --strict .   # the engine's static analysis of the module
claude plugin test .                # tests/*.test.ts with the engine's test kit
tsc -p . --noUnusedLocals           # needs .claude-plugin/types/, written when Claude Code loads the mod with --plugin-dir
schema="$(mktemp -d)" && codex app-server generate-json-schema --out "$schema" && node scripts/check-codex.mjs "$schema"
```

Run validate, test and tsc after every change. `.github/workflows/check.yml` runs the same (except tsc) weekly against the newest Claude Code and Codex.

## Layout

- `hooks/register.tsx`: everything that takes `$` (events, timers, store, http, processes) and the drawing, plus `/usage-glance`.
- `hooks/model.ts`: what the band shows, from the view alone (pure; most tests live here).
- `hooks/parse.ts`: readings from the Claude plan-usage reply, reply headers, the Codex app-server reply, and the host's time zone (`date +%z`, or the Windows registry) (pure).
- `hooks/state.ts`: the runtime object `rt`, store keys, stored shapes, pure helpers.
- `bin/codex-limits.mjs`: node helper that asks `codex app-server` (account/read, then account/rateLimits/read).
- `types/index.d.ts`: the `$.state` contract (the `view` atom).

## Engine rules (hard constraints)

- A function that takes `$` must be declared at the top level of `hooks/register.tsx`; the engine does not follow `$` across an import. A name declared twice in the file (a `$`-function and a local) fails validation.
- The `atom` used with `read`/`update` must be declared in `hooks/register.tsx`.
- A render may not write state, even through another `$`: defer with `$.clock.after(0, ...)` (`rt.kick`).
- Desktop sessions start with `isInteractive=false`, no surface and an empty `$.session.surfaces()`: the desktop is known once `AbovePrompt` renders on surface `desktop`.
- Test kit: register every `on(...)` mock before the first `$` call; `takeLease` sleeps 30 ms, so advance the mocked clock (>= 1 s); retry jitter is 0-3 min, so check timing outside that range.

## Design decisions

One line. Weekly by default; the short window ("Session" for Claude, "5h" for Codex) replaces it at a shown 90% unless weekly is spent. Without Codex shown, Claude shows Session + Weekly + Context at all times, on two lines before dropping a window. No per-model weekly limits. Codex shows used %. Percentages bold, dim when stale; bars blue, amber from a shown 75%, red when spent. Cost `~$` is Claude Code's own session figure at API prices. To change any of these, open an issue first.

## Rules

- Never read, print or store credentials: Claude's plan-usage request goes through `$.session.authorize()` (bearer only) and the handle; never dump the process environment.
- Keep the plugin free and open source (Codex's app-server terms rule out commercial or hosted use).
- The plan-usage endpoint and the Codex session-log format are undocumented: any change to how they are read must fail safe (keep the last reading, back off, show `! Not updating`), never show wrong numbers.

## Release

- Published at https://github.com/RaySu/usage-glance; users install with `claude plugin marketplace add RaySu/usage-glance`.
- Bump `version` in `.claude-plugin/plugin.json` for every release: GitHub installs are copies keyed by version, and `claude plugin update` does nothing while it is unchanged.
