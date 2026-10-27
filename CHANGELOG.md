# Changelog

## Unreleased

- **New `business` commands:**
  - `business share-pixel <pixelId> --account-id --business-id` shares a business-owned pixel or dataset with an ad account, so its ad sets can optimize for the pixel's events.
  - `business pixel-accounts` lists the accounts a pixel is shared with.
- **`backup`:** export and restore carry ad sets' regional ad declarations (`regional_regulated_categories`, `regional_regulated_identities`), which Meta requires for Taiwan, Singapore and similar locations.
- **Copying campaigns between ad accounts with their creative content:**
  - **`backup export`:** `--with-media <dir>` downloads every image and video the creatives use. New filters: `--campaign-ids`, `--adset-status`, `--ad-status` and `--skip-rejected`. Creatives the account listing misses are fetched one by one.
  - **`backup restore --account-id <other>`:**
    - Copies images server-side (`copy_from`), falling back to uploading the exported files, and uploads videos and waits until they're ready.
    - Rewrites image hashes and video IDs in the creatives.
    - Keeps only portable tracking specs, and skips ads whose creative didn't restore.
  - **`backup restore` options:** `--campaign-map`, `--adset-map` and `--creative-map` reuse objects that already exist, for finishing a partial restore. `--exclude-countries` adds excluded countries to every ad set, e.g. for Meta's Taiwan/Singapore ad declarations. `--name-suffix` renames restored objects.
  - **Fixes:** restore no longer sends the read-only `call_to_action_type` (Meta rejected it with error #3) or zero budgets. `--account-id` now defaults to the snapshot's account, as documented, instead of `META_ADS_CLI_ACCOUNT_ID`.

- `auth refresh-token --update-env <file>` exchanges the token in an `.env` file for a new long-lived one. It verifies the new token (valid, same user, expires no sooner) before rewriting that one line, never prints tokens, and exits 2 when the token is about to expire and Meta didn't extend it (`--warn-days`, default 14). Meant for a weekly systemd timer or cron job; see README.

## 0.4.1 — 2026-10-27

Fixes the 45 findings in [docs/BUG_SPEC_2.md](docs/BUG_SPEC_2.md).

### Security and guardrails

- **MCP:** tool arguments can no longer inject global flags. Values are passed as `--opt=value`, positionals can't start with `-`, and input is checked against the tool schema. The server's spend cap reaches tool calls through the environment, so it can only be lowered. `--allow-live`/`--allow-delete`/`--allow-messaging` work in tool calls only when the server was started with them. `--plan`, `--validate` and `--verbose` are forwarded. Long-running commands aren't exposed.
- **Spend cap:**
  - Repeated `--max-spend-cap` flags: the lowest wins.
  - `--api-version` (flag, env or profile) must look like `v26.0`.
  - `rules` can't create budget-raising or unpausing rules past the policy without explicit flags.
  - Budget schedules are checked on the budget they produce, not the increase.
  - `accounts set-spend-cap` sends currency units, as Meta expects.
- **Policy:**
  - Account checks fail closed when Meta can't be reached.
  - `method=DELETE` in a body counts as a delete.
  - The account daily budget ceiling serializes concurrent writes and counts every delivering status.
  - A root-owned `/etc/meta-ads-cli/policy.json` always wins and can't be redirected by env vars. `policy show` checks the directory too.
- **`@file`** refuses credential files (the config dir, `.env`, token cache) and is off in MCP tool calls. JSON parse errors no longer echo the input.
- **Journal:** stores a size and hash instead of bulk payloads (customer lists, CAPI events, image bytes), rotates at 10 MB, leaves custom directories' permissions alone, and blocks double or out-of-order undo.
- **Log file:** written synchronously with mode 0600.
- **`claude` CLI fallback:** runs with no tools or MCP servers.

### Fixes

- **Login:** `auth login` asks only for the ads permissions again, because extra permissions made Meta reject the login ("Feature unavailable") for apps without those use cases. Add more with `META_ADS_CLI_AUTH_EXTRA_SCOPES`.
- **Preview modes:** `--plan`, `--validate` and `--dry-run` hand out `planned_N` ids that later steps can use, so multi-step commands (`apply`, A/B tests, launch workflows, async reports) work in all three modes. `--validate` only sends `validate_only` where Meta supports it.
- **Bulk:** the `--state-file` is ignored in preview modes and tied to the operation.
- **Campaign copies** for A/B tests are deep copies.
- **Optimizers:**
  - zero-decimal currencies are handled
  - ROAS and cost-per-result campaigns are ranked separately
  - `--min-roas` only judges purchase-optimized entities
- **`monitor watch`** no longer re-alerts on every check, retries failed pauses, and stops on auth or policy errors.
- **Profiles:** a profile's `apiVersion` is used. A broken default profile only warns.
- **Smaller fixes:**
  - async insights reports work under `--read-only`
  - `preflight` ignores paused children
  - `plan`/`apply` converge on targeting
  - catalog batch `item_type`
  - lead CSV dedupe
  - shared PII normalization
  - date-window fixes
  - the Anthropic SDK loads lazily

## 0.4.0 — 2026-10-27

Implements the gaps in [docs/PRODUCT_GAPS.md](docs/PRODUCT_GAPS.md) and [docs/MEDIA_BUYER_GAPS.md](docs/MEDIA_BUYER_GAPS.md), except the npm name and licence (owner decisions).

### Breaking changes

- `--dry-run` output moved to stderr; stdout carries only the result.
- Exit codes are now meaningful (2 usage, 3 auth, 4 permission, 5 rate limit, 6 API, 7 policy, 8 network) instead of always 1.
- `monitor auto-pause` and `monitor check` default to `last_7d` with volume floors, and skip ad sets in learning.
- `insights get` defaults its level to `campaign` for account IDs, and to the object's own level otherwise.
- `workflow launch-campaign` derives the optimization goal from the objective, requires `--countries` or `--targeting`, and requires a pixel for Sales.
- `bulk create-campaigns` requires `objective` in every config.
- `bidding validate` exits 1 when it finds errors. `TARGET_COST` is rejected everywhere.
- Significant ad set or campaign budget edits while learning need `--force`.
- `campaigns create --cbo` no longer sends a field; the campaign budget is the Advantage+ campaign budget.
- `leads webhooks` takes `--app-id`, `--page-id` and `--verify-token`, and makes the two subscription calls Meta needs.
- `catalog collection-ad` requires `--canvas-id`.
- `audiences overlap` reports estimated pairwise overlap, not the union.
- `funnel` retargeting stages exclude deeper stages unless `--allow-overlap`.

### Agents and governance

- `--error-format json`, `--plan` (real reads, writes held back), `--validate` (Meta `validate_only`), `--verbose`.
- Safety policy file: account allowlist, going-live/delete/messaging blocks, account daily budget cap. `policy show`.
- Write journal with `journal list` and `journal undo`.
- `schema --cli`, an MCP server mode (`meta-ads mcp`), and `completion bash|zsh|fish`.
- JSON options accept `@file` and `-` (stdin).
- Default profile (`profile use`), profile secrets in the keychain, profile tags, `limits`, `doctor --sandbox`.
- CI on Node 18/20/22. `keytar` is optional.
- The CLI no longer crashes with EPIPE when its output is piped into `head`.

### Media buying

- Shared metrics: each conversion is counted once, results follow the objective, and revenue, cost per result and ROAS come from `action_values`.
- Insights: `--with-derived`, `--compare-previous`, `--time-increment`, `--action-breakdowns`, `--filtering`, `--sort` and `--since/--until`. Named ranges use Meta's account-timezone presets. Also `attribution-audit` and `export-mmm`.
- Budget and bid optimizers, `ai score`, `ai recommendations`, fatigue and trends judge on cost per result or ROAS, with volume floors, learning awareness and capped changes.
- `bidding learning-phase` reads `learning_stage_info`. Other new bidding commands: `pacing`, `cpm-benchmark`, objective/goal/billing/promoted-object validation, and ROAS goal (`bid_constraints`).
- `plan`/`apply` launch specs, `campaigns preflight`, Advantage+ state, special-ad-category checks.
- Ad sets: `--roas-goal`, `--cost-cap`, `--bid-cap`, targeting helpers, frequency caps only where allowed, DSA defaults, brand safety, placement soft opt-out, creative audience pairing, `--with-insights` on lists.
- Ads: `ads disapproved`, `ads request-review`. Bulk: `bulk export`, `bulk import` with a diff, `bulk update`, resumable state. `targeting validate`.
- Audiences: customer-list upload and removal (hashed, batched), value-based and tiered lookalikes, labels, saved audiences.
- Conversions API: `event_id`/`order_id` dedup, Limited Data Use, `conversions quality` (Event Match Quality).
- Leads: CRM conversion-lead events (`leads crm-event`), incremental export, `webhooks listen` with lead streaming.
- `experiments` (Meta split tests and lift studies). `ab-test analyze` uses a significance test.
- `rules` (Meta automated rules) and `monitor watch` with Slack/webhook alerts.
- Creatives: Advantage+ enhancements opt-in/out, dynamic creative / flexible format, previews, ads from existing posts, image/video library, `bulk-create --folder`.
- Accounts: `health`, `spend` (pacing), `set-spend-cap`, `rollup`.
- Catalog: real `product-performance`, `diagnostics`.

## 0.3.0 — 2026-10-27

Fixes everything in [docs/BUG_SPEC.md](docs/BUG_SPEC.md), from a full source review.

### Breaking changes

- `pages delete-comment` now requires `--page-id`, because a comment ID doesn't identify its Page.
- `messenger messages <conversationId>` now requires `--page-id`.
- `--time-range last_7d` / `last_30d` / `last_90d` now cover the N full days before today, matching Meta's presets. Unknown range names are errors.
- The spend cap is the strictest of `--max-spend-cap`, `META_ADS_CLI_MAX_SPEND_CAP` and the profile cap. A flag can no longer raise it, and invalid values are errors.
- `ab-test create` refuses campaigns without a campaign-level budget instead of inventing one.
- POST creates are no longer retried on 5xx or network errors, to avoid duplicates. Check for the object before re-running.
- `auth login` requests more permissions (Pages, Instagram, catalog, `pages_manage_ads`). Override them with `META_ADS_CLI_AUTH_SCOPES`.
- Threads calls go to `graph.threads.com`, and `threads search` uses `keyword_search`.

- **The default Graph/Marketing API version is now v26.0** (was v25.0). Marketing API v25.0 expires 2027-02-23; `doctor` warns about expiring versions.
- Campaigns created without a campaign budget send `is_adset_budget_sharing_enabled` (default `false`; `--adset-budget-sharing` to enable).
- Advantage+ Shopping/App campaigns can't be copied, A/B tested or restored. Meta blocks this via the API, so the CLI refuses up front and `backup restore` skips them.
- Default Page, post and Instagram insights metrics replaced. Meta removed `page_impressions`, `page_fans`, `post_impressions`, IG `impressions`, `video_views` and others.
- Messenger tags `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE` and `POST_PURCHASE_UPDATE` are rejected; use `HUMAN_AGENT` or a utility template.
- Removed placements (`video_feeds`, `explore`, Messenger `story`) are rejected.
- `--targeting-automation` and the new `--advantage-audience` are sent inside `targeting`, where Meta reads them. Housing/employment/financial ad sets with narrowed targeting must pass `--advantage-audience`.
- `audiences create-lookalike --countries` is ignored (Meta dropped lookalike location); it prints a warning.
- Offline Conversions commands now use Conversions API datasets (`action_source=physical_store`). `--event-set-id` is a deprecated alias for `--dataset-id`; `create-offline-set` explains how to migrate.
- Insights reject `dma`, `device`, `platform` breakdowns and `7d_view`/`28d_view` attribution windows, with the replacement in the error.

### Highlights

- Startup no longer hangs for minutes on WSL or headless Linux, where the keychain lookup used to block.
- IDs are validated before they reach the URL, and the spend cap covers every budget field.
- Credential files are written 0600, and `doctor` warns about ones other users can read.
- `setup` keeps existing `.env` settings.
- `leads export` keeps lead answers.
- Conversions API user data is SHA-256 hashed (`--no-hash` to skip).
- `creatives update` handles video, photo, catalog and dynamic creatives.
- `retargeting dynamic-campaign` sets the catalog and a product audience: viewers and add-to-carts, excluding buyers.
- New: `insights async` / `async-result` (async report jobs), `--attribution-windows`, `whatsapp pricing-analytics`, `--shop-destination opt-out` on creatives, Threads post options (topic tag, poll, GIF, spoilers, reply controls, location, quote, share to IG story).
- Meta's `error_user_title`/`error_user_msg` are included in errors, and the auto-upgrade `X-Ad-Api-Version-Warning` header is printed.
