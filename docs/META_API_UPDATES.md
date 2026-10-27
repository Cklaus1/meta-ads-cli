# Meta API Updates: Impact on meta-ads-cli

_Researched 2026-10-27. Sources are official Meta developer pages unless marked **[UNVERIFIED]** or **[3rd-party]**. Line numbers reflect the working tree on 2026-10-27; another session is editing `threads.ts`, `meta-client.ts` and `auth.ts`, so their line numbers may shift._

## Status (2026-10-27)

Items 1–11, 15, 18–21, 26, 30, 33 and 37–38 (via Meta's `error_user_msg` in CLI errors) are done. The default is now v26.0. Not done: optional new-capability items 22–25, 27–29, 31–32, 34–35. Items 12–14, 16, 17, 36, 39, 40 and 41 need no CLI change. See CHANGELOG.md.

## TL;DR

- **The latest version is v26.0 (released 2026-07-29). No v27.0 has been announced.** The CLI defaults to v25.0 (`src/meta-client.ts:8`, `src/commands/doctor.ts:30`).
- **Marketing API v25.0 expires 2027-02-23.** Graph API v25.0 lasts until 2028-07-29, but most of this CLI calls Marketing API endpoints. Marketing API v24.0 expires **2026-11-10**.
- **Recommendation:** change the default to **v26.0** now. Meta auto-upgrades calls to a deprecated Marketing API version only for endpoints that didn't change. Calls to changed endpoints, such as `POST adsets` and `POST campaigns`, **fail**.
- **Today, 2026-10-27, is the "all versions" cutoff** for several v26 changes: poll ads, Messenger Stories, web-only applink, delivery-estimate fields, HEF `advantage_audience`, Commerce Orders, and legacy protocol params. **Pinning v25 no longer avoids any of them.**
- **Several defaults in the CLI already fail today:**
  - Deprecated Page, Post and Instagram insights metrics in the default `--metrics`.
  - Deprecated Messenger message tags.
  - Missing `is_adset_budget_sharing_enabled` when creating a campaign without a campaign budget.
  - Restoring ASC campaigns that carry `smart_promotion_type`.
  - Deprecated placements (`video_feeds`, Explore, Messenger `story`) listed in option help.
  - Offline Conversions API endpoints (removed May 2025).

## Summary table

| # | Item | Type | Effective / version | CLI impact (file:line) | Recommended change | Priority |
|---|------|------|--------------------|------------------------|--------------------|----------|
| 1 | v26.0 is current. Marketing API v25.0 expires 2027-02-23 and v24.0 expires 2026-11-10 | Version | v26 released 2026-07-29 | `src/meta-client.ts:8` (`API_VERSION='v25.0'`), `src/commands/doctor.ts:30` (`CURRENT_VERSION=25`), CLAUDE.md "default: v25.0" | Bump the default to `v26.0` after fixing items 5–9. Make `doctor` warn on Marketing API expiry, which differs from the Graph API dates | **P0** |
| 2 | `is_adset_budget_sharing_enabled` is required on campaign create when ad sets carry the budget | Breaking | v24.0+ (2025-10-08). Already applies at v25 | `src/commands/campaigns.ts:101-105` (`--adset-level-budgets` or no budget), `src/commands/workflows.ts:37-38,193` (`--budget-level adset`), `src/commands/retargeting.ts:295-299`, `src/commands/bulk.ts:56-59`, `src/commands/backup.ts:35-37,283` (not in `CAMPAIGN_FIELDS`/`CAMPAIGN_CREATE`) | When no campaign budget is set, send `is_adset_budget_sharing_enabled` (default `false`, or add `--adset-budget-sharing`). Include it in backup snapshot and restore | **P0** |
| 3 | Advantage+ Shopping (ASC) and Advantage+ App (AAC) campaigns can't be created, duplicated or updated. Remaining ones are paused in v26 | Breaking | v25.0+. All versions 2026-05-19. Pause at v26 **[date from blog, unverified]** | `src/commands/backup.ts:18,36` (reads and **re-sends `smart_promotion_type`** on restore). `src/commands/doctor.ts:216` deprecation-watch text is stale | Remove `smart_promotion_type` from `CAMPAIGN_CREATE`, and warn when a snapshot campaign has `AUTOMATED_SHOPPING_ADS`/`SMART_APP_PROMOTION`. Update doctor text | **P0** |
| 4 | Page and Post insights metrics deprecated (`page_fans`, `page_fan_adds`, `page_impressions`, `page_engaged_users`, `post_impressions`, `post_impressions_unique`, …) | Breaking (error on all versions) | 2024-03-14 / 2025-06-15 / 2025-11-15 (all versions). More `*_unique` and video impression metrics removed at the v26 release | `src/commands/pages.ts:257` (default metrics: 4 of 7 are deprecated), `src/commands/pages.ts:290` (`post_impressions`, `post_impressions_unique`, `post_engaged_users`) | New defaults: `page_follows,page_media_view,page_total_media_view_unique,page_views_total,page_post_engagements,page_actions_post_reactions_total` and `post_media_view,post_total_media_view_unique,post_clicks,post_reactions_by_type_total` | **P0** |
| 5 | Instagram insights: `impressions`, `plays`, `video_views`, `profile_views`, `website_clicks`, … removed | Breaking | Jan 8 2025 / Apr 21 2025 (all versions) | `src/commands/instagram.ts:345` (media defaults include `impressions`, `video_views`), `:371` (story `impressions`, `exits`, `taps_*`), `:445` (account `impressions`, `profile_views`, `website_clicks`, `email_contacts`, …) | Use `views,reach,likes,comments,shares,saved,total_interactions` (media), `views,reach,replies,navigation` (stories), and `reach,follower_count,profile_links_taps,views,accounts_engaged` (account, with `metric_type=total_value` where needed) | **P0** |
| 6 | Messenger message tags `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE` and `POST_PURCHASE_UPDATE` return error 100 | Breaking | 2026-04-27 | `src/commands/messenger.ts:16` (help lists them), `:32` | List only `HUMAN_AGENT` (plus utility templates). Reject the removed tags locally with a hint | **P1** |
| 7 | Placements removed: FB `video_feeds` (v24), IG Explore Feed (v26), Messenger `story` (v26; all versions late Aug or 2026-10-27), `messenger_home` (2025-11-11) | Breaking | See left | `src/commands/adsets.ts:93` (`video_feeds`), `:94` (`explore`), `:96` (`story`). Placement merge at `:142-150` and `:212-236` | Drop them from help. Validate and strip with a warning (Messenger `story` is silently dropped; Explore and video_feeds error). Add `threads_positions` values and IG `ig_search` (already listed) | **P1** |
| 8 | HEF (Housing/Employment/Financial) ad sets with constrained targeting must set `targeting_automation.advantage_audience` to 0 or 1 explicitly | Breaking | v26.0+. All versions 2026-10-27 | `src/commands/adsets.ts:83,126,207` (only a raw `--targeting-automation` JSON pass-through). `src/commands/duplication.ts` (copies) | Add `--advantage-audience <0\|1>`. When the parent campaign has `special_ad_categories` and targeting has custom audiences or interests, require it (or default it with a warning). Map error `ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG` in `errors.ts` | **P1** |
| 9 | Lookalike `lookalike_spec.country` / `location_spec` silently ignored. Creates a countryless parent lookalike | Deprecation (silent) | v26.0+. All versions 2026-09-01 | `src/commands/audiences.ts:95-112` (`--countries` builds `country`/`location_spec`) | Stop sending them. Deprecate `--countries` with a warning that location now comes from the ad set | **P1** |
| 10 | Attribution windows `7d_view` and `28d_view` return no data. Unique, hourly and frequency breakdowns limited to 13 or 6 months. `mmm` is async-only | Breaking (silent empty data) | 2026-01-12 | `src/commands/insights.ts` has no `--attribution-windows` option yet. `src/commands/adsets.ts:89` (`attribution_spec` help example is fine) | When adding `--attribution-windows`, allow only `1d_click,7d_click,28d_click,1d_view,1d_ev` and warn on view windows over 1d. Warn when `--since` is more than 13 months back with unique fields or breakdowns | **P2** |
| 11 | Insights breakdowns `impression_device`, `hourly_stats_aggregated_by_audience_time_zone` and `frequency_value` need enablement. `dma` replaced by `comscore_market` | Breaking | Enablement 2026-08-06. `dma` removed 2026-06-22 | `src/commands/insights.ts:20` (lists `impression_device`, plus invalid names `device` and `platform`) | Fix help: `device_platform`, `publisher_platform`, `platform_position`, `comscore_market`. Note that `impression_device` needs enablement | **P2** |
| 12 | Delivery estimate fields `daily_outcomes_curve`, `budget_guardrail` and `estimate_dau` removed | Removal | v26.0+. All versions 2026-10-27 | `src/commands/targeting.ts:121`, `src/commands/audiences.ts:177`. No explicit fields are requested, so **no break**. Output just loses fields | None required. Document that only `estimate_mau_*` and `estimate_ready` remain | P3 |
| 13 | Poll ads (`poll_spec`, `interactive_components_spec` type `poll`) blocked | Breaking | v26.0+. All versions 2026-10-27 | Not used (grep: no `poll_spec`) | None. Optionally reject in `creatives create --spec` validation | P3 |
| 14 | `applink_treatment=web_only` disallowed for Website+App campaigns | Breaking | v26.0+. All versions 2026-10-27 | Not used in src | None. Mention in docs if a raw-spec passthrough is added | P3 |
| 15 | Shops Ads: eligible creatives default to `destination_spec.destination_type=WEBSITE_AND_SHOP` | Behavior change | v26.0+ | `src/commands/creatives.ts:148,202` (create-image/video): advertisers with a shop get the default silently | Add `--shop-destination <default\|opt-out>` that maps to `WEBSITE_AND_SHOP_OPT_OUT` | P2 |
| 16 | Legacy protocol params removed (`pretty`, `debug`, `date_format`, root `GET /?ids=`, ETag/304). `metadata=1` removed | Breaking | v26.0+. All versions 2026-10-27. `metadata=1`: 2026-05-19 | `src/meta-client.ts`: none used (grep clean). `src/commands/doctor.ts:216` mentions metadata | None. Keep `schema` command static | P3 |
| 17 | Commerce Order Management API (47 endpoints) removed, no replacement | Removal | v26.0+. All versions 2026-10-27 | Not used (`catalog.ts` has no `commerce_orders`) | None | P3 |
| 18 | Offline Conversions API (`offline_conversion_data_sets`, `{event_set}/events`) discontinued | Removal | May 2025 (v16 sunset) | `src/commands/conversions.ts:193-265` (`offline-events`, `offline-event-sets`, `create-offline-set`). `src/commands/audiences.ts:58` (`OFFLINE_CONVERSION` subtype) | Remove these commands, or alias them to `datasets` / `dataset-send` with `action_source=physical_store` | **P1** |
| 19 | Auto-upgrade header `X-Ad-Api-Version-Warning` | New / ops | Since 2024 | `src/meta-client.ts:58-85` parses usage headers but not this one | Log a warning when the header is present | P2 |
| 20 | WhatsApp: `conversation_analytics` superseded by `pricing_analytics` (per-message pricing since 2025-07-01). Analytics lookback cut to 1 year (2025-12-01) | Deprecation **[deprecation itself is UNVERIFIED; only 3rd-party says it's deprecated]** | 2025-07-01 / 2025-12-01 | `src/commands/whatsapp.ts:219-234` | Add `whatsapp pricing-analytics` (`pricing_analytics` with `PRICING_CATEGORY`/`PRICING_TYPE` dimensions) and mark `conversation-analytics` legacy. Validate the 1-year lookback | P2 |
| 21 | Profile-visit optimization (`PROFILE_VISIT`, `PROFILE_AND_PAGE_ENGAGEMENT`, destination types `INSTAGRAM_PROFILE`/`FACEBOOK_PAGE`/`INSTAGRAM_PROFILE_AND_FACEBOOK_PAGE`) | New | 2026-07-20 | `src/commands/bidding.ts:24-28` `validGoals` is stale and would flag valid goals. `src/commands/adsets.ts:88` help | Refresh `validGoals` (add `PROFILE_VISIT`, `PROFILE_AND_PAGE_ENGAGEMENT`, `OFFSITE_CONVERSIONS`, `VALUE`, `THRUPLAY`, `CONVERSATIONS`, `QUALITY_LEAD`, `QUALITY_CALL`, `ENGAGED_USERS`, `REMINDERS_SET`, `VISIT_INSTAGRAM_PROFILE`, …). `CONVERSIONS` and `LEAD_GENERATION` checks should be re-verified against the reference | P2 |
| 22 | Creative audience pairing (`targeting_automation.creative_audience_pairing`, `creative_audience_pairing_persona`) | New | 2026-10-19 | `adsets.ts`, `ads.ts`, `creatives.ts` | `--creative-audience-pairing` flag on adsets create/update | P3 |
| 23 | PCA unification (`is_pca_unified` on `OUTCOME_SALES` campaigns, immutable) | New | 2026-10-22 | `src/commands/campaigns.ts:69-86` | `--pca-unified` flag on create. Add to list fields | P3 |
| 24 | Advantage+ creative features `image_animation`, `video_filtering`, `video_uncrop` (in `degrees_of_freedom_spec.creative_features_spec`) | New | 2026-06-28 | `src/commands/creatives.ts` | `--enhancements a,b,c` → `degrees_of_freedom_spec` | P3 |
| 25 | `placement_soft_opt_out` (up to 5% spend on excluded placements) | New | v24.0+ | `src/commands/adsets.ts` (absent) | `--placement-soft-opt-out` | P3 |
| 26 | Daily budget flexibility raised to 75% (weekly cap 7× daily) | Behavior | v24.0+ | `src/meta-client.ts` / `--max-spend-cap` guard: daily overspend can reach 1.75× | Note in `docs/SPENDING_CAPS.md` that the per-day cap guard bounds the configured budget, not actual daily spend | P2 |
| 27 | Ads in WhatsApp Status: `wamo_whatsapp_identity_spec`, `user_age_unknown` default, carousels up to 10 cards. WhatsApp marketing messages in Ads (2026-08-13) | New | v26.0+ | `src/commands/adsets.ts:97` (`--whatsapp-positions status` exists) | Optional `--whatsapp-identity` on creatives | P3 |
| 28 | Audience labels (`audience_labels` on customer-file, website and app CAs) | New | 2026-04-30 | `src/commands/audiences.ts` create | `--labels` option | P3 |
| 29 | `regional_regulated_categories` `BRAZIL_REGULATION` and `universal_beneficiary`/`universal_payer` | New | 2025-12-08 | `src/commands/adsets.ts:101-102` (only DSA fields) | Add `--regional-regulated-categories` and identities | P3 |
| 30 | Async insights report failures return `error_code`, `error_message`, `error_subcode`, `error_user_title`, `error_user_msg` | New | v25.0+ | The CLI has no async report jobs (`insights.ts` is synchronous only) | Consider `insights async` (`POST /insights` → poll `/{report_run_id}`), which `mmm` and large breakdowns need | P2 |
| 31 | IG Audio Swap for Reels ads (`selected_audio_spec`, `source_instagram_media_id` on `/advideos`) | New | 2026-06-01 | `src/commands/creatives.ts:444` (upload-video) | Optional flags | P3 |
| 32 | Partnership ads: `creator_username` filter on `branded_content_ad_permissions`. API ad-code generation | New | 2026-03-30 | `src/commands/branded-content.ts:14-92` | Add `--creator-username` filter / `ad-code` command | P3 |
| 33 | Threads API additions: reply approvals, ghost posts, spoilers/text attachments, GIFs (GIPHY; Tenor sunset 2026-03-31), polls, `topic_tag`, location, 5-link limit, `threads_share_to_instagram`, `clicks` insight, Post Intents | New / limit | 2025-02 → 2026-08 | `src/commands/threads.ts:39-48` (create supports text, image, video, carousel, reply and link only). `:199,218` (insights defaults lack `clicks`) | Add `--topic-tag`, `--poll`, `--gif-id`/`--gif-provider GIPHY`, `--spoiler`, `--text-attachment`, `--reply-control`, `--location-id`, `--share-to-ig-story`. Add `clicks` to insights. Pre-validate ≤5 links | P2 |
| 34 | Threads ads: video, carousels, catalog, app ads, page-backed accounts, promote existing FB/IG posts, reply moderation | New | 2025-08 → 2026-04 | `src/commands/adsets.ts:92,95` (`threads` platform / `threads_positions` present) | Mostly works via existing flags. Document `customization_spec` `threads` | P3 |
| 35 | Messenger: Calling API GA, message reactions/edit, utility templates with named params, Page Integrity API | New | 2025-12 → 2026-03 | `src/commands/messenger.ts` | Optional new subcommands | P3 |
| 36 | Messenger lead ads creation via API deprecated (`/{page}/messenger_lead_forms`) | Deprecation | v24.0+ | Not used (`leads.ts` uses `leadgen_forms` only) | None | P3 |
| 37 | Flagged custom audiences and conversions can't be updated or used | Breaking | All versions 2026-01-06 | `src/commands/audiences.ts`, `src/commands/conversions.ts:105` | Map the error to a friendly message in `errors.ts` | P3 |
| 38 | Detailed-targeting interest consolidation (some interests rejected) | Breaking | All versions 2026-01-06 (delivery stopped 2026-01-15) | `src/commands/targeting.ts` (search), `adsets.ts` targeting JSON | Surface `targetingvalidation` errors. Possibly add a `targeting validate` command | P3 |
| 39 | Rights Manager owner fields renamed (`*_rh_owner`, `*_owner`) | Breaking | v26.0+ | Not used | None | — |
| 40 | Page fields `current_location`, `genre`, `network`, `parking`, `start_info` blocked for New Pages Experience | Breaking | v26.0+. All versions ~late Oct 2026 (TBC) | grep: not requested in `pages.ts` | None | — |
| 41 | Marketing API access tiers renamed (Limited/Full). Auto-approval at 500 calls / 15 days, <15% error rate | Policy | 2026-05-04 | `src/commands/doctor.ts` | Update wording if doctor mentions "Standard/Advanced access" | P3 |

## Details and sources

### 1. Versions and default

Version dates from the official changelogs:

| Version | Released | Graph API available until | Marketing API available until |
|---|---|---|---|
| v26.0 | 2026-07-29 | TBD | TBD |
| v25.0 | 2026-02-18 | 2028-07-29 | **2027-02-23** |
| v24.0 | 2025-10-08 | 2028-02-18 | **2026-11-10** |

- There is no v27.0 announcement as of 2026-10-27. Meta ships roughly every four months, so v27 is plausibly due around Nov 2026 to Jan 2027 **[UNVERIFIED estimate]**.
- **Auto-upgrade behavior:** calls to an expired Marketing API version auto-upgrade only for endpoints unchanged between versions. Other calls fail. You can opt out in App Dashboard → Marketing API → Settings. Upgraded calls carry the `X-Ad-Api-Version-Warning` header.
- **Recommendation:**
  1. Bump `API_VERSION` to `v26.0` once items 2, 7, 8 and 9 are handled.
  2. Change the "default: v25.0" line in `CLAUDE.md`.
  3. Set doctor's `CURRENT_VERSION` to 26 and have it show the Marketing API expiry date.
- `META_ADS_CLI_API_VERSION` remains the override.

Sources:
- https://developers.facebook.com/docs/graph-api/changelog
- https://developers.facebook.com/docs/marketing-api/marketing-api-changelog
- https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/version25.0
- https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/version24.0
- https://developers.facebook.com/docs/marketing-api/overview/versioning

### 2. v26.0 changes (Graph and Marketing)

Unless noted, each change applies to v26.0+ from 2026-07-29 and to **all versions on 2026-10-27**.

- **Graph API:**
  - Commerce Order Management API removed (47 endpoints).
  - Rights Manager owner fields renamed.
  - Legacy protocol features removed: `pretty`, `debug`, `date_format`, root `?ids=`, ETag/`If-None-Match`.
  - New Pages Experience legacy Page fields blocked. The all-versions date is "approximately 90 days" after launch and still TBC.
- **Marketing API:**
  - Delivery-estimate fields removed.
  - Explicit `advantage_audience` required for HEF ad sets. Error `ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG`. Endpoints: `POST /act/adsets` and `POST /{adset}/copies`.
  - Instagram Explore Feed placement removed. **No all-versions date is given.**
  - Messenger Stories `story` dropped from `messenger_positions`.
  - Poll ads blocked.
  - `applink_treatment=web_only` blocked in Web+App campaigns. Use `automatic` or `deeplink_with_web_fallback`.
  - Shops Ads `WEBSITE_AND_SHOP` default.
  - WhatsApp Status ads expanded.
  - Lookalike `country` and `location_spec` ignored. All-versions date: **2026-09-01**.
- **Discrepancy:** the Graph changelog says Messenger Stories reach all versions on 2026-10-27. The Marketing API v26 page says "late August 2026". Either way, the change is live now.
- **Explore enum [UNVERIFIED]:** I couldn't confirm from official text which enum Meta means by "Instagram Explore Feed". `explore` is the likely one. `explore_home` (Explore home) may survive. Validate against the live API before stripping `explore_home`.

Sources:
- https://developers.facebook.com/docs/graph-api/changelog/version26.0
- https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/version26.0
- https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26/

### 3. v25.0 changes

- **ASC/AAC:** campaign create, copy and update is disallowed (v25+). It applies to all versions from 2026-05-19.
  - Meta's blog says remaining ASC/AAC campaigns get paused "in V26.0 (estimated September 2026)". **[The pause date is UNVERIFIED in a changelog.]**
  - ECBC campaigns stay editable until v26.
  - Migrate to the Advantage+ campaign structure: https://developers.facebook.com/docs/marketing-api/advantage-campaigns/
- **Async report runs:** failures now return error fields, and `error_code` changes from uint to int.
- **Graph API:**
  - Page, Post, Video and Story impression/reach `*_unique` metrics are deprecated at the v26 release on all versions.
  - `metadata=1` removed on all versions from 2026-05-19.
  - Webhooks mTLS CA rotation on 2026-03-31. Trust `meta-outbound-api-ca-2025-12.pem`. This is relevant if `src/commands/webhooks.ts` users verify client certs.

Sources:
- https://developers.facebook.com/docs/graph-api/changelog/version25.0
- https://developers.facebook.com/blog/post/2026/02/13/asc-and-aac-deprecation-mapi-v25/

### 4. v24.0 changes still relevant

- `is_adset_budget_sharing_enabled` is required on `POST /act/campaigns` when budgets are at the ad-set level.
  - **This affects the CLI today on v25.** `campaigns.ts`, `workflows.ts`, `retargeting.ts`, `bulk.ts` and `backup.ts` never send it.
  - The exact error wording ("Must specify True or False in is_adset_budget_sharing_enabled field") is from community reports **[3rd-party]**. The requirement itself is in the official v24 changelog.
- Related out-of-cycle change (2025-08-18): budget sharing allows up to 20% sharing across ad sets.
- Daily-budget flexibility went from 25% to 75%.
- `placement_soft_opt_out` was added.
- Facebook video feeds placement removed. The official page doesn't name the enum; `video_feeds` is the conventional value **[UNVERIFIED enum]**.
- Messenger lead ad creation via the API is deprecated.
- Flagged custom audiences and conversions are blocked on all versions from 2026-01-06.
- Detailed-targeting consolidation applies to all versions from 2026-01-06.
- Catalog `items_batch` payloads are capped at 30 MB. `allow_upsert` was added to `/products`, which is relevant to `src/commands/catalog.ts:152,466`.

Source: https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog/version24.0

### 5. Out-of-cycle Marketing API changes

**2026:**

| Date | Change |
|---|---|
| 2026-10-22 | `is_pca_unified` |
| 2026-10-19 | Creative audience pairing |
| 2026-10-06 | `ig_search` video ads |
| 2026-08-13 | WhatsApp marketing messages in Ads |
| 2026-07-20 | Profile-visit optimization |
| 2026-06-28 | Advantage+ creative `image_animation`, `video_filtering`, `video_uncrop` |
| 2026-06-22 | `dma` → `comscore_market` breakdown |
| 2026-06-11 | Creator Marketplace filters |
| 2026-06-01 | IG audio swap |
| 2026-05-08 | Breakdown enablement for `impression_device`, `hourly_stats_aggregated_by_audience_time_zone`, `frequency_value` (effective 2026-08-06) |
| 2026-05-04 | `lift_estimate` on recommendations |
| 2026-04-30 | `audience_labels` |
| 2026-04-21 | Threads ads for page-backed accounts |
| 2026-03-30 | Partnership ad `creator_username` / ad codes |
| 2026-03-25 | Threads ad reply moderation |
| 2026-02-17 | Threads app ads |

**2025:**

| Date | Change |
|---|---|
| 2025-12-08 | `BRAZIL_REGULATION` |
| 2025-10-29 | `instagram_profile_visits` insight metric |
| 2025-10-13 | Attribution and breakdown limits (effective 2026-01-12) |
| 2025-10-09 | `messenger_home` removed |
| 2025-09-18 | EU political ads banned (effective 2025-10-06) |
| 2025-08-19 | `COMSCORE_MARKET` geo targeting |
| 2025-08-18 | `is_adset_budget_sharing` |
| 2025-05-01 | `value_semantic_type` |
| 2025-03-31 | FB `notification` position |
| 2025-03-10 | `use_unified_attribution_setting` and `action_report_time` ignored |
| 2025-01-14 | `FINANCIAL_PRODUCTS_SERVICES` replaces `CREDIT` in `special_ad_categories` |

CLI notes:
- **EU political ads ban:** `campaigns.ts:77` `--special-ad-categories` with `ISSUES_ELECTIONS_POLITICS` and EU targeting now fails. A local warning would help.
- **`CREDIT` special ad category:** the CLI doesn't hard-code `CREDIT`. Consider rejecting it locally.

Sources:
- https://developers.facebook.com/docs/marketing-api/out-of-cycle-changes/occ-2026/
- https://developers.facebook.com/docs/marketing-api/out-of-cycle-changes/occ-2025/
- https://developers.facebook.com/blog/post/2025/10/16/ads-insights-api-metric-availability-updates/

### 6. Page, Post and Instagram insights

**Page and Post metrics:**

| Metric | Deprecated | Alternative |
|---|---|---|
| `page_fans` | 2025-11-15 | `page_follows` |
| `page_fan_adds` | 2025-11-15 | none |
| `page_impressions` | 2025-11-15 | `page_media_view` |
| `post_impressions` | 2025-11-15 | `post_media_view` |
| `post_impressions_unique` | 2025-06-15 | `post_total_media_view_unique` |
| `page_engaged_users` | 2024-03-14 | none |

- `post_engaged_users` is presumed deprecated alongside `page_engaged_users` **[UNVERIFIED: not in the retrieved list]**.
- Deprecated metrics return an invalid-metric error on all versions. Because `pages.ts:257` requests them in a single `metric=` list, **the whole default call fails**.

**Instagram:**
- `impressions`, `plays`, `clips_replays_count` and `ig_reels_aggregated_all_plays_count` were removed from media and user insights on all versions on 2025-04-21.
- `video_views`, `profile_views`, `website_clicks` and other user metrics stopped working on 2025-01-08.
- Story `exits`, `taps_forward` and `taps_back` were replaced by `navigation` **[UNVERIFIED in this session; based on prior Meta docs]**.
- Newer fields worth exposing: `reposts_count`, `saved_count`, `shares_count`, `total_*`, `is_ai_generated` (publish param) and `media_audio_type`.
- Since 2026-07-30, `media_url` is omitted for some videos. `instagram media` output should fall back to `permalink` or `thumbnail_url`.

Sources:
- https://developers.facebook.com/documentation/pages-api/platforminsights/page/deprecated-metrics
- https://developers.facebook.com/blog/post/2025/08/15/page-insights-api-updates/
- https://developers.facebook.com/docs/instagram-platform/changelog

### 7. Threads API

- **Base URL:** `graph.threads.com/v1.0` is correct. `graph.threads.net` also works (2025-06-06).
- **2025-2026 additions:**
  - Posts: polls (2025-04), location tagging and search (2025-05), `topic_tag` and topic search (2025-07), GIFs (2025-10; GIPHY only after the Tenor sunset 2026-03-31), spoilers and text attachments (2025-10), ghost posts (2025-12), reply approvals (2026-02).
  - Limits and quotas: the 5-link limit (`THREADS_API__LINK_LIMIT_EXCEEDED`, 2025-12-22) and new quota fields in `threads_publishing_limit`.
  - Insights and search: the `clicks` insight metric (2025-07-02), `followers_count`/`follower_demographics` without a linked IG account (2026-01-30), and keyword search filters (media type, author, since/until).
  - Webhooks: mentions, delete and publish webhooks.
  - Sharing and tokens: share to IG Story (`threads_share_to_instagram`, 2026-03-25), `token_type` in short-lived token responses (2026-08-12), and `/debug_token` with an app token (2026-08-18).
- **CLI coverage:** `src/commands/threads.ts:39-48` exposes only basic media types, reply and link attachment. `threads.ts:199,218` insights defaults lack `clicks`.

Source: https://developers.facebook.com/docs/threads/changelog

### 8. WhatsApp Cloud API

- The On-Premises API was sunset on 2025-10-23. The CLI is Cloud-only, so it isn't affected.
- Per-message pricing has been in effect since 2025-07-01.
- Media IDs from webhooks expire after 7 days (since 2025-10-09).
- Status webhooks no longer include the `conversation` object outside Free Entry Point windows.
- Messaging limits are now portfolio-based.
- New APIs: Groups API (2025-10-06), Calling API (2025-07-15), typing indicators, Block API, template groups, and Embedded Signup v4.
- Analytics lookback dropped to 1 year (2025-12-01).
- **`conversation_analytics` deprecation [UNVERIFIED]:** only a third-party doc (Yellow.ai) says it was deprecated in v25. Meta's analytics page (updated 2026-02-12) still documents it. Add `pricing_analytics` regardless.
- The official changelog fetched in this session showed nothing after May 2026. **Re-check it for June to October 2026 entries.**

Sources:
- https://developers.facebook.com/docs/whatsapp/cloud-api/changelog
- https://developers.facebook.com/docs/whatsapp/on-premises/changelog
- https://developers.facebook.com/documentation/business-messaging/whatsapp/analytics

### 9. Messenger

- Message tags `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE` and `POST_PURCHASE_UPDATE` return error 100 from 2026-04-27. Use utility templates or `HUMAN_AGENT`.
- The Instagram `share` webhook attachment is replaced by `ig_post`, rolling out gradually.
- New: Calling API GA (2026-02-11), named params in utility templates (2026-03-06), Page Integrity API (2026-01-30), message reactions and edits (2025-12-02), and the Conversations API fields `reply_to` and `is_owner`.

Source: https://developers.facebook.com/docs/messenger-platform/changelog

### 10. Conversions API and offline events

- **Offline Conversions API:** discontinued in May 2025. That covers the `offline_conversion_data_sets` endpoints and posting to `{offline_event_set}/events`. Send offline events through the Conversions API on a dataset (pixel) with `action_source=physical_store`.
  - CLI impact: `conversions.ts` `offline-events`, `offline-event-sets` and `create-offline-set` (lines ~193-265) are dead.
  - Source: https://developers.facebook.com/docs/graph-api/changelog/version20.0 (deprecation list).
- **Business SDK v26 Parameter Builder:** the Meta Business SDK v26 adds Conversions API Parameter Builder integration (fbc/fbp/client IP normalization). The CLI could mirror this as `--auto-fbc` normalization in `send-event`. Source: v26 blog above.
- **No dedicated CAPI changelog:** I couldn't fetch an official CAPI changelog for 2026; the old URL returns 404. Third-party reports **[UNVERIFIED]** describe:
  - a one-click/no-code CAPI (2026-04),
  - a 2026-03 change that restricts click-through attribution to link clicks, with "engage-through" reported separately.
  Neither changes the CAPI wire format.

### 11. Lead ads

- No `leadgen_forms` deprecation was found.
- Only Messenger lead-ad creation via the API is deprecated (v24), and `leads.ts` doesn't use it.
- **[UNVERIFIED]** A third-party note says leads are retrievable for 90 days only. Consider documenting this for `leads export`.

## Could not verify from official sources

- The ASC/AAC "pause all remaining campaigns at v26 (Sep 2026)" date. It appears only in Meta's blog as an estimate, not in a changelog.
- The exact enum names for the removed "Facebook video feeds" (`video_feeds`) and "Instagram Explore Feed" (`explore` vs `explore_home`) placements.
- `post_engaged_users` and IG story `exits`/`taps_*` deprecation status.
- Deprecation of WhatsApp `conversation_analytics`.
- WhatsApp changelog entries after May 2026, and an official Conversions API changelog for 2026.
- The v27.0 release timing.
- The New Pages Experience field-block all-versions date ("~90 days after launch, TBC").
