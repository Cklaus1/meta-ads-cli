# Changelog

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
