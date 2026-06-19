# Spending Caps & Safe Delegated Access

This guide explains how to limit advertising spend risk when running Meta Ads CLI
— especially when handing API access to an engineer, an automated agent, or a CI
pipeline. It covers the CLI's built-in `--max-spend-cap` guard plus the Meta-side
controls that complement it.

> **TL;DR** — For delegated/agent access, stack three independent walls: a
> **System User token scoped to a sandbox or low-cap account**, the CLI's
> **`--max-spend-cap`** (or `--read-only`), and a Meta **account-level
> `spend_cap`**. An action would have to defeat all three to spend real money.

---

## 1. The `--max-spend-cap` guard (CLI-enforced)

The CLI can block any write whose budget exceeds a ceiling you set. It is
enforced inside `MetaClient.request()` — the single chokepoint every command
routes through — so it covers **all** commands (campaigns, ad sets, ads, bulk,
duplication, etc.) without per-command configuration.

### What it checks

The guard inspects `POST` request bodies (creates **and** edits — Meta uses POST
for both) and rejects the call if any of these fields exceeds the cap:

| Field | Where it appears |
|-------|------------------|
| `daily_budget` | campaigns, ad sets |
| `lifetime_budget` | campaigns, ad sets |
| `spend_cap` | campaigns, accounts |
| `bid_amount` | ad sets, ads |

**All values are in cents** — the same unit the Meta API and this CLI use
throughout. `--max-spend-cap 1000` means **$10.00**.

### How to set it

Two ways, flag takes precedence over env:

```bash
# Per-invocation flag
meta-ads --max-spend-cap 1000 campaigns create --daily-budget 5000 ...

# Durable env var (recommended for delegated access — can't be "forgotten")
export META_ADS_CLI_MAX_SPEND_CAP=1000
meta-ads campaigns create --daily-budget 5000 ...
```

When delegating to an engineer or agent, set the **env var** in their
environment. Unlike a flag, they can't omit it on a one-off command.

### What you see when it blocks

```
$ meta-ads --max-spend-cap 10000 campaigns create --daily-budget 50000 ...
Error: Spend-cap guard: daily_budget=50000¢ ($500.00) exceeds the
--max-spend-cap of 10000¢ ($100.00). Raise --max-spend-cap /
META_ADS_CLI_MAX_SPEND_CAP, or lower the budget.
```

### Validated during `--dry-run` too

The guard runs **before** the dry-run preview, so a violation is caught while
previewing — an engineer sees the block without ever issuing a live call:

```bash
meta-ads --dry-run --max-spend-cap 1000 campaigns create --daily-budget 5000 ...
# → blocked here, nothing sent to Meta
```

### Limitations (know these)

- **Only sees what the CLI sends.** The guard reads budget fields out of the
  request body the CLI constructs. It cannot police spend that happens through
  Meta's own optimization once a campaign is live — only the *budget you set* via
  the CLI.
- **Per-field, not cumulative.** It caps each individual budget field on each
  write; it does not track total spend across many campaigns. For a true account
  ceiling, use Meta's account-level `spend_cap` (section 3).
- **POST-only.** `GET` (reads) and `DELETE` are never budget-relevant, so they
  pass through.

---

## 2. Complementary CLI guards

`--max-spend-cap` composes with the other safety flags:

| Flag / env | Effect | Use when |
|------------|--------|----------|
| `--read-only` | Blocks **all** POST/DELETE | Analytics/reporting agents that never need to write |
| `--dry-run` | Previews every write as a logged call without sending | Validating an agent's intended actions before going live |
| `--max-spend-cap <cents>` | Blocks writes over a budget ceiling | Agents that *do* write but must stay under a limit |

`--read-only` is the strongest: if the agent only needs to read insights, run
`ai recommendations`, or export backups, it **physically cannot spend** —
combine it with `--max-spend-cap` for defense in depth.

Check what's active any time:

```bash
meta-ads doctor      # reports the spend-cap guard status, token scopes, and more
```

---

## 3. Meta-side controls (account-enforced)

The CLI guard is your first wall; these are enforced by Meta regardless of which
tool calls the API.

### Sandbox ad account — zero spend, by design

Meta offers a **sandbox mode** built for exactly this. A sandbox ad account:

- Accepts all Marketing API calls and returns realistic responses
- **Never delivers ads — no impressions, no spend, no funding source needed**

This is the safest target for agent development. The agent can create/edit/delete
freely and *cannot* spend. (Tradeoff: sandbox accounts aren't visible in Ads
Manager — they're API-only.)

### Account-level `spend_cap`

On a real test account, set a hard account cap so campaigns auto-pause when total
spend hits it:

```bash
meta-ads accounts ... # set spend_cap (in cents) on the account
```

⚠️ **Meta rate-limits spend-cap changes to 10 per day** — set it once and leave it.

### Token scope — least privilege

Issue tokens with only the scopes the task needs:

- **`ads_read` only** (no `ads_management`) → Meta rejects *any* write at the API
  level, independent of the CLI. Ideal for read-only agents.
- **System User token scoped to one account** → even a misbehaving agent can only
  touch that single account, not your whole Business Manager.

See [TOKENS / auth setup](../README.md) for issuing tokens.

---

## 4. Recommended recipe: engineer or agent with minimal risk

| Layer | How to set | What it stops |
|-------|-----------|---------------|
| **Sandbox account** | Meta Business Settings | Spend entirely (can't deliver) |
| **System User token scoped to that account** | Meta Business Settings → System Users | Touching your other accounts |
| **`ads_read`-only scope** (if read-only agent) | Token scope | Any write, API-enforced |
| **`META_ADS_CLI_MAX_SPEND_CAP`** | Env var in their environment | Over-budget writes, CLI-enforced |
| **`--read-only` / `--dry-run`** | Flag or env | Writes / previews them safely |
| **Account `spend_cap`** (if testing real delivery) | Meta account setting | Runaway total spend, hard ceiling |

**Concrete handoff:** give the engineer a **System User token scoped to a
sandbox or low-cap test account**, set `META_ADS_CLI_MAX_SPEND_CAP` in their
environment, and have them develop with `--dry-run` first, then `--read-only`
for anything live. That's three independent walls between their agent and your
daily budget.

---

## 5. Related environment variables

| Variable | Purpose |
|----------|---------|
| `META_ADS_CLI_MAX_SPEND_CAP` | Cents ceiling on budget fields in writes (same as `--max-spend-cap`) |
| `META_ADS_CLI_ACCOUNT_ID` | Default account — point it at a sandbox/test account for delegated use |
| `META_ADS_CLI_ACCESS_TOKEN` | The token; scope it minimally for delegated access |

See [CLAUDE.md](../CLAUDE.md) for the full environment-variable reference.
