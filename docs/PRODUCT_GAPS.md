# Product Gaps Review: meta-ads-cli

Reviewed on 2026-10-27 against version 0.3.0. The working tree had uncommitted changes, and `dist/` was built at 11:10 that day. This is a product manager's review. It covers missing features, half-done features and confusing user experience.

- Code bugs are out of scope. They live in [BUG_SPEC.md](BUG_SPEC.md).
- Meta API version changes are out of scope. They live in [META_API_UPDATES.md](META_API_UPDATES.md), which is referenced here only where its P3 "new capability" items matter to users.

Evidence is given as `file:line` (line numbers from the working tree on the review date), as a missing command, or as observed CLI behaviour (`node dist/index.js ...`). Any claim about a competitor is marked **(unverified)** unless a source was checked.

**Who uses this tool.** The analysis covers three kinds of user:
1. **Marketers and operators** who launch, manage and report on campaigns.
2. **Agencies** that run many client accounts.
3. **AI agents** that act for (1) or (2), under delegated and budget-limited access.

---


**Status (2026-10-27):** All gaps except G4's npm name and licence (owner decisions) are implemented in 0.4.0; see CHANGELOG.md. Items the implementers couldn't verify against Meta's docs are listed in the PR description.

## Executive summary: top 5 recommendations

1. **Make the CLI's machine contract reliable for agents (P0, effort S–M).**
   - **Errors.** Every failure is one line of plain text, `Error: <msg>`, with exit code 1 (`src/errors.ts:11-12`). Meta's `code`, `error_subcode` and `fbtrace_id` are thrown away (`src/meta-client.ts:387`).
   - **Dry-run output.** `--dry-run` writes `[dry-run] ...` text lines to **stdout** and then a JSON stub after them, so `meta-ads --dry-run ... | jq` breaks. Reads under dry-run return a fake object instead of data (`src/meta-client.ts:227-233`).
   - **Fix.** Add a JSON error envelope, documented exit codes, a stdout that carries only the result, and a `--plan` mode that runs the real reads and stubs only the writes.

2. **Close the governance hole for delegated access: going live and deleting are unguarded (P0, effort M).**
   - **Going live is not checked.** `--max-spend-cap` checks budget *values*, but the action that actually starts spending is `campaigns|adsets|ads update --status ACTIVE`, and nothing checks it.
   - **Deletes run without confirmation.** `campaigns|adsets|ads delete`, `audiences delete`, `catalog delete-product` and `whatsapp delete-template` all run immediately.
   - **The policy is easy to undo.** It lives in env vars and profiles, which an agent with a shell can unset or edit.
   - **Missing controls.** There is no account allowlist, no cap on total daily budget across the account, and no local journal of the writes the CLI made.
   - **Fix.** Add a policy file and an approval gate, sketched in [G2](#g2-governance-going-live-deletes-tamper-resistant-policy-audit-log).

3. **Fix report fidelity (P0, effort S–M).**
   - **CSV and table output drop conversion values.** `actions: [{action_type:'purchase', value:'3'}, ...]` comes out as `"purchase, link_click"` with the numbers missing (`src/formatter.ts:39`; reproduced). Every CSV report built from insights therefore loses its conversions.
   - **`analytics report` ignores `--time-range`.** The flag is accepted but never sent (`src/commands/analytics.ts:156-176`).
   - **Fix.** Add derived metric columns: `purchases`, `cpa`, `roas` and `results`.

4. **Ship it: distribution and licensing (P0, effort S, plus a business decision).**
   - **Both natural npm names belong to other people.** `meta-ads-cli` is published by another maintainer (v0.1.0, oclif-based, also installs a `meta-ads` binary), and `meta-ads` is published by a third party (v0.19.5). Both were checked with `npm view`.
   - **No CI.** There is no `.github/` folder.
   - **The only install path is `git clone` plus a build** (`README.md:50`).
   - **The licence blocks the main users.** CC-BY-NC-4.0 is not a software licence and bans commercial use, which excludes agencies and in-house marketers.

5. **Add real automation, using Meta's server-side automated rules plus alerts (P1, effort M).**
   - **Why the current commands fall short.** `monitor check` and `monitor auto-pause` are one-shot commands. They only work if something like cron runs the CLI on a machine that holds a token.
   - **What is missing.** Meta's Automated Rules API (`adrules_library`), which runs inside Meta with no CLI process, is not wrapped at all (grep: no `adrules`). There is also no Slack, email or webhook notification output.
   - **Comparison.** Rules plus alerts is the main thing marketers buy Revealbot/Birch and Madgicx for **(unverified)**.

---

## Prioritized gap table

Effort: S is under 2 days, M is under 2 weeks, L is more than 2 weeks.

| # | Gap | Who | Priority | Effort |
|---|-----|-----|----------|--------|
| G1 | Machine contract for agents: JSON errors, exit codes, a stdout that carries only the result, dry-run with real reads (`--plan`) | Agents, CI | **P0** | S–M |
| G2 | Governance: going-live and delete guards, a tamper-resistant policy file, an account allowlist, a total-budget cap, a write journal | Agents, agencies | **P0** | M |
| G3 | Report fidelity: CSV/table lose `actions` values, no derived metrics, `analytics report` ignores time range | Marketers, agents | **P0** | S–M |
| G4 | Distribution: npm name taken, no CI, git-clone install, NC licence, keytar native dependency | Everyone | **P0** | S (+decision) |
| G5 | Automation: Meta automated rules, scheduled monitoring, Slack/email/webhook alerts | Marketers, agencies | P1 | M |
| G6 | End-to-end launch from a spec file (`plan`/`apply`), including the creative; `workflow launch-campaign` is half-done | Marketers, agents | P1 | L |
| G7 | Server-side validation (`execution_options=validate_only`) and a pre-flight "will this launch?" check | Agents, marketers | P1 | S–M |
| G8 | Generated CLI introspection (all ~270 commands, flags and types) and an MCP server mode | Agents | P1 | M |
| G9 | Customer-list custom audiences (hashed upload) and saved audiences | Marketers | P1 | M |
| G10 | Account-level `spend_cap` command and a spend-pacing view; the docs point at a command that doesn't exist | Agencies, agent owners | P1 | S |
| G11 | JSON input from file or stdin (`@file`, `-`) and readable JSON parse errors | Agents, power users | P1 | S |
| G12 | Ad previews and a disapproved/limited-ads report | Marketers | P1 | S–M |
| G13 | Consistency: time flags, money units, default limits, confirmation flags, default output format | Everyone | P1 | M |
| G14 | Multi-account and agency use: cross-account rollups, a default profile, keychain tokens, client tags | Agencies | P1 | M |
| G15 | Native A/B tests (`ad_studies`) instead of copy-and-compare | Marketers | P2 | M |
| G16 | Creative workflows: asset library, Advantage+/dynamic creative, video processing status, bulk from folder | Marketers | P2 | M–L |
| G17 | Bulk sheet round-trip (CSV export, edit, import with diff), bulk update of any field, resumable batches | Agencies, marketers | P2 | M |
| G18 | Webhook receiver (`webhooks listen`) and lead streaming to CSV, CRM or a webhook | Lead-gen marketers | P2 | M |
| G19 | Observability: `--verbose`, `fbtrace_id`, a `limits` command, request timing | Agents, maintainers | P2 | S |
| G20 | Heuristic "intelligence" commands with hard-coded, currency-blind thresholds, and overlapping report commands | Marketers | P2 | M |
| G21 | Docs and skills drift: version, file counts, stale `skills/`, branding text | Everyone | P2 | S |
| G22 | Shell completion and `--help` examples | Humans | P3 | S |
| G23 | Sandbox onboarding (`doctor --sandbox`, a test-account bootstrap guide) | Agent builders | P3 | S |
| G24 | New Meta capabilities listed as P3 in META_API_UPDATES (creative-audience pairing, PCA unified, Advantage+ creative enhancements, audience labels, Threads polls/topic tags) | Marketers | P3 | S each |

---

## Details

### G1. Machine contract for agents

**Who:** AI agents, CI scripts, anyone piping output into `jq`.

**Evidence**
- **Errors.** `src/errors.ts:11-12` prints `Error: ${message}` to stderr and exits with code 1 for *every* failure: bad flag, auth failure, permission denied, rate limit, spend-cap block or Meta validation error.
- **Meta error details are discarded.** `src/meta-client.ts:353-388` reads `error_subcode` and then discards it (`void errorSubcode`). `fbtrace_id` is never surfaced. `error_user_title` and `error_user_msg` are folded into one message string.
- **Dry-run output.** `src/meta-client.ts:229-231` writes `[dry-run] GET ...` to stdout with `console.log`, and the JSON stub follows it. Observed output of `node dist/index.js --dry-run campaigns list --account-id act_1`:
  - the first line is `[dry-run] GET https://...`;
  - after it comes `{"dryRun":true,"method":"GET","endpoint":"act_1/campaigns"}`.
- **Reads are also stubbed under dry-run.** Any read-then-write workflow (`workflow launch-campaign`, `duplicate-and-test`, `bidding optimize-budget`, `backup restore`) therefore can't show a realistic preview. Under `--dry-run` the preAction hook also skips auth entirely (`src/index.ts:202`).
- **Only some commands set an exit code.** `doctor`, `monitor` and `backup diff` set `process.exitCode = 1` when they find problems. Nothing else signals "completed, but with warnings or partial failure". For example, `bulk update-status` with 3 of 10 failed still exits 0.

**Impact**
- An agent cannot tell "retry later" (rate limit) from "fix your input" (validation), "re-authenticate" (190) or "blocked by policy" (spend cap) without parsing English text.
- Dry-run output can't be parsed, so agents can't do "show the human the plan, then execute".

**Proposal**
- **JSON errors.** Add `--error-format json` (default on when stdout is not a TTY, or set by `META_ADS_CLI_ERROR_FORMAT=json`). It writes this to stderr: `{"error":{"type":"rate_limit|auth|permission|validation|policy|network|not_found|usage","message":..,"meta":{"code":..,"subcode":..,"fbtrace_id":..,"user_title":..,"user_msg":..},"retry_after_ms":..}}`.
- **Documented exit codes:**

  | Code | Meaning |
  |------|---------|
  | 0 | Success |
  | 1 | Generic error |
  | 2 | Usage error |
  | 3 | Authentication |
  | 4 | Permission |
  | 5 | Validation |
  | 6 | Rate limited |
  | 7 | Blocked by policy (spend cap, read-only, approval needed) |
  | 8 | Partial failure |
  | 9 | Not found |

- **Dry-run output goes to stderr.** Under `--dry-run -o json`, emit `{"dryRun":true,"requests":[{method,url,body}]}` as the result, so a multi-call workflow shows every planned call.
- **`--plan` mode.** Real GETs run, writes are recorded and not sent, and at the end it prints a structured plan of the writes (see G6).
- **Partial results.** Bulk-style commands exit with code 8 and output `{succeeded:[...], failed:[{id,error}]}`.

**Effort:** S for the error envelope and exit codes, M for `--plan`. **Priority: P0.**

### G2. Governance: going live, deletes, tamper-resistant policy, audit log

**Who:** Owners who delegate to agents or juniors, and agencies.

**Evidence**
- **The spend-cap guard covers budget fields only** (docs/SPENDING_CAPS.md §1). These all pass with a $10 cap:
  - creating a campaign at the cap and then `campaigns update <id> --status ACTIVE`;
  - creating 500 ad sets at $10 each (SPENDING_CAPS.md says so itself: "Per-field, not cumulative");
  - `duplicate campaign --deep-copy` followed by activation.
- **No confirmation on destructive commands.** `campaigns.ts:198`, `adsets.ts:337`, `ads.ts:152`, `audiences.ts:181`, `catalog.ts:250`, `whatsapp.ts:215`, `leads.ts:144`, `reach-frequency.ts:86` and `branded-content.ts:41` all execute immediately.
- **The two confirmation flags that do exist are named differently.** `backup restore --yes` (`backup.ts:213`) and `monitor auto-pause --confirm` (`monitoring.ts:146`).
- **No account allowlist.** Any token can address any `act_` ID it has access to. `--account-id` is validated for format only (`src/index.ts:186-189`).
- **The policy is easy to tamper with.** It comes from env vars and `~/.config/meta-ads-cli/profiles.json`, both of which the agent's own user can edit. `profile create --spend-cap` and `profile delete` are themselves unguarded.
- **Sending messages is unguarded.** WhatsApp and Messenger sends go out to real customers without any guard (`whatsapp.ts:84-154`, `messenger.ts:25-57`). That is reputational and billable risk.
- **No record of writes.** There is no local, append-only journal of the writes the CLI made. Logging is opt-in (`META_ADS_CLI_LOG_FILE`). `accounts activity` shows Meta's activity log, which doesn't say *which agent run* did what.

**Impact.** The headline promise in SPENDING_CAPS.md, "three independent walls", is weaker than it reads. The cheapest way to spend money (switching on something already created) gets through.

**Proposal**
- **A policy file** at `~/.config/meta-ads-cli/policy.json`, or `/etc/meta-ads-cli/policy.json` to make it root-owned. It also takes `META_ADS_CLI_POLICY=<path>`.
  ```json
  {
    "allowedAccounts": ["act_1"],
    "maxBudgetCents": 1000,
    "maxAccountActiveDailyBudgetCents": 5000,
    "allow": { "activate": "approval", "delete": false, "send_message": false, "audience_upload": true },
    "maxWritesPerRun": 50
  }
  ```
  When a policy file is present, a flag or env var may make it stricter but never looser. `doctor` reports the file's path, its permissions, and whether it can be tampered with.
- **Approval gate.** An action set to `"approval"` stops with exit code 7 and prints an approval token. A human approves it with `meta-ads approve <token>`, or interactively when on a TTY. Agents then retry with `--approval <token>`.
- **One confirmation flag.** Use `--yes` everywhere for destructive commands. Without it, a TTY gets a prompt and a non-TTY fails with exit code 7. Keep `--confirm` as a deprecated alias.
- **Write journal** at `~/.local/state/meta-ads-cli/journal.jsonl`. Each entry records the time, profile, command line, request, response ID and before-state (for updates).
- **Undo.** `meta-ads journal list|show|undo <id>` (undo applies to status and budget changes only).
- **Total-budget check.** `maxAccountActiveDailyBudgetCents` requires a GET of active campaigns and ad sets before any activation or budget raise.

**Effort:** M. **Priority: P0.** This is the main differentiator for "safe for agents". Meta's own tools and the third-party MCP servers do not advertise anything like it **(unverified)**.

### G3. Report fidelity

**Who:** Marketers exporting reports, and agents summarising performance.

**Evidence**
- **CSV and table output lose the conversion values.** `src/formatter.ts:39` collapses an array of objects to `name || id || displayName || first value`.
  - For insights, `actions` and `cost_per_action_type` become `"purchase, link_click"` with the values missing. Reproduced with `formatOutput({data:[{actions:[{action_type:'purchase',value:'3'}]}]},'csv')`, which gives `"purchase"`.
  - The README and CONTEXT.md recommend `insights get ... -o csv > report.csv`, `ai export-dataset -o csv` and `leads export -o csv`. Lead `field_data` is special-cased; insights are not.
- **`analytics report` ignores `--time-range`.** It accepts the flag (`analytics.ts:159`) but never adds `time_range`/`date_preset` to the params (`analytics.ts:165-172`), so the report always covers Meta's default window. It also lists `campaign_name` at `--level account`. *Not in BUG_SPEC.md.*
- **No derived metrics.** "Results", purchases, ROAS, CPA, CPL and cost per result have to be dug out of nested `actions` / `action_values` / `purchase_roas` arrays by hand. Ads Manager shows them as columns.
- **No period-over-period comparison** (this week vs last week) in `insights`. `analytics trends` (`--days`) is the closest, and it is a different command with a different output shape.
- **No saved report definitions and no multi-account rollup** (see G14).

**Proposal**
- **Expand arrays into columns.** In csv/table output, turn `{action_type,value}` arrays into columns such as `actions.purchase`, `actions.link_click` and `cost_per_action_type.purchase`. Add `--flatten-actions` (on by default for csv/table).
- **Derived metrics.** `insights get --metrics results,purchases,cpa,roas,cpl` computes columns from `actions`, `action_values` and the ad set's `optimization_goal`, and `--action-type purchase` picks the conversion event.
- **Comparison.** `insights get --compare previous_period` adds Δ and Δ% columns.
- **Saved reports.** `insights report save <name> --level campaign --metrics ... --time-range last_7d` and `insights report run <name> [--accounts a,b]`.
- **Fix `analytics report`**, or merge it into `insights` (see G20).

**Effort:** S for the flattening fix, M for derived metrics and comparison. **Priority: P0**, because reports are silently wrong today.

### G4. Distribution, CI and licensing

**Who:** Everyone, and especially non-developer marketers and agency teams.

**Evidence**
- **The npm names are taken.** `npm view meta-ads-cli` returns someone else's package (maintainer `giorgioliapakis`, MIT, oclif, `bin: meta-ads`). `npm view meta-ads` returns another CLI (maintainer `gupsammy`, v0.19.5). Running `npm i -g meta-ads-cli` today installs a *different* tool, and its `meta-ads` binary would clash with this one.
- **Install is git-only.** The only documented path is `git clone` + `npm install` + `npm run build` + `npm link` (`README.md:50-58`). `package.json` has no `files` field, so a publish would ship `tests/`, `docs/` and so on (and `cache/` unless an `.npmignore` exists).
- **No CI.** There is no `.github/workflows` folder: no test runs on PRs, no build check, no release automation.
- **The version is hard-coded in two places.** It appears in both `src/index.ts:52` and `package.json` (CHANGELOG 0.3.0).
- **The licence.** CC-BY-NC-4.0 is a content licence, which Creative Commons itself advises against using for software. It also bans "commercial" use, and running ad campaigns for a business, or for clients as an agency, is commercial. Prospective users and contributors will likely avoid it.
- **keytar.** The `keytar` native module needs libsecret and a prebuilt binary, and the upstream project is archived. It is a common source of install failures on Linux, WSL and Alpine. CHANGELOG 0.3.0 already had to fix a keychain hang on WSL.
- **No standalone binaries** (Bun or Node SEA), no Homebrew formula, no Docker image for CI and agent sandboxes.

**Proposal**
- Publish as a scoped package (`@cklaus1/meta-ads-cli`, available as of this review) with `files: ["dist"]`, and read the version from `package.json`.
- Add GitHub Actions: lint, typecheck and test on Node 18/20/22; tag and publish to npm with provenance.
- Make keytar an `optionalDependencies` entry, falling back to the 0600 file (this is mostly the existing behaviour).
- Publish a Docker image `ghcr.io/.../meta-ads-cli`.
- **Licence:** choose MIT, Apache-2.0, or a source-available licence that allows commercial *use* but restricts resale (for example Elastic-2.0 or BSL). This is a business decision.

**Effort:** S (plus a decision). **Priority: P0.**

### G5. Automation: rules, schedules and alerts

**Who:** Marketers and agencies running always-on accounts.

**Evidence**
- **No automated rules.** grep finds no `adrules` / `adrules_library`. Meta's Automated Rules API runs rules server-side (pause when CPA > X, raise budget when ROAS > Y, notify), with no CLI process, cron job or token-holding machine.
- **`monitor check` and `monitor auto-pause` are one-shot** (`monitoring.ts:74,138`). There is no `--watch` or `--interval`, and no daemon.
- **No notification channel.** grep finds no `slack`, `webhook-url` or `smtp`. Alerts print to stdout.
- **`bidding budget-schedule` and `seasonal-schedule`** cover budget schedules, but not rules.

**Proposal**
```
meta-ads rules list|get|create|update|delete|preview|history --account-id act_1
meta-ads rules create --name "Pause high CPA" --entity adset \
  --filter 'cost_per_result>2500,spent>5000' --time-preset LAST_3_DAYS \
  --action PAUSE --schedule SEMI_HOURLY [--notify]
meta-ads monitor check ... --notify slack:$SLACK_WEBHOOK | webhook:https://... | email:...
meta-ads monitor watch --interval 15m --config monitors.yaml   # long-running, journaled
```
- `rules create` should check rule actions that raise budgets (`CHANGE_BUDGET`) against the spend-cap policy (G2).
- `rules preview` should show which entities would match right now.

**Comparison:** Revealbot/Birch, Madgicx and AdEspresso centre on rules and alerts **(unverified)**.

**Effort:** M. **Priority: P1.**

### G6. End-to-end launch from a spec (plan/apply)

**Who:** Marketers launching campaigns, and agents asked to "launch this campaign".

**Evidence**
- **`workflow launch-campaign` is half-done** (`workflows.ts:175-188`):
  - it requires an existing `--creative-id`, so the creative has to be built first through `creatives upload-image` and `create-image`;
  - it creates one ad set and one ad;
  - `--optimization-goal` defaults to `LINK_CLICKS` whatever the `--objective` is, so an `OUTCOME_SALES` launch without overrides optimises for clicks;
  - there is no pixel or promoted object.
- **`bulk create-campaigns` creates campaigns only** (`bulk.ts:29-32`): no ad sets, ads or creatives.
- **There is no declarative format.** `backup export/diff/restore` already has a snapshot model (`backup.ts:82-214`). It is the right foundation, but it can't be used to *author* new structures.
- **Failures leave orphans.** If step 3 of a multi-step launch fails, steps 1 and 2 are left behind, and nothing reports what to clean up.

**Proposal.** Add a YAML/JSON spec format reusing the backup snapshot schema:

```yaml
account: act_1
campaign: { name: Fall Sale, objective: OUTCOME_SALES, daily_budget: 5000, promoted_object: {pixel_id: 1, custom_event_type: PURCHASE} }
adsets:
  - name: US 25-44
    targeting: { geo_locations: {countries: [US]}, age_min: 25, age_max: 44 }
    ads:
      - name: Hero
        creative: { image: ./hero.jpg, primary_text: "...", headline: "...", link: https://..., cta: SHOP_NOW }
```

```
meta-ads apply launch.yaml --plan     # validate (G7) + print the diff/plan as JSON
meta-ads apply launch.yaml            # creates PAUSED; journals IDs; rolls back or prints orphans on failure
meta-ads apply launch.yaml --activate # subject to G2 approval
```
- Make `workflow launch-campaign` derive `optimization_goal` and `billing_event` from the objective.
- Accept `--image <path>` / `--video <path>` plus copy flags, so the CLI builds the creative itself.

**Effort:** L. **Priority: P1.** This is the biggest "job to be done" gap for a launch-focused tool.

### G7. Server-side validation before writes

**Who:** Agents and marketers.

**Evidence**
- grep finds no `execution_options` / `validate_only`. The Marketing API accepts `execution_options=["validate_only"]` on create and update, which checks a write fully without committing it.
- `--dry-run` only shows the request locally, so invalid targeting, a missing pixel or a policy problem surfaces only on the live call.
- META_API_UPDATES rows #37 and #38 (flagged audiences, consolidated interests) are exactly the errors that validate-only would catch.

**Proposal**
- A global `--validate` flag that adds `execution_options=["validate_only"]` to every POST and reports the results.
- `--plan` (G1) should call it automatically for each planned write.
- `meta-ads targeting validate --targeting @spec.json` calling `targetingvalidation`.

**Effort:** S–M. **Priority: P1.**

### G8. Introspection and MCP

**Who:** Agents (Claude Code, OpenClaw and others), and tool builders.

**Evidence**
- **`schema` is a hand-maintained table covering 11 services** (`src/commands/schema.ts:12-68`) out of 37 command groups and roughly 270 subcommands. It also describes Graph *endpoints*, not CLI flags.
- **CONTEXT.md's first rule for agents is to "Start with `schema`"**, which sends them to an incomplete and differently shaped description.
- **There is no way to get the CLI's own command tree as JSON.** This review had to scrape `--help` 271 times.
- **The checked-in `skills/` folder is stale.** It has 24 skills plus INDEX, while `generate-skills.ts` defines 32, and `skills/` is in `.gitignore` while files are present.
- **No MCP server mode.** By contrast:
  - several community Meta Ads MCP servers exist (search results: byadsco/meta-ads-mcp and many Glama listings);
  - one project says it aligned tool names with an official Meta MCP server at `mcp.facebook.com/ads` **(unverified; secondhand)**;
  - Pipeboard's meta-ads-mcp is a widely used hosted MCP **(unverified)**.

**Proposal**
- **`meta-ads schema --cli [-o json]`**, generated by walking the Commander tree. For each command it gives the name, aliases, description, arguments, options (type, default, required, choices, unit "cents"), whether it writes, whether it is destructive, and which policy actions it touches. Use the same output to generate skills, README tables and shell completion (G22).
- **`meta-ads mcp`** (stdio, and optionally HTTP), exposing each subcommand as a tool, generated from the same tree. It must be governed by the same policy file (G2) and journal, which would be a real advantage over community MCP servers.
- Keep the Graph-endpoint schema as `schema --api`.

**Effort:** M. **Priority: P1.**

### G9. Customer-list audiences and saved audiences

**Who:** Marketers doing CRM retargeting and exclusions (one of the most common audience tasks).

**Evidence**
- `audiences create-custom` takes `--subtype` and `--rule` (`audiences.ts:53-60`). There is no upload to `/{audience_id}/users` (grep finds no `/users`), no SHA-256 normalisation of email and phone, and no add/remove/replace sessions.
- The Conversions API code already has hashing (CHANGELOG "Conversions API user data is SHA-256 hashed"), so the building block exists.
- grep finds no `saved_audiences`. Only the CHANGELOG mentions audience sharing between accounts.

**Proposal**
```
meta-ads audiences upload <audienceId> --file customers.csv --schema EMAIL,PHONE,FN,LN [--mode add|remove|replace] [--no-hash]
meta-ads audiences create-customer-list --name "Buyers 2026" --file buyers.csv --schema EMAIL
meta-ads audiences saved list|get|create
meta-ads audiences share <audienceId> --to act_2
```
- Upload in batches of 10k with a session ID and progress on stderr.
- Gate it behind the `audience_upload` policy (G2).

**Effort:** M. **Priority: P1.**

### G10. Account spend cap and pacing

**Who:** Agency owners and owners delegating to agents.

**Evidence**
- `docs/SPENDING_CAPS.md:146` tells users to run the placeholder `meta-ads accounts ... # set spend_cap (in cents) on the account`. No such command exists: `accounts` has only `list`, `get` and `activity` (`accounts.ts:10-50`).
- The document calls the account cap "the true account ceiling", but the CLI can't set it.
- There is no view of spend against the cap, budget remaining, or pacing ("we'll overspend this month by X").

**Proposal**
```
meta-ads accounts set-spend-cap act_1 --cents 100000   # warns about Meta's 10-changes/day limit; G2-gated
meta-ads accounts reset-spend-cap act_1
meta-ads accounts spend act_1 [--month]                 # amount_spent vs spend_cap, MTD, projected EOM
```

**Effort:** S. **Priority: P1.** The fix is small, it closes a documented hole, and it completes the governance story.

### G11. JSON input from files or stdin

**Who:** Agents and power users.

**Evidence**
- About 20 options take inline JSON only, including:
  - `--targeting` (`adsets.ts:215,306`), `--config` (`bulk.ts:39`), `--images` (`bulk.ts:159`);
  - `--events` (`conversions.ts:185,233,351`), `--items` (`instagram.ts:210`), `--stages` (`retargeting.ts:210`);
  - `--components` (`whatsapp.ts:116`), `--brands` (`ads-library.ts:82`).
- Each is a bare `JSON.parse`, so malformed input gives `Error: Unexpected token } in JSON at position 41` with no hint of which flag was wrong.
- Shell quoting of nested JSON is the most common failure for agents and for humans on Windows.

**Proposal**
- Add one helper, `parseJsonOption(value, flagName)`, that accepts an inline string, `@path/to/file.json` or `-` (stdin).
- On error it names the flag and position: `--targeting: invalid JSON at line 3 col 5`.
- Validate shape where a schema is known (targeting, promoted_object).

**Effort:** S. **Priority: P1.**

### G12. Ad previews and review status

**Who:** Marketers, and anyone approving agent-built ads.

**Evidence**
- **No previews.** grep finds no `generatepreviews`; the only `previews` mention is in `backup.ts`. There is no way to see what an ad looks like in Feed, Stories or Reels before switching it on, which is critical for human approval of agent-built ads.
- **No review report.** `ads get` returns `ad_review_feedback` and `issues_info` (`ads.ts`), but no command lists disapproved, limited or with-issues ads across an account with their reasons.

**Proposal**
- `meta-ads ads preview <adId|--creative-id> --format MOBILE_FEED_STANDARD,INSTAGRAM_REELS [--html out.html]`, returning preview iframe URLs.
- `meta-ads ads issues --account-id act_1 [--status DISAPPROVED,WITH_ISSUES]` returning the ad, the reason, the policy and the fix hint.
- Include both in `workflow full-audit`.

**Effort:** S–M. **Priority: P1.**

### G13. Consistency: flags, units and defaults

**Who:** Everyone. Inconsistency makes humans and agents guess.

| Area | Current state (evidence) | Proposal |
|------|--------------------------|----------|
| Time windows | `--time-range` (13 commands), `--date-start/--date-end` (insights), `--date-preset` (`monitor`, `monitoring.ts:81,144`), `--days` (`analytics trends`, `optimization-insights`), `--since/--until` as **Unix timestamps** (`accounts activity`, `accounts.ts:53-54`), `--start-date/--end-date`, `--period` | One vocabulary everywhere: `--time-range <preset>` or `--since/--until <YYYY-MM-DD>`. Keep the old flags as hidden aliases |
| Money units | Budgets and bids in **cents** (campaigns, adsets, spend cap). `monitor --max-cpc` and `--max-spend` in **currency units** (`monitoring.ts:76,79`). Insights `spend` comes back as currency strings | Accept a suffix, e.g. `--max-spend 50.00USD` or `5000c`. Always echo both units in output. Document one rule |
| Default page size | `campaigns list` 10 (`campaigns.ts:44`), `ads list` 10, `audiences list` 25, `accounts list` 200, `insights get` 25 | One default (for example 50) and a `"truncated": true, "next": "<cursor>"` hint in JSON when there are more pages, so agents don't treat page 1 as everything |
| Pagination flags | `--all` on 21 commands, `--page-delay` only on some, `--after` only on some | The same trio everywhere a list exists |
| Confirmation | `--yes` (backup restore) vs `--confirm` (monitor auto-pause) vs nothing (all deletes) | `--yes` everywhere (G2) |
| Default output | `json` almost everywhere; `doctor` defaults to `text` (`doctor.ts:90`); `monitor dashboard` to `table` (`monitoring.ts:220`); `auth *` and `profile use` don't support `-o` | `json` when not a TTY, readable output on a TTY, or document the exceptions |
| Insights level | `insights get` defaults `--level ad` even when the object is an account or campaign (`insights.ts:88`) | Default to the object's own level |
| Delete semantics | campaigns/adsets/ads set `status=DELETED` (irreversible), audiences use HTTP DELETE | Offer `archive` as the safe default, and require `--yes` for `delete` |
| Naming | `ig` group described as "Instagram Shopping and business profile management" (`instagram.ts:42`), but it is mostly publishing. Root description says "Facebook & Instagram" (`index.ts:51`). `pixels` is defined in `audiences.ts:191` | Update descriptions; move `pixels` to its own module |

**Effort:** M (mostly mechanical, needs a deprecation path). **Priority: P1.**

### G14. Multi-account and agency use

**Who:** Agencies and multi-brand advertisers.

**Evidence**
- **Profiles exist** (`profile.ts`), but:
  - **tokens and app secrets are stored in plain JSON** (0600 permissions) rather than the keychain that `auth` uses;
  - **`profile create --access-token EAA...` puts the token in shell history;**
  - **`profile use` doesn't switch anything.** It prints `export META_ADS_CLI_ACCESS_TOKEN="<full token>"` to stdout (`profile.ts:95-101`), which leaks the secret into terminal scrollback and logs;
  - there is no persistent "current profile".
- **No cross-account operations.** Nothing like "spend yesterday across all 30 clients", "all accounts with disapproved ads" or "accounts whose payment failed". Every command takes a single `--account-id`.
- **No client metadata.** There are no tags, names or currency/timezone normalisation for rollups.

**Proposal**
- `profile switch <name>` persists the current profile; add `profile current`.
- Store secrets in the keychain, with the file as fallback.
- `profile create --access-token -` reads the token from stdin.
- Global `--accounts act_1,act_2|@clients.txt|all` on read commands (insights, ads issues, accounts spend). Fan out with concurrency limits and rate-limit awareness, and add an `account_id` column to the output.
- `meta-ads accounts health --all`: status, disable reason, funding, spend vs cap, active campaigns, disapprovals.

**Effort:** M. **Priority: P1.**

### G15. Native experiments

**Who:** Performance marketers.

**Evidence**
- `ab-test create` duplicates campaigns with a different bid strategy and compares their insights (`ab-testing.ts`). grep finds no `ad_studies`.
- Copies compete for the same audience, so the result is not a clean split test, and no significance test is reported to Meta's standard.
- There is no conversion-lift or brand-lift study support.

**Proposal**
- `meta-ads experiments create --type SPLIT_TEST --cells @cells.json --start ... --end ...`, plus `experiments results <id>` (confidence and winner from Meta).
- Keep `ab-test` as a quick, local "compare two entities" helper and rename it accordingly.

**Effort:** M. **Priority: P2.**

### G16. Creative workflows

**Who:** Marketers and creative strategists.

**Evidence**
- **Uploading works, browsing doesn't.** There are `creatives upload-image/upload-video/create-image/create-video/clone/update` commands, but no `creatives images list` or `videos list` (the account asset library), so existing assets can't be reused by hash.
- **No Advantage+ or dynamic creative builder.** `asset_feed_spec` is only touched by clone, backup and duplicate. There is no builder for multiple texts, headlines and images, and no Advantage+ creative enhancement toggles (META_API_UPDATES #24, P3).
- **`upload-video` doesn't wait for processing** (`creatives.ts:458`). Meta video IDs aren't usable until encoding finishes, so creating the ad straight afterwards fails intermittently. There is no resumable or chunked upload for large files.
- **No bulk creative from a folder or CSV** (`bulk upload-creatives` takes a JSON array of URLs, `bulk.ts:154`).
- **No AI help with copy.** There is an LLM layer (`src/llm.ts`), but no `ai copy` / `ai variants` for headlines and primary text. That is an obvious use given the existing Anthropic integration.

**Proposal**
```
meta-ads creatives images list|get --account-id act_1
meta-ads creatives upload-video --file x.mp4 --wait [--timeout 600]
meta-ads creatives create-dynamic --images a.jpg,b.jpg --headlines @h.txt --bodies @b.txt --link ... --enhancements standard_enhancements,image_animation
meta-ads bulk upload-creatives --dir ./assets [--manifest creatives.csv]
meta-ads ai copy --product "..." --audience "..." --n 5 [--brand-voice @voice.md]
```

**Effort:** M–L. **Priority: P2.**

### G17. Bulk-sheet round trip

**Who:** Agencies and marketers who live in spreadsheets (the Ads Manager export/import workflow).

**Evidence**
- `bulk update-status` changes status only (`bulk.ts:87-92`). There is no bulk update of budgets, names, bids or end dates.
- There is no CSV import.
- Batches are not resumable or idempotent: a failure halfway forces a manual reconciliation. Since 0.3.0, creates are deliberately not retried (CHANGELOG), which makes resumability more important.
- There is no Graph Batch API use for general edits (grep shows `batch` only in catalog and conversions), so large edits are slow and consume rate limit.

**Proposal**
```
meta-ads bulk export --account-id act_1 --level adset -o csv > adsets.csv
# edit in a spreadsheet
meta-ads bulk import adsets.csv --plan     # diff vs live, validate_only
meta-ads bulk import adsets.csv --yes      # Graph batch API, journaled, --resume <journal-id>
```
- Idempotency: match rows by ID, or by a name plus an external-key label (`adlabels`) for creates, so that running the same import again doesn't create duplicates.

**Effort:** M. **Priority: P2.**

### G18. Webhook receiver and lead delivery

**Who:** Lead-generation marketers.

**Evidence**
- `webhooks subscribe` and `leads webhooks` register subscriptions (`webhooks.ts`, `leads.ts:221`), but nothing *receives* them.
- `leads export` is a pull command with no `--since` incremental cursor, so polling for new leads means re-downloading everything.

**Proposal**
- `meta-ads webhooks listen --port 8080 --verify-token ... [--forward https://crm] [--exec 'script.sh']`, verifying `X-Hub-Signature-256`.
- `meta-ads leads export <formId> --since 2026-10-26 [--state-file .leads-cursor]`.
- `meta-ads leads sync --to csv:leads.csv|webhook:URL --interval 5m`.

**Effort:** M. **Priority: P2.**

### G19. Observability

**Who:** Agents debugging failures, and maintainers.

**Evidence**
- There is no `--verbose`/`--debug` flag; the only switch is the `META_ADS_CLI_LOG_LEVEL` env var.
- `fbtrace_id`, which Meta support asks for, is never shown (G1).
- Rate-limit usage is parsed from response headers (`meta-client.ts:58-85`, 254) but can't be inspected, so agents can't plan their call budget.
- There is no per-request timing.

**Proposal**
- Global `-v/--verbose` to log requests and timings to stderr (with redacted tokens).
- `meta-ads limits [--account-id]` showing current app, account and business-use-case usage percentages and the estimated time to regain access.
- Include `fbtrace_id` in every error.

**Effort:** S. **Priority: P2.**

### G20. Heuristic "intelligence" commands and overlapping reports

**Who:** Marketers who may act on bad advice.

**Evidence**
- **`bidding auto-adjustments` uses fixed thresholds** (`bidding.ts:325-332`): "CPC < 1" and "CPC > 5" in account currency, whatever the currency (1 JPY vs 1 USD), objective or vertical. Its `--threshold` flag compares against CTR in percent. Its name suggests it adjusts bids, but it only recommends.
- **Unclear commands.** `analytics optimization-insights` is described as "meta-cognition insights from past optimization patterns" (`analytics.ts:180`), which doesn't tell a user what it does. `bidding competitor-analysis` and `analytics competitive-intel` sound like they overlap.
- **Five commands give roughly the same account summary:** `insights account`, `analytics report`, `monitor dashboard`, `workflow full-audit` and `ai score`, each with different flags and output shapes.
- **The commands disagree with each other.** `ai recommendations` uses an LLM with benchmarks (`src/benchmark.ts`), while `bidding recommendations` and `bidding scaling-recommendation` use separate hard-coded rules, so the CLI can give conflicting advice.

**Proposal**
- **Label advice clearly.** Mark heuristic output with `"method":"heuristic"` and include the thresholds used.
- **Use relative thresholds.** Base them on the account's own median or benchmarks instead of absolute currency values.
- **Merge the overlapping commands.** Fold the summary commands into `insights` (data) and `ai` (judgement). Deprecate `analytics report` and `monitor dashboard`, and rename `auto-adjustments` to `bid-suggestions`.

**Effort:** M. **Priority: P2.**

### G21. Docs and skills drift

**Evidence**
- **Default API version.** README and AGENTS.md say v26.0. CLAUDE.md's env var table says v25.0. The built `--help` says "default: v25.0" while requests go to v26.0, presumably through `.env`.
- **File counts.** CLAUDE.md:55 and AGENTS.md:37 say "35 command files"; there are 37.
- **The README command tables leave out commands:**
  - `backup` and `doctor` are missing entirely;
  - `insights async` and `async-result` are missing from the `insights` row;
  - `pixels` is listed but `pixels events` is undocumented.
- **No upgrade path or troubleshooting section** for common Meta errors (190, 200, 100/33, 17/613/80004).
- **Skills.** The checked-in `skills/` is stale (see G8), and CONTEXT.md doesn't mention `--max-spend-cap`, `doctor`, `backup` or the policy story.

**Proposal**
- Generate the README tables, CONTEXT.md command lists and skills from `schema --cli` (G8) in CI, and fail on drift.
- Add `docs/TROUBLESHOOTING.md` and `docs/AGENT_QUICKSTART.md`.

**Effort:** S. **Priority: P2.**

### G22. Shell completion and examples in help

There is no `completion` command (grep). Subcommand `--help` has almost no examples, and new users rely on the README.

**Proposal:** `meta-ads completion bash|zsh|fish|pwsh`, plus `.addHelpText('after', examples)` generated from the skills data.

**Effort:** S. **Priority: P3.**

### G23. Sandbox onboarding

SPENDING_CAPS.md recommends sandbox ad accounts, but the CLI gives no help with them.

**Proposal**
- `doctor` should detect whether the target account is a sandbox and say so.
- `setup --agent` should run a guided flow: System User token, sandbox account, policy file, `--read-only` profile.

Onboarding also needs every user to create their own Meta App (README "Requirements"). That is a big drop-off point for marketers. A published app ID, or a hosted login like Pipeboard's **(unverified)**, would remove it, but it is a business and compliance decision.

**Effort:** S (doctor/setup). **Priority: P3.**

### G24. New Meta capabilities worth surfacing

These are taken from META_API_UPDATES.md P3 rows, ranked by user value:
- Advantage+ creative enhancements, `--enhancements` (#24; pairs with G16).
- Audience labels, `--labels` (#28).
- Creative-audience pairing (#22).
- PCA unified sales campaigns (#23).
- `placement_soft_opt_out` (#25).
- Threads polls, topic tags and reply controls (#33, rated P2 there).
- Partnership-ads ad codes (#32).

Each is a small flag addition; add them alongside the related feature work above rather than one at a time.

**Priority: P3.**

---

## Things that exist and work well (keep them)

- **The single-chokepoint spend-cap guard** (`MetaClient.request`) with "strictest wins" composition. It is the right design to extend into the G2 policy engine.
- **`backup export/diff/restore`.** This is the foundation for plan/apply (G6) and bulk round-trip (G17).
- **`doctor`'s preflight checks.** Token scopes, versions, file permissions and the LLM configuration all appear in one place.
- **Header-aware rate-limit throttling and no retries on non-idempotent POSTs.** Both are sound defaults.
- **`insights async`.** In the working tree it already covers large reports and META_API_UPDATES #30.
- **Breadth.** The CLI covers Pages, IG, Threads, WhatsApp and Messenger. Few competing tools cover organic and messaging alongside ads **(unverified)**.

## Competitive notes

None of these were tested hands-on.

- **Other npm CLIs, existence verified with `npm view`:**
  - `meta-ads` (v0.19.5, "Command-line interface for the Meta (Facebook) Marketing API");
  - `meta-ads-cli` (v0.1.0, oclif, built on `facebook-nodejs-business-sdk`).
- **Community MCP servers for the Meta Marketing API:** many are listed on Glama and mcpservers.org (search results), for example byadsco/meta-ads-mcp. Their feature sets are **unverified**.
- **An official Meta Ads MCP endpoint (`mcp.facebook.com/ads`)** is mentioned by a third-party project **(unverified)**.
- **Meta's own SDKs** (`facebook-nodejs-business-sdk`, `facebook-python-business-sdk`) are libraries, not CLIs. They don't add safety controls (**unverified** for recent versions).
- **Positioning.** No competitor seen advertises a policy- and approval-gated agent mode, so G1, G2, G7 and G8 together would differentiate this CLI ("the safe way to let an agent touch your ad account").
