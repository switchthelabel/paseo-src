---
name: paseo-memory
description: Shared long-term memory on this daemon. Search it at task start; write a checkpoint before you finish.
---

# Shared memory (paseo-memory)

Every agent on this daemon shares one memory vault through the `basic-memory`
MCP server. The tools are preapproved; call them without asking.

## At task start

Before you plan the work:

1. Call `search_notes` with the key terms of the task. Use specific terms;
   the search is semantic.
2. If a result looks close to the task, call `read_note` on it and use what
   the earlier agent learned. Call `build_context` when you need the notes
   around a topic.

If the search returns nothing that fits, continue; the vault is empty for
this task.

## Before you finish

Write a checkpoint with `write_note`:

- `title`: `Checkpoint — <short task name> — <date>`
- `directory`: `checkpoints`
- `tags`: the task type and the project name
- `content`, with one section per heading:
  - `## Objective and result` — what the task asked for and what happened
  - `## Decisions` — choices made and why
  - `## Files` — paths touched
  - `## Commands and tests` — what you ran and the outcome
  - `## Unresolved` — open problems, with the next action

The daemon also writes a reduced checkpoint at turn end. Your note is the
richer record; write it even when a turn-end checkpoint exists.

## Never write to memory

- Credentials, tokens, keys, or environment values
- Raw transcripts
- Any secret you were told to keep out of logs

If a value looks like a credential, do not put it in a note. Name the file or
setting that holds it instead.
