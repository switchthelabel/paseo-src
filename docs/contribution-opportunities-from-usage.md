# Paseo Contribution Opportunities from Real Usage

**Date:** 2026-10-17  
**Status:** Recommendation  
**Primary recommendation:** Improve the agent-facing workspace inventory so it exposes Git state that Paseo already computes.

## Executive summary

The strongest contribution opportunity is a focused server bug fix:

> `list_workspaces` should expose the workspace Git state that Paseo already sends to app clients.

Paseo already computes this state. The daemon already broadcasts it through the workspace runtime payload. The agent-facing automation tool reduces each workspace to identity fields and drops the Git facts.

This gap forces automation to inspect every worktree with separate Git commands. It also makes fleet views, cleanup tools, session dashboards, and agent coordination less reliable. The fix can reuse the existing cached runtime snapshot. It does not need a new inventory service or new Git subprocesses.

The best contribution sequence is:

1. Discuss the workflow and the contract gap.
2. Open a focused bug report with concrete evidence.
3. Submit a small server pull request if the maintainer accepts the direction.

The next useful contribution is a provider capability mismatch in `create_agent`. A later contribution should document the scope of `list_agents`. Archive safety remains important, but existing upstream issues already cover most of that work.

## Scope and evidence

This report uses the relevant shared Paseo session memory requested for this analysis, local repository documentation, current source code, and the Opus advisor review.

The session history shows a real multi-agent workflow rather than a single coding session:

- 478 agent sessions existed for the repository since 2026-08-28.
- Those sessions used 151 distinct worktrees.
- The repository had about 90 local branches in the observed state.
- 38 branches had no commits.
- 30 branches had no upstream.
- 22 branches had already merged.
- The observed work included questions, reviews, research, monitoring, and model probes.
- Fewer than one session in ten was a build task.

These numbers show two important conditions:

1. Paseo must support more than build-and-commit work.
2. Automation needs reliable state across many workspaces and sessions.

This is not product telemetry. It is an analysis of the available session records and repository state. Counts can change as the server creates new sessions and worktrees.

## What the usage pattern shows

The original opportunity list contained five themes:

1. Intent-aware routing for questions, research, and implementation.
2. Safe archive and recovery for worktrees.
3. A global workspace and agent inventory.
4. Checkpoints, handoffs, and session continuity.
5. Provider and task routing.

All five themes describe real friction. The usage evidence also shows that they do not all belong in Paseo core.

Some of the workflow already exists in local plugins and operations tools. The current environment includes session routing, branch shipping, teardown cleanup, branch sweeping, and checkpoint support. Rebuilding those systems in core would duplicate working solutions and increase maintenance cost.

The archive concern also overlaps existing upstream work. A contribution should add new evidence to those discussions rather than create a duplicate request.

The global inventory concern contains the clearest core defect. Paseo has much of the required data already. The agent-facing projection does not expose it.

## The key finding from the Opus review

The app-facing protocol defines `WorkspaceGitRuntimePayloadSchema` in [`packages/protocol/src/messages.ts`](../packages/protocol/src/messages.ts).

The payload already includes these fields:

- `currentBranch`
- `remoteUrl`
- `isPaseoOwnedWorktree`
- `isDirty`
- `aheadBehind.ahead`
- `aheadBehind.behind`
- `aheadOfOrigin`
- `behindOfOrigin`

The daemon computes and broadcasts this information to app clients.

The agent-facing tool uses a smaller schema in [`packages/server/src/server/agent/tools/paseo-tools.ts`](../packages/server/src/server/agent/tools/paseo-tools.ts). `WorkspaceAutomationSummarySchema` currently includes only:

- `workspaceId`
- `projectId`
- `cwd`
- `isolation`
- `kind`
- `title`

The `list_workspaces` tool also filters out archived workspaces and accepts no input.

This creates a projection gap:

```text
Git state is computed
        |
        +--> App runtime payload: Git state is available
        |
        +--> Agent automation summary: Git state is dropped
                                      |
                                      +--> Automation runs extra Git commands
```

The Session Sentinel workflow exposed this gap. It had to inspect Git directly across 151 worktrees. That work was a workaround for missing data in the tool contract.

The correction is therefore smaller than the original proposal. Paseo does not need a new global inventory system for this use case. It needs the existing workspace state to remain available across its client surfaces.

## Recommended first contribution

### Title

Expose cached workspace Git state from `list_workspaces`

### Problem statement

Agents can list active workspaces, but the result does not include the Git state that Paseo already knows.

An agent cannot reliably determine the following facts from the tool result:

- Which branch the workspace uses.
- Whether the workspace has uncommitted changes.
- Whether the directory is a Paseo-owned worktree.
- Which remote the workspace uses.
- Whether the branch is ahead of or behind its comparison target.

The agent must inspect each directory with Git commands. That approach increases latency and creates inconsistent results. It also duplicates the daemon's existing Git reads.

### Proposed change

Extend the workspace automation summary with optional fields that match the existing workspace Git runtime payload.

The summary should expose the existing values without creating a second Git inspection path:

- `currentBranch: string | null`
- `remoteUrl: string | null`
- `isPaseoOwnedWorktree: boolean`
- `isDirty: boolean | null`
- `aheadBehind: { ahead: number, behind: number } | null`
- `aheadOfOrigin: number | null`
- `behindOfOrigin: number | null`

The implementation should read the cached workspace runtime snapshot. It should not start new Git subprocesses for each tool call. This aligns with the existing P1 concern in upstream issue [#2391](https://github.com/getpaseo/paseo/issues/2391), which calls for deduplicated Git reads.

### Archived workspaces

The tool should preserve its current default behavior. Existing callers should continue to receive active workspaces unless they request archived records.

An additive option such as `includeArchived: boolean` can support cleanup and audit workflows. The default should remain `false`.

The archived record should include enough state to explain why the workspace is no longer active. The exact field name should follow the existing workspace record contract. The change should not force a new archive model into the tool.

### Why this is the best first change

This contribution has four strong properties:

- **High reuse:** Many agents can use the same state.
- **Small scope:** The change affects one automation schema and one mapper.
- **Low risk:** Optional fields preserve existing callers.
- **Low duplication:** The implementation reuses existing runtime data.

It also supports several workflows at once:

- Session Sentinel can rank workspaces without shelling out to Git.
- Cleanup tools can find dirty worktrees before archive operations.
- Fleet views can show branch and synchronization state.
- Agents can select a workspace with evidence instead of directory names.
- Operators can distinguish local checkouts from Paseo-owned worktrees.

## Acceptance criteria

The change should meet these criteria:

1. `list_workspaces` keeps its current default behavior.
2. The result includes the existing cached Git state when Paseo has it.
3. Missing Git state remains `null` or absent according to the current runtime contract.
4. The result does not require a new Git subprocess per workspace.
5. Clean and dirty workspaces produce distinct, correct results.
6. Branch names and remote URLs match the app-facing runtime state.
7. Ahead and behind values match the existing runtime snapshot.
8. Archived workspace behavior is explicit and tested.
9. Old callers can parse the result without changes.
10. App-facing and agent-facing workspace projections use the same source values.

## Non-goals

The first contribution should not include:

- A new global inventory service.
- A new Git cache or reconciliation system.
- A large app interface.
- Archive deletion or recovery redesign.
- Automatic branch cleanup.
- A new provider abstraction.
- Required fields that break older callers.

These boundaries keep the change suitable for a focused bug-fix pull request.

## Ranked contribution backlog

### 1. Workspace Git state parity

**Priority:** Highest  
**Shape:** Reproducible contract bug  
**Owner:** `packages/server`  
**Likely files:** [`packages/server/src/server/agent/tools/paseo-tools.ts`](../packages/server/src/server/agent/tools/paseo-tools.ts) and the existing workspace runtime mapping code

This is the recommended contribution. It fixes a clear mismatch between data that Paseo already computes and data that an automation client receives.

### 2. Provider capability validation in `create_agent`

The session records show a provider mismatch in about 19.1 percent of observed `create_agent` failures. The measured sample contained 21 failures in 110 sessions.

The failures included cases such as:

- A provider could not inherit the caller's `auto` mode.
- A provider rejected `modeId` or `thinkingOptionId`.

The tool advertises parameters that the selected provider cannot always honor. The likely core fix is to validate or normalize provider capabilities before the request reaches the provider.

This is a good second contribution because it is bug-shaped, reproducible, and useful across providers. It needs a provider capability matrix and regression tests for unsupported combinations.

### 3. Document and control `list_agents` scope

The current tool scopes results by the caller's working directory when no `requestedCwd` is supplied. It filters with a same-or-descendant path check.

The description does not explain this scope. The result also has a limit of 200, while the observed server had 478 sessions. A global request can therefore truncate without exposing a total.

A focused improvement could:

- Document the default scope.
- Add an explicit scope option if the product contract supports it.
- Return enough metadata for callers to understand truncation.

This is smaller than the first contribution. It should follow the workspace state fix unless a maintainer prefers it as the first bug report.

### 4. Scheduled-agent permission deadlocks

The scheduled `session-sentinel-scan` failed six times in the observed history. Two runs waited for permission. Four later runs remained active.

This looks like an operational reliability issue. Before proposing a core change, reproduce the state transition and identify whether the scheduler, permission wait, or active-run accounting owns the defect.

The issue is a good candidate for a focused bug report if the failure reproduces on a clean schedule.

### 5. Archive preflight correctness

Archive safety remains important. The observed usage showed that many worktree sessions did not reach a commit or push. A forced archive can therefore remove work that the user has not preserved elsewhere.

However, existing upstream issues already cover most of the requested behavior:

- [#1335](https://github.com/getpaseo/paseo/issues/1335) covers archive deletion without confirmation or undo.
- [#2225](https://github.com/getpaseo/paseo/issues/2225) covers incorrect dirty-state labeling after a branch has merged.

The best contribution is to add usage evidence and reproduction details to those issues. A new duplicate issue would not improve the contribution path.

## Work that should stay outside Paseo core

The local workflow already includes several solutions:

- Session routing for questions and implementation work.
- Ship-branch automation for preserving changes.
- Teardown hooks for session cleanup.
- Branch sweeps for stale branches.
- Checkpoints and handoff records.

These tools solve specialized workflow problems. Paseo's contribution guidance says that specialized workflows belong in plugins when an extension can provide them.

This does not reduce their value. It changes where they should live. The core contribution should expose reliable reusable state. Plugins and operations tools can then build routing, reporting, and cleanup behavior on top of that state.

## Contribution path

Paseo's [`CONTRIBUTING.md`](../CONTRIBUTING.md) sets a clear process:

- Use Discussions for product and workflow proposals.
- Report focused, reproducible bugs through GitHub issues.
- Keep core pull requests small.
- Include tests, commands, and QA evidence.
- Expect the maintainer to close pull requests that do not fit the product direction.

The recommended sequence is:

### Step 1: Start a Discussion

Describe the workflow in user terms:

- An agent needs to compare many workspaces.
- The app already shows the required Git state.
- The automation tool omits the same state.
- Automation therefore starts redundant Git commands.

Link the Session Sentinel example, but do not frame the proposal as a private feature. Explain how any fleet, cleanup, or coordination tool could use the same projection.

### Step 2: Open a focused bug report

Use a title such as:

> `list_workspaces` omits cached workspace Git runtime state

Include:

- The current tool output shape.
- The existing protocol payload fields.
- A minimal reproduction using one dirty and one clean workspace.
- The extra Git commands required by an agent.
- The requirement to reuse cached state.
- The backward-compatibility requirement.

### Step 3: Submit a small pull request

The pull request should change the schema, mapper, and targeted tests. It should include the exact commands and QA evidence requested by the repository.

Do not combine this work with archive UX, provider routing, scheduling, or a new inventory interface.

## Test and QA plan

The test plan should cover the data contract and the runtime source.

### Automated tests

Add or extend the existing server tool tests for:

- A clean local workspace.
- A dirty local workspace.
- A worktree with a current branch.
- A workspace with a remote URL.
- Ahead and behind values.
- A workspace with unavailable Git state.
- Active workspace filtering.
- Archived workspace inclusion when requested.
- Backward-compatible parsing of optional fields.

The tests should prove that the mapper uses the cached workspace snapshot. They should not need to launch a new Git process for each `list_workspaces` call.

### Manual QA

Run the daemon with at least two workspaces:

1. A clean local checkout.
2. A dirty or branch-based worktree.

Call `list_workspaces` from an agent. Compare the result with the app workspace state. Confirm that the branch, dirty flag, remote, and synchronization values agree.

Also verify the default archived behavior and the explicit archived behavior if the option is accepted.

### Compatibility QA

Read [`docs/protocol-compatibility.md`](../docs/protocol-compatibility.md) before changing any shared protocol type. New fields must remain optional. The change must not narrow or remove existing fields.

The first contribution may not need a protocol change because the workspace Git payload already exists. The agent-facing schema should map to that existing contract.

## Decision

Contribute the workspace Git state parity fix first.

It converts a broad inventory problem into a narrow, evidence-backed contract bug. It improves several workflows at once. It reuses existing daemon state. It has a clear test boundary. It also fits Paseo's contribution rules better than a new feature proposal.

After that contribution, investigate provider capability validation. Then improve `list_agents` scope documentation and truncation behavior. Add archive evidence to the existing upstream issues. Keep routing, autosave, teardown, and branch cleanup in the plugin and operations layer unless the maintainer identifies a missing core extension point.

## References

### Repository references

- [`CONTRIBUTING.md`](../CONTRIBUTING.md)
- [`packages/server/src/server/agent/tools/paseo-tools.ts`](../packages/server/src/server/agent/tools/paseo-tools.ts)
- [`packages/protocol/src/messages.ts`](../packages/protocol/src/messages.ts)
- [`docs/protocol-compatibility.md`](../docs/protocol-compatibility.md)
- [`docs/qa.md`](../docs/qa.md)
- [`docs/plugins.md`](../docs/plugins.md)

### Upstream references

- [Issue #1335: archive deletion safety](https://github.com/getpaseo/paseo/issues/1335)
- [Issue #2225: archive dirty-state detection](https://github.com/getpaseo/paseo/issues/2225)
- [Issue #2391: deduplicate Git reads](https://github.com/getpaseo/paseo/issues/2391)
- [Issue #4943: workspace, backing, and checkout model](https://github.com/getpaseo/paseo/issues/4943)
- [Issue #5098: agent workspace identity](https://github.com/getpaseo/paseo/issues/5098)
- [Discussion #2918: cross-agent activity and cost](https://github.com/getpaseo/paseo/discussions/2918)
- [Issue #7184: tool contract mismatch precedent](https://github.com/getpaseo/paseo/issues/7184)
