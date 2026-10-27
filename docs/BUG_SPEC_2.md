# Bug Spec 2: meta-ads-cli review after 0.3.0 / 0.4.0

**Date:** 2026-10-27 · **Scope:** `src/`, focused on `git diff 5288652..HEAD` (0.3.0 = db41219, 0.4.0 = b1485e9) and the seams between modules · **Type:** review only; no source or test changes were made

**How findings were checked:** every finding was confirmed by reading the code at the cited `file:line`. Findings marked **[repro]** were also reproduced against a fresh `npm run build` (`META_ADS_CLI_ACCESS_TOKEN=x node dist/index.js ... --dry-run`) or a small `tsx` snippet. Findings marked **[docs]** depend on Meta API behaviour that was recalled from Meta's documentation but not tested against the live API. Confirm those before fixing.

**Baseline:** `npm test` passes: 37 files, 480 tests. Startup is fine: `--help` takes about 0.1 s.

**Status (2026-10-27):** all 45 findings are fixed in 0.4.1; see CHANGELOG.md. B2-07 was confirmed against Meta's AdAccount reference (`spend_cap` writes are in currency units).

## Summary

| ID | Sev | Title | Location |
|----|-----|-------|----------|
| B2-01 | Critical | MCP tool arguments can inject global flags, which overrides the forwarded `--max-spend-cap` and turns on `--allow-live`, `--allow-delete` and `--allow-messaging` **[repro]** | `src/commands/mcp.ts:74-94`, `src/index.ts:230-248` |
| B2-02 | High | `--api-version` (and `META_ADS_CLI_API_VERSION`) is never validated, so a path or query string injected there bypasses the spend cap and the policy **[repro]** | `src/index.ts:107,234`, `src/meta-client.ts:171-172,399-400` |
| B2-03 | High | `rules create`, `update` and `enable` bypass the spend cap and `blockGoingLive`: rules that raise budgets or unpause run on Meta's servers **[repro]** | `src/commands/rules.ts:33-42,150-163,208,213-238` |
| B2-04 | High | The MCP server doesn't forward `--plan` or `--validate`, so `meta-ads --plan mcp` sends real writes | `src/commands/mcp.ts:97-106` |
| B2-05 | High | `--plan` placeholder IDs (`planned-N`) fail `validateEndpoint`, so every multi-step flow crashes under `--plan`. A test locks in the bad format | `src/meta-client.ts:441,776`, `src/validate.ts:79` |
| B2-06 | High | The bulk `--state-file` is written in `--dry-run`, `--plan` and `--validate` and isn't tied to the operation, so the real run then skips everything and reports success **[repro]** | `src/commands/bulk.ts:30-43,316-319,425-428` |
| B2-07 | High | `accounts set-spend-cap --cents` probably sends a cap 100× too large (Meta's write field is in currency units) **[docs]** | `src/commands/accounts.ts:216-221` |
| B2-08 | High | `ab-test create` and `wf duplicate-and-test` copy campaigns without `deep_copy`, so both arms are empty | `src/commands/ab-testing.ts:121-131`, `src/commands/workflows.ts:360-363` |
| B2-09 | Medium | The Graph method override (`method=DELETE` in a POST body) gets past `blockDeletes` (`audiences remove-users`, `bulk update --set method=DELETE`) **[repro]** | `src/meta-client.ts:268-273`, `src/commands/audiences.ts:153-154`, `src/commands/bulk.ts:145,240-245` |
| B2-10 | Medium | Policy account checks fail open: a failed lookup skips the allowlist and the account daily ceiling | `src/meta-client.ts:242-255,305-306,324-338` |
| B2-11 | Medium | The account daily-budget ceiling can be beaten by parallel creates, and it ignores budget schedules | `src/meta-client.ts:316-359`, `src/commands/bulk.ts:187-207` |
| B2-12 | Medium | `seasonal-schedule`: `budget_value` is an *increase*, so the cap only checks the increase, not the resulting budget | `src/commands/bidding.ts:413-431`, `src/meta-client.ts:131-135,192` |
| B2-13 | Medium | The policy isn't tamper-resistant as documented: the file can be deleted from the user-owned dir, `VITEST=1` disables it, and `policy show` misreports this | `src/policy.ts:46-51,88-103,111-118`, `src/commands/policy.ts:15-24`, `src/journal.ts:33` |
| B2-14 | Medium | `@file` JSON inputs read any file, including the credential stores, and echo it to dry-run, plan, journal and Meta, which exfiltrates other profiles' tokens through MCP **[repro]** | `src/json-input.ts:7-27` |
| B2-15 | Medium | The journal, plan and dry-run output store full customer-list and CAPI payloads (PII) and base64 image bytes | `src/journal.ts:41-46`, `src/meta-client.ts:438-439,475-478`, `src/commands/audiences.ts:144-155`, `src/commands/conversions.ts:124`, `src/commands/plan.ts:324-326` |
| B2-16 | Medium | The journal `chmod`s the parent dir of a custom journal file to 0700 (for example `/tmp` or the project dir) **[repro]** | `src/journal.ts:56`, `src/private-file.ts:8-13` |
| B2-17 | Medium | A profile's `apiVersion` is silently ignored **[repro]** | `src/index.ts:107,116,124`, `src/profiles.ts:169` |
| B2-18 | Medium | A default profile that is stored in the keychain or missing locks out every command, including `--help` and `profile use --clear` **[repro]** | `src/index.ts:146-152`, `src/profiles.ts:151-158` |
| B2-19 | Medium | `--validate` breaks every multi-step create (`apply`, `wf launch-campaign`, `backup restore`) | `src/meta-client.ts:444-456`, `src/commands/plan.ts:324-337,433-447`, `src/commands/workflows.ts:305-313`, `src/commands/backup.ts:249-255` |
| B2-20 | Medium | `--validate` adds `execution_options` to endpoints that don't support it (messages, audience users, CAPI events, subscriptions) and may apply them **[docs]** | `src/meta-client.ts:444-456` |
| B2-21 | Medium | Creating an async insights report (a read) is treated as a write: blocked by `--read-only`, journaled, and broken by `--validate` **[repro]** | `src/commands/insights.ts:296` |
| B2-22 | Medium | The optimizers divide budgets by 100 regardless of currency, so zero-decimal currencies (JPY, KRW and others) are 100× off | `src/commands/bidding.ts:698,709,915-916,937`, `src/commands/accounts.ts:262` |
| B2-23 | Medium | `optimize-budget` and `cross-campaign-coordination` rank everything by ROAS once any campaign has revenue, so lead and traffic campaigns get cut | `src/commands/bidding.ts:560-568,790-791` |
| B2-24 | Medium | `monitor`/`auto-pause --min-roas` pauses ad sets that have no purchase objective (missing ROAS counts as 0) **[repro]** | `src/commands/monitoring.ts:31,93,282` |
| B2-25 | Medium | `monitor watch` dedupe keys contain live numbers, so it re-alerts every tick, and a failed pause is never retried **[repro]** | `src/commands/monitoring.ts:75-94,226-228,383-385` |
| B2-26 | Medium | `insights export-mmm` doesn't validate `--timeout` or `--poll-interval`, so `NaN` polls forever at about 1 ms | `src/commands/insights.ts:350-372,540-548` |
| B2-27 | Medium | `journal undo` has no ordering or double-undo protection, and `undo_of` is never set | `src/commands/journal.ts:29-49`, `src/journal.ts:24` |
| B2-28 | Medium | `campaigns preflight` fails on paused or inactive children | `src/commands/campaigns.ts:418-454` |
| B2-29 | Medium | `plan`/`apply` never converge on ad set `targeting` (full-JSON compare against Meta's expanded targeting) | `src/commands/plan.ts:229-271` |
| B2-30 | Medium | `catalog batch` sends no `item_type` and ignores `@file`/stdin **[docs]** | `src/commands/catalog.ts:547-563` |
| B2-31 | Medium | The local `claude -p` fallback runs with the user's tools enabled on a prompt built from untrusted ad data | `src/llm.ts:210-214` |
| B2-32 | Low | MCP: long-running commands are exposed, positionals aren't guarded with `--`, and input isn't validated against the schema | `src/commands/mcp.ts:7,74-81,173-182` |
| B2-33 | Low | Logger: the async file stream loses the final (error) lines on `process.exit`, and the log file isn't 0600 | `src/logger.ts:22-33`, `src/errors.ts:150-155`, `src/index.ts:129-133` |
| B2-34 | Low | `@anthropic-ai/sdk` is imported eagerly on every startup | `src/llm.ts:1` |
| B2-35 | Low | `duplicate creative` uses `META_ADS_CLI_ACCOUNT_ID` instead of the original's account | `src/commands/duplication.ts:109,138` |
| B2-36 | Low | JSON input shape isn't checked (`bulk upload-creatives --images`, `experiments create --cells`, `--confidence-level`) | `src/commands/bulk.ts:383-386`, `src/commands/experiments.ts:124-126` |
| B2-37 | Low | `creatives preview --spec -` reads stdin once per format, so the second format fails **[repro]** | `src/commands/creatives.ts:337-339` |
| B2-38 | Low | `backup restore` swallows `PolicyError` (exits 1, not 7, and keeps going) | `src/commands/backup.ts:249-255,362-365` |
| B2-39 | Low | `catalog update-product --sale-price` without a currency assumes USD | `src/commands/catalog.ts:283-286` |
| B2-40 | Low | The CAPI city normalizer strips non-ASCII letters, unlike the audience normalizer, so hashes don't match | `src/commands/conversions.ts:18`, `src/commands/audiences.ts:34` |
| B2-41 | Low | `webhooks listen --leads-csv`: naive header split, dry-run stubs appended as leads, no dedupe | `src/commands/webhooks.ts:40,207-209` |
| B2-42 | Low | `monitor watch` loops forever on permanent errors (auth, permission, usage, policy) | `src/commands/monitoring.ts:395-398` |
| B2-43 | Low | Bidding edge cases: wrong day count for non-`last_Nd` ranges, `bid_amount=0`, unvalidated floors | `src/commands/bidding.ts:509,678-679,709-713,747-750,776` |
| B2-44 | Low | `adsets update` skips the special-category and DSA checks that `create` applies, and its dry-run preview shows targeting wiped | `src/commands/adsets.ts:629-650` |
| B2-45 | Low | Date-window math: spend projection, learning guard only reads page 1, seasonal dates in local time, `trends` counts rows rather than days | `src/commands/accounts.ts:79-82,238-246`, `src/commands/campaigns.ts:255-262`, `src/commands/bidding.ts:428-429`, `src/commands/analytics.ts:166-168` |

**Earlier guarantees, re-checked**

| Guarantee | Status | Notes |
|-----------|--------|-------|
| Spend cap can't be bypassed | **Broken** | Broken by B2-01, B2-02, B2-03 and B2-12. Upload, journal undo, bulk import, apply and experiments all go through `request()`/`uploadFile()`, so they are covered. |
| `--read-only` blocks every write | Holds | Over-blocks async insights (B2-21). |
| `--dry-run` and `--plan` never send writes | Mostly | Over MCP, `--plan` is dropped (B2-04). Dry-run and plan do write *local* state files (B2-06). |
| Endpoint validation covers new endpoints | **Broken** | The base URL is unvalidated (B2-02), and the plan placeholder IDs are rejected (B2-05). |
| Credential files are 0600 | Holds | Token cache, profiles, config and `.env` all go through `writePrivateFile`. The log file isn't 0600 (B2-33). |
| No tokens in journal, logs or plan | Mostly | `redact` covers keys containing `token`, `secret` or `password`. `@file` can smuggle secrets in under other keys (B2-14). |
| Startup stays fast | Holds | One eager SDK import (B2-34). A default keychain profile adds a D-Bus round-trip to every startup (B2-18). |

---

## Critical

### B2-01: MCP tool arguments inject global flags that override guardrails
**Location:** `src/commands/mcp.ts:74-94` (`toolArgv`), `src/commands/mcp.ts:97-106` (`forwardedGlobals`), `src/index.ts:230-248`

**What's wrong**

`toolArgv` passes each option value as a separate argv element (`argv.push(long, value)`), with no `--opt=value` form and no `--` separator.

Commander v11 doesn't always treat the next token as the option's value. Program-level options are recognised anywhere in argv, and the **last** occurrence wins (`program.opts()` in the preAction hook). So a value such as `--max-spend-cap=99999999` or `--allow-live`, placed before another option, is parsed as a *global flag*:
- The first value raises the cap that the server forwarded.
- The second turns off the policy's `blockGoingLive`. `--allow-delete` and `--allow-messaging` work the same way.

`readArgvOption` takes the first occurrence while Commander takes the last, so the two disagree.

**Reproduced (dry-run, equivalent to what `toolArgv` builds)**
```
meta-ads --dry-run --max-spend-cap 5000 campaigns update 123 --name x --status PAUSED \
  --daily-budget 90000 --bid-strategy --max-spend-cap=99999999 --start-time 2026
→ POST 123 {"daily_budget":"90000","bid_strategy":"--start-time",...}   exit 0 (should be exit 7)

META_ADS_CLI_POLICY_FILE={"blockGoingLive":true} meta-ads --dry-run campaigns update 123 \
  --status ACTIVE --bid-strategy --allow-live --start-time 2026
→ POST 123 {"status":"ACTIVE",...}   exit 0 (blocked without the injected value)
```

**Failure scenario:** the documented setup is `meta-ads --max-spend-cap 5000 --profile client-a mcp`. A prompt-injected agent calls `campaigns_update` with `{campaignId:"123", daily_budget:"900000", bid_strategy:"--max-spend-cap=999999999", start_time:"x"}`. The budget is applied with no cap. The same trick unlocks going live, deletes and messaging under a strict policy.

**Recommended fix**
1. In `toolArgv`, emit `${long}=${value}` for every non-boolean option. Reject string values that start with `-` for positional arguments, or put positionals after a `--` (option-only commands may need reordering).
2. Make guardrails impossible to loosen from argv in the subprocess:
   - Pass the server's cap as `META_ADS_CLI_MAX_SPEND_CAP` in the child `env`. That value is min-combined, so a flag can't raise it.
   - Set `META_ADS_CLI_MCP_CHILD=1`, which makes `index.ts` ignore `--allow-live`, `--allow-delete` and `--allow-messaging`, unless the server itself was started with them.
3. In `index.ts`, reject a repeated `--max-spend-cap` (or take the minimum of all occurrences).
4. Validate `request.params.arguments` against `inputSchema`: string type, and `additionalProperties: false`.

**Test to add:** for `campaigns_update`, build argv with `toolArgv` from input `{bid_strategy: '--max-spend-cap=999999999', daily_budget: '90000', start_time: 'x'}` and globals `['--dry-run','--max-spend-cap','5000']`. Run the built CLI and expect exit 7. Add the same test for `--allow-live` under a `blockGoingLive` policy.

---

## High

### B2-02: `--api-version` is put into the base URL unvalidated, bypassing the spend cap and policy
**Location:** `src/index.ts:107,234`, `src/meta-client.ts:171-172` (`baseUrl`), `src/meta-client.ts:399-400` (`buildUrl` validates only `endpoint`), `src/auth.ts:309,332,356`

**What's wrong:** `validateEndpoint` was added (BUG-02) so that IDs can't smuggle in a path or query string. The API version is concatenated into the base URL with no check at all: `https://graph.facebook.com/${apiVersion}`. That also covers `META_ADS_CLI_API_VERSION`, which `.env` can set.

**Reproduced**
```
meta-ads --dry-run --max-spend-cap 5000 --api-version 'v26.0/123?daily_budget=99999999&status=ACTIVE#' campaigns update 456 --name x
→ [dry-run] POST https://graph.facebook.com/v26.0/123?daily_budget=99999999&status=ACTIVE#/456   exit 0
```
The spend cap and policy check endpoint `456` and the body `{name}`. Meta receives a POST to object `123` with `daily_budget` and `status=ACTIVE` in the query string. Graph reads query parameters on POST, and the `#` drops the real endpoint.

**Failure scenario:** an agent that runs under a policy file, or that is reached through MCP (`--api-version` is forwarded, and B2-01 can inject it), raises budgets or goes live, or writes to an account outside the allowlist.

**Recommended fix:** validate the version everywhere it enters, with `/^v\d+\.\d+$/`:
- the flag, the env var and the profile
- `AuthManager`
- `MetaClient`

Also build URLs with `new URL()` and check that the resulting pathname is `/${version}/${endpoint}` with no search component before adding params.

**Test to add:** `new MetaClient(auth, true, 'v26.0/1?x=1#')` throws a UsageError. CLI e2e: `--api-version 'v1/2?a=b'` exits 2.

### B2-03: Automated rules bypass the spend cap and `blockGoingLive`
**Location:** `src/commands/rules.ts:150-163` (create), `:208` (guardrail-template create), `:213-238` (update and enable). The only check is `assertRuleAllowed` at `:33-42`, which handles Meta error 2703.

**What's wrong:** `execution_spec`, `evaluation_spec` and `schedule_spec` are sent as opaque JSON strings. `enforceSpendCap` looks only at top-level body keys, and `enforcePolicy` looks only at `status`, `status_option` and `configured_status`.

**Reproduced:** with a policy of `{"blockGoingLive":true,"maxSpendCapCents":5000}`, `--dry-run rules create` accepts both of these:
- `{"execution_type":"CHANGE_BUDGET","execution_options":[{"field":"change_spec","value":{"amount":100,"unit":"PERCENTAGE"}}]}`
- `{"execution_type":"UNPAUSE"}`

**Failure scenario:** an agent can't raise a budget directly, so it creates a rule that adds 100% every 30 minutes, or one that unpauses everything. Meta runs the rule server-side with no CLI involvement, and the guardrails never see it.

**Recommended fix:** parse `execution_spec`.
- Under `blockGoingLive` without `--allow-live`, reject `UNPAUSE` and `REBALANCE_BUDGET`.
- When any spend cap or account ceiling is set, reject `CHANGE_BUDGET` and `CHANGE_BID` unless `change_spec` has an absolute `limit` within the cap. Simpler: reject them outright unless an explicit `--allow-budget-rules` flag is given and the policy allows it.
- Apply the same checks on `update`, and on `enable`, which re-posts a stored spec.

**Test to add:** under each policy, `rules create` with a CHANGE_BUDGET (+%) spec and with an UNPAUSE spec both exit 7.

### B2-04: MCP doesn't forward `--plan` or `--validate`
**Location:** `src/commands/mcp.ts:97-106`

**What's wrong:** `forwardedGlobals` forwards only `--read-only`, `--dry-run`, `--profile`, `--max-spend-cap` and `--api-version`. `--plan`, `--validate` and `--verbose` are dropped silently. The help text says "Global guardrails are forwarded to every call".

**Failure scenario:** a user starts `meta-ads --plan mcp` (or `--validate mcp`) so they can review what an agent would do. Every tool call runs in a fresh subprocess without `--plan`, so the writes go live.

**Recommended fix:**
- Forward `--plan`, `--validate` and `--verbose`.
- Have `index.ts` refuse to start `mcp` with any global flag that `forwardedGlobals` doesn't handle, so this can't silently drift again.
- Note: in `--plan` mode each subprocess has its own plan, so the plan text also needs to come back in the tool result. It already does, on stderr.

**Test to add:** `forwardedGlobals` for a program parsed with `--plan --validate` contains both flags.

### B2-05: `planned-N` placeholder IDs are rejected by `validateEndpoint`
**Location:**
- Placeholder IDs: `src/meta-client.ts:441` (request) and `:776` (upload)
- Regex: `src/validate.ts:79`, `/^[A-Za-z0-9_]+$/`
- Failing callers:
  - `src/commands/ab-testing.ts:132` and later
  - `src/commands/plan.ts:333-345` (`uploadVideo` polls `planned-N`)
  - `src/commands/insights.ts` `waitForReport` (`insights async` and `export-mmm`)
- Test that locks in the format: `tests/integration/g1-governance.test.ts:125`

**What's wrong:** plan mode returns `id: "planned-1"` "so later steps can reference this object". As soon as a later step uses that ID as a path segment, the request throws `UsageError: Invalid ID or endpoint: "planned-1"`. Examples are `planned-1/copies`, polling `planned-1`, and reading a video's status.

**Failure scenario:** these all exit 2 partway through, with a partial plan:
- `meta-ads --plan ab-test create ...`
- `--plan apply spec.json` with a video
- `--plan insights async ...`

**Recommended fix:**
- Use endpoint-safe placeholders (`planned_1`).
- In `request()`, short-circuit any request whose first path segment is a planned placeholder: return a stub for GETs, and record writes as usual.
- Give `uploadVideo` and `waitForReport` an early return in plan mode.
- Update the test.

**Test to add:** with mocked fetch, `--plan ab-test create` records at least 4 steps and exits 0, and `--plan apply` with a video spec exits 0.

### B2-06: The bulk state file is written in preview modes and isn't tied to the operation
**Location:** `src/commands/bulk.ts:30-43` (`loadState`/`saveState`), `:316-319` (import), `:425-428` (`runBulkUpdate`)

**What's wrong:** an ID is added to `done` as soon as `client.request` resolves. In `--dry-run`, `--plan` and `--validate`, nothing was applied, yet the ID is still marked done. The file stores only IDs, not the operation or the field values.

**Reproduced**
```
--dry-run bulk update --ids 111,222 --set daily_budget=5000 --state-file s.json   → s.json {"done":["111","222"]}
bulk update-status --ids 111,222 --status PAUSED --state-file s.json              → "skipped": 2, exit 0
```

**Failure scenario:** the user previews with `--dry-run`, then runs for real with the same state file. Nothing is updated and the command reports success. Reusing the file across different operations does the same thing.

**Recommended fix:**
- Don't load or save state in dry-run, plan or validate mode. `MetaClient` needs an `isValidateMode()` getter for this.
- Store `{op_hash, done}`, where `op_hash` is a hash of the command plus the body, and refuse a mismatched file.
- Write the file atomically (`writePrivateFile`-style tmp and rename). Today a crash mid-write corrupts it.

**Test to add:** a dry-run bulk update leaves no state file, and a state file with a different `op_hash` is rejected.

### B2-07: `accounts set-spend-cap --cents` probably sends a cap 100× too large [docs]
**Location:** `src/commands/accounts.ts:216-221`

**What's wrong:** the code sends `spend_cap=<cents>`, and its comment says "Sent in minor units like the read field". As we recall the AdAccount update reference, the *writable* `spend_cap` is in the currency's main unit (a float in dollars for USD), while the read field and `amount_spent` are in cents. The CLI's own spend-cap guard treats the value as cents, so the oversized value passes the guard as well.

**Failure scenario:** the user wants a $50 cap and passes `--cents 5000`. Meta sets $5000.

**Recommended fix:**
1. Confirm against the live API, using a sandbox account: set `spend_cap=50` and read it back.
2. If the docs are confirmed, send `cents / 10^decimals(currency)`. Keep `--cents` as the input, so the cap guard stays in cents.

**Test to add:** `set-spend-cap --cents 5000` on a USD account sends `spend_cap=50`.

### B2-08: Campaign copies are made without `deep_copy`
**Location:** `src/commands/ab-testing.ts:121-131`, `src/commands/workflows.ts:360-363`

**What's wrong:** `POST {campaign}/copies` is sent with only `status_option`. Meta defaults `deep_copy` to false, so the copies have no ad sets and no ads. `duplication.ts` does set `deep_copy`. The `ab-testing` issue predates 5288652; the `workflows` one is new.

Separately, `wf duplicate-and-test` reads `copied_campaign_id`. Under `--plan`, the response carries only `id`, so the rename and budget-split writes are silently left out of the plan.

**Failure scenario:** the A/B test or split never delivers. The Ad Study enrolls two empty campaigns. The "activate both" step activates nothing.

**Recommended fix:**
- Send `deep_copy: 'true'`, plus `rename_options` where needed.
- For large campaigns, use the async copy path.
- Fall back to `data.id` when reading the copy ID.

**Test to add:** both copy requests include `deep_copy=true`, and `--plan wf duplicate-and-test` records 4 writes.

---

## Medium

### B2-09: The `method=DELETE` override gets past `blockDeletes`
**Location:** `src/meta-client.ts:268-273`, `src/commands/audiences.ts:153-154`, `src/commands/bulk.ts:145,240-245`

**What's wrong:** Graph treats a POST whose body contains `method=DELETE` as a DELETE. `enforcePolicy` checks only the HTTP method and the status fields. The journal and plan also record the call as a plain POST.

**Reproduced:** under `{"blockDeletes":true}`, both of these exit 0:
- `--dry-run bulk update --ids 111 --set method=DELETE` sends `POST 111 {"method":"DELETE"}`
- `--dry-run audiences remove-users 123 --file c.csv`

**Failure scenario:** an agent wipes objects or customer lists without `--allow-delete`.

**Recommended fix:**
- In `request()` and `uploadFile()`, compute an effective method: `fields.method?.toUpperCase() ?? method`. Apply read-only, `blockDeletes` and the journal to that method.
- Have `parseSetPairs` reject reserved keys: `method`, `access_token`, `execution_options` and `batch`.

**Test to add:** under `blockDeletes`, `POST 1 {method:'DELETE'}` throws a PolicyError, and so does `remove-users`.

### B2-10: Policy account checks fail open
**Location:** `src/meta-client.ts:242-255` (`lookupAccount` swallows every error and returns null), `:305-306` (null means the allowlist is skipped), `:324-338` (a failed `current` read means `endsActive` is false)

**What's wrong:**
- A lookup can fail on a 5xx after retries, a rate limit, a timeout, or a permission error on another business's object. When it does, the account allowlist isn't enforced for the write.
- If the object read fails, a `daily_budget` raise on an active object skips the account ceiling.
- Reads are only allowlist-checked when the endpoint starts with `act_`. Reading objects in other accounts by ID is unrestricted.

**Failure scenario:** during a rate-limit window, an agent's write to a campaign in a non-allowlisted account goes through.

**Recommended fix:**
- Distinguish "this object has no `account_id`" (a successful response without the field) from "the lookup failed".
- Throw a PolicyError on failure whenever an allowlist or ceiling is configured. The ceiling path already throws when there is no account; make it fail closed too.
- Optionally allowlist-check reads of ad objects as well.

**Test to add:** with an allowlist, a mocked 500 on the lookup GET causes the write to throw a PolicyError, not to succeed.

### B2-11: The account daily-budget ceiling is incomplete and racy
**Location:** `src/meta-client.ts:316-359`, `src/commands/bulk.ts:187-207`

**What's wrong:**
- **Parallel creates:** `bulk create-campaigns` creates in parallel (`Promise.all`, batch 5). Each create sums the current ACTIVE budgets on its own and can't see siblings that are still in flight. With a ceiling of 10000 and five ACTIVE creates at 9000, all five pass and the account ends at 45000.
- **Other budgets ignored:** `lifetime_budget` and budget schedules (`*/budget_schedules`, B2-12) don't count.
- **Narrow status filter:** objects whose `effective_status` is `IN_PROCESS` or `WITH_ISSUES` but that will deliver aren't counted.

**Recommended fix:**
- Keep a process-wide running total of budgets approved in this run.
- Serialise writes when a ceiling is set.
- Count `configured_status=ACTIVE` rather than `effective_status`.
- Count budget schedules.

**Test to add:** a parallel batch of ACTIVE creates is blocked after the ceiling is reached.

### B2-12: `seasonal-schedule` checks the increase, not the resulting budget
**Location:** `src/commands/bidding.ts:413-431`, `src/meta-client.ts:131-135,192`

**What's wrong:** for `budget_value_type=ABSOLUTE`, Meta's `budget_value` is the amount *added* during the high-demand period. The guard compares that increase to the cap. With a cap of 5000, a budget of 4000 and `+100%`, the guard sees 4000 and passes, but the effective budget is 8000. MULTIPLIER schedules are exempt from the guard entirely (`:192`).

**Recommended fix:** for writes to `*/budget_schedules`, fetch the parent's `daily_budget` or `lifetime_budget` and check the resulting budget against the cap. For a MULTIPLIER, that is `current × value`.

**Test to add:** cap 5000, budget 4000, `--adjustment 100 --apply` gives a PolicyError.

### B2-13: The policy's tamper-resistance is weaker than documented
**Location:** `src/policy.ts:46-51,88-103,111-118`, `src/commands/policy.ts:15-24`, `src/journal.ts:33`

**What's wrong**
- **Deletable default file:** the default policy lives in `~/.config/meta-ads-cli/`, a directory the agent's user owns (mode 0700). Making `policy.json` root-owned and read-only doesn't stop that user from `rm`-ing or renaming it. A missing file means "no policy", so the guardrails switch off, yet `policy show` reports `tamper_resistant: true` because it checks only `W_OK` on the file.
- **`VITEST` escape hatch:** any non-empty `VITEST` env var disables the policy and the journal in production builds. `.env` is loaded by `dotenv/config`, so a writable `.env` in the working directory is enough.

**Recommended fix:**
- In `policyWritableByCurrentUser`, also check write access on the parent directory, and the sticky bit.
- Support a "policy required" marker that can't be removed: a system path such as `/etc/meta-ads-cli/policy.json`, checked first. If it exists, ignore `META_ADS_CLI_POLICY_FILE`.
- Replace `process.env.VITEST` with a test-only injection, for example `resetPolicyCache({ path })` and the test setup file.

**Test to add:** `policy show` reports `tamper_resistant: false` when the parent directory is writable.

### B2-14: `@file` inputs can read and leak credential files
**Location:** `src/json-input.ts:7-27`

**What's wrong:** any JSON flag accepts `@<any path>` (for example `--adlabels`, `--targeting` or `--spec`). If the file is valid JSON, it is sent as a field value. That value then:
- is printed by `--dry-run` and `--plan` to stderr (which MCP returns to the model)
- is stored in the journal
- is sent to Meta

**Reproduced:**
```
--profile t --dry-run campaigns update 123 --adlabels @~/.config/meta-ads-cli/profiles.json
→ [dry-run] Body: {"adlabels":"{\"t\":{\"accessToken\":\"abc\",...}}"}
```
Invalid JSON also leaks the first 10 characters of the file in the parse error (Node 22).

**Failure scenario:** an MCP agent that is scoped to `--profile client-a` reads `profiles.json` or `token-cache.json`. That gives it client B's token, or the user's own long-lived token if the client was given a narrower one.

**Recommended fix:**
- Refuse `@` paths that resolve, after `realpath`, inside `CONFIG_DIR`, or that point at `.env` files.
- In MCP child processes, disable `@file` and `-` entirely (`META_ADS_CLI_MCP_CHILD`), or restrict paths to the working directory.
- Don't echo file content in parse errors.

**Test to add:** `parseJsonInput('@' + CONFIG_DIR + '/profiles.json', ...)` throws.

### B2-15: The journal, plan and dry-run output store personal data and huge payloads
**Location:** `src/journal.ts:41-46` (`redact` only matches `token|secret|password`), `src/meta-client.ts:438-439,475-478`, `src/commands/audiences.ts:144-155`, `src/commands/conversions.ts:124`, `src/commands/plan.ts:324-326`

**What's wrong**
- Each customer-list batch stores up to 10,000 rows of hashed identifiers in `journal.jsonl`, with MADID and EXTERN_ID unhashed.
- CAPI events add IP address, user agent, `fbp` and `fbc`, plus raw values under `--no-hash`.
- Image uploads through `adimages` `bytes` store the whole base64 image.
- `readJournal` loads the whole file for every `journal list` or `undo`, and `--plan` and `--dry-run` print all of it.

**Failure scenario:**
- A 100k-row upload adds about 7 MB of personal data to a file that is never rotated.
- `journal list` slows down.
- The data is kept indefinitely, which is a GDPR retention problem.

**Recommended fix:**
- Summarise large or sensitive keys (`payload`, `data`, `session`, `bytes`) as `{size, sha256}` in the journal and plan, and truncate them in dry-run output.
- Add journal rotation, or a size cap.

**Test to add:** after an upload, the journal entry contains no row data.

### B2-16: The journal `chmod`s the parent directory of a custom path
**Location:** `src/journal.ts:56`, `src/private-file.ts:8-13`

**What's wrong:** `appendJournal` calls `ensurePrivateDir(path.dirname(file))`, which `chmod`s an *existing* directory to 0700 unconditionally.

**Reproduced:** with `META_ADS_CLI_JOURNAL_FILE=<dir>/j.jsonl` and `<dir>` at 755, the directory is 700 after one write.

**Failure scenario:**
- `META_ADS_CLI_JOURNAL_FILE=/tmp/meta.jsonl` run as root (as in this environment) makes `/tmp` mode 0700, which breaks every other user and service.
- `./journal.jsonl` locks down the project directory.

**Recommended fix:** only `chmod` directories that the code itself created, or only `CONFIG_DIR`. For custom paths, only create the file with 0600.

**Test to add:** an existing 0755 directory keeps its mode after `appendJournal`.

### B2-17: A profile's `apiVersion` is ignored
**Location:** `src/index.ts:107` (`apiVersion` read from env at module load, *before* `main()` applies the profile), `:116,124` (that stale value is passed to `AuthManager` and `MetaClient`, where it wins over env), `src/profiles.ts:169`

**Reproduced:** `profile create --name t --api-version v21.0`, then `--profile t --dry-run campaigns list` still calls `v26.0`.

**Recommended fix:** read `process.env.META_ADS_CLI_API_VERSION` in `getAuth()`/`getClient()` or in the preAction hook, after `applyProfile` has run. Then validate it (B2-02).

**Test to add:** with a profile `apiVersion` of v21.0, the dry-run URL contains `/v21.0/`.

### B2-18: A broken default profile locks out the whole CLI
**Location:** `src/index.ts:146-152`, `src/profiles.ts:151-158`

**What's wrong:** `main()` applies the default profile before registering commands, and `applyProfile` throws when:
- the profile's secrets are in a keychain that isn't available (headless SSH, cron, WSL without D-Bus, the MCP subprocess), even when `META_ADS_CLI_ACCESS_TOKEN` is already set; or
- the profile is missing, for example because `profiles.json` was deleted.

**Reproduced:** with default profile `k` (`secretsInKeychain: true`) and `META_ADS_CLI_NO_KEYCHAIN=1`:
- `profile use --clear` fails with "keeps its token in the OS keychain" (exit 1).
- `--help` fails the same way.

Every startup also pays for a keychain round-trip, up to the 2 s timeout, even for `--help`.

**Recommended fix:**
- For the *default* profile (`onlyUnset`), warn and continue instead of throwing.
- Skip the keychain read when the env token is already set.
- Never apply profiles for `profile`, `help`, `completion` or `--version`.

**Test to add:** with an unusable default profile, `profile use --clear` exits 0.

### B2-19: `--validate` breaks every multi-step create
**Location:** `src/meta-client.ts:444-456` (the response is `{validated, response}`, with no top-level `id`, `images` or `hash`), `src/commands/plan.ts:324-337,433-447`, `src/commands/workflows.ts:305-313`, `src/commands/backup.ts:249-255`

**What's wrong**
- `uploadImage` throws "returned no hash".
- `uploadVideo` gets `{skipped:true}` back and throws.
- `apply` sends `campaign_id: '<campaign-id>'`.
- `wf launch-campaign` sends `campaign_id=undefined` (`URLSearchParams` turns it into the string "undefined").
- `backup restore` skips every child.

**Failure scenario:** `--validate apply spec.json` and `--validate wf launch-campaign` always fail at the first child object.

**Recommended fix:** have validate mode return a placeholder `id` (using the same scheme as plan, B2-05), and have the commands skip child steps that need a real parent ID, or validate them with the parent placeholder.

**Test to add:** with mocked fetch, a `--validate apply` on a two-level spec sends no body containing "undefined" or "<campaign-id>", and exits 0.

### B2-20: `--validate` may apply writes on endpoints that don't support `validate_only` [docs]
**Location:** `src/meta-client.ts:444-456`

**What's wrong:** `execution_options=["validate_only"]` is documented for ad objects: campaigns, ad sets, ads and creatives. Validate mode adds it to *every* POST, including:
- `*/messages` (Messenger, WhatsApp, Instagram)
- `*/users` (audience upload)
- `*/events` (CAPI)
- `*/subscriptions` and `*/subscribed_apps`
- `threads_publish`

Endpoints that ignore unknown parameters will **execute** the write. The user was promised "nothing changes".

**Recommended fix:** allowlist the edges that support `validate_only`, and skip everything else with a `[validate] skipped` note, the same way DELETE is handled. CAPI could use `test_event_code` instead.

**Test to add:** `--validate` on `555/messages` doesn't call fetch.

### B2-21: Creating an async insights report counts as a write
**Location:** `src/commands/insights.ts:296` (`startAsyncReport` POSTs to `act_X/insights`)

**What's wrong:** the POST is blocked by `--read-only` and by policy `readOnly`. Reproduced: `--read-only insights async act_123` exits 7.

It is also:
- journaled as a write
- recorded instead of run under `--plan` (and then B2-05 hits)
- sent with `validate_only` under `--validate`, so Meta returns no `report_run_id` and the command throws

**Failure scenario:** a read-only MCP agent can't run large reports or `export-mmm`.

**Recommended fix:** add a `readLike: true` request option that skips the write checks, plan, validate and journal. Use it only for `*/insights` POSTs.

**Test to add:** `--read-only insights async` reaches fetch, and `--validate` sends no `execution_options`.

### B2-22: Budgets are divided by 100 regardless of currency
**Location:** `src/commands/bidding.ts:698,709,915-916,937`, `src/commands/accounts.ts:262`

**What's wrong:** budgets and bids are in minor units, and they are converted to main units by dividing by 100 so they can be compared with insights spend (which is in main units). For zero-decimal currencies (JPY, KRW, TWD, CLP, VND and others), the result is 100× wrong:
- `auto-adjustments --apply` never sees under-delivery.
- With no `--target-cpa`, the target becomes `bid/100`, so cost-cap bids are cut 10% on every run.
- `pacing` is 100× off.

**Recommended fix:** read the account `currency`, and use one shared `minorUnitsPerMain(currency)` helper based on a table of currency offsets.

**Test to add:** a JPY fixture with `daily_budget` 5000 and spend 4000 gives a delivery ratio of about 0.8.

### B2-23: Optimizers apply ROAS to every campaign once one campaign has revenue
**Location:** `src/commands/bidding.ts:560-568,790-791`

**What's wrong:** `useRoas` becomes global as soon as any row has revenue. Campaigns without ROAS (lead or traffic) then rank as 0 and are cut, and `--target-cpa` is ignored.

**Failure scenario:** `optimize-budget --apply --target-cpa 20` on a mixed account cuts lead campaigns that beat their CPA target by 20%.

**Recommended fix:** choose the KPI per campaign from its result event, and rank within each KPI group. Never treat a `null` ROAS as 0.

**Test to add:** in a mixed fixture, a lead campaign under its CPA target isn't decreased.

### B2-24: `--min-roas` pauses ad sets that have no purchase objective
**Location:** `src/commands/monitoring.ts:31,93,282`

**What's wrong:** `getRoas` returns `undefined` when there are no purchase values, and `?? 0` turns that into a failing ROAS.

**Reproduced:** `pauseReasons({spend:'50',impressions:'5000',objective:'OUTCOME_LEADS',actions:[lead 10]},{minRoas:'1'})` returns `['ROAS 0 < 1']`.

**Failure scenario:** `auto-pause --min-roas 1 --confirm` pauses every lead and traffic ad set.

**Recommended fix:** apply the ROAS rule only when the result event is `purchase` and there are purchase signals.

**Test to add:** a lead row with `--min-roas` produces no reasons.

### B2-25: `monitor watch` re-alerts on every tick and never retries a failed pause
**Location:** `src/commands/monitoring.ts:75-94` (the reasons embed live numbers), `:226-228,383-385` (the key is `id|reason`)

**What's wrong**
- "Spend 150 > 100" and then "Spend 151 > 100" count as different alerts, so `--notify slack:` spams every interval.
- Conversely, when the text is stable (for example "ROAS 0 < 2"), a pause that failed is never retried, because only *new* alerts are acted on.

**Recommended fix:** key alerts on `id` plus the rule type (`HIGH_SPEND`, `LOW_ROAS`, and so on). On every tick, retry pauses for every object in `to_pause` that is still ACTIVE.

**Test to add:** two ticks with different spend produce one alert, and a failed pause is retried on the next tick.

### B2-26: `export-mmm` can poll forever
**Location:** `src/commands/insights.ts:540-548`, with `waitForReport` at `:350-372`

**What's wrong:** `--timeout 30m` gives `NaN`. `Date.now() >= NaN` is always false, and the poll sleep becomes about 1 ms, so the command busy-polls the Graph API until it is rate-limited. `insights async --poll-interval 0` is also accepted.

**Recommended fix:**
- Share option validation between `insights async` and `export-mmm`: positive finite numbers, with a poll interval of at least 1 s.
- Make `waitForReport` guard against non-finite values itself.

**Test to add:** `export-mmm --timeout abc` exits 2.

### B2-27: `journal undo` is unsafe to repeat or reorder
**Location:** `src/commands/journal.ts:29-49`, `src/journal.ts:24`

**What's wrong**
- **Later writes overwritten:** undo re-posts `previous` without checking for later writes to the same endpoint. Say a budget goes 5000 → 8000 (entry A), then 8000 → 3000 (entry B). Undoing A sets 5000 and silently discards B.
- **Repeat undo:** a second undo of A repeats that. `undo_of` is declared but never set, so repeats can't be detected.
- **Unset fields:** fields that were unset before the write (such as `end_time` or `bid_amount`) aren't in `previous`, so undo leaves them changed and doesn't warn.
- **Wrong token or base URL:** undo always uses the user token and the Graph base URL, even when the original write used a Page token or Threads.

**Recommended fix:**
- Write `undo_of` on the undo write (pass it through `request()` options).
- Refuse without `--force` when a newer successful entry touched the same endpoint and fields, or when the entry has already been undone.
- Report changed fields that `previous` doesn't cover.

**Test to add:** undoing the older of two entries on the same object fails without `--force`, and a second undo of the same entry fails.

### B2-28: `campaigns preflight` judges inactive children
**Location:** `src/commands/campaigns.ts:418-454`

**What's wrong:** the budget, geo, end-time, bidding, "no ads" and creative checks run on every ad set and ad, including PAUSED and ARCHIVED ones. One leftover paused ad set with no ads gives `will_deliver=false` and exit 1.

**Recommended fix:** check only children that are ACTIVE or will be activated. Report the others as warnings.

**Test to add:** one healthy active ad set plus one paused, empty ad set gives `will_deliver: true`.

### B2-29: `plan`/`apply` never converge on targeting
**Location:** `src/commands/plan.ts:229-271`

**What's wrong:** `targeting` is diffed as full JSON. Meta returns targeting with fields it adds itself (such as `geo_locations.location_types` and `targeting_automation`), so the targeting never matches the spec. This was inferred from Meta's response shape and not run live.

**Failure scenario:**
- Every `plan` shows an update for every ad set.
- Every `apply` re-sends targeting, which is a significant edit that can reset learning.

**Recommended fix:** compare only the keys the spec sets, recursively, and treat a superset as equal.

**Test to add:** `diffFields` reports no change when live targeting is a superset of the desired targeting.

### B2-30: `catalog batch` is incomplete [docs]
**Location:** `src/commands/catalog.ts:547-563`

**What's wrong**
- `POST /{catalog}/items_batch` requires `item_type` (for example `PRODUCT_ITEM`), and the command never sends it.
- `--requests` is passed raw: there's no JSON validation and no `@file` or `-` support, even though the help mentions payloads of up to 30 MB.
- The help shows the format of the older `/batch` endpoint.

**Recommended fix:**
- Add `--item-type`, defaulting to `PRODUCT_ITEM`.
- Parse `--requests` with `parseJsonInput` and require an array.
- Fix the help text.

**Test to add:** the dry-run body contains `item_type`, and `@file` is accepted.

### B2-31: The `claude -p` fallback runs with tools enabled on untrusted input
**Location:** `src/llm.ts:210-214`

**What's wrong:** the spawn arguments are only `-p --model --output-format json`. The prompt embeds ad names, copy and comments, which are attacker-controllable. The subprocess gets whatever tool permissions the user's Claude settings allow (for example Bash allowlists and MCP servers).

**Failure scenario:** a prompt-injection string in a public comment makes the subprocess run an allowed tool as the user.

**Recommended fix:** pass flags that disable every tool (for example `--tools ""` or `--disallowedTools` covering everything), together with `--max-turns 1` and `--strict-mcp-config` with an empty config.

**Test to add:** the spawn argv contains the tool-disabling flags.

---

## Low

### B2-32: MCP hardening
**Location:** `src/commands/mcp.ts:7,74-81,173-182`

**What's wrong**
- **Long-running commands exposed:** `webhooks listen` and `monitor watch` are offered as tools, and each call blocks for up to `--tool-timeout` (600 s). `EXCLUDED_ROOTS` covers neither.
- **Unguarded positionals:** positional arguments (`[formId]`, `[adsetIds]`, `[adId]`) are pushed raw, so an injected `--flag` value becomes a flag (see B2-01).
- **No schema validation:** tool input is never validated against `inputSchema`, so a non-string value is `JSON.stringify`'d into argv.

**Recommended fix:** exclude long-running commands, guard positionals, and validate input against the schema.

**Test to add:** `buildTools` doesn't include `webhooks_listen` or `monitor_watch`.

### B2-33: Logger loses the last lines and is world-readable
**Location:** `src/logger.ts:22-33`, `src/errors.ts:150-155`, `src/index.ts:129-133`

**What's wrong:** `META_ADS_CLI_LOG_FILE` uses an async `WriteStream`. `handleErrors` and `fail()` call `process.exit` right after `logger.error`, so the final error line, the one you need, is usually lost. The file is also created with the default umask (0644), and it contains request parameters and account IDs.

**Recommended fix:** use `fs.appendFileSync` with `{mode: 0o600}`, or flush the stream in an `exit` handler.

**Test to add:** after a failing command, the log file contains the error entry.

### B2-34: Eager Anthropic SDK import
**Location:** `src/llm.ts:1`

**What's wrong:** `@anthropic-ai/sdk` is loaded on every invocation. That costs about 40 ms on this machine, against roughly 100 ms total for `--help`.

**Recommended fix:** use `await import()` inside the Anthropic provider, the same way MCP and keytar are loaded.

**Test to add:** an e2e test that `--help` doesn't load the SDK (check via `--trace-event` or a `require.cache` guard).

### B2-35: `duplicate creative` copies into the wrong account
**Location:** `src/commands/duplication.ts:109,138`

**What's wrong:** the help says the copy goes to the original creative's account, but the option defaults to `META_ADS_CLI_ACCOUNT_ID`, so the original's `account_id` is never used when that env var is set. The copy lands in the wrong account, where its `image_hash` doesn't exist.

**Recommended fix:** use `opts.accountId || act_${original.account_id}`, with no env default.

**Test to add:** with the env var set and the original in another account, the POST goes to the original's account.

### B2-36: Input shapes aren't checked
**Location:** `src/commands/bulk.ts:383-386`, `src/commands/experiments.ts:124-126`

**What's wrong**
- `upload-creatives --images` with an object crashes with "is not iterable".
- An object passed to `experiments create --cells` gets through `validateCells`, because `.length` is undefined.
- `--confidence-level abc` is sent to Meta as "NaN".

**Recommended fix:** check with `Array.isArray` and `Number.isFinite`.

**Test to add:** object input gives a UsageError.

### B2-37: `creatives preview --spec -` with several formats
**Location:** `src/commands/creatives.ts:337-339`

**What's wrong:** stdin is parsed inside the per-format loop, so the second read returns empty. Reproduced: `--format A,B` fails with "invalid JSON in stdin".

**Recommended fix:** parse the spec once, before the loop.

**Test to add:** a stdin spec with two formats makes two requests.

### B2-38: `backup restore` hides policy blocks
**Location:** `src/commands/backup.ts:249-255,362-365`

**What's wrong:** spend-cap, read-only and policy errors are collected as ordinary failures. The command exits 1 instead of 7 and keeps going.

**Recommended fix:** rethrow `PolicyError`, or exit with the first typed error's code.

**Test to add:** a spend-cap block during restore exits 7.

### B2-39: Sale price is assumed to be USD
**Location:** `src/commands/catalog.ts:283-286`

**What's wrong:** without `--price`, `parsePrice(sale, undefined)` defaults to USD, and `sale_price_currency` is never sent. `--sale-price 1000` on a JPY product sends 100000.

**Recommended fix:** require a currency, and send `sale_price_currency`.

**Test to add:** `--sale-price 1000` without a currency is rejected.

### B2-40: City normalisation is inconsistent
**Location:** `src/commands/conversions.ts:18` vs `src/commands/audiences.ts:34`

**What's wrong:** the CAPI normalizer strips everything outside `[a-z0-9]` ("München" becomes "mnchen"), while the audience normalizer keeps Unicode letters. Meta expects UTF-8 letters to be kept, so the CAPI hashes don't match and match rates drop.

**Recommended fix:** share one normalizer that uses `\p{L}`.

**Test to add:** "München" hashes the same from both paths.

### B2-41: `webhooks listen --leads-csv` edge cases
**Location:** `src/commands/webhooks.ts:40,207-209`

**What's wrong**
- The existing CSV header is split naively on `,`, so a quoted header misaligns columns.
- In dry-run, `{dryRun:true,...}` stubs are appended as leads.
- Meta retries deliveries, so the same lead can be appended more than once.

**Recommended fix:** parse the header with the CSV parser, skip appends in dry-run and plan mode, and dedupe on lead ID.

**Test to add:** the same lead delivered twice is appended once.

### B2-42: `monitor watch` never gives up
**Location:** `src/commands/monitoring.ts:395-398`

**What's wrong:** every error is caught and logged, and the loop continues. An expired token or a missing permission produces an error line every interval, forever.

**Recommended fix:** rethrow a `CliError` whose type is `auth`, `permission`, `usage` or `policy`.

**Test to add:** an auth error on the first tick ends the loop with exit 3.

### B2-43: Bidding edge cases
**Location:** `src/commands/bidding.ts:509,678-679,709-713,747-750,776`

**What's wrong**
- `auto-adjustments` assumes 7 days for `this_month`, `last_month` and `maximum`, which skews the delivery ratio.
- It can send `bid_amount=0` when the current bid is 0 or unreadable and no `--target-cpa` is given.
- `--min-results`, `--min-spend` and `--total-budget` aren't validated, and NaN silently turns the volume floor off.

**Recommended fix:** restrict the ranges to presets with a known day count, skip zero bids, and validate the numbers.

**Test to add:** `--min-spend abc` exits 2.

### B2-44: `adsets update` skips create-time checks
**Location:** `src/commands/adsets.ts:629-650`

**What's wrong:** the special-ad-category Advantage+ audience check and the EU DSA defaults run on `create` but not on `update`. The dry-run preview builds targeting from a placeholder read, so it looks as if geo targeting and audiences would be wiped.

**Recommended fix:** share the checks between `create` and `update`, and skip the merged-targeting preview in dry-run.

**Test to add:** an `update` that conflicts with a special ad category is rejected.

### B2-45: Date-window math
**Location:** `src/commands/accounts.ts:79-82,238-246`, `src/commands/campaigns.ts:255-262`, `src/commands/bidding.ts:428-429`, `src/commands/analytics.ts:166-168`

**What's wrong**
- **Spend projection:** it divides by local full days, but the spend includes today's partial spend in the account's timezone.
- **Learning guard:** the `campaigns update` learning-phase guard reads only the first page of ad sets (about 25).
- **Seasonal dates:** `seasonal-schedule` dates are parsed in local time, not the account's timezone.
- **`analytics trends`:** it compares the last N *rows* rather than N calendar days, and Meta omits days with no delivery.

**Recommended fix:** use the account timezone and `requestAllPages`, and group by `date_start`.

**Test to add:** a trends fixture with a missing day still compares equal calendar windows.

---

## Test-suite notes
- `tests/integration/g1-governance.test.ts:125` asserts `id: 'planned-1'`, which locks in B2-05.
- `tests/unit/g2-introspection.test.ts:53-78` tests `toolArgv` and `forwardedGlobals` only with benign values. There is no test for values that start with `-` (B2-01), and none checks that `--plan` or `--validate` are forwarded (B2-04).
- No test covers `--api-version` or `META_ADS_CLI_API_VERSION` validation (B2-02), or a profile's `apiVersion` taking effect (B2-17).
- The policy tests cover only top-level body fields. Nothing covers `method=DELETE` overrides (B2-09), rule specs (B2-03) or lookup failures (B2-10).
