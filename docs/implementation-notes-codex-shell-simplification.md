# Implementation notes — Codex 壳层简化

Plan: `docs/codex-shell-simplification-plan.md`

## Summary

Capability baselining plus the Skill, Memory, and Errand simplification slices
are complete. All Codex probes now identify and exercise the same selected runtime,
Butler Skill enablement uses Codex native configuration, and normal Codex
threads no longer receive the redundant `load_skill` host tool. Project-scoped
MCP configuration, discovery, and tool calls are proven on both supported
runtimes. Long-term memory behavior now lives in the native `butler-memory`
Skill, adapted from Mem0's Apache-2.0 memory Skills at a pinned revision, while
the confirmed local data and approval boundary remains a minimal Host Tool.
All 9 RocketX-managed Skill bodies now live in checked-in `SKILL.md` files.
The 8 executable core Skills are mirrored verbatim for Codex; the API-only
Azure adapter remains separate from the complete vendored Azure Skill already
used by Codex. Butler errands now use persistent Codex threads, native Goals,
native subagent delegation, and persisted thread history. Routine migration is
also complete. Manual `$skill` invocation and Plugin distribution now use
Codex-native protocol surfaces, and seven non-runnable learning pseudo-Skills
have been removed; production MCP adapters remain a later phase.

## Decisions

- `scripts/lib/codex-app-server-spike.ts` now owns the probe-only runtime
  resolution contract. Every probe must report `pinned` or `system`, the
  resolved path, and the actual CLI version.
- Recoverable Butler errands will use persistent Codex threads. Ephemeral
  threads remain suitable only for disposable turns because app-server rejects
  Goal state on them.
- Every Butler errand now starts with `ephemeral: false`, creates an active
  native Goal before the first turn, and lets Codex continue while that Goal is
  active. RocketX no longer treats the first `turn/completed` event as proof
  that the errand is done.
- A completed Goal is the success boundary. Paused, blocked, usage-limited, or
  budget-limited Goals are shown as stopped work; an explicit user stop first
  pauses the native Goal and then interrupts the active turn.
- Subagent selection remains Codex-native. RocketX supplies only the persistent
  task instruction and maps `subAgentActivity` to UI progress. It does not
  maintain a second child-agent registry.
- Final errand text is re-read from `thread/read` after the Goal reaches a
  terminal state. This recovers missed streaming deltas and leaves parent/child
  history in Codex as the sole durable execution record.
- All four built-in Routine templates now reference native Skills. The last
  inline methodology, room digest, moved from a TypeScript prompt into
  `core/room-digest/SKILL.md`; the scheduler passes only selected room names as
  task parameters.
- The one-minute host timer remains because neither supported app-server
  exposes Automation CRUD. Its responsibilities are limited to due/precheck,
  login scope, pause, approval surfaces, and Today delivery.
- Version-1 room-digest instances that still contain the old bundled prompt
  migrate to the native Skill. Higher contract versions keep their prompt so a
  user's edited method is never overwritten.
- Butler's skill-management UI now treats `skills/list` and
  `skills/config/write` as authoritative when Codex is available. The old
  disabled-name list is migrated once and retained only as a compatibility
  shadow for code paths that still read synchronously.
- All three Butler composers expose the same `$skill` autocomplete. Candidate
  metadata comes from `skills/list`; selection only inserts `$name `, while
  dispatch resolves the real native Skill path and sends a Skill `UserInput`.
- Plugin discovery, Marketplace addition/upgrade, and Plugin install/uninstall
  use the app-server `plugin/*` and `marketplace/*` methods directly. RocketX
  owns no Marketplace index, package manifest, install root, or download code.
- Marketplace configuration remains Codex-owned. RocketX now displays the
  configured entries and can remove user-added marketplaces through
  `marketplace/remove`; remote-only catalogs stay visible but are labeled as
  Codex-managed instead of receiving a nonfunctional remove action.
- Marketplace loading is offline-first: an explicit browser offline signal
  routes directly to `plugin/installed`, online catalog reads have an 8-second
  UI deadline and a 4-second installed-plugin fallback, and network recovery
  triggers a fresh catalog read. Mutations release their busy state after 15
  seconds with an honest warning that Codex may still finish in the background,
  because app-server exposes no generic cancellation method for these calls.
- Seven learning-analysis Markdown files were removed because they described
  internal typed algorithms without a callable Codex tool surface.
  `butler-reply-guardian` remains as a core Skill because it can execute through
  `list_mentions`; the learning extension continues to run as TypeScript.
- Removing those pseudo-Skills also removed the dynamic Skill-provider map.
  Checked-in core Markdown plus user-authored compatibility Skills are now the
  only project Skill sources.
- Disabled skills stay present in `.agents/skills`; disabling is native Codex
  configuration, not file deletion. This keeps the Skill visible and makes
  re-enabling path-stable.
- The existing `rcx-mcp` remains the external-agent, read-only chat-context
  server. It is not reused as Butler's business MCP because it cannot access
  WebView-local calendar, loaded workbench, approval, or session state.
- Codex `dynamicTools` remains the minimal host-function boundary for data
  that only exists inside the running RocketX host. This is an app-server
  capability adapter, not a second tool-selection or Agent runtime.
- Native Skills remove the normal need for `load_skill`; only malformed
  pre-migration Skills keep that compatibility tool.
- Managed Skill content lives only under
  `apps/web/src/butler/skills/<category>/<name>/SKILL.md`. The shared loader
  uses Vite's eager raw glob in the app and synchronous reads of those same
  files in Node tests; TypeScript retains ordering and enablement only.
- `renderButlerSkillFile` returns bundled Markdown verbatim after checking that
  its parsed name, description, and body agree with the catalog fields. It
  still renders user-authored UI Skills from fields because those are stored
  profile data rather than checked-in product resources.
- `butler-memory` owns recall, confirmed writes, revocation, restoration,
  legacy import, and brief-preference methodology. The base Persona retains
  only the non-negotiable content boundary, and the existing Host Tools retain
  trusted scope capture plus approval enforcement.
- Mem0 repository revision
  `74f6dc6f0d60906c4babf762fc8d14b7169c196c` is the documented upstream
  reference for recall-first context loading, atomic explicit writes,
  read-only memory review, and confirmed forgetting. RocketX rewrites those
  semantics into one local Skill rather than vendoring the plugin.
- The Mem0 remote MCP, SDK, lifecycle hooks, automatic capture, and hard-delete
  behavior are intentionally excluded. They would add credentials, data
  egress, another runtime, or weaker approval semantics without improving the
  current local Host Tool boundary.
- Memory data does not move into Butler home's `memory/*.md`. Butler home is
  the Codex working directory, so a plaintext cross-scope file would bypass
  `recall_memory` filtering. The Skill owns methodology; the Host Tool remains
  the data and trusted-scope boundary.
- MCP credential experiments use an explicit fake value only. Both supported
  runtimes must inject it successfully and leave no matching bytes under the
  temporary Codex Home after shutdown before inline MCP environment values are
  considered for a production adapter.

## Deviations

- The original plan said to migrate all business tools to MCP. Current storage
  boundaries show that doing so for host-local state would require a new
  WebView-to-child-process bridge. The conservative deviation is to prove the
  native MCP configuration path first, migrate only independently runnable
  capabilities, and retain the existing Codex host-function boundary for the
  rest.
- User-authored and edited legacy Routine prompts remain supported. Automatically
  converting those into generated Skills would create files and alter user
  configuration without an explicit product migration contract.
- Local `SKILL.md` paste remains visible as a compatibility path for existing
  project-scoped Skills. New discovery and distribution are centered on Codex
  Marketplace Plugins instead of inventing a RocketX package format.

## Surprises

- Before this change, protocol/smoke/native-Skill probes used the pinned Codex
  `0.144.4`, while the Dynamic Tool probe silently used the system Codex
  `0.145.0`. Their PASS results were therefore not one comparable capability
  matrix.
- Subagent persistence is exposed through `subAgentActivity` plus the child
  thread's `parentThreadId`. A client cannot infer the lifecycle solely from
  `thread/started` or a completed `collabAgentToolCall`.
- `turn/completed` is not an errand completion signal when a native Goal is
  active. A focused live probe observed automatic continuation on both
  supported runtimes: pinned `0.144.4` emitted 5 turn starts / 4 completions
  and system `0.145.0` emitted 4 starts / 3 completions while the Goal remained
  active. The host must query Goal state before closing the transport.
- Codex app-server exposes scheduled-task templates through plugin metadata,
  but neither `0.144.4` nor `0.145.0` exposes Automation CRUD client methods.
- The first focused regression exposed an orphaned in-memory enabled-state
  entry when a custom Skill was removed and installed again. `removeSkill`
  now clears only that Skill's native snapshot entry.
- On Windows, `where codex` can return a non-executable extensionless npm shim
  before `codex.cmd`. The shared resolver validates each candidate and keeps
  looking until it finds a real CLI.
- A stopped app-server can briefly retain its working-directory handle on
  Windows. Probe shutdown now waits after a forced kill, and temporary cleanup
  retries transient lock failures.
- Per-thread nested `config.mcp_servers` works unchanged on both the pinned and
  system runtimes. `mcpServerStatus/list` plus a direct `mcpServer/tool/call`
  verifies the complete configuration path without depending on model
  selection.
- The pinned `0.144.4` and system `0.145.0` runtimes both forwarded the fake
  MCP environment value and, after shutdown, left no matching value in their
  temporary Codex Home. This is observed version-specific behavior, not a
  permanent secret-storage guarantee.
- Azure DevOps Server is not production-MCP-ready only because its API is
  external. Its current safe boundary also includes PowerShell resolution,
  packaged script ownership, startup failure behavior, and PAT handling.
- Mem0's high-star repository now ships a real Codex plugin and granular
  Skills, but its bundled Codex MCP points to the hosted Mem0 endpoint and
  requires `MEM0_API_KEY`. Community adoption therefore supports using its
  Skill contracts; it does not justify silently changing RocketX from local
  memory to a remote service.
- Vite `?raw` imports do not run under the repository's direct `tsx --test`
  path. A generated TypeScript catalog was rejected; the loader instead uses
  the same Markdown files through environment-specific read mechanisms.
- The official Skill validator needs UTF-8 mode on this Windows host. Running
  it with `python -X utf8` validated all 9 managed Skill directories.
- The apparently simpler “transparent `memory/*.md`” plan was unsafe: Codex
  runs with Butler home as its working directory and read-only sandboxing does
  not make a plaintext file scope-aware. The existing removal of
  `memory/facts.md` is a security boundary, not migration debt.
- Both supported runtimes expose the typed Marketplace and Plugin methods.
  An isolated Codex Home correctly returns an empty catalog rather than a
  built-in RocketX default, so the UI presents “add marketplace” as an explicit
  user action.
- App-server requests already had a 15-second timeout after they were sent, but
  Codex transport startup had no UI-level deadline. Marketplace operations now
  wrap the whole start-plus-request path, so a stuck cold start cannot leave the
  Skill page spinning forever.

## Questions for review

None for this phase.

## Verification

- `pnpm codex:protocol:check`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test:regression` — 856 passed
- `pnpm test:pure` — 230 passed
- `pnpm test:ui` — 93 passed
- `pnpm smoke:codex-app-server`
- `pnpm smoke:codex-app-server:system`
- `pnpm spike:codex-shell-contract` — pinned and system runtimes both
  passed all 9 contract checks
- `pnpm spike:codex-mcp-config` — pinned and system runtimes both discovered
  the configured server, discovered its tool, completed a real tool call, and
  passed the fake-credential persistence probe
- `pnpm spike:codex-plugin-marketplace` — pinned and system runtimes both
  returned valid empty `plugin/list` and `plugin/installed` responses for an
  isolated Codex Home
- `pnpm spike:butler-native-skills`
- `pnpm spike:butler-native-skills:system`
- `python -X utf8 .../skill-creator/scripts/quick_validate.py <skill-dir>` —
  all 9 managed Skill directories passed
- `pnpm exec tsx --test scripts/regressions/butler-errands.test.ts` — 22 passed
- `pnpm exec tsx --test scripts/regressions/routines.test.ts scripts/regressions/butler-bundled-skills.test.ts`
  — 22 passed
- `pnpm typecheck`
- Focused native Goal continuation probe — pinned `0.144.4` and system
  `0.145.0` both kept starting turns while the Goal stayed active
