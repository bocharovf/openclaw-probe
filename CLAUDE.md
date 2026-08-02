# CLAUDE.md — openclaw-probe

Notes for whoever (human or AI) next touches this repo. This is not a copy of
[README.md](README.md) — read that first for what the plugin does and its
public contract. This file is the war stories: things that already broke
once, weren't obvious from the code, and are easy to reintroduce in a PR that
looks correct and passes `npm test`.

## Gotchas

**The `inFlight` correlation Map in `src/llmCapture.ts` must stay module-level,
not created inside `registerLlmCapture()`.** OpenClaw calls `register()` on
this plugin multiple times within a single still-running Gateway process —
confirmed live via repeated `[probe] armed` log lines at a constant PID,
concentrated around sub-agent spawns. A Map created fresh per `register()`
call is only visible to the listeners added by that one call; an `llm_input`
handled by one registration and its matching `llm_output` handled by another
silently miss each other and the entry is dropped with no error. This
undercounted `llm_api_log.entries_captured` by ~90% in a real run before it
was caught (git history: "Fix raw LLM capture severely undercounting
entries"). If you touch this file, keep `inFlight` (and any future
correlation state) at module scope, and keep the "multiple registrations for
the same event write exactly one entry" test in `llmCapture.test.ts` — it's
the regression guard for this specific failure mode.

**`api.runContext.setRunContext`/`getRunContext` looks like the "correct" fix
for the above (host-managed per-run scratch storage, not tied to any one
plugin instance) but does not currently work as documented.** Live-verified:
`setRunContext` returns `undefined` instead of the documented `boolean`, and
the paired `getRunContext` never finds the value. Don't reach for it again
without re-verifying against a real Gateway first — the type signature
matching the SDK docs is not enough evidence that it works.

**`llm_input`/`llm_output` fire once per completed agent run, not once per
individual LLM completion inside a run's tool-calling loop.** This is a host
ceiling, not a bug in this plugin — confirmed by cross-checking against the
independently-installed `llm-api-logger` plugin's own log for the same
window, which showed the identical cap. Do not "fix" `llm_api_log` to try to
match `iterations.llm_calls`; document the gap instead (see README's
Requirements section and the verbose report formatter).

**Don't cache "directory exists" mkdir results behind a module-level flag
tied to a path that can vary between calls.** An earlier version of
`llmCapture.ts` did `dirReady ??= mkdir(llmLogDir, {recursive:true})...`
scoped at module level; this broke every test after the first because each
test uses a fresh temp `llmLogDir` and the cached promise from test 1 made
later tests skip `mkdir` entirely. `fs.mkdir(..., {recursive:true})` is cheap
and idempotent — just call it unconditionally before every write.

**The save-time and lookup-time slug for a saved report must be computed by
the exact same function.** `handleShow`/`handleVerbose` in `src/commands.ts`
look up a report via `slugify(name)`. `handleRange` used to save under a
separate `rangeSlug(startMs, endMs)` scheme, which meant every range report
was silently unreachable by name even though the file existed on disk (git
history: "Fix range reports being unreachable by name"). If you add another
way to name/save a report, route it through `slugify()` for both directions
or add a regression test that goes through the real show/verbose path (not a
second call to whatever created the report) — the original bug's test
coverage missed it precisely because it re-ran the creating command instead
of exercising retrieval.

**`resolveStateDir()` (from the plugin SDK, used in `src/paths.ts`) already
returns the whole `~/.openclaw` root, despite "state" in the name — it is
not the `state/` subdirectory inside it.** Do not `dirname()` it. Got this
wrong in the initial implementation; the fix is in `resolveBaseDir()`.

**`hooks.allowConversationAccess: true` is required in the operator's config
for `llm_input`/`llm_output` to fire at all for this plugin (any non-bundled
plugin using those hooks needs it).** Without it, the hooks are just never
invoked — no error, no warning, `llm_api_log` stays empty. This is expected
and documented in the README; don't chase it as a bug if raw capture looks
dead on a fresh install.

**Testing `/probe` via `openclaw agent --message "..."` does not work — that
CLI command bypasses command parsing entirely and sends the text straight to
the model.** To actually exercise the command-dispatch code path (what a
real chat message does), go through the Gateway's `chat.send` RPC:

```bash
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.openclaw/openclaw.json','utf8')).gateway.auth.token)")
IK=$(node -e "console.log(require('crypto').randomUUID())")
openclaw gateway call chat.send --token "$TOKEN" \
  --params "{\"sessionKey\":\"agent:main:probe-test-1\",\"message\":\"/probe\",\"idempotencyKey\":\"$IK\"}" \
  --json --timeout 30000
# then poll:
openclaw gateway call chat.history --token "$TOKEN" \
  --params '{"sessionKey":"agent:main:probe-test-1","limit":2}' --json
```

Use an isolated `sessionKey` (not `agent:main:main`) for this. Sending test
`/probe` traffic straight into the operator's real main session pollutes
their actual conversation and burns real tokens on any message that doesn't
get intercepted as a command — this happened once during development.

**`openclaw audit --json` and `openclaw plugins list --json` subprocess calls
take a few seconds each (CLI process startup, not the query itself).** This
is expected for a `/probe` report-generation command a human triggers
explicitly, not a bug to "optimize away." Do not replace `openclaw plugins
list --json` (`contracts.tools`, fast, no runtime loading) with `openclaw
plugins inspect <id> --runtime --json` per plugin for the tool→plugin
map — the latter loads each plugin's runtime and takes ~5-6s *per plugin*,
which does not scale past a handful of installed plugins.

**`tsconfig.json` must keep excluding `src/**/*.test.ts`.** Without the
`exclude`, `tsc` compiles test files into `dist/`, and they leak into the
published npm package (`files` in `package.json` ships the whole `dist/`
directory as-is).

## Dev workflow

```bash
npm install
npm run build
npm test
```

Live-testing against a real Gateway (needs a host with OpenClaw already
configured):

```bash
npm run build
openclaw plugins install . --force
openclaw gateway restart
openclaw doctor   # confirm 0 plugin errors after install
```

Then drive it via `chat.send` as shown above, not `openclaw agent`. Check
`openclaw plugins install`'s own output for the `[probe] armed - base dir:
...` log line — if that path doesn't end in `.openclaw`, something is wrong
with `resolveBaseDir()` (see gotcha above).

Before publishing a new version: `npm pack --dry-run` and check the file
list — only `dist/`, `openclaw.plugin.json`, `README.md`, `LICENSE`, and
`package.json` should appear. Anything from `src/` showing up means
`tsconfig.json`'s `exclude` broke.
