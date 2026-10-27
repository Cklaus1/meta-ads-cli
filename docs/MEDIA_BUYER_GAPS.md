# Media Buyer Gaps: meta-ads-cli Reviewed by a Practitioner

**Reviewer stance:** a senior performance marketer / media buyer who runs large Meta budgets and works with the Marketing API directly.
**Scope:** ad-craft and media-buying substance. That means campaign structure, bidding, budgets, creative testing, measurement, reporting, audiences, lead quality, compliance, automation and account health. It also covers whether the defaults and heuristics are ones an expert would trust.
**Out of scope:** pure code bugs (see `docs/BUG_SPEC.md`), API version churn (`docs/META_API_UPDATES.md`) and product/packaging gaps (`docs/PRODUCT_GAPS.md`). A few items touch those areas; they are included only where they change what a media buyer sees.
**Reviewed:** 2026-10-27, against the working tree (README, CLAUDE.md, CONTEXT.md, `src/commands/*.ts`). Line numbers are for that tree and may shift, because other sessions are editing `src/`.

---


**Status (2026-10-27):** All 47 gaps are addressed in 0.4.0; see CHANGELOG.md. Two parts were not done because the API couldn't be confirmed: creating partnership-ad creatives and building Instant Experiences via the API (`collection-ad` now requires an existing canvas).

## Executive summary: top 5

1. **The "intelligence" layer optimises for the wrong things, and some of it acts.** `bidding optimize-budget`, `bidding auto-adjustments`, `bidding scaling-recommendation`, `ai score`, `workflow full-audit` and the `ai recommendations` fallback rank and recommend on CTR and CPC, using fixed dollar thresholds. They ignore the campaign objective, CPA, ROAS, revenue and learning state. `monitor auto-pause` pauses entities on *today's* intraday data, with no minimum-spend or significance floor and no allowance for conversion reporting lag. A buyer would never let an agent run these against a live account. They should be rebuilt around **cost per result by objective, plus value**, or relabelled clearly as toy heuristics. (P0)
2. **Conversion counting is wrong in places, and revenue is never fetched.** `monitor`'s `getConversions()` sums `purchase`, `omni_purchase` and `offsite_conversion.fb_pixel_purchase`. Those are overlapping views of the *same* purchases, so the count is inflated 2–3×. The same is true of the lead types. No default field set requests `action_values`, so revenue and AOV can't be computed, and only `purchase_roas` is available. Nothing maps objective → result action, so there is no real "cost per result". (P0)
3. **The A/B testing is not a test.** `ab-test create` and `workflow duplicate-and-test` duplicate a campaign twice. The two copies then compete in the same auction against overlapping audiences. `ab-test analyze` declares a "winner" on CPC/CPM/CTR/*spend*, with no conversions and no significance test. Meta's **Ad Studies API** (`SPLIT_TEST`, `LIFT`, `GEO_LIFT`, and creative tests with 2–5 cells) gives randomized, non-overlapping cells. None of it is wrapped. Conversion Lift and Brand Lift, the incrementality tools buyers rely on at scale, are also missing. (P0)
4. **Measurement hygiene is missing.** `conversions send-event` has no `--event-id`, which is the key Meta uses to dedupe pixel and CAPI events (event_id + event_name, 48h window). Agents sending server Purchases next to a browser pixel will double-count. There is no Event Match Quality / Dataset Quality API check, no Limited Data Use (`data_processing_options`) support, and no CRM **Conversion Leads** feedback loop (`lead_id`, `action_source=system_generated`). `validate-setup` only checks `last_fired_time`. (P0/P1)
5. **The modern Advantage+ structure and core bidding levers aren't first-class.** Since v25 an "Advantage+ sales/app/leads campaign" is a *standard* campaign with Advantage+ budget, audience and placements. Its state shows up in the read-only `advantage_state_info`. The CLI never reads or validates that field. Its error message for ASC/AAC campaigns says "recreate it as a standard campaign" without explaining how to reach Advantage+ state. `--cbo` sends `campaign_budget_optimization`, which is not a campaign field. The ROAS goal (`bid_constraints.roas_average_floor`) can't be set. `bidding learning-phase` doesn't even request `learning_stage_info`. Advantage+ creative enhancements (`degrees_of_freedom_spec.creative_features_spec`) can't be opted in or out, and that is a brand-safety control most buyers set on every ad. (P0/P1)

---

## Prioritized gap table

Effort: S = under 1 day, M = 1–3 days, L = more than 3 days. Priority: P0 = misleading or unsafe today; P1 = core workflow a buyer needs weekly; P2 = important for scale or specialist work; P3 = nice to have.

| # | Gap | Why it matters to a media buyer | Evidence (file:line) | Suggested command / flag sketch (API) | Effort | Pri |
|---|-----|------------------------------|----------------------|----------------------------------------|--------|-----|
| 1 | Budget/bid "optimisers" rank on CTR÷CPC | Budget flows to cheap clicks instead of profitable conversions. CTR/CPC is weakly correlated, or anti-correlated, with CPA for conversion campaigns | `bidding.ts:236-257` (optimize-budget), `:325-333` (auto-adjustments), `:410-423` (scaling), `:370-377` (cross-campaign) | Rebuild on objective-aware `cost_per_result`, `action_values`/ROAS and marginal CPA, with min-conversion floors and a learning-state guard. Add `--target-cpa`/`--target-roas`. Until then, prefix output with `heuristic: click-based, not conversion-based` | M | P0 |
| 2 | `monitor auto-pause` judges on `today` with no significance floor | Intraday CPA/ROAS is noise. Conversions report with a lag (CAPI events can arrive up to 7 days later; attribution windows run 1–7 days), so winners get paused at 10am | `monitoring.ts:144` (default `today`), `:47-68`, `:175-178` | Default `--date-preset last_3d` or `last_7d`. Add `--min-spend`, `--min-impressions`, `--min-results`, `--max-cpa` (objective result), `--skip-learning`. Skip entities whose `learning_stage_info.status=LEARNING`. Better still, push the rule to Meta via `adrules_library` (row 9) | S | P0 |
| 3 | Conversion double-counting | `purchase`, `omni_purchase` and `offsite_conversion.fb_pixel_purchase` overlap, and so do `lead`, `offsite_conversion.fb_pixel_lead` and `onsite_conversion.lead_grouped`. Summing them inflates conversions 2–3× | `monitoring.ts:10-13`, `:33-36` | Pick one canonical type per event (prefer `omni_*`, else the pixel type) and never sum overlapping aliases. Ship a shared `result-mapping.ts` keyed on objective + optimization_goal + promoted_object | S | P0 |
| 4 | No revenue (`action_values`) and no "cost per result by objective" | ROAS/AOV/CPA by objective is *the* report. Today users get `actions[]` blobs and must map them by hand. Agents pick the wrong action | `insights.ts:98`, `:149`, `:209`; `analytics.ts:168`; `ai.ts:61`, `:305` | Default fields add `action_values`, `inline_link_clicks`, `outbound_clicks`, `cost_per_inline_link_click`, `quality_ranking`, `engagement_rate_ranking`, `conversion_rate_ranking`, `attribution_setting`. Add `insights get --results` to derive `results`, `cost_per_result`, `revenue`, `roas`, `aov` from the ad set's optimization_goal/promoted_object (whether Insights exposes a native `results` field is *unverified*) | M | P0 |
| 5 | Fake A/B tests | Duplicated campaigns overlap in the auction and contaminate each other. "Winner" uses spend/CPC with no significance test | `ab-testing.ts:72-101`, `:146-154`; `workflows.ts:232-284` | `experiments create --type SPLIT_TEST --cell name=A,campaigns=… --cell …` → `POST /{business_id}/ad_studies` (cells, `treatment_percentage` ≥10). Add `experiments results`. `ab-test analyze` should compare CPA/ROAS with a two-proportion z-test or Bayesian credible interval and a minimum sample | M | P0 |
| 6 | CAPI without `event_id` (dedup) | Pixel + CAPI Purchase without a shared event_id gets double-counted. That inflates ROAS and confuses optimisation | `conversions.ts:72-108` (no `--event-id`, `--order-id`) | `send-event --event-id <id>`. Warn when `action_source=website` and no event_id is given. In `send-batch`, warn on events missing `event_id` | S | P0 |
| 7 | `bidding learning-phase` doesn't fetch learning state | The command named "learning phase" returns only `issues_info` | `bidding.ts:107` | Request `learning_stage_info` (status LEARNING / SUCCESS / FAIL, `conversions`, `last_sig_edit_ts`). Add `--account-id` to scan all ad sets in "Learning limited" and flag ones below ~50 optimisation events per week | S | P0 |
| 8 | Click-metric scoring in `ai score`, `full-audit`, `campaign-health`, `ai recommendations` fallback | Fixed $ thresholds (CPC > $2/$3/$5, CPM > $15) ignore currency, geo, objective and placement. "No bid cap → consider COST_CAP" is bad default advice: cost caps throttle delivery when set wrong | `ai.ts:74-88`, `:271-276`; `workflows.ts:95-97`, `:148-150`; `bidding.ts:206-213` | Use account-relative benchmarks (`benchmark.ts` already exists) on objective-specific KPIs. Drop the absolute $ thresholds. Pass objective, optimization_goal, learning state, results, revenue and attribution into the LLM context | M | P0 |
| 9 | No Meta Automated Rules (`adrules_library`) | Rules run server-side every 30 minutes, need no cron or agent uptime, are logged in Ads Manager, and are what buyers already use. Rules that turn ads off cannot include cost conditions (error 2703), which is a useful guardrail | none (grep: no `adrules`) | `rules list/create/update/delete/history` → `POST /act_{id}/adrules_library` with `evaluation_spec` (filters, SCHEDULE/TRIGGER), `execution_spec` (PAUSE, CHANGE_BUDGET, CHANGE_BID, NOTIFICATION, …), `schedule_spec`; `GET /{rule_id}/history`. Templates such as `--template stop-loss --max-cpa 50 --min-spend 100 --window last_3d` | M | P1 |
| 10 | Advantage+ campaign state unreadable / unguided | Buyers need to know whether a campaign is in Advantage+ Sales/App/Leads state, and which lever (budget, audience, placement) knocked it out | `campaigns.ts:57`, `:84` (no `advantage_state_info`); `campaigns.ts:30-33` (message says "recreate as standard") | Read `advantage_state_info`. Add `campaigns create --advantage-plus` that sets campaign budget, `targeting_automation.advantage_audience=1` and no placement restrictions, then verifies state after creation. Fix the error text to explain the v25 unified flow | S | P1 |
| 11 | `--cbo` sends a non-existent field | `campaign_budget_optimization` is not on the Campaign object. Campaign-level `daily_budget`/`lifetime_budget` *is* CBO (Advantage+ campaign budget). The flag adds confusion | `campaigns.ts:108`, `:132` | Remove or make it a no-op alias with a note. Document "budget on campaign = Advantage+ campaign budget" | S | P1 |
| 12 | No ROAS goal / bid_constraints; deprecated TARGET_COST still advertised | Minimum ROAS ("ROAS goal") is the main value-bidding lever and needs `bid_constraints.roas_average_floor` (×10000). TARGET_COST was deprecated in v9 but `bidding validate`/`recommendations` and CONTEXT.md still suggest it | `adsets.ts:155` (no bid_constraints flag); `bidding.ts:31-34`, `:290-292`; `CONTEXT.md` "Bid Strategies" | `adsets create/update --roas-goal 2.5` → `bid_constraints={"roas_average_floor":25000}`. Validate: MIN_ROAS needs `optimization_goal=VALUE` and no bid_amount; COST_CAP/BID_CAP need `bid_amount`. Remove TARGET_COST | S | P1 |
| 13 | `bidding validate` doesn't validate the combinations that matter | Objective ↔ optimization_goal ↔ billing_event ↔ promoted_object compatibility is where launches fail. The billing-event whitelist misses THRUPLAY, POST_ENGAGEMENT, etc. | `bidding.ts:29-64` | Encode the ODAX compatibility matrix. Optionally verify against Meta by creating PAUSED with `execution_options=["validate_only"]` (*unverified for all edges*) | M | P1 |
| 14 | Unsafe launch defaults | `workflow launch-campaign` defaults `--optimization-goal LINK_CLICKS` for *any* objective. A Sales campaign launched this way optimises for clicks and has no `promoted_object`/pixel. `bulk create-campaigns` defaults to OUTCOME_TRAFFIC. Countries default to US | `workflows.ts:183-186`; `bulk.ts:53` | Derive the default goal from the objective (SALES → OFFSITE_CONVERSIONS + require `--pixel-id`/`--event`; LEADS → LEAD_GENERATION or QUALITY_LEAD; AWARENESS → REACH; TRAFFIC → LANDING_PAGE_VIEWS). Refuse SALES without promoted_object | S | P1 |
| 15 | No Advantage+ creative enhancements control | Meta auto-applies enhancements (text variations, image touch-ups, music, templates, comments). Brands need explicit per-feature OPT_IN/OPT_OUT. The `standard_enhancements` bundle was retired in v22 | `creatives.ts:157-271` (no `degrees_of_freedom_spec`) | `creatives create-* --enhancements text_optimizations=OPT_OUT,image_touchups=OPT_IN,…` → `degrees_of_freedom_spec.creative_features_spec`. Add `creatives enhancements <id>` to show the current per-feature status | S | P1 |
| 16 | No Dynamic Creative / flexible format / placement asset customisation authoring | Serious creative testing at scale uses `asset_feed_spec` (multiple bodies, titles, images and videos; 9:16 for Stories/Reels vs 4:5 for feed; `ad_formats: AUTOMATIC_FORMAT`). The CLI can only edit existing feeds, and `creatives clone` refuses asset-feed creatives | `creatives.ts:25-47` (merge only), `:344-346` (clone rejects); `adsets.ts:165` (`--dynamic-creative` flag only) | `creatives create-flexible --images h1,h2 --videos v1 --bodies-file … --titles … --ad-format AUTOMATIC_FORMAT --placement-rule story=9x16_hash` → `asset_feed_spec` (+ `asset_customization_rules`). Max 30 assets, one ad_format per feed | L | P1 |
| 17 | No creative-level and asset-level reporting / fatigue that a buyer trusts | Fatigue check uses *daily* frequency (not cumulative), all-clicks CTR, first-half vs second-half means with no volume floor, and includes today's partial day | `analytics.ts:68-120`; `analytics.ts:27-31` (trends include `until: now`), `:43-55` (first-day vs last-day) | `analytics creative-fatigue --level ad --account-id`: rolling 7-day link CTR / CPA / CPM vs the ad's first 7 days, cumulative reach-frequency over the lifetime, min impressions, exclude today. Asset breakdowns (`image_asset`, `video_asset`, `body_asset`, `title_asset` with `actions`/`action_values`) for DCO/flexible ads. Thumb-stop / hold rate from `video_p25`… and `video_play_actions` | M | P1 |
| 18 | No ad previews | Buyers, clients and compliance review the ad *as rendered* per placement before launch | none (grep: no `generatepreviews`) | `creatives preview <creativeId> --format MOBILE_FEED_STANDARD,INSTAGRAM_REELS,INSTAGRAM_STORY` → `GET /{creative_id}/previews` or `GET /act_{id}/generatepreviews?creative=…&ad_format=…` | S | P1 |
| 19 | Customer-list audiences can't be built | First-party lists (purchasers, high-LTV customers, CRM stages) are the best seeds and exclusions. `create-custom --subtype CUSTOM` has no `customer_file_source` and there is no `/users` upload | `audiences.ts:52-79` | `audiences upload <id> --file customers.csv --schema EMAIL,PHONE,FN,LN,COUNTRY` (normalise + SHA-256 using the existing `hashUserData`, 10k-row batches with `session` / `batch_seq` / `last_batch_flag`) → `POST /{audience_id}/users`; `--replace` → `/usersreplace`; `create-custom --customer-file-source USER_PROVIDED_ONLY` | M | P1 |
| 20 | Value-based and tiered lookalikes missing | Value-based LAL (seeded with LTV) beats plain LAL for ecommerce. Buyers also build 0–1%, 1–3%, 3–5% bands | `audiences.ts:81-121` (single ratio only) | `create-lookalike --starting-ratio 0.01 --ratio 0.03`; `--value-based` with a value column in the upload (*exact field names unverified*) | S | P2 |
| 21 | "Audience overlap" reports a union, not overlap | `delivery_estimate` with several custom audiences returns the reach of the *union*, which is not overlap. Any number derived from it is misleading | `audiences.ts:142-178` | Compute overlap as `sum(individual) − union` per pair, label it estimated, or remove the command. Meta's Audience Overlap tool is not in the API (*unverified*) | S | P2 |
| 22 | Funnel retargeting stages overlap and "exclude converters" is a no-op | The "Visitors" stage contains "Cart" users. Without exclusions, ad sets compete and frequency stacks. `--exclude-converters` is declared but never used | `retargeting.ts:65` (unused flag), `:200-239` (no exclusions) | Build each stage with `exclusions` for deeper stages and purchasers (`rule.exclusions`). Emit a ready `excluded_custom_audiences` targeting snippet | S | P1 |
| 23 | Frequency caps applied where Meta rejects them | `frequency_control_specs` can only be written on ad sets optimised for REACH or THRUPLAY. `retargeting frequency-optimization` targets conversion retargeting ad sets | `retargeting.ts:324-346`; `adsets.ts:166` | Pre-check the ad set's `optimization_goal` and explain the alternatives (shorter retention windows, exclusions, Reach campaign for retargeting) | S | P1 |
| 24 | No CRM Conversion Leads loop / lead quality is just form completeness | Lead buyers optimise on *qualified* leads. Meta's Conversion Leads integration needs CRM stage events with `lead_id`, `action_source=system_generated`, `custom_data.event_source=crm`, `lead_event_source` | `leads.ts:173-218` (quality = field fill-rate of first 100 leads) | `leads crm-event --dataset-id … --lead-id … --stage "SQL"` (or `--file stages.csv`) → `POST /{dataset_id}/events`. `leads create-form --higher-intent` (`is_optimized_for_quality`; *field name unverified*), `--qualifying-question` | M | P1 |
| 25 | Lead export not incremental, missing metadata | Daily sync to a CRM needs `--since` filtering and `is_organic`, `platform`, `adset_id`, `form_id` for source attribution | `leads.ts:73-86`, `:157-171` | `leads export --since 2026-10-26T00:00:00` → `filtering=[{field:"time_created",operator:"GREATER_THAN",value:<ts>}]`; add the fields | S | P1 |
| 26 | No Event Match Quality / dataset quality checks | EMQ, coverage of CAPI vs pixel, dedup rate and freshness decide how well value/conversion bidding works | `conversions.ts:268-296` (validate-setup = `last_fired_time` only) | `conversions quality <datasetId>` → `GET /dataset_quality?dataset_id=…` (Dataset Quality API: EMQ per event, ACR, freshness, event spend). `validate-setup` should also check domain verification and recent CAPI vs browser volumes | M | P1 |
| 27 | No Limited Data Use / consent flags on CAPI | US state privacy compliance: `data_processing_options=["LDU"]`, `_country`, `_state` | `conversions.ts:72-108`, `:175-211` | `send-event --ldu [--ldu-country 1 --ldu-state 1000]`, also inside batch defaults | S | P1 |
| 28 | Insights lack the controls buyers use daily | No `time_increment` (daily/weekly), no `action_breakdowns`, no `filtering`/`sort`, no period-over-period comparison. The breakdown help omits `hourly_stats_aggregated_by_advertiser_time_zone`, `product_id` and the asset breakdowns. `analytics report` ignores `--time-range` | `insights.ts:80-133`; `insights.ts:11` (help); `analytics.ts:155-176` (timeRange unused) | `insights get --time-increment 1|7|monthly --action-breakdowns action_type,action_device --filter 'campaign.name CONTAIN "Prospecting"' --sort spend_descending --compare previous_period` | M | P1 |
| 29 | Date ranges use the machine's clock, not the ad account timezone | An agent on a UTC server asking for "yesterday" for an account in America/Los_Angeles gets the wrong day. That breaks pacing checks and daily reports | `time-range.ts:1-45` (local clock, by design); used everywhere | Prefer Meta's `date_preset` (resolved in account TZ) for named ranges, or resolve with the account's `timezone_name` | S | P1 |
| 30 | Attribution is under-explained | Since mid-2025 Meta ignores `use_unified_attribution_setting`/`action_report_time` (reported by Supermetrics; *not confirmed in Meta docs*). Results use each ad set's `attribution_spec`. Mixed windows across ad sets make account-level CPA comparisons misleading, and the per-row `attribution_setting` field isn't requested | `insights.ts:28-43`, default fields `:98` | Always request `attribution_setting`. Add `insights attribution-audit --account-id` that lists ad sets by `attribution_spec` and warns about mixes. Default comparison windows `7d_click,1d_view` side by side | S | P1 |
| 31 | No conversion lift / brand lift / geo lift | At scale, incrementality decides budget between Meta and other channels. Platform-reported ROAS over-credits retargeting | none (grep: no `ad_studies`) | `experiments create --type LIFT|GEO_LIFT`, `experiments results <studyId>` (objectives edge) → `/{business_id}/ad_studies`. Lift results access is limited and often needs a Meta rep (*verify per account*) | L | P2 |
| 32 | No MMM-ready export | MMM needs daily spend/impressions/reach by campaign × geo (and by platform), stable IDs and full history, in long format | `ai.ts:292-313` (`export-dataset` ignores `--time-range`, no geo, capped at 10 pages) | `export mmm --since … --until … --by campaign,country --time-increment 1` via async insights with `--all` and resumable paging. Output long-format CSV with currency and timezone columns | M | P2 |
| 33 | Account health / delivery blockers not surfaced | Payment failures, `disable_reason`, account spend cap nearly reached, ad-volume limits, disapproved ads and rejected creatives are the usual reasons "nothing delivers" | `accounts.ts:20`, `:42` (no `disable_reason`, `is_prepay_account`, `min_daily_budget`); `ads.ts:301` (`ad_review_feedback` only in `get`) | `accounts health <id>`: `account_status` decoded, `disable_reason`, `spend_cap` vs `amount_spent` (% used), `funding_source_details`, `ads_volume` edge (ads running vs limit; *unverified*), count of ads with `effective_status=DISAPPROVED/WITH_ISSUES` plus their `ad_review_feedback`. `ads rejections --account-id` lists reasons | M | P1 |
| 34 | No appeal / re-review path | Disapprovals are a weekly event. Buyers need "request review" without opening Ads Manager | none | `ads request-review <adId>`: a re-save of the ad triggers re-review; a formal appeal API is *unverified*. Otherwise print the Account Quality link | S | P2 |
| 35 | `catalog product-performance` returns no performance | The name promises product-level performance but it only lists products and the catalog | `catalog.ts:435-462` | Use `insights` with `breakdowns=product_id`, `action_breakdowns=action_type` at ad level for catalog ads, joined to product names. Note the restricted off-Meta action limitation | S | P1 |
| 36 | "Collection ad" builds a catalog ad, not a collection | Real collection ads need an Instant Experience (canvas) with a product set. The current `template_data` spec is a carousel-style catalog ad (*verify*) | `catalog.ts:380-433` | Build the Instant Experience first (`/{page_id}/canvases`) and reference it in `link_data` (*endpoint details unverified*), or rename the command | M | P2 |
| 37 | Catalog ad health missing | Catalog campaigns die quietly on feed errors, missing pixel `content_ids` matches and out-of-stock items | `catalog.ts` (no diagnostics) | `catalog diagnostics <id>` → `GET /{catalog_id}/diagnostics`, event-source match rate (`/{catalog_id}/check_batch_request_status` exists already for batches) (*diagnostics edge unverified*) | S | P2 |
| 38 | `competitor-analysis` claims auction insights | Meta has no auction insights API. A fixed "CPM > $15 = competitive" rule is meaningless across geos and objectives | `bidding.ts:183-218` | Rename to `cpm-benchmark` and compare with account history by placement and country, or remove. For real competitive intelligence, point to `library search` | S | P1 |
| 39 | Budget pacing / spend forecast missing | Lifetime budgets, flighting and month-end caps need "on pace?" checks. Seasonal budget changes should use Meta's own budget scheduling | `bidding.ts:142-181` (seasonal-schedule only prints suggestions); `bidding.ts:116-140` (budget-schedule exists) | `budget pacing --campaign-id` (spend-to-date vs elapsed flight %, projected end spend). Make `seasonal-schedule` emit or apply `budget_schedules` (high-demand periods) instead of printing advice | S | P2 |
| 40 | Missing ad set levers | No `--roas-goal`/`bid_constraints`, no `excluded_custom_audiences` helper, no geo/age/gender helpers, no `--existing-customer-budget-cap` (*field deprecated with ASC; verify replacement*), `update` can't change `frequency_control_specs`, `promoted_object` or `destination_type` | `adsets.ts:139-235`, `:237-334` | Add the flags; `--exclude-audiences id1,id2`, `--countries`, `--age-min/max` that merge into targeting like placements already do | S | P1 |
| 41 | No "use existing post" / partnership ads authoring | Running ads from an existing post keeps social proof. Partnership (creator) ads are now a top-performing format | `creatives.ts` (no `object_story_id`/`source_instagram_media_id`); `branded-content.ts` (permissions only) | `creatives create-from-post --post-id <page_post>` / `--ig-media-id`; partnership ads with the creator's identity (*exact fields unverified*) | S | P2 |
| 42 | Special Ad Categories flow incomplete | You can't set categories after creation via `campaigns update`, and nothing warns that HEC-F restricts age/gender/zip/lookalikes | `campaigns.ts:154-195` | `campaigns update --special-ad-categories`. Pre-flight lint of targeting against HEC-F restrictions (the HEC-F Advantage+ audience check in `adsets.ts:64-82` is a good start) | S | P2 |
| 43 | DSA fields not defaulted for EU | Ads delivered in the EU need beneficiary/payor. Agents will forget them | `adsets.ts:176-177` (flags exist) | Profile-level `dsa_beneficiary`/`dsa_payor` defaults auto-applied when targeting includes EU geos. Also check `GET /act_{id}/dsa_recommendations` (*unverified*) | S | P2 |
| 44 | Brand safety controls missing | Block lists, inventory filters and publisher exclusions for Audience Network / in-stream / Reels | `adsets.ts:132` reads `brand_safety_config` but nothing writes it | `brand-safety blocklists list/create` (`/{business_id}/publisher_block_lists`), `adsets update --inventory-filter LIMITED` (*field names unverified*) | M | P3 |
| 45 | Learning-phase-unaware writes | Large budget jumps, bid changes and creative swaps can reset learning. The CLI writes blindly | `adsets.ts:237-334`; `bidding.ts:410-423` | On `update`, warn when the change is "significant" (e.g. >20–30% budget change, bid/targeting/optimisation change) and the ad set is in LEARNING. `--force` to proceed | S | P2 |
| 46 | `ads list`/`campaigns list` have no performance join | The first thing a buyer wants is "list ads with spend, CPA and ROAS, last 7 days", sorted | `ads.ts:284-323`; `campaigns.ts:40-75` | `--with-insights last_7d` via field expansion `insights.date_preset(last_7d){spend,actions,action_values}` | S | P2 |
| 47 | Reach & Frequency planning lacks curve output | Planning needs the budget → reach curve and frequency distribution, not just the IDs | `reach-frequency.ts:46-56` | `rf get --curve` that prints `curve_budget_reach` as a table | S | P3 |

---

## Details by area

### 1. Campaign structure and Advantage+

- **Advantage+ unified flow (verified).** From v25.0, `smart_promotion_type=AUTOMATED_SHOPPING_ADS` can no longer create ASC campaigns. A normal campaign reaches Advantage+ state when it has an Advantage+ campaign budget, Advantage+ audience and Advantage+ placements. `advantage_state_info` (read-only, available since v23) reports `ADVANTAGE_PLUS_SALES` / `ADVANTAGE_PLUS_APP` / (reportedly) `ADVANTAGE_PLUS_LEADS` / `DISABLED`, with the state of each lever. The CLI never asks for this field (`campaigns.ts:57,84`), so an agent can't confirm whether it built an Advantage+ campaign. A buyer would want:
  - `campaigns create --advantage-plus`, which sets the campaign budget, writes `targeting_automation.advantage_audience=1` on the ad set and sets no placement fields, then reads `advantage_state_info` back and reports any lever that is off.
  - `campaigns list` showing `advantage_state_info.advantage_state` as a column.
- **CBO.** Budget on the campaign *is* Advantage+ campaign budget. `--cbo` (`campaigns.ts:108,132`) sends `campaign_budget_optimization`, which is not on the Campaign reference (verified), and `budget_rebalance_flag` was deprecated in v7.
- **Consolidation advice.** Nothing in `workflow full-audit` flags fragmentation, the most common structural issue in large accounts: many ad sets with small budgets, each below the roughly 50 optimisation events per week needed to exit learning. An audit check should compute, per ad set, `weekly_results` vs that threshold, count ad sets in "learning limited" and recommend consolidation.

### 2. Bidding and learning phase

- `bidding learning-phase` (`bidding.ts:96-114`) is named for the learning phase but fetches `issues_info` only. `learning_stage_info` exists on AdSet (verified) and is already fetched by `adsets list/get`, so the fix is trivial.
- **ROAS goal.** Meta's bid strategy docs say min-ROAS needs a ROAS floor, written as `bid_constraints = {"roas_average_floor": 15000}` (1.5× scaled by 10000), with no `bid_amount`. The docs contradict themselves on whether that sits inside `bid_constraints`; the example uses `bid_constraints`. No CLI flag sets it.
- **TARGET_COST** is deprecated (v9, verified on the Campaign reference), yet `bidding validate`, `bidding recommendations` and CONTEXT.md still offer it as "Consistent cost at scale".
- **`bidding recommendations`** is a static lookup table. Advising `LOWEST_COST_WITH_BID_CAP` for a CPC goal is reasonable. Recommending COST_CAP as a blanket cost-control default (also in the `ai recommendations` fallback, `ai.ts:274-276`) is not: a cost cap set below the true CPA stops delivery. Expert guidance is to start on highest volume (lowest cost), collect a baseline CPA, then set the cap at or slightly above the 7-day CPA.
- **`auto-adjustments`** changes bids by ±15% based on CTR > 2×threshold and CPC < $1. Its `--threshold` default of 0.5 is compared with CTR in percent. Many ad sets have `bid_amount=0` (lowest cost), so ×1.15 still produces 0 and the recommendation is a no-op.
- **`seasonal-schedule`** computes budgets but doesn't schedule anything. Meta's `budget_schedules` (high-demand periods) is already wrapped in `budget-schedule`; the two should be joined.

### 3. Budgets and pacing

- There is no pacing view: spend-to-date vs flight elapsed for lifetime budgets, or month-to-date vs account spend cap.
- `monitor check --max-spend` compares spend with an absolute amount. A pacing check (projected spend vs budget) is what prevents overspend and underspend.
- `--max-spend-cap` (the CLI's own write guard) is good for agent safety. A media buyer would also want **account-level `spend_cap`** read and warned on in `doctor`/`accounts health` (`spend_cap - amount_spent`), because hitting it stops all delivery.

### 4. Creative testing

- **Methodology.** There is no creative test path. In order of preference, the options are:
  1. Ad Studies `SPLIT_TEST_V2` with `creative_test_config` (2–5 cells, verified on the Ad Study reference).
  2. A "sandbox" testing ad set inside a CBO campaign with `daily_min_spend_target` per ad set. Those flags exist (`adsets.ts:150-153`) but there is no workflow around them.
  3. Flexible / Dynamic creative with asset-level breakdowns.
- **Flexible format / DCO** needs `asset_feed_spec` authoring: `ad_formats: ["AUTOMATIC_FORMAT"]` to mix image and video, up to 30 assets, and asset customisation rules for 9:16 placements (verified on the Asset Feed Spec docs; the `FORMAT_AUTOMATION` optimization_type is listed inconsistently in the docs).
- **Advantage+ creative enhancements.** The per-feature opt-in/out lives in `degrees_of_freedom_spec.creative_features_spec`. The bundle was removed in v22, so features such as `text_optimizations`, `image_touchups`, `image_template` and `video_auto_crop` must be set individually (verified on the v22 blog). Many brands require OPT_OUT on generative text, and the CLI can neither set nor display it.
- **Fatigue detection (misleading today).** `analytics creative-fatigue`:
  - With `time_increment=1`, `frequency` is per-day frequency, so ">3" is a very high bar and the wrong signal. Fatigue shows in rising cumulative frequency, falling *link* CTR and hook rate, and rising CPA/CPM over a rolling window.
  - It includes today's partial day (`until: now`).
  - It has no volume floor: 3 days of 50 impressions can raise "fatigue".
  - `analytics trends` compares the first day with the last day, which is noise-dominated and, again, includes a partial today.
  - Expert method: rolling 7d vs the ad's launch 7d (or the prior 7d) on link CTR, CPM, CPA and hook rate (3-second plays ÷ impressions), with minimum impressions and conversions, and cumulative frequency from a lifetime query.

### 5. Measurement

- **Dedup (verified):** pixel `eventID` must equal CAPI `event_id` and the `event_name` must match, within a 48h window. `send-event` has no `--event-id`. `send-batch`/`dataset-send` pass through whatever JSON is given, but nothing warns when it is missing.
- **EMQ (verified):** the Dataset Quality API (`GET /dataset_quality?dataset_id=…`) returns per-event match quality, ACR, freshness and event spend. This is the right backend for `conversions validate-setup` and a `doctor`-style "tracking health" report.
- **LDU (verified):** `data_processing_options: ["LDU"]` with `data_processing_options_country`/`_state` (0/0 = geolocate). No CLI flag sets these.
- **`ph` normalisation** strips non-digits but cannot add the country code. Meta expects E.164 digits including the country code, so a hint or a `--default-country-code` option would help match rates.
- **Attribution.** `parseAttributionWindows` correctly blocks `7d_view`/`28d_view` (removed 2026-01-12). The bigger issue for buyers:
  - Each ad set carries its own `attribution_spec`.
  - The account-level sum mixes windows when ad sets differ.
  - Per third-party reports, Meta ignored `use_unified_attribution_setting`/`action_report_time` after 2025-06-10. That is unverified in Meta docs.
  - Insights rows expose `attribution_setting`, which the CLI never requests.
  - The breakdowns doc mentions an `incrementality` window value in `action_attribution_windows` (verified that the string appears in Meta's breakdowns doc). Meta's incremental attribution is worth wrapping as an `--attribution-windows incrementality` option once confirmed.
- **Lift / incrementality / MMM.** See rows 31–32. Conversion Lift and GeoLift both go through `ad_studies` (types `LIFT`, `GEO_LIFT`, `CONTINUOUS_LIFT_CONFIG`; verified type list).

### 6. Reporting

- **Default metric set.**
  - Present: `impressions, clicks, spend, cpc, cpm, ctr, reach, frequency, actions, conversions, cost_per_action_type, purchase_roas`.
  - Missing: `action_values` (revenue), `inline_link_clicks`/`outbound_clicks` (`clicks` is *all* clicks, including profile and "see more"), `cost_per_inline_link_click`, `inline_link_click_ctr`, the three ranking fields, `attribution_setting`, and video hook/hold rates.
- **`insights get` defaults to `--level ad`** even for an account ID. That gives a huge, unsorted ad-level dump; `campaign` is a saner default for account objects.
- **Cohort / delta comparisons:** there is no `--compare previous_period` and no WoW/MoM deltas, which is the most common question ("what changed?").
- **Breakdowns:** pass-through works, but help lists only demographic/platform ones. Buyers need `hourly_stats_aggregated_by_advertiser_time_zone` (last 13 months only, no reach/frequency), `product_id` (catalog; off-Meta actions restricted), asset breakdowns (`impressions/clicks/spend/reach/actions/action_values` only) and `user_segment_key` (new vs existing customers in Advantage+ sales). All of these are verified on the Breakdowns page.
- **Custom conversions** can be created but are not mapped into reports. `offsite_conversion.custom.<id>` action types should be resolved to names.

### 7. Audiences

- **Customer lists (verified):** `subtype=CUSTOM` + `customer_file_source` (`USER_PROVIDED_ONLY` | `PARTNER_PROVIDED_ONLY` | `BOTH_USER_AND_PARTNER_PROVIDED`), then `POST /{id}/users` with `payload.schema`/`data` (SHA-256, normalised, ≤10k per request, `session` for multi-batch), and `/usersreplace` for full refresh. The CLI already has `hashUserData()` in `conversions.ts` and can reuse it.
- **Policy (verified):** since 2025-09-02, audiences suggesting health conditions or financial status are flagged (operation_status 471). Surface `operation_status` on create/list, and explain it.
- **Exclusions:** retargeting builders never emit exclusions. Funnel stages overlap. `--exclude-converters` is dead.
- **Overlap:** the current method returns the union only; see row 21.

### 8. Catalog / Advantage+ catalog ads

- `product-performance` has no performance data (row 35).
- `collection-ad` is likely mis-built (row 36, unverified).
- `dynamic-template` hardcodes `multi_share_end_card:false` and offers no catalog-ad creative options (frames, catalog video, `template_url_spec` deep links).
- `retargeting dynamic-campaign` builds a sensible DPA retargeting ad set. Missing are a broad-audience (prospecting) Advantage+ catalog variant and the `retention`/`exclusion` defaults buyers expect: ViewContent/AddToCart 14d, excluding Purchase 7d. *(Current defaults not inspected in full.)*

### 9. Lead ads quality

- **Conversion Leads (verified payload):** `lead_id`, `action_source=system_generated`, `custom_data.event_source=crm`, `lead_event_source=<CRM name>`, one event per funnel stage with `event_time` after lead creation. It only works for Instant Forms.
- `leads quality` measures field completeness, which says nothing about lead quality. Real signals:
  - contact rate / qualification rate from the CRM;
  - duplicate rate (same email/phone across leads);
  - invalid phone/email patterns;
  - `is_organic`;
  - time-of-day spikes, which suggest bots.
- `leads webhooks` subscribes on `{formId}/subscriptions`. Leadgen webhooks are subscribed at page level (`/{page_id}/subscribed_apps` with `subscribed_fields=leadgen`, plus app-level `/{app_id}/subscriptions`). That is code-level, but it means real-time CRM sync silently doesn't work.

### 10. Compliance

- **Special Ad Categories:** settable on create, not on update. Good HEC-F `advantage_audience` guard exists (`adsets.ts:64-82`).
- **DSA:** flags exist; should be auto-defaulted for EU geos (row 43).
- **Review/rejections:** `ad_review_feedback` is only available via `ads get`. There is no account-wide view of disapproved ads with reasons, and no re-review path.

### 11. Automated rules

Meta's rules engine (verified) supports scheduled and trigger-based evaluation, filters on insights fields, and actions including PAUSE, CHANGE_BUDGET, CHANGE_BID, NOTIFICATION and PING_ENDPOINT. It also has a history edge for auditing. For an agent-operated account this is the safest automation primitive:
- it runs inside Meta;
- it is visible to every human in Ads Manager;
- it has guardrails (error 2703: rules that turn off ads cannot include cost conditions).

The CLI's own `monitor auto-pause` reinvents this client-side, with weaker semantics. Recommend `rules` as the first-class path and keep `auto-pause` as a one-off tool.

### 12. Account health

`accounts get` returns status, balance, `spend_cap` and funding source, but no `disable_reason` and no decoding of `account_status` codes (1 active, 2 disabled, 3 unsettled, 7 pending risk review, …; *code list from memory, verify*). There is also no roll-up of delivery blockers. A buyer's daily "why isn't it spending?" check needs all of these in one place:
- payment failures (unsettled);
- account spend cap hit;
- disapproved ads;
- ad sets with `issues_info`;
- learning-limited ad sets;
- ad limit (ads volume).

---

## Defaults an expert would change

| Where | Current default | Recommended |
|-------|-----------------|-------------|
| `workflow launch-campaign` `--optimization-goal` | `LINK_CLICKS` for any objective | Derive from objective; require pixel + event for SALES |
| `bulk create-campaigns` objective | `OUTCOME_TRAFFIC` | Required, no default |
| `monitor auto-pause` / `check` `--date-preset` | `today` | `last_3d` or `last_7d`, plus minimum spend/results floors |
| `insights get` `--level` | `ad` | `campaign` (or the object's own level) |
| Insights default fields | no `action_values`, `clicks` = all clicks | add revenue, link clicks, rankings, `attribution_setting` |
| `analytics report` time range | ignored → Meta default | honour `--time-range` |
| `ai score` / `bidding analyze` / `scaling-recommendation` / `dashboard` time range | not passed → Meta default 30d | honour the flag; default `last_7d`, excluding today |
| Date resolution | local machine clock | ad account timezone (`date_preset`) |
| `audiences create-lookalike --ratio` | 0.01 | fine as the default; add banded `--starting-ratio` |
| `retargeting frequency-optimization` | 3 impressions / 7 days on any ad set | only REACH/THRUPLAY ad sets; otherwise refuse with an explanation |
| `bidding recommendations` | includes TARGET_COST | remove; add ROAS-goal guidance |
| `ai recommendations` fallback | "No bid cap → consider COST_CAP" | remove; only suggest caps with a CPA baseline |
| `creatives create-video --cta` | `LEARN_MORE` | fine, but warn for SALES objectives (SHOP_NOW / ORDER_NOW usually do better; *opinion*) |

---

## Sources

Verified (fetched or searched 2026-10-27):
- Campaign reference: bid_strategy enum, TARGET_COST deprecated in v9, no `campaign_budget_optimization` field. https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/
- Ad set reference: `learning_stage_info`; `frequency_control_specs` writable only for REACH/THRUPLAY; DSA fields; `bid_constraints`. https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/
- Bid strategy: ROAS floor `roas_average_floor` ×10000. https://developers.facebook.com/docs/marketing-api/bidding/overview/bid-strategy
- Advantage+ campaign experience (v25 unified, `advantage_state_info`). https://developers.facebook.com/docs/marketing-api/advantage-campaigns and https://developers.facebook.com/blog/post/2025/06/03/advantage-plus-campaign-experience-for-sales-and-app/ ; secondary: https://ppc.land/meta-launches-unified-api-structure-for-advantage-campaigns/
- Pixel/CAPI dedup (event_id + event_name, 48h). https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events
- Dataset Quality API (EMQ). https://developers.facebook.com/docs/marketing-api/conversions-api/dataset-quality-api
- Data processing options / LDU. https://developers.facebook.com/docs/marketing-api/overview/data-processing-options
- Conversion Leads CRM integration. https://developers.facebook.com/documentation/ads-commerce/conversions-api/conversion-leads-integration/payload-specification and https://developers.facebook.com/docs/marketing-api/conversions-api/conversion-leads-integration/how-to-find-the-lead-id
- Ad Rules (`adrules_library`). https://developers.facebook.com/docs/marketing-api/reference/ad-rule/
- Ad Studies (SPLIT_TEST, LIFT, GEO_LIFT, cells). https://developers.facebook.com/docs/marketing-api/reference/ad-study/
- Insights breakdowns (hourly, product_id, asset breakdowns, user_segment_key, action breakdowns). https://developers.facebook.com/docs/marketing-api/insights/breakdowns
- Custom audiences / customer lists (`customer_file_source`, `/users`, `/usersreplace`, 10k batch, policy flag 471). https://developers.facebook.com/docs/marketing-api/audiences/guides/custom-audiences
- Advantage+ creative per-feature opt-in (v22). https://developers.facebook.com/blog/post/2025/01/17/marketing-api-v22-impacts-to-advantage-plus-creative-enhancements/ and https://developers.facebook.com/docs/marketing-api/reference/ad-creative-features-spec/
- Asset feed spec / flexible format. https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/ and https://developers.facebook.com/docs/marketing-api/ad-creative/asset-feed-spec/options/
- Ad previews (`generatepreviews`). https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/generatepreviews

Secondary / unverified in Meta docs:
- `use_unified_attribution_setting` / `action_report_time` ignored after 2025-06-10: https://docs.supermetrics.com/docs/facebook-ads-reach-and-attribution-changes-june-10-2025
- Native `results`/`cost_per_result` insights field: unclear (conflicting third-party reports).
- `ads_volume`, `disable_reason` code list, catalog `diagnostics`, `is_optimized_for_quality`, value-based lookalike parameters, publisher block list endpoints, collection-ad canvas flow, DSA recommendations: from practitioner memory, not checked against current docs.
