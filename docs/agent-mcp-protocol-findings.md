# Agent MCP Protocol and Paseo Skill Findings

Date: 2026-09-16

Status: research and proposal. Nothing described here is implemented in the checkout, and the running
daemon on port 6767 was not touched.

Scope: why OpenCode, Goose, z.ai, and other ACP providers cannot run Paseo skills, plus the concrete
fix for each cause. Written after reviewing agent `20c9d55e-e495-4643-9ed6-b325c201c393`, whose
diagnosis was mostly right but attributed the MCP failure to the wrong clients.

## Summary

Two independent problems sit between an agent and a running Paseo skill:

1. **Discovery is fine.** Paseo installs the skill bundle to `~/.agents/skills`, `~/.claude/skills`,
   and `~/.codex/skills`. Every provider in question reads at least one of those. No new install
   target is required.
2. **Execution is broken.** Paseo's injected MCP server rejects the `MCP-Protocol-Version: 2026-07-28`
   header that newer clients send. The Paseo tool catalog never mounts, so a skill whose body calls
   `list_profiles`, `create_agent`, and so on has no tools to call. This is the real "can't run".
3. **Surfacing is partially broken.** Paseo's ACP adapter labels every ACP command `kind: "command"`,
   so skill-backed commands never appear in the inline `/` picker. Cosmetic alongside (2), and it
   still runs from the message-start command list.

Recommended fix: a `COMPAT`-tagged forward-compat allowlist that adds `2026-07-28` to the SDK's
`SUPPORTED_PROTOCOL_VERSIONS` before any transport handles a request, plus a one-line `_meta`
read in the ACP command mapping.

## Part 1 — Diagnosis

### 1.1 Symptom

`~/.paseo/daemon.log` contains 19 occurrences of:

```
Bad Request: Unsupported protocol version: 2026-07-28
  (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)
```

All 19 come from `runAgentMcpRequest` via `WebStandardStreamableHTTPServerTransport.validateProtocolVersion`.

### 1.2 Which client sends it — corrected

The earlier review attributed the header to Goose and Codex. The daemon log says otherwise. All 19
errors fall between 03:13:54 and 05:33:20 (09-16). Correlating each error with the agent created
immediately before it:

| Creation | Provider | Errors within 3 min |
| --- | --- | --- |
| 03:13:52 | zai | 2 |
| 03:16:50 | zai | 4 |
| 03:18:49 | zai | 2 |
| 03:31:21 | claude | 2 |
| 03:31:47 | zai | 2 |
| 03:33:00 | gemini | 0 |
| 04:31:09 | zai | 1 |
| 05:03:28 | zai | 1 |
| 05:11:25 | zai | 1 |
| 05:21:30 | zai | 2 |
| 05:24:55 | opencode | 0 |
| 05:33:41 | opencode | 0 |
| 05:44:48 | deepseek-harness | 0 |

Every cluster is a `zai` or `claude` agent. `zai` is `extends: "claude"`, so both are the Claude
Agent SDK. The first error's immediate predecessor is a `provider:"claude"` line reading
`"Claude Agent SDK stderr"` for the zai agent created 845 ms earlier.

Consequence: Paseo's tool catalog is failing to mount for a first-class provider, not just for Goose.

Corroborating evidence:

- Goose's binary does contain `2026-07-28` (38 matches), `MCP-Protocol-Version` (14), and the
  `rmcp-3.3.0` marker, plus the string
  `tool not found, InputRequiredResult requires negotiated protocol version 2026-07-28 or newer`.
  Goose needs the same fix; it just is not the source observed here.
- The bundled `claude` binary and `/usr/local/bin/codex` show zero plaintext matches for the version
  or the header name. Both are packed, so that is not evidence either way.
- Definitive confirmation is available without guessing: `config.mcpDebug` makes `bootstrap.ts:1494`
  log the request body, whose `initialize` carries `clientInfo`. Reading it requires a daemon
  restart, so it was not done.

### 1.3 The failure path in the SDK

Two reads of one module-level array, both in `@modelcontextprotocol/sdk` 1.29.0:

- `dist/esm/server/webStandardStreamableHttp.js:621` — `validateProtocolVersion` rejects any
  `MCP-Protocol-Version` header not in `SUPPORTED_PROTOCOL_VERSIONS` with a 400. It runs on every
  non-initialize POST (`:450`).
- `dist/esm/server/index.js:270` — `_oninitialize` computes
  `SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION`, so an
  unknown requested version negotiates down to `2025-11-25`.
- `dist/esm/types.js:2-4` — `LATEST_PROTOCOL_VERSION = '2025-11-25'`; the list stops there. Published
  latest, 1.30.0, is identical (`npm view @modelcontextprotocol/sdk dist-tags` → `latest: 1.30.0`).

Sequence for a 2026 client:

1. `initialize` skips header validation (`webStandardStreamableHttp.js:441-454`).
2. The server answers `2025-11-25`.
3. The client keeps sending `2026-07-28`.
4. `tools/list` is header-validated and gets a 400.
5. The Paseo tool catalog never mounts.

The endpoint is stateless: `bootstrap.ts:1451-1461` builds a fresh server and transport per HTTP
request and tears them down when the response closes; the caller is identified by the
`callerAgentId` query parameter (`bootstrap.ts:1521`). There is no session on which to renegotiate,
so every post-initialize request repeats the failure.

The import chain is safe: the server package is ESM (`packages/server/package.json` `"type": "module"`),
and the stack runs `streamableHttp.js:136` → `webStandardStreamableHttp.js:450`. Both the transport
and `Server` import `../types.js`, so they share the same ESM module instance that Paseo imports. No
CJS/ESM dual-package hazard.

### 1.4 What changed in the next revision

The SDK ships a types-only draft of the next revision,
`dist/esm/spec.types.d.ts` (`LATEST_PROTOCOL_VERSION = "DRAFT-2026-v1"`, line 18), generated from the
spec `main` branch. It never reaches the transport. Diffing it against the released 2025-11-25
schemas, every change touching Paseo's surface is optional:

- `Tool` — adds optional `icons`, optional `execution.taskSupport`, optional `outputSchema`, optional
  `_meta`. `name`, `title`, and `inputSchema` are unchanged.
- `CallToolResult` — required `content`; optional `structuredContent` and `isError`; `Result._meta`
  optional. This is exactly what `mcp-server.ts:17-29` emits.
- `ListToolsResult`, `InitializeResult`, `ServerCapabilities` — same core shape. `tasks` and
  `extensions` are opt-in capabilities, and Paseo advertises neither.
- `InputRequiredResult` is a new optional result the client gates on the server opting in.

So Paseo emits a strict subset that remains valid at the newer revision. The residual risk is that
the released `2026-07-28` differs from the draft in a way that makes a field required; the live
client test in the plan below settles that.

## Part 2 — Fix: the MCP handshake

### 2.1 Options

**A. Runtime forward-compat allowlist (recommended).** Append `2026-07-28` to the SDK's exported
array before any transport handles a request. This fixes header validation and negotiation in one
place, and it is one deletion to remove later.

```ts
// packages/server/src/server/agent/mcp-protocol-compat.ts
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

// COMPAT(mcpProtocol2026): added in v0.9.0, remove once the released
// @modelcontextprotocol/sdk lists 2026-07-28 in SUPPORTED_PROTOCOL_VERSIONS.
const FORWARD_COMPATIBLE_PROTOCOL_VERSIONS = ["2026-07-28"] as const;

export function installMcpProtocolCompatibility(
  supportedVersions: string[] = SUPPORTED_PROTOCOL_VERSIONS,
): void {
  for (const version of FORWARD_COMPATIBLE_PROTOCOL_VERSIONS) {
    if (!supportedVersions.includes(version)) supportedVersions.push(version);
  }
}
```

Call it as the first statement of `createAgentMcpServer` (`mcp-server.ts:31`). That is the single
choke point used by both `bootstrap.ts:1442` and the tests, and it runs before
`new StreamableHTTPServerTransport` at `bootstrap.ts:1456`. `SUPPORTED_PROTOCOL_VERSIONS` is declared
`string[]`, not `readonly`, so `push` typechecks. The server imports no SDK client, so widening the
list cannot change outbound client behavior.

Trade-off: it mutates a dependency's module state and relies on shared module identity. Both facts
are covered by tests below.

**B. `patch-package` patch of the SDK.** The repo already runs `scripts/postinstall-patches.mjs` with
eight patches. Add `@modelcontextprotocol/sdk+1.29.0.patch` editing the ESM and CJS `types.js`. More
declarative, reaches code paths that do not call the shim, but adds a second server-side dependency
patch to re-verify on every bump. Reasonable if runtime mutation is rejected.

**C. Subclass the transport and server.** Override `validateProtocolVersion` and
`Server._oninitialize`. Avoids the global mutation but duplicates the version list and reaches into a
private method. Strictly more code for the same effect.

**D. Bump the SDK, or use the draft at runtime.** No published version supports `2026-07-28`; the
draft is types-only. Dead end.

Choose A.

### 2.2 Test plan

1. Unit — `installMcpProtocolCompatibility(["2025-11-25"])` adds `2026-07-28`; a second call does not
   duplicate.
2. Unit — after install, `SUPPORTED_PROTOCOL_VERSIONS` contains `2026-07-28`. This guards the
   module-identity assumption and turns into a no-op when the SDK adds it natively.
3. HTTP integration — POST `initialize` with `params.protocolVersion = "2026-07-28"` → response
   `protocolVersion === "2026-07-28"`; POST `tools/list` with header `MCP-Protocol-Version: 2026-07-28`
   → 200 with tools. An unknown version (`2099-01-01`) still 400s. A `2025-11-25` client still
   negotiates and works.
4. E2E — extend `packages/server/src/server/agent/agent-mcp.e2e.test.ts`, which already boots a real
   daemon (`:167`) and talks to `/mcp/agents`. The SDK *client* cannot request `2026-07-28`, so this
   leg must drive raw `fetch` with the headers, like the unauthorized-request case at `:269`.
5. Real-client proof, manual and the only check against the released revision: run one Goose ACP
   session and one Claude/zai agent against a patched dev daemon and confirm the Paseo tools mount
   and a `tools/call` round-trips.
6. Repo gates: `npm run build:client` → `npm run build:server`, targeted
   `npx vitest run <file> --bail=1`, `npm run typecheck:server`, `npm run lint -- <files>`,
   `npm run format`.

## Part 3 — Fix: ACP skill labeling

`acp-agent.ts:2917` hardcodes `kind: "command"`. The inline picker accepts only `kind === "skill"`
(`packages/app/src/utils/agent-command-autocomplete.ts:79-83`). Goose marks skill-backed ACP commands
with `_meta.commandType: "Skill"`, observed by driving its ACP `available_commands_update`.

```ts
kind: command._meta?.["commandType"] === "Skill" ? "skill" : "command",
```

`AvailableCommand._meta` is `Record<string, unknown> | null | undefined` in the ACP schema, so this is
type-safe. `AgentSlashCommandKind` already exists (`agent-sdk-types.ts:538`).

Boundaries:

- This affects only the inline picker. At message start every command already shows, and the skill
  still runs. It is cosmetic next to Part 2.
- `glm-acp-agent` advertises the skills but sends no `_meta`, so it stays a plain command. A fallback
  would need the daemon's installed skill-name set inside the provider layer; the clean route is to
  pass it through the launch context, not to import `orchestration-skills` into a provider. Treat
  that as a separate, optional change.

## Part 4 — Skill discovery and install targets

`resolveSkillTargets` (`orchestration-skills/internal/paths.ts`) writes three directories:
`~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`. `SkillSyncOptions` in
`orchestration-skills/internal/sync.ts` mirrors that list.

Read paths, verified against the installed binaries:

- Claude and zai — `~/.claude/skills`.
- Codex — `~/.codex/skills`.
- Goose — `~/.agents/skills` (global and project).
- OpenCode — its binary contains `~/.agents/skills/`, `~/.claude/skills/`, `.opencode/skill[s]`, and
  `~/.config/opencode/skill`; it auto-loads the first two, which Paseo already writes.

No provider named in the original question needs a new Paseo install target.

## Part 5 — Delivery

### 5.1 The fix is a Paseo source change

Both changes live under `packages/server`. Neither is reachable from `paseo.json`, provider profiles,
agent settings, or the app; there is no MCP protocol-version knob. It does not touch the
app↔daemon WebSocket protocol in `packages/protocol`, so no protocol-contract or capability-gating
work is required, and the app needs no `server_info.features` flag.

Ship it as a normal PR: branch, `COMPAT` tag, build client and server, targeted tests, typecheck,
lint, format, CI. If it is release-bound, target `next`.

### 5.2 Committing source does not fix the running daemon

The daemon on 6767 runs the globally installed `@getpaseo/cli` 0.8.0 at
`/usr/local/lib/node_modules/@getpaseo/cli`, not this checkout. Editing or building the checkout
changes nothing about the running daemon. The fix takes effect after a build and release (or a local
install) plus a daemon restart, which is not done without explicit permission.

### 5.3 Alternatives

| Route | Ships to users | Notes |
| --- | --- | --- |
| Commit to Paseo source | yes | The correct home and the only durable path |
| Patch upstream `@modelcontextprotocol/sdk` | eventually | Right long-term fix; latest 1.30.0 still stops at 2025-11-25, so Paseo cannot wait |
| `patch-package` patch in this repo | yes | Still a Paseo commit, in `patches/`; viable if runtime mutation is rejected |
| Hot-patch the installed CLI `dist` on this machine | no | Unblocks before a release, but unsupported, wiped by every global install, and needs a restart |
| Local Paseo plugin monkey-patching at startup | no | Plugins are trusted and in-process so it is technically possible, but outside the plugin contract and fragile |
| Wait for a newer MCP client | no | Not under Paseo's control, and Claude and zai are already affected |

Ownership: the MCP spec says the server answers with a version it supports and a client that cannot
support it should disconnect, so a client that refuses to downgrade is arguably out of spec. Paseo
cannot fix the client, and claiming a revision whose tool surface Paseo already satisfies is a
legitimate server-side fix. File the upstream SDK change in parallel so the shim can eventually be
deleted.

## Open questions

1. Confirm the client: run a throwaway daemon with `mcpDebug` and read `clientInfo.protocolVersion`
   from a failing `initialize`. The log timing says Claude/zai.
2. Validate against the released `2026-07-28`, not the draft: one Goose and one Claude session
   against a patched daemon, with a `tools/call` round-trip.
3. Decide allowlist vs. floor. An explicit `2026-07-28` entry is safest but the next client revision
   repeats the problem. A `>= 2026-07-28` floor is more future-proof but claims revisions Paseo has
   not checked. Start explicit, revisit when a real client is green in CI.

## Reference index

Repo:

- `packages/server/src/server/bootstrap.ts:1436-1562` — agent MCP block; `:1441` session factory;
  `:1456` transport; `:1494` `mcpDebug`; `:1521` `callerAgentId`.
- `packages/server/src/server/agent/mcp-server.ts:17-31` — tool result mapping and server factory.
- `packages/server/src/server/agent/providers/acp-agent.ts:2912-2918` — command mapping.
- `packages/app/src/utils/agent-command-autocomplete.ts:79-83` — inline filter.
- `packages/server/src/server/agent/agent-sdk-types.ts:538` — `AgentSlashCommandKind`.
- `packages/server/src/server/orchestration-skills/internal/paths.ts` and `sync.ts` — install targets.
- `packages/server/src/server/agent/agent-mcp.e2e.test.ts:167`, `:269` — e2e harness.
- `scripts/postinstall-patches.mjs`, `patches/` — patch mechanism.
- `docs/protocol-compatibility.md` — `COMPAT` tagging convention.
- `docs/architecture.md:436`, `docs/providers.md:69` — native tools vs the MCP fallback.

SDK (installed 1.29.0):

- `dist/esm/types.js:2-4` — version constants.
- `dist/esm/server/index.js:270-281` — negotiation.
- `dist/esm/server/webStandardStreamableHttp.js:441-454`, `:621-629` — header validation.
- `dist/esm/spec.types.d.ts:18` — draft `DRAFT-2026-v1`.

Environment evidence:

- `~/.paseo/daemon.log` — 19 errors, 03:13:54–05:33:20 on 09-16.
- `/home/ubuntu/.local/bin/goose` — `rmcp-3.3.0`, `2026-07-28`, `MCP-Protocol-Version`.
- `/usr/local/bin/opencode` — skill directory strings.
- `npm view @modelcontextprotocol/sdk dist-tags` — `latest: 1.30.0`.
