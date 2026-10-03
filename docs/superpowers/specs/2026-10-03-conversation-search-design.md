# Conversation Search Design

Status: Draft for review, revision 3

## Purpose

Sessions search finds session metadata. It does not find conversation text. A user who remembers something they said, or the subject of a past conversation, cannot find the session.

This design adds conversation search across all sessions on one daemon. The user need has two parts:

- Find exact text: an error, file path, code symbol, or phrase.
- Find a session by its meaning: "the discussion about aggressive reconnect retries."

The second part is the reason for this work. Keyword search alone does not satisfy it, so semantic search is in the first usable release, not a later addition.

## Scope

The first release indexes visible user and assistant message text for root agents known to one daemon. A result is a session with its best matching excerpts. Selecting an excerpt opens the chat at that message.

The first release excludes:

- Tool calls and tool output.
- Terminal content.
- Attachments and binary payloads.
- Reasoning text.
- Provider child (subagent) transcripts.
- Remote embedding services.
- Daemons on hosts other than Linux. See [Deployment](#deployment).

This feature does not replace Sessions metadata search. It does not synchronize conversation content between daemons. The index is not a source of truth.

## Existing Code This Design Builds On

| Code | What it does | How this design uses it |
| --- | --- | --- |
| `packages/server/src/server/agent-history-search.ts` | Ranks every persisted agent on workspace, title, branch, and project name. | Unchanged. Conversation search is a separate mode. |
| `packages/server/src/server/agent/chat-search/index.ts` | In-chat Find for one loaded agent (`agent.timeline.search.request`). Extracts searchable text from projected items and returns `seq` locations. | Reuse its text extraction so the index and in-chat Find match the same text. |
| `packages/app/src/agent-stream/use-scroll-to-message.web.ts` and `chat-find/` | Loads history and scrolls to a `seq`. | Reuse for result navigation. |

## Constraints From the Timeline Model

These facts shape the design. `docs/timeline-sync.md` owns the detail.

1. The daemon keeps projected timeline items in memory only. Provider history is the durable transcript.
2. The timeline `epoch` is a random UUID minted each time an agent's timeline is initialized (`agent-timeline-store.ts`). It changes on daemon restart, on reload, and on rewind. An `epoch` and `seq` pair is valid only while that in-memory timeline lives.
3. Loading a stored agent calls `resumeAgentFromPersistence`, which opens a provider session. Archived agents open with `purpose: "history"`.
4. An index can be incomplete during backfill or after a failure. The app must not show "No matches" unless coverage is complete for the searched scope.

Constraint 2 means an index document cannot store `epoch` and `seq` as its identity or its navigation target. Both would be invalid after the next daemon restart.

## Decision

Run Typesense on the same Linux server as the daemon, as a loopback-only service. The server operator installs and supervises Typesense. The daemon connects to it, and owns all writes and all queries. Clients use only the daemon WebSocket connection.

The daemon reaches the engine through one narrow interface:

```text
ConversationIndex
  upsert(chunks)
  deleteAgent(agentId)
  search(query, mode, filter, limit) -> grouped hits
  health()
```

Nothing outside the adapter imports a Typesense type. This keeps the engine replaceable if the [evaluation gate](#rollout) fails.

Typesense is selected for three properties:

- Hybrid search with rank fusion of keyword and vector results in one query.
- Built-in embedding models that run on CPU inside the Typesense process. Paseo does not need its own embedding runtime.
- `group_by`, which returns sessions with their best excerpts rather than a flat list of messages.

## Architecture

```text
Provider history (authoritative)
        |
Projected user and assistant items
        |
        +--- live: turn finished ---------+
        +--- backfill: history-only load -+
                                          v
                                  Chunker + index state store
                                          |
                                  ConversationIndex adapter
                                          |
                                  Typesense service (loopback)
                                          |
conversation.search.request  ---->  grouped hits + coverage
conversation.search.resolve.request ->  current epoch + seq
                                          |
                          existing scroll-to-message navigation
```

## Index Documents

One document is one chunk of one message.

A message is split into chunks that fit the embedding model input limit. Text past that limit is truncated by the model and cannot be found by meaning, so chunking is required, not an optimization. Chunks split on paragraph and code-fence boundaries with a small overlap. A short message is one chunk.

| Field | Purpose |
| --- | --- |
| `id` | `{agentId}:{messageKey}:{chunkIndex}`. |
| `agentId`, `workspaceId`, `projectKey` | Grouping, ownership, and filters. |
| `provider`, `branch`, `archived` | Filters and result context. |
| `role` | `user` or `assistant`. |
| `messageKey` | Provider `messageId` when the item has one. Otherwise `o{ordinal}`, the position of the item among the agent's user and assistant items. |
| `ordinal` | Position among the agent's user and assistant items. Used to resolve the message when `messageId` is absent or changed. |
| `messageHash` | Hash of the full message text. Used to detect change and to verify resolution. |
| `createdAt` | Recency ranking and date filters. |
| `text` | Chunk text, extracted with the same function as in-chat Find. |
| `embedding` | Vector generated by Typesense from `text`. Present only when semantic search is on. |

The document does not store `epoch` or `seq`.

Session title and the first user prompt are also indexed as one extra chunk per agent with `role: "user"` and `ordinal: 0`. A gist query often matches how the session started.

## Indexing

### Live

The writer indexes when a turn ends: on `turn_completed`, `turn_failed`, or cancel. It reads the turn's user and assistant items from the in-memory projection. A user message is indexed when its canonical submitted row is recorded.

There is no coalescing timer and no indexing of streaming deltas. A message is indexed once, when it is final.

### Backfill

On enable, and after a schema or model change, the backfill controller walks eligible agents, newest first, one at a time.

- If the agent is already loaded, it reads the in-memory projection. It does not reload the agent, so it never mints a new epoch under a connected client.
- If the agent is not loaded, it loads it with `purpose: "history"`, indexes it, and closes it again. It never opens an interactive session for indexing.
- It yields to active agents. Backfill pauses while any agent on the daemon is running a turn.

The cost of a history-only load differs per provider and must be measured before this ships. See the [evaluation gate](#rollout).

### Index state

The daemon keeps one small record per agent in `$PASEO_HOME/search/state.json`, written atomically as described in `docs/data-model.md`:

```text
agentId, indexedMessageCount, lastMessageHash, sourceUpdatedAt,
schemaVersion, embeddingModel, status (indexed | pending | failed), error class
```

Backfill skips an agent whose record matches the stored agent's `updatedAt`, the current `schemaVersion`, and the current `embeddingModel`. This makes restart cheap: the daemon does not load every agent to learn that nothing changed.

A rewind, reload from disk, or compaction changes history. The writer detects this when the stored `lastMessageHash` at `indexedMessageCount` no longer matches. It deletes that agent's documents and re-indexes the agent.

Agent deletion removes every document with that `agentId` and its state record. Archive changes update the `archived` field.

## Search and Ranking

Each request runs one Typesense query with `group_by: agentId`. The response is a list of sessions. Each session carries up to three excerpts.

| Mode | Query | When |
| --- | --- | --- |
| `keyword` | Lexical on `text`, typo tolerance on, quoted phrases exact. | Semantic search is off, or the query is quoted. |
| `hybrid` | Lexical and vector, fused by rank. | Default when semantic search is on. |

Ranking rules:

- The lexical side keeps the larger fusion weight. An exact error string or symbol must outrank a vague semantic neighbor.
- User chunks rank above assistant chunks at equal relevance. The user request is "something I said."
- Recency is a tie breaker only.
- Typo tolerance is off for tokens that look like code: paths, identifiers with punctuation, hex strings.

Fusion weights are set from the golden query set in the evaluation gate, not chosen by hand.

Permission and scope filters go into the engine query as `filter_by`. The daemon does not filter results after retrieval, because post-filtering breaks the result limit and can return an empty page that has matches.

The app debounces input and sends a `requestId`. The daemon answers only the newest request per client.

### Multiple hosts

The app sends one request to each connected daemon that advertises the feature. Scores from separate indexes are not comparable. The app groups results by host.

## Result Navigation

A result identifies a message by `agentId`, `messageKey`, `ordinal`, and `messageHash`. The app resolves it when the user selects it:

1. The app sends `conversation.search.resolve.request`.
2. The daemon loads the agent if needed, finds the projected item by `messageId`, or by `ordinal` verified with `messageHash`, and returns the current `epoch` and `seq`.
3. The app opens the chat and scrolls with the existing scroll-to-message path.

If the message no longer exists, the daemon returns `found: false`. The app opens the chat at its tail and says the message is no longer in this session's history. The daemon marks the agent `pending` so backfill repairs it.

## Lifecycle and Coverage

Engine state and index coverage are separate. The previous draft mixed them into one state.

Engine state, one per daemon:

| State | Meaning |
| --- | --- |
| `disabled` | The user has not enabled conversation search. |
| `preparing` | The daemon is creating the collection, or Typesense is downloading the embedding model. |
| `ready` | Typesense answers queries. |
| `unreachable` | Typesense does not answer. The daemon retries with bounded backoff. |
| `failed` | The writer failed. Carries an error class and a retry action. |

Coverage, in every search and status response:

```text
eligible, indexed, pending, failed   (agent counts)
```

The app shows "No matches" only when engine state is `ready` and `pending` and `failed` are both zero for every searched host. Otherwise it shows results with a coverage notice, for example "Indexed 412 of 530 sessions."

## Protocol and Client Contract

```text
conversation.search.request            workspace.read
conversation.search.response
conversation.search.resolve.request    workspace.read
conversation.search.resolve.response
conversation.search.status.request     workspace.read
conversation.search.status.response
conversation.search.configure.request  daemon.manage
conversation.search.configure.response
```

`configure` carries one action: `enable`, `disable`, `set_semantic`, `rebuild`, or `clear`. These change daemon state and consume disk, CPU, and network, so they need `daemon.manage`. The previous draft gave rebuild the read permission.

`server_info.features.conversationSearch` gates the app surface. A daemon with no Typesense settings does not advertise it. The app does not send these RPCs to a daemon without the feature. Follow `docs/protocol-compatibility.md` and `docs/rpc-namespacing.md`.

## Deployment

The first release targets one deployment: the daemon and Typesense run on the same Linux server.

- The operator installs Typesense from the official DEB package or the official Docker image, pinned to one version. systemd or Docker supervises it. The daemon does not download, start, or stop Typesense.
- Typesense listens on `127.0.0.1` only. Its data directory is outside `$PASEO_HOME`, owned by the Typesense service user.
- The daemon reads two settings: `conversationSearch.typesense.url` and `conversationSearch.typesense.apiKeyFile`. The key is in a file with mode `0600`, not in `config.json`, so config backups do not copy it.
- A daemon without these settings does not advertise the feature.
- The daemon creates its collection with a name that includes the daemon id and `schemaVersion`. A schema change builds a new collection and drops the old one after backfill.

This removes process supervision, binary download, and installer changes from the first release. It also keeps the GPL-3.0 Typesense server a separately installed program. Paseo, which is Apache-2.0, only calls its HTTP API.

Typesense has no native Windows binary. A daemon-managed sidecar for desktop installs is a later decision and is not part of this design.

Reference host for sizing: x86_64, Ubuntu 24.04, 8 cores, 22 GB RAM, Docker available.

## Configuration, Privacy, and Resources

Conversation search is off by default. Semantic search is a second switch, off by default.

- Index state lives in `$PASEO_HOME/search/` with mode `0700`. The Typesense data directory holds plain message text. This is the same exposure as the provider transcript files already on the machine, and the settings screen says so.
- After the daemon creates the collection, it uses a Typesense key scoped to that collection, not the admin key.
- Embeddings are computed inside Typesense. Message text and queries do not leave the machine. Enabling semantic search downloads the model once. The setting states the download size and source.
- The model must be multilingual. The app ships in nine languages.
- The daemon logs counts, durations, and error classes. It does not log text, queries, excerpts, keys, or vectors.

Typesense holds its index in RAM, about two to three times the indexed text size, plus vectors. The daemon enforces a budget: it indexes newest sessions first and stops at a configured size. Sessions past the budget count as `pending` with a distinct reason, so the app does not claim full coverage. The default budget comes from the corpus measurement in the evaluation gate.

## Failure Handling

Typesense failure must not affect agent creation, streaming, timeline hydration, or Sessions metadata search. The writer never runs on the stream path. It reads finished turns.

- A failed write marks the agent `pending`. Backfill retries it with bounded backoff.
- A Typesense outage moves engine state to `unreachable`. The daemon does not restart Typesense. Its supervisor does. When Typesense answers again, the state store identifies what is missing.
- If the collection is missing or damaged, the daemon recreates it and runs backfill. No user data is lost.
- Writes are idempotent. Document ids are deterministic and `messageHash` skips unchanged messages.

## Rollout

1. **Evaluation gate. No product code.** Export one real `$PASEO_HOME` corpus to a throwaway script and a local Typesense. Record:
   - Corpus size, chunk count, index RAM, and build time.
   - History-only load cost per provider, and whether any provider starts a process for it.
   - A golden set of at least 20 real queries the user could not answer with Sessions search, with the expected session for each.
   - Recall at 5 for keyword and for hybrid on that set.

   Continue only if hybrid recall is clearly better than keyword and RAM fits a default budget. If hybrid does not beat keyword, Typesense is not justified and the design returns to an embedded lexical index.
2. Index service, state store, backfill, and `status` and `configure` RPCs. No search surface.
3. `search` and `resolve` RPCs, Sessions screen mode, excerpts, and navigation. Keyword and hybrid ship together.
4. Multi-host grouping.
5. Operator documentation: install, pin, and upgrade Typesense on the server.

The current metadata search stays unchanged throughout.

## Test Strategy

Follow `docs/testing.md`: real dependencies over mocks. Add to existing suites.

- Chunker: boundaries, overlap, code fences, model input limit, deterministic ids.
- Text extraction parity: the indexed text for an item equals what in-chat Find matches.
- State store: skip unchanged agents, detect rewind and compaction, schema and model version bumps.
- Backfill: an already loaded agent keeps its epoch. An unloaded agent is closed after indexing. Backfill pauses during an active turn.
- Resolve: by `messageId`, by `ordinal` with hash, and the not-found path. One test restarts the daemon between search and resolve.
- Coverage: no "No matches" state while `pending` or `failed` is above zero.
- Permissions: `configure` refuses a principal without `daemon.manage`. Search results never include an agent outside the principal's scope.
- Protocol compatibility: an old client parses new daemon messages. An old daemon hides the feature.
- One daemon integration test with a real Typesense container on Linux CI.
- Outage: the daemon stays healthy and metadata search works while Typesense is stopped.
- The golden query set runs as a recall benchmark, not a pass or fail unit test.

## Alternatives

**Embedded index (SQLite FTS5 with a vector extension, or LanceDB).** No separate service and it works on every platform. Paseo would own embedding generation and rank fusion. This is the fallback if the evaluation gate fails, and the likely path for desktop installs.

**Meilisearch.** Same service shape, with a native Windows binary and hybrid search. Not needed for a Linux server deployment.

**SereneDB.** Search plus analytics in one server. This feature needs a small rebuildable retrieval index, not an analytical database.

## Review Questions

1. Should the operator install Typesense from the DEB package under systemd, or run the Docker image?
2. Should archived sessions appear by default, or behind a filter?
3. Should provider child transcripts be indexed in a later release?
4. Is one "Search conversations" field with automatic hybrid mode correct, or does the user need an explicit "Search by meaning" control?
