# Conversation Search Design

Status: Draft for review, revision 5

## Purpose

Sessions search finds session metadata. It does not find conversation text. A user who remembers something they said, or the subject of a past conversation, cannot find the session.

This design adds conversation search across sessions. The user need has two parts:

- Find exact text: an error, file path, code symbol, or phrase.
- Find a session by its meaning: "the discussion about aggressive reconnect retries."

The second part is the reason for this work. Keyword search alone does not satisfy it, so semantic search is in the first usable release, not a later addition.

## Scope

The first release indexes visible user and assistant message text for root agents. A result is a session with its best matching excerpts. Selecting an excerpt opens the chat at that message.

Two deployment modes ship. See [Deployment modes](#deployment-modes).

- **Per-host.** Each daemon indexes its own sessions. The app searches every connected host.
- **Central.** One daemon also indexes the sessions of other hosts, so one search covers all of them, including hosts that are offline.

The first release excludes:

- Tool calls and tool output.
- Terminal content.
- Attachments and binary payloads.
- Reasoning text.
- Provider child (subagent) transcripts.
- Remote embedding services.

This feature does not replace Sessions metadata search. The index is not a source of truth.

## Existing Code This Design Builds On

| Code | What it does | How this design uses it |
| --- | --- | --- |
| `packages/server/src/server/agent-history-search.ts` | Ranks every persisted agent on workspace, title, branch, and project name. | Unchanged. Conversation search is a separate mode. |
| `packages/server/src/server/agent/chat-search/index.ts` | In-chat Find for one loaded agent (`agent.timeline.search.request`). Extracts searchable text from projected items and returns `seq` locations. | Reuse its text extraction so the index and in-chat Find match the same text. |
| `packages/app/src/agent-stream/use-scroll-to-message.web.ts` and `chat-find/` | Loads history and scrolls to a `seq`. | Reuse for result navigation. |
| `packages/server/src/server/speech/providers/local/sherpa/model-downloader.ts` | Downloads and verifies an ONNX model on demand. | Same pattern for the embedding model. |
| `packages/client/src/daemon-client.ts` | Authenticated client for the daemon Session protocol. | The central indexer uses it to read sessions from other hosts. |

## Constraints From the Timeline Model

These facts shape the design. `docs/timeline-sync.md` owns the detail.

1. The daemon keeps projected timeline items in memory only. Provider history is the durable transcript.
2. The timeline `epoch` is a random UUID minted each time an agent's timeline is initialized (`agent-timeline-store.ts`). It changes on daemon restart, on reload, and on rewind. An `epoch` and `seq` pair is valid only while that in-memory timeline lives.
3. Loading a stored agent calls `resumeAgentFromPersistence`, which opens a provider session. Archived agents open with `purpose: "history"`.
4. An index can be incomplete during backfill or after a failure. The app must not show "No matches" unless coverage is complete for the searched scope.

Constraint 2 means an index document cannot store `epoch` and `seq` as its identity or its navigation target. Both would be invalid after the next daemon restart.

## Decision

Embed the index in the daemon with LanceDB. No separate search service. The daemon owns the index files, all writes, and all queries. Clients use only the daemon WebSocket connection.

The daemon reaches the engine through one narrow interface:

```text
ConversationIndex
  upsert(chunks)
  deleteAgent(agentId)
  search(query, mode, filter, limit) -> grouped hits
  health()
```

Nothing outside the adapter imports a LanceDB type.

Why LanceDB and not a service:

- **BM25 keyword ranking.** Rare words outrank common words. The evaluation showed this is the property that finds "the session where I mentioned useanvil" from a sentence. Typesense and Meilisearch rank by match count and drop query words by position, so a rare word at the end of a sentence is dropped first. They needed a hand-made stop-word list to come close, and still lost.
- **Vectors and BM25 in one store**, with the fusion done by Paseo.
- **A library, not a process.** Nothing to install or supervise per host. It works on every platform the daemon runs on, including Windows.
- The whole history of a busy host is tens of megabytes of text. A service buys nothing at that size.

Embeddings are computed inside the daemon with `onnxruntime-node` and the `multilingual-e5-small` model, downloaded on enable through the existing ONNX model-downloader pattern. The model must be multilingual because the app ships in nine languages.

The previous revision chose a Typesense service. The evaluation replaced that decision; see [Evaluation](#evaluation).

## Architecture

```text
Provider history (authoritative)
        |
Projected user and assistant items
        |
        +--- live: turn finished --------------+
        +--- backfill: history-only load ------+
        +--- central: pulled from other hosts -+
                                               v
                               Chunker + embedder + index state store
                                               |
                                      ConversationIndex (LanceDB)
                                               |
conversation.search.request  ---->  BM25 hits + vector hits -> RRF -> grouped by session
conversation.search.resolve.request ->  current epoch + seq
                                               |
                               existing scroll-to-message navigation
```

## Index Documents

One document is one chunk of one message.

Chunks are at most 128 model tokens, about 400 to 500 characters. The embedding model truncates longer input, and the evaluation showed the Typesense embedder truncated 1,200-character chunks at 128 tokens without reporting it. Text past the limit cannot be found by meaning. Chunks split on paragraph and code-fence boundaries with a small overlap. A short message is one chunk.

| Field | Purpose |
| --- | --- |
| `id` | `{hostId}:{agentId}:{messageKey}:{chunkIndex}`. |
| `hostId` | The daemon that owns the session. Equals the local daemon id in per-host mode. |
| `agentId`, `workspaceId`, `projectKey` | Grouping, ownership, and filters. |
| `provider`, `branch`, `archived` | Filters and result context. |
| `automated` | True for sessions started by schedules, heartbeats, or Hub triggers. Excluded by default. |
| `role` | `user` or `assistant`. |
| `messageKey` | Provider `messageId` when the item has one. Otherwise `o{ordinal}`. |
| `ordinal` | Position among the agent's user and assistant items. Used to resolve the message when `messageId` is absent or changed. |
| `messageHash` | Hash of the full message text. Used to detect change and to verify resolution. |
| `createdAt` | Recency ranking and date filters. |
| `text` | Chunk text, extracted with the same function as in-chat Find. BM25 indexed. |
| `vector` | 384-dimension embedding of `text`. Present only when semantic search is on. |

The document does not store `epoch` or `seq`.

Session title and the first user prompt are also indexed as one extra chunk per agent with `role: "user"` and `ordinal: 0`. A gist query often matches how the session started.

The `automated` flag exists because the evaluation showed scheduled recaps, digests, and extraction jobs filling every result list. They are searchable behind a filter, not by default.

## Indexing

### Live

The writer indexes when a turn ends: on `turn_completed`, `turn_failed`, or cancel. It reads the turn's user and assistant items from the in-memory projection. A user message is indexed when its canonical submitted row is recorded.

There is no coalescing timer and no indexing of streaming deltas. A message is indexed once, when it is final.

Embedding runs in a worker thread so it never blocks the event loop. One turn is a handful of chunks and takes well under a second.

### Backfill

On enable, and after a schema or model change, the backfill controller walks eligible agents, newest first, one at a time.

- If the agent is already loaded, it reads the in-memory projection. It does not reload the agent, so it never mints a new epoch under a connected client.
- If the agent is not loaded, it loads it with `purpose: "history"`, indexes it, and closes it again. It never opens an interactive session for indexing.
- It yields to active agents. Backfill pauses while any agent on the daemon is running a turn.
- BM25 indexing is fast. Embedding is the slow step, on the order of tens of chunks per second on CPU. Backfill writes the BM25 index first so keyword search works within seconds, then embeds in the background and reports progress. "Search by meaning" shows partial coverage until embedding finishes.

The cost of a history-only load differs per provider and must be measured per provider before this ships.

### Index state

The daemon keeps one small record per agent in `$PASEO_HOME/search/state.json`, written atomically as described in `docs/data-model.md`:

```text
hostId, agentId, indexedMessageCount, lastMessageHash, sourceUpdatedAt,
schemaVersion, embeddingModel, textIndexed, vectorsIndexed,
status (indexed | pending | failed), error class
```

Backfill skips an agent whose record matches the stored agent's `updatedAt`, the current `schemaVersion`, and the current `embeddingModel`. This makes restart cheap: the daemon does not load every agent to learn that nothing changed.

A rewind, reload from disk, or compaction changes history. The writer detects this when the stored `lastMessageHash` at `indexedMessageCount` no longer matches. It deletes that agent's documents and re-indexes the agent.

Agent deletion removes every document with that `agentId` and its state record. Archive changes update the `archived` field.

## Search and Ranking

Each request runs one or two queries against the index, then groups by `agentId`. The response is a list of sessions. Each session carries up to three excerpts.

| Mode | Query | When |
| --- | --- | --- |
| `keyword` | BM25 on `text` and `title`. Quoted phrases exact. | Default. |
| `hybrid` | BM25 list and vector list, fused with reciprocal rank fusion. | The user turns on **Search by meaning**. |

**Search by meaning** is an explicit control next to the search field. The app does not choose the mode for the user. The control is disabled, with a reason, when semantic search is off on the daemon or the vectors are not yet built. The app remembers the last setting.

Ranking rules:

- Reciprocal rank fusion with equal list weights is the starting point. In the evaluation it kept exact rare-word matches at the top while letting the vector list surface sessions that share no words with the query.
- User chunks get a ranking boost at equal relevance. The user request is "something I said." A filter to user chunks only lost targets in the evaluation; it is a boost, not a filter.
- Recency is a tie breaker only.
- Archived sessions are included by default. A filter excludes them. Automated sessions are excluded by default. A filter includes them.

Permission and scope filters go into the engine query, not into post-filtering, because post-filtering breaks the result limit and can return an empty page that has matches.

The app debounces input and sends a `requestId`. The daemon answers only the newest request per client.

### Multiple hosts

In per-host mode, the app sends one request to each connected daemon that advertises the feature. Scores from separate indexes are not comparable. The app groups results by host.

In central mode, the app sends the request to the central daemon, which returns results from every indexed host in one ranked list, each with its `hostId`. The app still searches a connected host directly when that host is not covered by the central index.

## Result Navigation

A result identifies a message by `hostId`, `agentId`, `messageKey`, `ordinal`, and `messageHash`. The app resolves it when the user selects it:

1. The app sends `conversation.search.resolve.request` to the daemon that owns the session, identified by `hostId`.
2. That daemon loads the agent if needed, finds the projected item by `messageId`, or by `ordinal` verified with `messageHash`, and returns the current `epoch` and `seq`.
3. The app opens the chat and scrolls with the existing scroll-to-message path.

If the owning host is offline, the app shows the excerpt and the session title and says the host must be online to open the chat. If the message no longer exists, the daemon returns `found: false`; the app opens the chat at its tail and says the message is no longer in this session's history.

## Deployment Modes

### Per-host

Every daemon with conversation search enabled indexes its own sessions. Nothing is installed. This is the default and needs no configuration beyond the enable switch.

### Central

One daemon is the central indexer. It indexes its own sessions and pulls sessions from other hosts. It does this as an ordinary client of each other daemon, through the existing Session protocol, with a credential that carries `workspace.read` and nothing else. It lists agents, reads timelines through the existing timeline RPCs, and detects change through the same `updatedAt` watermark as local backfill.

This needs no new code on the other hosts. Any daemon that a Paseo client can read can be indexed. It also means the central indexer loads agents on the other hosts the same way local backfill does, so the same pacing rules apply there: one agent at a time, pause while that host runs a turn.

The connection is outbound from the central daemon to each host, using the same host addresses and credentials the app uses. The central daemon persists one relationship record per host under `$PASEO_HOME/search/hosts/`. Removing a host deletes its documents.

Text leaves the owning host in central mode. The host's transcripts are copied to the central daemon's index. The settings screen says so when a host is added, and a host can only be added by a principal with `daemon.manage` on the central daemon and a `workspace.read` credential for the host.

The reference deployment for central mode is this Linux server: x86_64, Ubuntu 24.04, 8 cores, 22 GB RAM.

## Lifecycle and Coverage

Engine state and index coverage are separate.

Engine state, one per daemon:

| State | Meaning |
| --- | --- |
| `disabled` | The user has not enabled conversation search. |
| `preparing` | The daemon is creating the index, or downloading the embedding model. |
| `ready` | The index answers queries. |
| `failed` | The index or writer failed. Carries an error class and a retry action. |

Coverage, in every search and status response, per host:

```text
hostId, eligible, indexed, pending, failed   (agent counts)
vectorsIndexed                              (agent count, for Search by meaning)
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

`configure` carries one action: `enable`, `disable`, `set_semantic`, `rebuild`, `clear`, `add_host`, or `remove_host`. These change daemon state and consume disk, CPU, and network, so they need `daemon.manage`.

`server_info.features.conversationSearch` gates the app surface. The app does not send these RPCs to a daemon without the feature. Follow `docs/protocol-compatibility.md` and `docs/rpc-namespacing.md`.

## Configuration, Privacy, and Resources

Conversation search is off by default. Semantic search is a second switch, off by default.

- Index files live in `$PASEO_HOME/search/` with mode `0700`. They hold plain message text. This is the same exposure as the provider transcript files already on the machine, and the settings screen says so.
- Enabling semantic search downloads the embedding model once, with a pinned checksum. The setting states the download size and source. Message text and queries never leave the machine in per-host mode.
- In central mode, text leaves the owning host for the central daemon. See [Central](#central).
- The daemon logs counts, durations, and error classes. It does not log text, queries, excerpts, or vectors.

Resources: the index on disk is of the same order as the indexed text plus 1.5 KB per chunk for vectors. Query memory is small. The embedding model is loaded only while a backfill or a live turn needs it, and unloaded after an idle period, because it is hundreds of megabytes in memory.

## Failure Handling

Index failure must not affect agent creation, streaming, timeline hydration, or Sessions metadata search. The writer never runs on the stream path. It reads finished turns.

- A failed write marks the agent `pending`. Backfill retries it with bounded backoff.
- A damaged index directory is deleted and rebuilt. No user data is lost.
- Writes are idempotent. Document ids are deterministic and `messageHash` skips unchanged messages.
- A host the central daemon cannot reach stays `pending` with reason `unreachable`. Its already indexed documents remain searchable.

## Evaluation

Step 1 of the previous rollout ran on this server with an export of its own sessions and a set of real queries from the user. Numbers stay out of this document; the conclusions that changed the design are:

- Typesense keyword ranking lost sessions that a BM25 index found first, because it has no rare-word weighting and drops query words by position. A stop-word list helped and was not enough.
- LanceDB BM25 found those sessions without tuning. Adding its vector list through reciprocal rank fusion kept them at the top and added sessions that share no words with the query.
- The Typesense built-in embedder silently truncated chunks at 128 tokens. Chunk size is now set to that limit.
- Automated sessions dominated results until excluded.
- Several queries found nothing because the sessions live on another host. That is the reason for central mode.
- Embedding on CPU runs at tens of chunks per second, so a full backfill of a busy host takes tens of minutes and must run in the background.

The throwaway scripts and data for this evaluation are outside the repository.

## Rollout

1. Index service with BM25 only: chunker, state store, backfill, `status` and `configure` RPCs. No search surface.
2. `search` and `resolve` RPCs, Sessions screen mode, excerpts, and navigation.
3. Embedding worker, model download, vector index, **Search by meaning** control.
4. Central mode: host relationships, remote backfill, `hostId` in results, offline-host handling in the app.
5. Per-provider measurement of history-only load cost, and backfill pacing from those numbers.

The current metadata search stays unchanged throughout.

## Test Strategy

Follow `docs/testing.md`: real dependencies over mocks. Add to existing suites.

- Chunker: boundaries, overlap, code fences, the 128-token limit, deterministic ids.
- Text extraction parity: the indexed text for an item equals what in-chat Find matches.
- State store: skip unchanged agents, detect rewind and compaction, schema and model version bumps.
- Backfill: an already loaded agent keeps its epoch. An unloaded agent is closed after indexing. Backfill pauses during an active turn.
- Ranking: a query with one rare word ranks the session containing it first. Automated sessions are absent by default.
- Resolve: by `messageId`, by `ordinal` with hash, the not-found path, and the offline-host path. One test restarts the daemon between search and resolve.
- Coverage: no "No matches" state while `pending` or `failed` is above zero.
- Permissions: `configure` refuses a principal without `daemon.manage`. Search results never include an agent outside the principal's scope.
- Central mode: two in-process daemons from `docs/ad-hoc-daemon-testing.md`; one indexes the other with a `workspace.read` credential; removing the host deletes its documents.
- Protocol compatibility: an old client parses new daemon messages. An old daemon hides the feature.
- The embedding worker never runs on the main thread; a test asserts event-loop latency during a backfill.
- A recall benchmark over a query set runs as a benchmark, not a pass or fail unit test.

## Alternatives

**Typesense or Meilisearch service.** Built-in embedding and typo tolerance, but match-count ranking without rare-word weighting, and a process to install on every host. Rejected by the evaluation.

**SQLite FTS5 with a vector extension.** Same BM25 quality as LanceDB in the evaluation, and smaller. Paseo would carry a vector extension and an ANN index itself. A valid fallback if LanceDB's native module causes packaging trouble in Electron or Nix.

**OpenSearch, or Postgres with ParadeDB and pgvector.** BM25 and vectors in one server. Only worth it for a shared index far larger than one user's hosts. Central mode covers the multi-host need without a server.

**SereneDB.** Search plus analytics in one server. This feature needs a small rebuildable retrieval index, not an analytical database.

## Review Questions

1. Should provider child transcripts be indexed in a later release?
2. In central mode, should the app prefer the central result list and hide per-host results, or merge both?
