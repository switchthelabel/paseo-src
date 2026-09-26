# Upstream Provider Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Submit small upstream contributions that improve Z.AI/GLM usage and add OpenRouter and DeepSeek usage fetchers.

**Architecture:** The existing `ProviderUsageService` remains the only server entry point. Each provider owns one private fetcher module that reads a documented environment variable, calls official HTTPS endpoints through `fetchProviderApi`, parses the response with Zod, and returns the existing generic `ProviderUsage` shape. The existing protocol and app cards remain unchanged.

**Tech Stack:** TypeScript, Node.js `fetch`, Zod, Vitest, Paseo provider-usage service.

**Spec:** `docs/superpowers/specs/2026-09-26-provider-usage-upstream-design.md`

## Global Constraints

- Start with a GitHub Discussion. The official contribution guide requires discussion for feature work and closes pull requests by default.
- Do not submit more than one provider change in a pull request.
- Do not alter `packages/protocol/src/messages.ts` or `packages/app/src/provider-usage/` in these pull requests.
- Read credentials only. Never refresh, rewrite, transmit to another host, or log a credential.
- Use `fetchProviderApi` for the existing 15-second timeout.
- Return `unavailableUsage(this)` for missing credentials and HTTP 401 or 403 responses.
- Throw only unexpected transport or payload errors. `ProviderUsageService` already isolates that failure from other providers.
- Add no custom polling, cache, RPC, dashboard, panel, composer pill, notification, or provider alias.
- Keep API schemas, endpoint constants, and normalization helpers private to the fetcher file.
- Run only changed test files locally. Do not run the full test suite.
- Run `npm run format`, `npm run typecheck`, and `npm run lint` before each pull request.
- Keep the existing user-owned `CLAUDE.md` modification out of all commits.

---

## Repository and Discussion Preparation

### File Map

| Path | Role |
| --- | --- |
| `CONTRIBUTING.md` | Maintainer contribution rules and pull-request evidence requirements. |
| `docs/providers.md` | Owner document for usage fetcher design rules. |
| `docs/protocol-compatibility.md` | Compatibility requirements if a later currency design needs a protocol field. |
| `packages/server/src/services/quota-fetcher/manifest.ts` | Registers each built-in usage fetcher. |
| `packages/server/src/services/quota-fetcher/provider.ts` | Fetcher interface. |
| `packages/server/src/services/quota-fetcher/usage.ts` | Shared timeout, unavailable result, tone, percentage, and date helpers. |
| `packages/server/src/services/quota-fetcher/providers/zai.ts` | Existing Z.AI fetcher to improve. |
| `packages/server/src/services/quota-fetcher/service.test.ts` | Integration-style deterministic tests for registered fetchers. |
| `packages/server/src/services/quota-fetcher/usage.test.ts` | Tests for shared pure helpers only. |

### Task 1: Create the upstream proposal before code

**Files:**

- Read: `CONTRIBUTING.md`, `docs/providers.md`, `docs/protocol-compatibility.md`, and `docs/qa.md`.
- Create externally after user approval: GitHub Discussion in `getpaseo/paseo`.

**Produces:** Maintainer feedback and a public rationale that each PR can link.

- [ ] **Step 1: Draft the Discussion with this title**

```text
Proposal: extend generic Provider Usage with Z.AI quota windows, OpenRouter key usage, and DeepSeek USD balance
```

- [ ] **Step 2: Include this problem statement**

```text
Paseo already has a provider-agnostic provider-usage API, a daemon cache, Host Usage cards, and an active-provider tooltip. It has usage fetchers for several services. Z.AI currently reports subscription metadata but not quota windows. OpenRouter and DeepSeek have documented read-only usage or balance APIs but no built-in fetcher.

I have a local plugin that validates these APIs. I propose three small server-only contributions. Each would normalize data into the existing ProviderUsage shape. The proposal does not add UI, new protocol fields, agent-provider aliases, custom-profile credential discovery, or management-key operations.
```

- [ ] **Step 3: Ask these design questions explicitly**

```text
1. Is process-environment-only credential lookup acceptable for initial OpenRouter and DeepSeek fetchers?
2. Should OpenRouter account credits remain out of scope because that endpoint needs a management key?
3. Should DeepSeek support wait until a generic ISO-currency extension exists, or is USD-only reporting acceptable?
4. Is a Host Usage-only result acceptable until Paseo has a generic billing-source association for custom providers?
```

- [ ] **Step 4: Do not create branches or code until the maintainer accepts the direction**

Expected: The Discussion states which fetchers and constraints the maintainer accepts.

### Task 2: Prepare isolated pull-request worktrees

**Files:** No source changes.

**Consumes:** Maintainer direction from Task 1.

**Produces:** One clean worktree and branch per accepted pull request.

- [ ] **Step 1: Verify the current worktree is not clean**

Run: `git status --short`

Expected: `CLAUDE.md` remains modified and is not part of this work.

- [ ] **Step 2: Add the official Paseo repository as an upstream remote, if it is absent**

```bash
git remote add upstream https://github.com/getpaseo/paseo.git
git fetch upstream main
```

Expected: `upstream/main` resolves to the official base branch.

- [ ] **Step 3: Create a dedicated worktree for the accepted Z.AI change**

```bash
git worktree add -b feature/zai-usage-windows ../paseo-zai-usage upstream/main
```

Expected: The new worktree starts clean and contains no user-owned changes.

- [ ] **Step 4: Repeat Step 3 only after each prior pull request reaches a stable review outcome**

Use branch names `feature/openrouter-usage` and `feature/deepseek-usd-usage`.

---

## Pull Request 1: Z.AI / GLM Quota Windows

### Task 3: Define Z.AI API parsing and normalization tests

**Files:**

- Modify: `packages/server/src/services/quota-fetcher/service.test.ts`.
- Read: `packages/server/src/services/quota-fetcher/providers/zai.ts` and `packages/server/src/services/quota-fetcher/usage.ts`.

**Consumes:** `ZaiQuotaProvider.fetchUsage(): Promise<ProviderUsage>`.

**Produces:** Tests that prove Z.AI quota windows use the existing generic shape.

- [ ] **Step 1: Add a fixture for the subscription response and a fixture for this quota response**

```ts
{
  success: true,
  data: {
    level: "max",
    limits: [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        usage: "100",
        currentValue: "42",
        remaining: "58",
        percentage: "42",
        nextResetTime: 1780000000000,
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        number: 7,
        usage: "200",
        currentValue: "176",
        remaining: "24",
        percentage: "88",
        nextResetTime: 1780500000000,
      },
    ],
  },
}
```

- [ ] **Step 2: Add a failing test that sets `ZAI_API_KEY` and asserts the two normalized windows**

```ts
expect(zai).toMatchObject({
  status: "available",
  planLabel: "GLM Coding Max",
  windows: [
    { id: "session", label: "Session", usedPct: 42, remainingPct: 58, tone: "ok" },
    { id: "weekly", label: "Weekly", usedPct: 88, remainingPct: 12, tone: "warning" },
  ],
});
```

- [ ] **Step 3: Add failing cases for malformed quota data, no quota limits, HTTP 401, and a failed subscription lookup**

Expected behavior: malformed or missing quota data is unavailable, HTTP 401 is unavailable, and a failed subscription lookup keeps usable windows with a label derived from `data.level`.

- [ ] **Step 4: Run the target test before implementation**

Run: `npx vitest run packages/server/src/services/quota-fetcher/service.test.ts --bail=1`

Expected: The new Z.AI tests fail because the current fetcher does not request or return quota windows.

### Task 4: Implement Z.AI quota windows

**Files:**

- Modify: `packages/server/src/services/quota-fetcher/providers/zai.ts`.
- Test: `packages/server/src/services/quota-fetcher/service.test.ts`.

**Consumes:** Existing `fetchProviderApi`, `windowFromUsedPct`, `toneFromUsedPct`, `usedPctOf`, and `toIsoStringOrNull` helpers.

**Produces:** `ZaiQuotaProvider.fetchUsage()` returns session and weekly windows without a protocol change.

- [ ] **Step 1: Add private Zod schemas for the quota response**

```ts
const ZaiQuotaLimitSchema = z.object({
  type: z.string().optional(),
  unit: ApiNumberSchema.optional(),
  usage: ApiNumberSchema.optional(),
  currentValue: ApiNumberSchema.optional(),
  remaining: ApiNullableNumberSchema.optional(),
  percentage: ApiNumberSchema.optional(),
  nextResetTime: ApiNullableNumberSchema.optional(),
});

const ZaiQuotaResponseSchema = z.object({
  success: z.boolean().optional(),
  data: z.object({
    level: ApiOptionalStringSchema,
    limits: z.array(ZaiQuotaLimitSchema).optional(),
  }),
});
```

- [ ] **Step 2: Request the fixed quota endpoint with the existing Z.AI credential**

```ts
const quotaResponse = await fetchProviderApi(
  this.fetchApi,
  "https://api.z.ai/api/monitor/usage/quota/limit",
  { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
);
```

Expected: The fetcher does not accept host overrides and does not read a configuration file.

- [ ] **Step 3: Convert limit entries into generic windows**

```ts
const usedPct = limit.percentage ?? usedPctOf(limit.currentValue, limit.usage);
const resetsAt = toIsoStringOrNull(limit.nextResetTime ?? Number.NaN);
const window = windowFromUsedPct({
  id: limit.unit === 3 ? "session" : limit.unit === 6 ? "weekly" : `window_${index + 1}`,
  label: limit.unit === 3 ? "Session" : limit.unit === 6 ? "Weekly" : `Window ${index + 1}`,
  utilizationPct: usedPct,
  resetsAt,
  tone: toneFromUsedPct(usedPct),
});
```

Do not include `TIME_LIMIT` entries as model quota windows. Add them as a generic request balance only when every amount is present and the API response identifies the entry as a tool allowance.

- [ ] **Step 4: Keep the subscription request best-effort**

Expected: A successful quota response returns `available` even when the subscription label request fails. Prefer `productName`; otherwise use `GLM Coding ${level}`; otherwise use `GLM Coding Plan`.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run packages/server/src/services/quota-fetcher/service.test.ts --bail=1`

Expected: All existing provider-usage tests and new Z.AI cases pass.

### Task 5: Document, verify, and submit the Z.AI pull request

**Files:**

- Modify: `docs/providers.md`.
- Test: `packages/server/src/services/quota-fetcher/service.test.ts`.

**Produces:** A focused Z.AI pull request with repeatable evidence.

- [ ] **Step 1: Integrate one sentence into the existing Provider Usage Fetchers section**

```text
Z.AI usage reads the Coding Plan quota endpoint with `ZAI_API_KEY` or `GLM_API_KEY`; subscription metadata supplies only an optional plan label.
```

- [ ] **Step 2: Format and run required static checks**

```bash
npm run format
npm run typecheck
npm run lint
```

Expected: Each command exits with code 0.

- [ ] **Step 3: Perform real-provider QA with a personal Z.AI plan**

Record the command, redacted response fields, visible Session and Weekly values, reset times, plan label, platform, daemon version, and any unavailable condition. Do not store the API key.

- [ ] **Step 4: Commit only scoped files**

```bash
git add docs/providers.md packages/server/src/services/quota-fetcher/providers/zai.ts packages/server/src/services/quota-fetcher/service.test.ts
git commit -m "feat: show Z.AI coding plan usage windows"
```

- [ ] **Step 5: Open a pull request linked to the accepted Discussion**

Include the automated test command, static checks, real-provider QA evidence, supported platforms, and explicit statement that no protocol or app change is included.

---

## Pull Request 2: OpenRouter Key Usage

### Task 6: Test OpenRouter normalization before implementation

**Files:**

- Modify: `packages/server/src/services/quota-fetcher/service.test.ts`.
- Modify: `packages/server/src/services/quota-fetcher/manifest.ts`.

**Produces:** Failing expectations for a normal OpenRouter API key.

- [ ] **Step 1: Add a test fixture for `GET https://openrouter.ai/api/v1/auth/key`**

```ts
{
  data: {
    usage: 12.5,
    usage_daily: 1.25,
    usage_weekly: 4.5,
    usage_monthly: 12.5,
    limit: 50,
    limit_remaining: 37.5,
    limit_reset: "monthly",
    is_free_tier: false,
  },
}
```

- [ ] **Step 2: Add a failing test for the registered `openrouter` provider**

```ts
expect(openrouter).toMatchObject({
  providerId: "openrouter",
  displayName: "OpenRouter",
  status: "available",
  planLabel: "Pay as you go",
  balances: [
    expect.objectContaining({
      id: "monthly_spend",
      label: "Monthly spend",
      used: 12.5,
      remaining: 37.5,
      limit: 50,
      unit: "usd",
      tone: "ok",
    }),
  ],
});
```

- [ ] **Step 3: Add failing cases for a key without a cap, numeric strings, HTTP 401, and malformed JSON**

Expected behavior: uncapped spend has `used` but no fabricated remaining balance or percentage; HTTP 401 is unavailable; malformed JSON becomes a provider-local error.

- [ ] **Step 4: Run the target test**

Run: `npx vitest run packages/server/src/services/quota-fetcher/service.test.ts --bail=1`

Expected: The OpenRouter tests fail until the manifest has a fetcher.

### Task 7: Add the OpenRouter usage fetcher

**Files:**

- Create: `packages/server/src/services/quota-fetcher/providers/openrouter.ts`.
- Modify: `packages/server/src/services/quota-fetcher/manifest.ts`.
- Test: `packages/server/src/services/quota-fetcher/service.test.ts`.

**Produces:** `OpenRouterQuotaProvider implements ProviderUsageFetcher`.

- [ ] **Step 1: Implement the fetcher contract**

```ts
export class OpenRouterQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "openrouter";
  readonly displayName = "OpenRouter";

  constructor(options: { logger: Logger; fetch?: ProviderApiFetch }) {}

  async fetchUsage(): Promise<ProviderUsage> {
    // Read process.env.OPENROUTER_API_KEY only.
    // Request the auth/key endpoint with Bearer authentication.
    // Parse with a private Zod schema.
  }
}
```

- [ ] **Step 2: Normalize only the reset window named by `limit_reset`**

```ts
const resetLabel = {
  daily: "Daily spend",
  weekly: "Weekly spend",
  monthly: "Monthly spend",
}[response.data.limit_reset ?? ""];
```

Expected: A capped key returns one `usd` balance with `used`, `limit`, `remaining`, a correctly calculated tone, and the next matching UTC reset. An uncapped key returns a detail such as `Monthly spend` rather than a false `$0.00` balance.

- [ ] **Step 3: Register the fetcher**

```ts
{
  providerId: "openrouter",
  create: (options) => new OpenRouterQuotaProvider({ logger: options.logger, fetch: options.fetch }),
},
```

- [ ] **Step 4: Do not call `/api/v1/credits`**

Expected: The initial fetcher works with an ordinary API key and never requests a management key.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run packages/server/src/services/quota-fetcher/service.test.ts --bail=1`

Expected: New and existing provider-usage tests pass.

### Task 8: Document, verify, and submit the OpenRouter pull request

**Files:**

- Modify: `docs/providers.md`.
- Test: `packages/server/src/services/quota-fetcher/service.test.ts`.

- [ ] **Step 1: Integrate this constraint into Provider Usage Fetchers**

```text
OpenRouter usage reads `OPENROUTER_API_KEY` and reports key-level spend or limits. It does not request account credits because that endpoint requires a management key.
```

- [ ] **Step 2: Run verification**

```bash
npm run format
npm run typecheck
npm run lint
npx vitest run packages/server/src/services/quota-fetcher/service.test.ts --bail=1
```

Expected: All commands exit with code 0.

- [ ] **Step 3: Perform real-provider QA with a normal OpenRouter key**

Record the key limit state, a capped and an uncapped result if both are available, and a redacted response. Confirm no credits request occurs.

- [ ] **Step 4: Commit and open the linked pull request**

```bash
git add docs/providers.md packages/server/src/services/quota-fetcher/manifest.ts packages/server/src/services/quota-fetcher/providers/openrouter.ts packages/server/src/services/quota-fetcher/service.test.ts
git commit -m "feat: add OpenRouter provider usage"
```

---

## Pull Request 3: DeepSeek USD Balance

### Task 9: Confirm that the maintainer accepts USD-only reporting

**Files:**

- Read: `packages/protocol/src/messages.ts` and the accepted GitHub Discussion.

**Produces:** An explicit go or no-go decision.

- [ ] **Step 1: Confirm the existing balance unit enum remains `usd`, `credits`, `requests`, and `tokens`**

Expected: The protocol has no generic CNY or ISO-currency representation.

- [ ] **Step 2: Confirm the Discussion accepts this behavior**

```text
The first DeepSeek fetcher will return an available provider only when `/user/balance` has a USD entry. It will not convert, relabel, or display a CNY balance as USD or generic credits.
```

- [ ] **Step 3: Stop this pull request if either condition is not true**

Expected: DeepSeek currency support becomes a separate maintainer-designed protocol proposal.

### Task 10: Test and add the DeepSeek USD fetcher

**Files:**

- Create: `packages/server/src/services/quota-fetcher/providers/deepseek.ts`.
- Modify: `packages/server/src/services/quota-fetcher/manifest.ts`.
- Modify: `packages/server/src/services/quota-fetcher/service.test.ts`.

**Produces:** `DeepSeekQuotaProvider implements ProviderUsageFetcher`.

- [ ] **Step 1: Add failing tests for the official balance response**

```ts
{
  is_available: true,
  balance_infos: [
    { currency: "USD", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
  ],
}
```

```ts
expect(deepseek).toMatchObject({
  providerId: "deepseek",
  displayName: "DeepSeek",
  status: "available",
  balances: [
    expect.objectContaining({ id: "usd_balance", label: "Balance", remaining: 110, unit: "usd", tone: "ok" }),
  ],
});
```

- [ ] **Step 2: Add failing cases for `is_available: false`, no USD entry, numeric strings, HTTP 401, and malformed JSON**

Expected behavior: a no-USD response is unavailable; numeric strings parse; the authentication failure is unavailable; malformed JSON becomes a provider-local error.

- [ ] **Step 3: Implement a private schema and environment-only request**

```ts
const DeepSeekBalanceResponseSchema = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(z.object({
    currency: z.string(),
    total_balance: ApiNumberSchema,
    granted_balance: ApiNumberSchema.optional(),
    topped_up_balance: ApiNumberSchema.optional(),
  })),
});
```

```ts
const response = await fetchProviderApi(this.fetchApi, "https://api.deepseek.com/user/balance", {
  headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
});
```

- [ ] **Step 4: Return the existing generic balance shape**

```ts
balances: [{
  id: "usd_balance",
  label: "Balance",
  remaining: usd.total_balance,
  unit: "usd",
  tone: balanceToneFromRemaining(usd.total_balance),
}],
```

Expected: The label, value, and unit stay truthful for old and new clients.

- [ ] **Step 5: Register and test the fetcher**

Run: `npx vitest run packages/server/src/services/quota-fetcher/service.test.ts --bail=1`

Expected: The new DeepSeek tests pass with the existing protocol.

### Task 11: Document, verify, and submit the DeepSeek pull request

**Files:**

- Modify: `docs/providers.md`.
- Test: `packages/server/src/services/quota-fetcher/service.test.ts`.

- [ ] **Step 1: Integrate this limitation into Provider Usage Fetchers**

```text
DeepSeek usage reads `DEEPSEEK_API_KEY` and currently reports only a USD account balance. Do not convert other reported currencies until the provider-usage protocol has generic currency support.
```

- [ ] **Step 2: Run verification**

```bash
npm run format
npm run typecheck
npm run lint
npx vitest run packages/server/src/services/quota-fetcher/service.test.ts --bail=1
```

Expected: All commands exit with code 0.

- [ ] **Step 3: Perform real-provider QA**

Record platform, daemon version, USD response fields, visible Host Usage card, and the behavior for a non-USD account if one is available. Redact every key and account identifier.

- [ ] **Step 4: Commit and open the linked pull request**

```bash
git add docs/providers.md packages/server/src/services/quota-fetcher/manifest.ts packages/server/src/services/quota-fetcher/providers/deepseek.ts packages/server/src/services/quota-fetcher/service.test.ts
git commit -m "feat: add DeepSeek provider usage"
```

---

## Post-Submission Follow-up

### Task 12: Keep non-core plugin features independent

**Files:**

- Read: `/home/ubuntu/paseo-plugins/provider-usage/`.

**Produces:** A maintained plugin that does not duplicate accepted core work.

- [ ] **Step 1: Do not remove plugin features before an upstream change merges and releases**

Expected: Existing users keep their dashboard, panel, pill, alerts, and generation lookup.

- [ ] **Step 2: After each release, replace only duplicate provider-fetch calls with `paseo.providers.listUsage()` where the released core feature supplies equivalent data**

Expected: The plugin retains unique UI while the daemon owns provider API calls and caching.

- [ ] **Step 3: Create separate Discussion proposals before requesting active-agent billing attribution, multi-currency balances, management-key credits, or new core UI**

Expected: Each request names the general capability, the affected providers, and a complete cross-platform experience.

## Plan Self-Review

- Spec coverage: Tasks 3 to 5 cover Z.AI windows. Tasks 6 to 8 cover OpenRouter key usage. Tasks 9 to 11 cover DeepSeek USD balance. Tasks 1 and 2 cover maintainer approval and clean contribution setup. Task 12 protects plugin-only work.
- Placeholder scan: No implementation step relies on unspecified files, API keys, or protocol fields.
- Type consistency: All three new sources implement `ProviderUsageFetcher` and return only existing `ProviderUsage`, `ProviderUsageWindow`, `ProviderUsageBalance`, and `ProviderUsageDetail` fields.
