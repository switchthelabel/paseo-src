# basic-memory

A server-only Paseo plugin that gives every agent on one daemon host a shared
long-term memory, backed by a [Basic Memory](https://github.com/basicmachines-co/basic-memory)
Markdown vault.

The plugin does two things:

1. **MCP injection.** A `server.before("agent.create")` hook adds a
   `basic-memory` stdio MCP server to every new agent. The agent can then
   search and write the shared vault with the tools `search_notes`,
   `read_note`, `write_note`, `recent_activity`, and `build_context`. The
   preapproved tools run without a permission prompt.
2. **Checkpoints.** A `server.on("agent.turn_ended")` handler writes one
   debounced note per agent turn burst: the last user request and the last
   assistant answer, both redacted and truncated. Canceled turns write
   nothing. The note lands in the vault seconds after the turn ends, so a
   later agent can find what an earlier agent did.

The vault is plain Markdown in one directory. Every harness that can read
files — and every agent through the injected MCP server — sees the same
memory.

## Layout on this host

| Path                                     | Role                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/home/ubuntu/paseo-memory`              | The vault (Markdown files)                                                                       |
| `/home/ubuntu/.local/bin/basic-memory`   | Basic Memory binary, installed with `uv tool install basic-memory --prerelease=allow`            |
| `~/.basic-memory/config.json`            | Basic Memory config; project `paseo-shared` points at the vault                                  |
| `~/.paseo/basic-memory-plugin.json`      | This plugin's config, written with defaults on first run                                         |
| `~/.agents/skills/paseo-memory/SKILL.md` | Instruction skill that tells agents to search first and write a rich checkpoint before finishing |

## Plugin config

`~/.paseo/basic-memory-plugin.json`. The plugin writes the defaults below on
first run. Edit the file to change behavior; the plugin reads it on every
turn, so changes apply without a reload.

| Key                   | Default                                | Meaning                                                    |
| --------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `binaryPath`          | `/home/ubuntu/.local/bin/basic-memory` | Basic Memory binary                                        |
| `vaultPath`           | `/home/ubuntu/paseo-memory`            | Vault directory, used to confirm each write landed on disk |
| `project`             | `paseo-shared`                         | Basic Memory project name passed to `mcp --project`        |
| `serverName`          | `basic-memory`                         | Name of the injected MCP server                            |
| `injectMcp`           | `true`                                 | Inject the MCP server into new agents                      |
| `excludeProviders`    | `[]`                                   | Provider IDs that must not get the injection               |
| `preapproveTools`     | `true`                                 | Preapprove the read and write tools                        |
| `preapproveProviders` | `["claude", "codex", "opencode"]`      | Providers that may receive preapproval grants              |
| `checkpoints`         | `true`                                 | Write turn-end checkpoint notes                            |
| `skipSubagents`       | `false`                                | Do not checkpoint subagents                                |
| `quietMs`             | `60000`                                | Debounce window; turn ends within it merge into one note   |
| `maxUserChars`        | `1000`                                 | Truncation limit for the request section                   |
| `maxOutputChars`      | `4000`                                 | Truncation limit for the result section                    |
| `folder`              | `checkpoints`                          | Vault folder for notes                                     |

## What a checkpoint contains

Title `Checkpoint — <agent title> — <YYYY-MM-DD HH:mm>` (UTC), tags
`checkpoint, <provider>, <project key>` where the project key is the git
common-dir name of the agent directory. Sections:

- header facts: agent id, title, provider, workspace, directory, turn outcome, timestamp
- `## Last request` — the last user message, redacted, at most `maxUserChars`
- `## Result` — assistant messages after that request (or the error text of a
  failed turn), redacted, at most `maxOutputChars`
- `## Next` — placeholder; read the agent timeline for what followed

Redaction replaces credential shapes (`Bearer …`, `sk-…`, `ghp_…`, `AKIA…`,
32+ character runs after token/secret/key/password labels) with `[token]`,
and email, SSN, EIN, phone, and long digit runs with short markers. The
plugin never stores credentials, environment values, or raw transcripts.
Redaction is pattern-based; do not treat checkpoints as safe to publish.

## Install

```bash
cd plugin-examples/basic-memory
npm install
npm run typecheck
npm test
bash deploy/deploy.sh                 # rsync to /home/ubuntu/paseo-plugins/basic-memory + install skill
paseo plugin install /home/ubuntu/paseo-plugins/basic-memory
paseo plugin ls basic-memory          # expect: running
paseo plugin logs basic-memory        # expect: "[basic-memory] plugin ready"
```

RPC method names are `basic-memory.status` and `basic-memory.write` (plugin
RPC names are lowercase; camelCase is rejected at registration).

No daemon restart. The plugin runs in its own subprocess; running agents are
not touched.

## Verified write path

The checkpoint writer speaks MCP over stdio itself: it spawns
`basic-memory mcp --project paseo-shared`, sends `initialize`,
`notifications/initialized`, then `tools/call write_note` with these verified
arguments — `title`, `content`, `directory`, `tags`, `output_format: "json"`
— and kills the process after the note file appears in the vault.

Basic Memory 0.23 answers `write_note` after its index update, not after the
Markdown file lands. The file is flushed about half a second later by a
background task of the still-running process, so the plugin keeps the child
alive while it polls the vault for the file (8 s limit) and only then shuts
the process down. Killing the child at the answer instead cancels the flush;
the note then stays pending until the next `basic-memory` session reconciles
it from the index. If the file is still missing at the deadline, the write
still counts as done for the same reason.

## Limits

- Injection is new-agents-only. Agents created before the plugin was enabled
  keep their saved configuration and get no server. That is also the rollback
  property: disable the plugin and new agents are clean.
- Only providers whose contract supports exact MCP tool preapproval (Claude,
  Codex, OpenCode, and custom providers that extend them) receive the
  preapproval grants. The daemon rejects agent creation when any other
  provider gets a `toolPolicy`, so every other provider gets the MCP server
  without preapproval and its harness prompts for the tools as usual. Add a
  custom provider id to `preapproveProviders` when it extends a supported
  harness.
- The vault is host-local. Agents on other daemon hosts do not see it.
- Search quality depends on Basic Memory's index; `basic-memory doctor`
  checks it.

## Rollback

```bash
paseo plugin disable basic-memory   # stops injection and checkpoints; no daemon restart
paseo plugin remove basic-memory    # also removes the daemon's plugin entry; source directory stays
uv tool uninstall basic-memory      # only if the vault is no longer needed
```

Disabling the plugin leaves the injected `basic-memory` server in the saved
configuration of agents that were created while it was enabled. Those agents
keep working while the binary stays installed. Agents created after the
disable get no injection. The vault directory is never deleted by any of
these commands.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test over the pure logic: inspect, redact, compose, debounce
```

The unit tests run with `node --experimental-strip-types`; relative imports
use explicit `.ts` extensions for that reason. The live write path is
exercised by installing the plugin and letting a turn end.
