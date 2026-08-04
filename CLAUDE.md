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

**There is no dedicated tool call for "a skill was used" — OpenClaw skills are
read as plain files.** `src/skillUsage.ts`'s detection watches
`after_tool_call` for a read-family tool (`read`, `read_file`, etc.) whose
target path's basename is `SKILL.md`, then recovers the declared skill name
from the file content's YAML frontmatter. This mirrors what the separately
installed `skill-usage` plugin does internally (confirmed by reading its
actual source on this dev host, under
`~/.openclaw/npm/projects/openclaw-skill-usage/`) — replicating the technique
removed the dependency on that plugin's output file entirely. Unlike the
`llm_input`/`llm_output` pair in `llmCapture.ts`, `after_tool_call` alone
carries both `params` (the read path) and `result` (the file content) on one
event, so this needed no before/after correlation map and none of the
module-scope gotcha above — one hook, one event, done. If you ever add
detection for some other tool-based signal, check first whether the hook you
need already bundles everything in one event before reaching for a
before/after pending-state pattern.

**`before_tool_call`/`after_tool_call` do not require
`hooks.allowConversationAccess`** (unlike `llm_input`/`llm_output`) — this is
why `skills_used` needs no operator opt-in while `llm_api_log` does. Don't
conflate the two when explaining either in the README.

**`/probe diff <name1>, <name2>` requires a literal comma between the two
names, not whitespace.** Both names can themselves contain spaces (including
the auto-generated range name `"<start> .. <end>"`, which already has spaces
baked in), so splitting on whitespace like the single-name commands do would
be ambiguous — there's no way to tell where name1 ends and name2 begins. The
comma is the delimiter of last resort here; don't "simplify" the parser to
whitespace-splitting, it will misparse any name with a space in it.

**A matched `model.completed` trajectory event's `messagesSnapshot` can have stale/reused
per-message timestamps that don't fall inside the run's own audit-derived window - don't
gate `llm_calls`/`models_used` entirely on that filter passing.** Found live on a real,
non-toy session (`d6d5a20c-...`, name `createdeletehostwithskill1`): the report showed real
non-zero `tokens` (from `mc.data.usage`, summed unconditionally once per matched run) but
`llm_calls: 0` and `models_used: {}` for the same run - a real user-reported contradiction,
not user error. Root cause: `llm_calls`/`models_used`/the `"LLM call:"` timeline entries were
derived *only* by filtering `mc.data.messagesSnapshot` for assistant messages whose
`m.timestamp` fell inside `[rw.startedMs - 1000, rw.finishedMs + 1000]` - and on that session,
every `model.completed` event's snapshot (checked directly in the raw `.trajectory.jsonl`)
carried the exact same stale message content and timestamp (~20 minutes before the run it was
attached to), across several unrelated `runId`s. `compactionCount` was `0`, so this isn't
ordinary compaction truncation - looks like a host-side trajectory-writer quirk on that build,
not something probe caused or can prevent. The event's own top-level `provider`/`modelId`/`ts`
fields were fine throughout (used already for `runLevelModel`, and for `tokens` via
`mc.data.usage` - neither depends on the snapshot). Fix (in `src/report.ts`'s `buildReport`):
if zero snapshot messages match the run's window (`matchedInWindow === 0`) after the normal
loop, still count one `llm_calls` and one `modelsUsed` bump from `runLevelModel`/`mc.ts`
directly - since a matched `model.completed` event for this `runId` is itself proof a
completion happened, independent of whatever's wrong with its snapshot. This can't recover
`tool_calling_rounds` for that call (no reliable non-snapshot signal for "had a tool call"),
so it's deliberately left uncounted for the fallback path, with a `warnings` entry saying so -
don't try to guess it from `tools_used`/audit data, that would silently misattribute unrelated
tool calls from other LLM calls in the same run. Regression test:
`report.test.ts`'s "falls back to the model.completed event's own provider/model...".

**`events` in `src/diff.ts`'s `buildDiff` is set-diffed by each entry's
normalized `"<type>: <name>"` key (`normalizeEventKey`), not its raw `event`
text, and `date` is discarded before comparing.** Two separate measurement
windows always have different timestamps for otherwise-identical events, so
including `date` in the comparison key would make every single event look
"added" on one side and "removed" on the other — the diff would be 100%
noise. The same problem exists one level down: `report.ts` bakes
duration/status/still-running detail into the tail of `event` (e.g.
`"tool call: exec (0.16s)"` vs `"(failed: tool_failed, 0.41s)"` vs
`"(started, still running at window end)"`) — diffing the raw string made
two calls to the *same* tool with different durations look like a
tool-added-and-removed pair, which is exactly what a user flagged live
(`/probe diff` on two runs that both called `exec` repeatedly showed it as
both `+`/`-`). `normalizeEventKey` fixes this by cutting at the first
`" ("`, since every event format in `report.ts` puts that detail in a
trailing `" (...)"` block and nothing else uses `" ("` — if you add a new
timeline event kind in `report.ts`, keep that convention (detail goes in a
trailing parenthesized block) or `normalizeEventKey` will silently stop
stripping it correctly. This also means a report with the same tool/
skill/model called multiple times (with different outcomes/durations)
collapses to one set entry, same as before; that's intentional — the diff
answers "did X start/stop being used at all," not "how many times," which
is also why `events`/`tools_used`/etc have no per-item count in the diff
output in the first place.

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
