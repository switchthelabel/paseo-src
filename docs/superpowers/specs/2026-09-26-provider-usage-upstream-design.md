# Upstream Provider Usage Design

## Purpose

Turn the proven provider-usage data work in the local `provider-usage` plugin into small,
maintainable contributions to the Paseo core repository. The scope is server-side usage
collection. The existing generic provider-usage API and app cards render the results.

## Outcome

Paseo can report:

- Z.AI Coding Plan quota windows for GLM users.
- OpenRouter key spend and key limit usage.
- A DeepSeek USD account balance when the account reports a USD balance.

Each source returns the existing `ProviderUsage` shape. No app surface, protocol field, or
provider adapter changes are part of this work.

## Contribution Boundary

The work is three independent server-only pull requests after a GitHub Discussion. Each pull
request adds or changes one fetcher, registers it in the manifest when it is new, adds focused
tests, and updates the provider-usage contributor guidance.

The first release only reads its documented environment variable:

| Usage source | Environment variable | Endpoint |
| --- | --- | --- |
| Z.AI / GLM | `ZAI_API_KEY` or `GLM_API_KEY` | `https://api.z.ai/api/monitor/usage/quota/limit` |
| OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1/auth/key` |
| DeepSeek | `DEEPSEEK_API_KEY` | `https://api.deepseek.com/user/balance` |

Fetchers are read-only. They do not refresh, rewrite, or log credentials. They use the existing
15-second HTTP timeout and return `unavailable` for missing credentials or authentication errors.

## Decisions

### Reuse the existing generic usage path

`ProviderUsageService` already caches results, coalesces simultaneous requests, isolates a failed
provider, and exposes results through the current Host Usage and active-agent tooltip surfaces.
New fetchers use that path. They do not add a plugin RPC, polling timer, dashboard, panel, pill,
toast, or provider-specific renderer.

### Z.AI / GLM is an improvement, not a new provider

`ZaiQuotaProvider` already exists. It currently reads plan metadata from the subscription endpoint.
It will additionally normalize quota windows from the quota endpoint. Subscription data remains a
best-effort source for the plan label.

### OpenRouter credits stay out of the first pull request

OpenRouter's account-credit endpoint requires a management key. The first contribution reads only
the normal API-key endpoint and shows its key-level spend or limit data. It must remain useful when
the caller does not hold a management key.

### DeepSeek is conditional on currency support

The current protocol accepts `usd`, `credits`, `requests`, and `tokens` balance units. It cannot
represent CNY without either lying to the user or changing the protocol. The DeepSeek pull request
returns a USD balance only. A CNY-only account returns `unavailable` with no fabricated conversion.
A discussion-approved, backward-compatible ISO-currency extension is separate work.

### Do not infer billing ownership from the agent provider

An OpenCode, Goose, Pi, Codex, or custom provider session can use more than one billing service.
Hard-coded mappings such as `opencode -> openrouter` are incorrect. New usage results appear in
Host Usage. Active-agent attribution requires a generic provider-to-billing-source design and is
not included here.

### Do not read configuration files directly

The plugin reads `~/.paseo/config.json`. Core code must not copy this pattern because Paseo supports
custom daemon homes. A future credential-resolver feature needs maintainer approval and a daemon
configuration boundary. The first three fetchers use the documented process environment only.

## Deferred Work

- OpenRouter management-key credit balances.
- CNY and other non-USD provider balances.
- Custom provider environment lookup for usage fetchers.
- Active-agent billing-source attribution.
- Dashboard, workspace panel, composer pill, warning toast, and generation lookup UI.

## Acceptance Criteria

- Existing clients parse every usage response without protocol changes.
- A failed provider does not hide results from other providers.
- No request or log contains an API key.
- Z.AI reports normalized quota windows when its quota endpoint returns usable limits.
- OpenRouter reports supported key-level usage without requiring a management key.
- DeepSeek reports a USD balance without currency conversion.
- Each pull request has deterministic fetcher tests and documented real-provider QA evidence.
