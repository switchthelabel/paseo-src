# GitHub error review — 7 days

**Window:** 2026-09-09 → 2026-09-16
**Host:** `vps-f950aef4` · daemon `0.8.0` · `PASEO_HOME=/home/ubuntu/.paseo`
**Account:** `switchthelabel` (GitHub CLI, scopes `gist`, `read:org`, `repo`, `workflow`)
**Question:** *"Based on all the GitHub errors I've experienced over the last 7 days, how do I get Paseo to accommodate me better?"*

---

## 1. Executive summary

The GitHub failures are not random, and they are not GitHub's fault. They cluster into a small number of repeatable mistakes that Paseo can either prevent or clean up automatically.

The single dominant failure is **acting on a branch that has no commits**: an agent finishes a turn, tries to `git push` a worktree-slug branch that was never created, then asks `gh pr create` to open a PR for it. GitHub answers `src refspec <slug> does not match any` and `No commits between main and <slug>`. The second cluster is **branching worktrees from stale local `main`**, which produces non-fast-forward push rejections and lockfile merge conflicts.

Three structural gaps in the current setup cause most of it:

1. **No turn-end git safety net on every repo.** Push/PR only happens when an agent remembers, so work is left dangling and later retried against a ref that does not exist.
2. **Worktrees branch from local `main`.** Paseo's own docs warn this is stale (`public-docs/worktrees.md:58`).
3. **Nothing scopes GitHub access or protects `main`.** Agents push to upstreams the account does not own, and to `main` directly.

### Top five actions

| # | Action | Fixes | Status |
|---|---|---|---|
| 1 | Set a real global git identity (was `Your Name <you@example.com>`) | Placeholder attribution on every commit/PR | ✅ done |
| 2 | Push `HEAD`, never a generated name; guard `ahead > 0` before push/PR | `src refspec … does not match any`, `No commits between`, empty PRs | Phase 3 |
| 3 | Make every worktree branch from `origin/main`, never `main` | Non-fast-forward rejections, lockfile conflicts | Phase 2 |
| 4 | Enable/repair `ship-branch` on every repo (auto-push at `agent.turn_ended`, non-fast-forward-safe) | Dangling/unpushed work, silent turn-end gaps | Phase 3 |
| 5 | Add a pre-push guard (no `main`, no empty branch, no repo you don't own) + agent git-hygiene instructions | Protected-branch pushes, 403s, empty PRs | Phase 3 |

Phase 1 (`agents.metadataGeneration.providers`) is also done; it is not in the top five because it improves the quality of generated branch/PR text rather than blocking a failure class.

---

## 2. Scope, method, and confidence

### Sources

| Source | What it holds | Window used |
|---|---|---|
| `~/.paseo/daemon.log` (+ rotated `2026*-daemon.log`) | Daemon lifecycle, workspace/git/WS events | current + 3 rotations |
| `~/.claude/projects/**/*.jsonl` (772 files in window, ~495 MB) | Every Claude-family agent transcript | mtime ≤ 7 days |
| `~/.codex/sessions/**` (101 files in window) | Codex transcripts | mtime ≤ 7 days |
| `~/.dsh/sessions/**` (845 files in window) | DeepSeek/DSH harness sessions | mtime ≤ 7 days |
| `~/.paseo/git-checkout-trace.log` | Wrapped `git` checkout/worktree calls with exit codes | 523 traced ops |
| `~/.basic-memory/memory.db` | Shared cross-agent memory notes | current |
| `~/.paseo/config.json`, `paseo.json`, `git config --global` | Configuration | current |
| GitHub API via `gh` | Repos, open PRs, Actions runs, auth | current |

### Method

1. Ripgrep each transcript store for the canonical GitHub/Git error strings.
2. Parse matching JSONL lines, extract all embedded text, and classify matches into error families.
3. De-duplicate by normalizing digits, so repeated retries of the same failure count once.
4. Correlate with `git-checkout-trace.log`, git configuration, and live GitHub state.

### Confidence and caveats

- The **unique-error counts** below are reliable as a relative ranking. The **raw counts** are inflated by code, test fixtures, and agents quoting their own safety policy — for example, `non-fast-forward` appears 100 times raw but only 31 distinct contexts, and many of those are `ship-branch`'s own unit tests. Treat unique contexts as the signal.
- The window is bounded by file mtime, which is when the transcript was last written — a session that ran inside the window but was never written again might be missed. The dated examples that surfaced all fall inside the window.
- DSH sessions contained **zero** matches: the DSH harness (including the agent writing this report) has not hit these errors. The failures come from Claude Code and Codex agents.
- GitHub Actions is **not** a meaningful part of the problem (section 3.10).

---

## 3. Error taxonomy

### 3.0 Counts at a glance (unique error contexts, last 7 days)

| Family | Claude | Codex | DSH | Total |
|---|---:|---:|---:|---:|
| Non-fast-forward / rejected push | 31 | 0 | 0 | **31** |
| Lockfile / content merge conflict | 10 | 17 | 0 | **27** |
| `gh` API `Validation Failed` | 10 | 2 | 0 | **12** |
| Review-comment path invalid | 7 | 0 | 0 | **7** |
| Protected-branch related | 6 | 0 | 0 | **6** |
| `src refspec … does not match any` | 4 | 0 | 0 | **4** |
| `No commits between` / PR already exists | 3 | 0 | 0 | **3** |
| Permission denied / 403 | 1 | 0 | 0 | **1** |
| URL/HTTP errors on GitHub endpoints | 3 | 0 | 0 | **3** |
| Secondary rate limit | 0 | 0 | 0 | **0**\* |
| `Bad credentials` | 0 | 0 | 0 | **0** |

\* A secondary rate-limit `HTTP 403` does appear in the broader store (dated 2026-09, from `gh search commits` bursts) but did not land inside this strictly-mtime-bounded 7-day slice. See 3.6.

---

### 3.1 Push a branch that does not exist → empty PR

**The most common and most confusing failure.**

```
error: src refspec helpful-manatee does not match any
error: failed to push some refs to 'https://github.com/switchthelabel/TaxCaseFlow-Scanner-App'
```

```
pull request create failed: GraphQL: Head sha can't be blank, Base sha can't be blank,
No commits between main and snowy-cougar, Head ref must be a branch (createPullRequest)
```

```
error: src refspec legal-catfish does not match any
```

Observed branch names: `legal-catfish`, `unarmed-hamster`, `helpful-manatee`, `snowy-cougar`, `fierce-catfish`. These are **Paseo worktree slugs**, not feature branches.

**Root cause.** Two distinct mistakes produce the same symptom:

1. The agent runs `git push origin <name>` where `<name>` is not a local branch. Either it used the worktree directory slug as a branch name, or it pushed a name it assumed Paseo had created.
2. The branch exists but is identical to the base (no commits). `gh pr create` then reports `No commits between main and X`. This is the PR-level twin of the same problem: the turn ended before anything was committed.

**Why Paseo lets it happen.** Paseo's push/PR UI is available, but nothing forces a commit before a push, and nothing blocks a push of an empty branch. The existing `ship-branch` plugin is designed to catch exactly this at `agent.turn_ended`, but it is not installed everywhere.

**Fix.** Pre-push guard on all three conditions, plus turn-end automation that commits (or visibly refuses) rather than silently retrying.

---

### 3.2 Non-fast-forward and stale-base pushes

```
! [rejected]        main -> main (non-fast-forward)
error: failed to push some refs to 'https://github.com/switchthelabel/claudive.git'
hint: Updates were rejected because the tip of your current branch is behind
```

```
=== push ===
To https://github.com/switchthelabel/TaxCaseFlow-Scanner-App
 ! [rejected]        main -> main (non-fast-forward)
```

An agent also reasoned about this explicitly:

> *"VPS script also pushes `code/` to `claude-code.git`, it will fight the desktop pipeline for the same repo (two writers, constant non-fast-forward rejections)."*

**Root cause.**
- Worktrees created from unqualified `main`, which is a **stale local ref**. Paseo fetches remote refs in the background, so `origin/main` is current and `main` is not — the exact warning in `public-docs/worktrees.md:58`.
- Agents pushing `main` directly instead of a feature branch.
- Two independent writers (a VPS sync job and a desktop pipeline) pushing the same repo/branch.

**Fix.** Branch from `origin/main`; forbid direct `main` pushes; scope automation to one writer per remote branch.

---

### 3.3 Permission denied / 403 to a repo you do not own

```
remote: Permission to lookscanned/lookscanned.io.git denied to switchthelabel.
fatal: unable to access 'https://github.com/lookscanned/lookscanned.io/':
  The requested URL returned error: 403
```

Dated `2026-09-08T20:27:25Z`.

**Root cause.** The agent worked in an upstream repository the account has no write access to, with no fork remote configured. The credential helper (`gh auth git-credential`) was working correctly — GitHub legitimately refused.

**Fix.** Fork-first workflow for upstream repos, and a per-repo `no-push` marker the guard respects.

---

### 3.4 Lockfile and content merge conflicts

```
Auto-merging package.json
Auto-merging pnpm-lock.yaml
CONFLICT (content): Merge conflict in pnpm-lock.yaml
Automatic merge failed; fix conflicts and then commit the result.
```

```
Rebasing (1/32)
Auto-merging bigdatawarehouse/resolution/discovery.py
CONFLICT (content): Merge conflict in bigdatawarehouse/resolution/discovery.py
error: could not apply a4648b9... feat: explicit load selection for person-resolution sweeps
```

Concentrated in `pnpm-lock.yaml`, `package.json`, and in one BigDataWarehouse rebase of 32 commits.

**Root cause.** Parallel worktrees all branched from the same stale base, then diverged on the same generated files. A 32-commit rebase is a symptom of letting a branch drift far behind before integrating.

**Fix.** Branch from `origin/main`; keep worktrees short-lived; rebase early; treat lockfiles as regenerate-don't-merge (`pnpm install --lockfile-only` / `npm install`) rather than hand-resolving.

---

### 3.5 `gh` API misuse — review comments on non-existent paths

```
{"message":"Validation Failed","errors":[{"resource":"PullRequestReviewComment",
"code":"invalid","field":"pull_request_review_thread.path",
"message":"could not be resolved"}]}
```

36 unique contexts across the broader store, 7 in-window.

**Root cause.** The agent posted a review comment against a file path that is not part of the PR diff — typically because the PR head had moved (the agent was reviewing a stale commit) or the path was wrong.

**Fix.** Agent instruction: resolve the PR head SHA first, and only comment on paths present in `gh pr diff --name-only`. Retry against the current head.

---

### 3.6 Rate limits

Not present in the strict 7-day window, but present immediately before it:

```
HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.
```

Recorded cause in an agent's own write-up: **`gh search commits` hit a secondary rate limit**, and activity had to be reconstructed by enumerating commits per repository.

**Root cause.** `gh search` and scraping-style queries have a much tighter secondary budget than normal REST calls. Bursts trip abuse detection.

**Fix.** Prefer `gh api` with pagination over `gh search`; cache results; don't fan out searches across agents simultaneously. Note this is unrelated to Paseo's own git process limits (section 6.2), which govern local `git` CPU load, not the GitHub API.

---

### 3.7 Commit identity is a placeholder

```
user.name=Your Name
user.email=you@example.com
```

Set **globally**, so it applies to every repository on the host. The shared memory vault already flags this as unresolved:

> *"Commit author is still the placeholder `Your Name <you@example.com>` on this clone's new commits."*
> — `Checkpoint — paseo-plugins GitHub cleanup — 2026-09-16`

**Root cause.** The host was provisioned without a real git identity, and no Paseo setup hook sets one.

**Impact.** Every commit and therefore every PR is authored by a placeholder. That breaks attribution, contribution graphs, some branch-protection and DCO policies, and any workflow that keys on author.

**Fix.** Set it once globally, and pin it per worktree in `paseo.json` for durability.

---

### 3.8 Worktree checkout interference

```
{"ts":"2026-09-15T14:14:55Z","subcommand":"checkout","exit":1,"cwd":"/home/ubuntu/paseo-plugins",
 "argv":"checkout main\n","parent_cmd":"gh pr merge 12 --merge --delete-branch"}
```

Of 523 traced git operations (310 `checkout`, 211 `worktree`, 2 `switch`) only 3 exited non-zero, but this one is diagnostic: `gh pr merge --delete-branch` tries to switch back to `main`, and fails because `main` is already checked out in another worktree.

A separate trace entry shows a failed `worktree remove --force /tmp/paseo-plugins-memory-search` (exit 128).

**Root cause.** A single checkout (`main`, or a branch) cannot be checked out in two worktrees at once. Paseo's parallel worktree model makes this collision reachable, and `git`-driven merge automation assumes it can return to `main`.

**Fix.** Let the merge automation use `git -C <main-checkout>` or `gh pr merge` without checkout; or perform merges from the checkout that owns `main`. The `git-collision-watch.state` file records `150` and `0` — worth confirming what those counters mean, because the trace itself recorded **zero** collisions flagged true.

---

### 3.9 Hygiene debt: stranded branches

Measured by `git for-each-ref` across checkouts:

| Repo | Local branches with **no upstream** | Branches with commits on **no remote** |
|---|---:|---:|
| `~/paseo-server-info` | **135** | **6** |
| `~/paseo-src` | 15 | 0 |
| `~/paseo-memory` | 1 | 0 |
| `~/paseo-plugins` | 2 | 0 |

The six branches with unreachable commits in `paseo-server-info` are **work that exists nowhere else on Earth**. That is the concrete cost of the failure in 3.1.

The vault already records a prior cleanup of the sibling repo:

> *"Deleted 18 stale local branches + 22 merged remote branches… PR #23 (vendor-third-party-plugins, ~178k lines): user chose 'decide later'… PR #23 decision (merge vs close)."*

Two pieces of in-flight work target this directly:
- Local branch `fix/gh-pr-create-unpushed-branch` in `paseo-src` (currently `[behind 1]`, no upstream).
- Open PR **#27** in `paseo-server-info`: *"session-sentinel: flag never-pushed branches the upstream check misses."*

---

### 3.10 CI is not the problem

| Repo | Runs since 09-08 | Failures |
|---|---:|---:|
| `paseo-src` | 0 | 0 |
| `paseo-plugins` | 0 | 0 |
| `paseo-server-info` | 0 | 0 |
| `paseo-memory` | 0 | 0 |
| `claudive` | 0 | 0 |
| `BigDataWarehouse` | 40 | **3** (`tests`, 2026-09-09 18:50–18:54) |

Only `BigDataWarehouse` runs Actions, and it had three failures on one afternoon in the middle of a 32-commit rebase. Everything else in the error set is **local `git`/`gh` misuse**, not CI.

### 3.11 Open PR backlog

`paseo-server-info` carries ten open PRs, several with worktree-slug branch names:

```
#29 publish-p1-to-p2-process      (draft)   #16 hungry-turtle
#27 session-sentinel-never-pushed           #15 legit-shark
#22 update-claude-code-cli                  #14 jazzy-husky
#18 docs/vps-audit-and-monitoring           #13 setup-windows-notification-sounds
                                            #11 deepseek/add-dsh-genui
                                            #5  quick-replies-buttons
```

Plus `paseo-src` #1 (draft) and #2, and `paseo-plugins` #23 (~178k lines, decision pending). A long-lived PR tail is itself a conflict generator (3.4).

---

## 4. Why Paseo behaves this way

These are product mechanics, not bugs — knowing them tells you which knob to turn.

- **Worktrees and workspaces are separate concepts.** More than one workspace can share one worktree, and Paseo removes the worktree when the last workspace is archived (`public-docs/workspaces.md:47`). Branch naming and base selection happen at creation, so a bad base is baked in for the life of the workspace.
- **Paseo fetches remote refs in the background; it does not silently fix your local `main`.** Hence the `origin/main` warning (`public-docs/worktrees.md:58`).
- **Paseo owns a real PR adapter.** `createPullRequest` lives in `packages/server/src/utils/checkout-git.ts` (line ~4048), and PR status surfaces around it. The app exposes **Create PR** in Changes and `--mode checkout-pr` for opening a PR as a workspace. Agents hand-rolling `git push && gh pr create` bypass this and lose its error handling.
- **Plugins get lifecycle hooks.** `agent.turn_started` and `agent.turn_ended` (`public-docs/plugins/v0.8/reference.md:431-432`, `docs/plugins.md:286`) are the sanctioned place for turn-end automation — exactly what `ship-branch` uses. Observers must not be awaited inside agent mutations.
- **Metadata generation is configurable.** Commit messages, PR text, branch names, and titles come from `agents.metadataGeneration.providers` (`docs/data-model.md:315`). Lean, weak models here is how you get branch names like `hungry-turtle`.
- **Git load has its own limiter.** `daemon.git.maxProcessesPerSecond` (default 64) and `maxProcessConcurrency` (default 8) throttle all Paseo git work (`docs/data-model.md:317`). Relevant to machine pressure under many parallel agents — unrelated to GitHub API limits.
- **`paseo.json` worktree `setup` runs once per worktree**, in the worktree, with `$PASEO_SOURCE_CHECKOUT_PATH` available (`public-docs/worktrees.md:98-113`). This is the correct home for identity, ref, and guard setup.

---

## 5. Accommodations

Ordered by leverage per unit of effort. Nothing here requires a daemon restart except where noted; config changes apply with `paseo reload`.

### 5.1 Tier 0 — do in five minutes

```bash
# Real identity (applied on this host)
git config --global user.name  "switchthelabel"
git config --global user.email "3246089+switchthelabel@users.noreply.github.com"

# Safe global defaults
git config --global push.autoSetupRemote true
git config --global fetch.prune true
git config --global pull.ff only
```

`push.autoSetupRemote` removes **only** the "a real local branch has no upstream" variant of 3.1. It does nothing when an agent runs `git push origin helpful-manatee` and `helpful-manatee` is not a ref at all — which is the failure actually observed. The durable convention is therefore to **push `HEAD`, never a generated name**:

```bash
git push -u origin HEAD
```

combined with the `ahead > 0` guard before any push or PR (5.3, 5.4).

### 5.2 Tier 1 — daemon configuration (`~/.paseo/config.json`)

```json
{
  "agents": {
    "metadataGeneration": {
      "providers": [
        { "provider": "claude" },
        { "provider": "codex" }
      ]
    }
  }
}
```

- `providers` is an array of **objects** (`{ provider, model?, thinkingOptionId? }`), not provider-name strings. A string array is rejected by `PaseoConfigSchema` with `expected object, received string`, and an invalid `config.json` makes `paseo reload` and even `paseo daemon status` fail until it is fixed. Validate before reloading.
- `metadataGeneration.providers` sets the preferred structured-generation fallback order for daemon-side metadata — commit messages, PR text, branch names, generated titles. Entries are tried first; Paseo then falls through to discovered defaults.
- **Do not lower `daemon.git` limits in this round.** They govern local git process pressure and have no bearing on the GitHub failures in this audit. Changing them alongside the identity fix would confound the before/after signal. Revisit only with observed local git contention.

Then reload and confirm:

```bash
paseo reload
paseo daemon status --json
```

### 5.3 Tier 2 — per-repo `paseo.json` and agent instructions

**Repo setup hook** (runs once per worktree, in the worktree):

```json
{
  "worktree": {
    "setup": [
      "git config user.name \"switchthelabel\"",
      "git config user.email \"3246089+switchthelabel@users.noreply.github.com\"",
      "git config push.autoSetupRemote true",
      "git fetch origin --prune",
      "printf 'head: %s\\nbase: %s\\nahead: %s\\n' \"$(git branch --show-current)\" \"$(git rev-parse --short origin/main)\" \"$(git rev-list --count origin/main..HEAD)\""
    ]
  }
}
```

The trailing print is cheap observability: every new worktree's first log line tells you the branch, the base it started from, and whether it is ahead — the three facts behind 3.1 and 3.2.

**Landing constraint.** Paseo reads `paseo.json` from the **committed version of the base branch** you pick, so an uncommitted edit in a checkout does not apply. The hook is inert until it is committed to the base branch — land it through a PR (preferred, and consistent with the no-direct-`main` rule) or a deliberate `main` commit, then create the validation worktree.

**Agent git-hygiene instructions** (add to the repo's `AGENTS.md` / a skill, so every provider inherits it):

- Push `HEAD`, never a generated name: `git push -u origin HEAD`. A name like `helpful-manatee` may not exist as a ref, and `push.autoSetupRemote` cannot rescue that.
- Commit before you push. If there is nothing to commit, do not push and do not open a PR.
- Guard first: `git fetch origin && git rev-list --count origin/main..HEAD` must be greater than 0 before any push or PR.
- Never push `main` or any protected branch.
- Never push to a repository your account does not own; fork first.
- Open PRs with an explicit head: `gh pr create --fill --head "$(git branch --show-current)"`.
- Before posting a review comment, resolve the current PR head and confirm the path is in `gh pr diff --name-only`.

### 5.4 Tier 3 — automation and plugins

**`ship-branch` — the primary turn-end safety net.** It pushes at `agent.turn_ended`, sets upstream, and deliberately refuses to act on non-fast-forward/network/auth failures so the next turn retries (verified in its code and tests: *"Push failed (non-fast-forward, network, auth, ...). Do NOT record the ledger, so the next turn retries."*). Ensure it is enabled and installed in **every** working repo, not just the ones where it was tested.

**`ship-status` + `pr-watch` — visibility.** Show which worktrees have unpushed commits and which branches have no PR.

**`session-sentinel` — cleanup and detection.** Already owns worktree reaping and the never-pushed-branch finding (PR #27). Run a pass to surface the 135 no-upstream branches.

**A pre-push guard** — small plugin or hook wrapping push, refusing when:

1. current branch is `main`/protected,
2. `git rev-list origin/main..HEAD` is 0,
3. the remote is not one the account owns (or the repo is marked `no-push`),
4. the worktree is in detached HEAD.

This is the one new thing worth building; it directly blocks 3.1, 3.2, and 3.3.

**A turn-end offer card** for "unpushed commits, no PR" (the `publish-repo` plugin already demonstrates the card pattern) so a stranded branch is visible in the timeline instead of discovered later.

**Stranded branches — inventory only; do not automate deletion or rescue.** The six `paseo-server-info` branches whose commits exist on no remote are potentially valuable until every commit has been inspected. Do not script a cleanup or an auto-rescue. Inventory by hand and review each branch:

```bash
# list branches and their upstream tracking state
git -C ~/paseo-server-info for-each-ref --format='%(refname:short)|%(upstream:track)' refs/heads
# flag branches holding commits that exist on no remote
for b in $(git -C ~/paseo-server-info for-each-ref --format='%(refname:short)' refs/heads); do
  n=$(git -C ~/paseo-server-info rev-list --count "$b" --not --remotes)
  [ "$n" -gt 0 ] && echo "$b: $n commits not on any remote"
done
```

### 5.5 Tier 4 — GitHub-side

- Enable `delete_branch_on_merge` on every active repo. Already enabled on `paseo-plugins` via `gh api`; do the rest.
- For upstream repos (`lookscanned/*`): `gh repo fork`, add the fork as a remote, push there, and PR across forks. Or mark those repos `no-push` in the guard.
- Triage the `paseo-server-info` PR tail and `paseo-plugins` #23 (the vault records the recommendation: close #23 and use `paseo plugin add owner/repo` for community plugins).
- Avoid `gh search` bursts; prefer `gh api` pagination and caching.

---

## 6. Implementation plan

Order matters: prevention of the dominant refspec / empty-PR failure comes first; historical cleanup comes last and stays manual. Verify each phase before starting the next.

### Phase 0 — identity and safe global defaults ✅ done and verified

```bash
git config --global user.name  "switchthelabel"
git config --global user.email "3246089+switchthelabel@users.noreply.github.com"
git config --global push.autoSetupRemote true
git config --global fetch.prune true
git config --global pull.ff only
git config --global --get-regexp 'user\.|push\.|fetch\.|pull\.'
```

Verified with a throwaway commit in a scratch repo:

```
author:    switchthelabel <3246089+switchthelabel@users.noreply.github.com>
committer: switchthelabel <3246089+switchthelabel@users.noreply.github.com>
```

The email is the account's own GitHub noreply address (account id `3246089`, login `switchthelabel`), so it is verified and attribution is guaranteed. The account exposes no public name or email and the token lacks the `user` scope, so no alternative verified address could be read; `redcell1@gmail.com` also appears in older commits if a real address is preferred.

### Phase 1 — daemon configuration ✅ done and verified

1. Edit `~/.paseo/config.json` and set `agents.metadataGeneration.providers` to the object array shown in 5.2.
2. `paseo reload` → `Configuration reloaded.`
3. `paseo daemon status --json` → healthy (`srv_R4aOscedqtlr`, `127.0.0.1:6767`, pid `4028379`).
4. Validate the file against `PaseoConfigSchema` before reloading, and confirm no `Invalid config` entries in `~/.paseo/daemon.log`.

`daemon.git` limits were deliberately **left at their defaults**.

Full change record — exact commands, verification output, the schema incident, and rollback: [`PHASE-0-1-EXECUTION-2026-09-16.md`](PHASE-0-1-EXECUTION-2026-09-16.md).

### Phase 2 — repo hook: one repo, validate, then roll out

1. Add the `worktree.setup` block (5.3) to `paseo.json` in **one** active repo.
2. Land it on the base branch — PR preferred; a direct `main` commit only if deliberate.
3. Create a fresh worktree with `--base origin/main` and validate three things: branch is not `main`, HEAD descends from the current `origin/main`, and `ahead` is 0 immediately after creation.
4. Only then roll the hook to the remaining repos.

### Phase 3 — push convention and guard

1. Add the git-hygiene instructions (5.3) — `git push -u origin HEAD`, commit before push, `ahead > 0` guard.
2. Verify `ship-branch`, `ship-status`, `pr-watch` are enabled and present for each repo.
3. Build the pre-push guard (5.4) and test it against: empty branch, `main`, non-owned remote, detached HEAD.

### Phase 4 — observability

Add the turn-end "unpushed commits / no PR" card so a stranded branch is visible in the timeline.

### Phase 5 — cleanup (manual, last)

1. Inventory stranded branches (5.4) and inspect the six `paseo-server-info` branches by hand, commit by commit.
2. Triage the open PR backlog; decide `paseo-plugins` #23.
3. Enable `delete_branch_on_merge` wherever it is still missing.

No automated deletion or rescue. Nothing in this phase runs until the six branches have been reviewed.

---

## 7. Verification and success metrics

Track these before/after over the next 7 days:

| Metric | Baseline | Target |
|---|---:|---:|
| `src refspec … does not match any` | 4 | 0 |
| `No commits between` | 3 | 0 |
| Non-fast-forward rejections | 31 | < 5 |
| Lockfile conflicts | 27 | < 10 |
| Review `Validation Failed` | 12 | 0 |
| Commits authored by placeholder | all | 0 |
| Branches with no upstream (`paseo-server-info`) | 135 | < 20 |
| Branches with commits on no remote | 6 | 0 |

Re-run the audit with the commands in Appendix A and compare.

---

## 8. What was changed, and what was not

**Changed (Phases 0 and 1, both verified):**

- `~/.gitconfig` — real author identity (`switchthelabel <3246089+switchthelabel@users.noreply.github.com>`), plus `push.autoSetupRemote`, `fetch.prune`, and `pull.ff only`.
- `~/.paseo/config.json` — added `agents.metadataGeneration.providers = [{provider: "claude"}, {provider: "codex"}]`; reloaded and schema-validated. Backups: `~/.paseo/config.json.bak-metadata-generation-20260915T232741` and `~/.paseo/config.json.bak-invalid-metadata-*`.

**Not changed:** no daemon restart, no branches or worktrees touched, no branch deleted or rescued, no `ship-branch`/guard changes, no GitHub state changed. `daemon.git` limits left at defaults. Phases 2–5 are still proposals.

The memory checkpoint was written to `~/paseo-memory/checkpoints/checkpoint-github-errors-7d-review-2026-09-16.md` using the harness's sanctioned `danger-full-access` escalation. The first attempt was denied by the default `workspace-write` sandbox — see Appendix D.

---

## Appendix A — evidence commands

```bash
# 1. Confirm the seven-day transcript set
find ~/.claude/projects -name '*.jsonl' -mtime -7 | wc -l   # 772
find ~/.codex/sessions  -type f -mtime -7 | wc -l           # 101
find ~/.dsh/sessions    -type f -mtime -7 | wc -l           # 845

# 2. Classify error strings (ripgrep over JSONL, then parse embedded text)
find ~/.claude/projects -name '*.jsonl' -mtime -7 -print0 \
  | xargs -0 rg -i -N -u -e 'src refspec .* does not match any|No commits between|non-fast-forward|Validation Failed|CONFLICT \(content\)|Permission to .* denied|API rate limit exceeded'

# 3. Git operation trace summary
python3 - <<'PY'
import json, collections
rows=[json.loads(l) for l in open('/home/ubuntu/.paseo/git-checkout-trace.log') if l.strip()]
print(len(rows), "ops;", sum(1 for r in rows if r.get('collision')), "collisions;",
      sum(1 for r in rows if r.get('exit') not in (0,None)), "nonzero")
print(collections.Counter(r.get('subcommand') for r in rows))
PY

# 4. Stranded-branch inventory
for R in ~/paseo-plugins ~/paseo-server-info ~/paseo-memory "$HOME/~paseoappsource/paseo-src"; do
  echo "== $R"
  git -C "$R" for-each-ref --format='%(refname:short)|%(upstream:track)' refs/heads \
    | awk -F'|' '$2==""{n++} END{print "  no upstream:", n+0}'
done

# 5. GitHub state
gh auth status
gh api rate_limit
gh repo list switchthelabel --limit 60
gh pr list -R switchthelabel/paseo-server-info --state open
gh run list -R switchthelabel/BigDataWarehouse -L 40
```

## Appendix B — evidence files

| Path | Why |
|---|---|
| `/home/ubuntu/.paseo/daemon.log` + `2026*-daemon.log` | Daemon and WS events |
| `/home/ubuntu/.paseo/git-checkout-trace.log` | Wrapped git ops + exit codes |
| `/home/ubuntu/.paseo/git-collision-watch.state` | `150` / `0` counters (meaning to confirm) |
| `/home/ubuntu/.paseo/pr-watch.json` | Two watched PRs (`paseo-server-info#27`, `paseo-src#2`) |
| `/home/ubuntu/.paseo/config.json` | Plugins, providers, profiles |
| `/home/ubuntu/.basic-memory/memory.db` | Shared memory; GitHub cleanup checkpoint |
| `/home/ubuntu/paseo-plugins/ship-branch/` | Turn-end push automation + tests |
| `/home/ubuntu/paseo-plugins/pr-watch/`, `ship-status/` | PR + unpushed visibility |
| `/home/ubuntu/paseo-plugins/session-sentinel/` | Worktree reap + never-pushed detection |
| `/home/ubuntu/paseo-plugins/publish-repo/` | Turn-end offer-card precedent |
| `packages/server/src/utils/checkout-git.ts` | `createPullRequest` (~4048) |
| `public-docs/worktrees.md` | `origin/main` warning (58), setup hooks (98) |
| `docs/data-model.md` | Git process limits (317), metadata generation (315) |
| `docs/plugins.md`, `public-docs/plugins/v0.8/reference.md` | Lifecycle hooks (286, 431-432) |

## Appendix C — error string → cause → fix

| Error string | Cause | Fix |
|---|---|---|
| `src refspec X does not match any` | Pushed a branch that does not exist locally (usually a worktree slug) | Guard: push `HEAD`, require a real branch |
| `No commits between main and X` | Branch has no commits vs base | Commit before push/PR; turn-end automation |
| `! [rejected] main -> main (non-fast-forward)` | Stale local base or direct-to-main push | Branch from `origin/main`; block `main` pushes |
| `Permission to X denied` / `403` | No write access to an upstream repo | Fork-first; `no-push` marker |
| `CONFLICT (content): pnpm-lock.yaml` | Parallel worktrees from a stale base | Fresh base; regenerate lockfiles |
| `Validation Failed … review_thread.path` | Review comment on a path not in the diff | Resolve head first; check `gh pr diff --name-only` |
| `secondary rate limit` 403 | `gh search` / scrape bursts | `gh api` pagination; cache |
| placeholder author | `user.name=Your Name` globally | Set real identity |
| `checkout main` exit 1 | `main` checked out in another worktree | Merge without checkout / from owning checkout |

## Appendix D — the DSH write sandbox

### Why writes outside the workspace fail

The DSH harness confines every shell command and filesystem mutation to a single writable root. The policy is built in `@deepseek-ai/dsh-base/cordis.patch.yml`:

```yaml
- id: sandbox-policy
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"
- id: permission
  config:
    presets:
      read-only:        { sandbox: read-only,         approval: ask }
      workspace-write:  { sandbox: workspace-write,   approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
```

The modes are file-effect policies (`SandboxMode`), enforced by a same-world backend (bubblewrap or Landlock on Linux). `workspace-write` means **the workspace root plus the host `/tmp` and `os.tmpdir()`** — and nothing else. There is no extra-root or allow-list setting.

Enforcement is visible in the mount table:

```
/dev/sda1 on /                                                   ext4 rw? no — ro,...
/dev/sda1 on /home/ubuntu/~paseoappsource/paseo-src              ext4 rw,...
```

The root is mounted read-only and the session workspace is re-mounted read-write. Any write outside that one directory returns `Read-only file system` (EROFS). The `~/paseo-memory` write hit that boundary; the `basic-memory` CLI hit it too, because it `chmod`s its own config directory (`~/.basic-memory`) during startup.

Two side effects worth knowing:

- `/tmp` is writable but **not persistent across tool calls** — each command runs with a fresh temporary area. Keep scratch files inside the workspace if they must survive.
- The sandbox covers file effects only. Network, process, syscall, and credential boundaries are explicitly out of scope for this policy vocabulary.

### How to fix it

**1. Per-call escalation (narrowest, sanctioned).** The harness ships an escalation ladder: from `workspace-write` the only wider mode is `danger-full-access` (`WIDER_MODES`). A retry carries `sandbox_permissions` plus a non-empty `justification` together, and the approval channel resolves it *before* execution. This is how the checkpoint above was written — one approved call, and the session stays confined otherwise. Use it for the occasional write outside the workspace.

**2. Provider-wide, via environment.** `DSH_PERMISSION_MODE` is read from the environment at DSH boot:

```json
{
  "agents": {
    "providers": {
      "deepseek-harness": {
        "command": ["dsh", "--profile", "acp"],
        "env": {
          "TZ": "America/Los_Angeles",
          "DSH_PERMISSION_MODE": "danger-full-access"
        }
      }
    }
  }
}
```

Caveats: `danger-full-access` also sets the approval policy to `never`, so prompts disappear. It applies to agents created after the change (the composed tree is read at boot), and if the variable is set in the daemon's own launch environment it requires a daemon restart. This removes confinement for every `deepseek-harness` agent — only choose it if that is intended.

**3. Do the write on the daemon side (best for memory).** The `basic-memory` plugin's MCP tools (`write_note`, `search_notes`, `recent_activity`, `build_context`) run in the **daemon** process, which is not sandboxed, so they write `~/paseo-memory` without any escalation. That is the designed path and needs no policy change. Two things to verify when those tools are missing from a session:

- Injection happens in `server.before("agent.create")` for every provider not in `excludeProviders`, but the resulting config is **saved with the agent**. An agent created before the plugin was enabled or reloaded never receives it. Reload the plugin and start a new agent.
- `deepseek-harness` is an ACP provider. If the ACP session ignores Paseo-injected `mcpServers`, add the server to the DSH profile directly (a `cordis.patch.yml` entry, exactly like the existing `mcp-exa` / `mcp-jina` / `mcp-chrome-devtools` entries) rather than relying on injection.

Also note that preapproval (`preapproveTools`) is limited to `preapproveProviders` — currently `claude`, `zai`, `codex`, `opencode`. `deepseek-harness` is not in that list, so its MCP calls require approval even when the server is injected.

**What not to do.** There is no supported way to add `~/paseo-memory` as an extra writable root while staying in `workspace-write`. `writableRoots()` derives the allow-list from the workspace root plus the temp areas; widening it means a custom patch overlay on the sandbox policy or profile, which is more machinery than one vault path justifies.

### Recommendation

Keep `DSH_PERMISSION_MODE` at the default `workspace-write`. Route memory writes through the daemon-side MCP tools, use `sandbox_permissions` escalation for the rare one-off write outside the workspace, and reserve `danger-full-access` for agents that genuinely need host-wide access.
