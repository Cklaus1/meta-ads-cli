# Bug Spec: meta-ads-cli source review

**Date:** 2026-10-26 · **Scope:** `src/` (core modules + all 37 command files) · **Type:** review only, no source changes made

**Already being fixed elsewhere, so not repeated here:** the duplicate `getUsage()` in `meta-client.ts`, the `handleErrors` generic constraint (`never[]` changed to `any[]`), `Profile` union typing in `commands/profile.ts`, and the implicit `any` in `commands/audiences.ts:146-160`.

Every finding below was checked against the code at the cited `file:line`. The startup hang (BUG-01) was also reproduced under `strace`.

## Status (2026-10-26)

All 35 findings below are fixed, along with the four pre-existing items listed above. `tsc --noEmit` is clean, and the suite has 271 tests, all passing. Follow-ups found during the fixes:
- `retargeting frequency-optimization` read its options object as an ad set ID (fixed).
- `workflow duplicate-and-test` doubled the budget the same way BUG-13 did (fixed: 50/50 split).
- Open: `creatives update` still assumes a `link_data` story; `video_data`/`asset_feed_spec` creatives aren't handled.
- Open: `threads search` uses `threads/search` (probably should be `keyword_search`, unverified).
- Open: `leads list/export` use the user token; Meta may require a Page token.
- Open: BUG-24 assumes Meta forbids editing `object_story_spec` on existing creatives. Not yet checked against the v25 docs.
- Breaking changes: `pages delete-comment` and `messenger messages` now require `--page-id`.

## Summary

| ID | Sev | Title | Location |
|----|-----|-------|----------|
| BUG-01 | Critical | `preAction` auth-skip list never matches, so keytar/D-Bus runs on every command (**root cause of the startup hang and the e2e timeouts**) | `src/index.ts:172-189`, `src/auth.ts:1,45-57` |
| BUG-02 | Critical | Entity/account IDs are never validated: path and query-string injection bypasses the spend-cap guard | `src/meta-client.ts:141-150,203`; `src/validate.ts` (dead code) |
| BUG-03 | High | The spend-cap can be raised by the flag, is silently disabled by bad or `=`-form values, and a profile cap loses to `.env` | `src/index.ts:67-73`, `src/meta-client.ts:107-108`, `src/profiles.ts:366-369` |
| BUG-04 | High | The spend-cap guard misses budget fields (`bid_cap`, `daily/lifetime_spend_cap`, `*_min_spend_target`, `budget_value`, `budget`) and lets non-numeric values through | `src/meta-client.ts:88,115-129` |
| BUG-05 | High | `uploadFile()` skips `--read-only` enforcement | `src/meta-client.ts:362-377` |
| BUG-06 | High | Credentials are written world-readable (token cache, profiles, `.env`) | `src/auth.ts:18-22,89`, `src/profiles.ts:19-23,38`, `src/commands/setup.ts:77` |
| BUG-07 | High | Non-idempotent POSTs are retried on 5xx, which creates duplicate campaigns/ad sets/ads | `src/meta-client.ts:234-241` |
| BUG-08 | High | The `setup` wizard deletes the access token, spend cap, API version and app secret from `.env` | `src/commands/setup.ts:61-77` |
| BUG-09 | High | `leads export` (CSV default) drops every lead answer and keeps only field names | `src/formatter.ts:29-38`, `src/commands/leads.ts:129-141` |
| BUG-10 | Medium | The rate-limit "too long to wait" branch is dead code: it sleeps 90s repeatedly when Meta says 30 min | `src/meta-client.ts:266-284` |
| BUG-11 | Medium | No HTTP timeouts and no retry on network errors, so requests can hang forever | `src/meta-client.ts:200,208,400`; `src/auth.ts:242,268`; `src/commands/doctor.ts:102`; `src/commands/creatives.ts:408` |
| BUG-12 | Medium | The OAuth callback server binds all interfaces, has no `state`, and accepts cross-origin `text/plain` POSTs (token injection) | `src/auth.ts:121-224` |
| BUG-13 | Medium | `ab-test create`: control budget never split, ABO campaigns get a $100/day budget injected, lifetime-budget campaigns break | `src/commands/ab-testing.ts:35-63` |
| BUG-14 | Medium | `workflow launch-campaign` / `retargeting dynamic-campaign` set the budget at both campaign and ad-set level, leaving orphaned campaigns | `src/commands/workflows.ts:147,160`; `src/commands/retargeting.ts:216,229` |
| BUG-15 | Medium | `monitor auto-pause`/`check`: safety options silently ignored, wrong units/window, only 100 entities checked | `src/commands/monitoring.ts:15-131` |
| BUG-16 | Medium | `adsets update --<placement>` replaces the whole targeting spec (wipes geo/audiences) | `src/commands/adsets.ts:214-224` |
| BUG-17 | Medium | `bulk create-campaigns --batch-size 0` loops forever; a non-numeric value silently creates nothing | `src/commands/bulk.ts:30-36` |
| BUG-18 | Medium | CSV formula injection, and YAML output that does not quote IDs/booleans/empty strings (ID precision loss) | `src/formatter.ts:139-203,215-220` |
| BUG-19 | Medium | Page/Messenger/Threads writes use the wrong token or host; OAuth scopes miss the permissions they need | `src/commands/pages.ts`, `messenger.ts`, `threads.ts`, `src/auth.ts:15` |
| BUG-20 | Medium | `auth refresh-token` throws away the new token (prints 20 chars, never saves) | `src/commands/auth.ts:208-242` |
| BUG-21 | Medium | `claude` CLI LLM provider: no timeout, whole prompt passed in argv (E2BIG), `is_error` swallowed | `src/llm.ts:196-238` |
| BUG-22 | Medium | `conversions send-event/send-batch` sends raw PII (em/ph) without SHA-256 normalisation | `src/commands/conversions.ts:19,33,124-137` |
| BUG-23 | Medium | `backup restore` aborts on the first API error without reporting what it already created | `src/commands/backup.ts:240-313` |
| BUG-24 | Medium | `creatives update` edits `object_story_spec` on an existing creative (Meta creatives are immutable) | `src/commands/creatives.ts:286-314` |
| BUG-25 | Low | `catalog`: `--custom-label-0/1` never applied; price parsing breaks on comma decimals, zero-decimal currencies and NaN | `src/commands/catalog.ts:138-162,193-200` |
| BUG-26 | Low | `duplicate`: `--name-suffix` ignored for campaign/adset/ad; creative dup ignores `--account-id` | `src/commands/duplication.ts:12-50,109-148` |
| BUG-27 | Low | Instagram publish: timeout falls through to publish, story `ERROR` not checked, carousel video children not awaited | `src/commands/instagram.ts:156-176,199-214,268-283` |
| BUG-28 | Low | `creatives save-image` writes the error body to disk and reports success | `src/commands/creatives.ts:407-417` |
| BUG-29 | Low | API version precedence inverted (env beats `--api-version`); auth/doctor hard-code `v25.0` | `src/index.ts:75-83`; `src/auth.ts:225,241,269`; `src/commands/doctor.ts:100` |
| BUG-30 | Low | Global flags are parsed by hand from argv: `--flag=value` forms are ignored; an unknown `--profile` crashes with a stack trace | `src/index.ts:57-83` |
| BUG-31 | Low | `resolveTimeRange`: UTC/local mix, ranges include today and are off by one, unknown names silently ignored | `src/time-range.ts:6-46` |
| BUG-32 | Low | `requestAllPages` returns the first page's stale `paging` block and follows `cursors.after` instead of `paging.next` | `src/meta-client.ts:299-355` |
| BUG-33 | Low | `uploadFile`: whole file in memory, filename not escaped, `--title/--description` ignored, docstring claims a resumable upload that doesn't exist | `src/meta-client.ts:358-421`; `src/commands/creatives.ts:364-367` |
| BUG-34 | Low | `validateSafeOutputDir` uses a prefix check (`/proj-evil` passes for `/proj`), relevant once BUG-02 wires it up | `src/validate.ts:6-16` |
| BUG-35 | Low | `audiences create-lookalike` silently uses only the first of `--countries` | `src/commands/audiences.ts:95-101` |

---

## Critical

### BUG-01: `preAction` auth-skip never matches, so keytar/D-Bus runs on every command (root cause of the startup hang)

**Location:** `src/index.ts:172-189`, `src/auth.ts:1` (eager `import keytar`), `src/auth.ts:45-57` (`initialize()` always calls `keytar.getPassword`)

**What's wrong:**
1. Commander 11 calls a hook as `callback(hookedCommand, actionCommand)` (`node_modules/commander/lib/command.js:1221`). The hook is registered on `program`, so `thisCommand` is always the root program. The parent walk therefore yields `['meta-ads']`, and `skipAuth.some(s => commandChain.includes(s))` is **never true**. `schema`, `generate-skills`, `profile`, `doctor`, `auth` and `setup` all run `auth.initialize()`, and the log line reads `Running: meta-ads ` with nothing after it.
2. `initialize()` calls `keytar.getPassword()` even when `META_ADS_CLI_ACCESS_TOKEN` is set. On Linux, keytar talks to the Secret Service over D-Bus via libsecret. On headless machines, WSL and CI there is no session bus, so GLib **autolaunches `dbus-launch`** (it connects to X11 at `/tmp/.X11-unix/X0`), then tries to activate `org.freedesktop.secrets`. Each D-Bus method call blocks a libuv threadpool thread with a **25 000 ms** timeout, or longer if gnome-keyring activation stalls.

**Evidence:**
- `strace -f node dist/index.js schema` shows `dbus-launch --autolaunch=…` exec'd from a threadpool thread, then `poll(..., 25000)` on the D-Bus fd. The main thread's `write(1, "[\n  {\n    \"service\": …)` happens only after that call returns.
- Observed timings: one run timed out at 60s with 0.13s user CPU. Most runs take about 0.1s and a few take about 3.6s, depending on whether a cached autolaunched bus/keyring is alive.
- This matches the reported symptom of minutes of wall time with about 0.15s CPU.
- The two e2e tests that time out at 10s are almost certainly `auth status shows not logged in` (calls `initialize()` directly) and `schema shows available services` (reaches it through the broken hook). `--help`, `--version` and `--dry-run` tests return before `initialize()`.

**Failure scenario:** An agent in WSL or a container runs `meta-ads schema` or `meta-ads campaigns list` with an env token set. The CLI hangs for 25s to several minutes before doing anything.

**Fix:**
- Use the second hook argument: `program.hook('preAction', async (_root, actionCommand) => { … walk actionCommand.parent … })`.
- In `AuthManager.initialize()`/`loadTokenCache()`, return early when `META_ADS_CLI_ACCESS_TOKEN || META_ACCESS_TOKEN` is set.
- Load keytar lazily (`const keytar = (await import('keytar')).default` inside a try). Wrap keytar calls in a short timeout, e.g. `Promise.race` with a 2s timer that falls back to the file cache. Allow opting out with `META_ADS_CLI_NO_KEYCHAIN=1`.
- Optional: load `@anthropic-ai/sdk` lazily inside `AnthropicProvider` (`src/llm.ts:1`) to cut startup cost.

**Acceptance / tests:**
- Unit test: invoke the registered hook with `(program, schemaCmd)` and assert `AuthManager.initialize` is not called for `schema`, `profile list`, `doctor`, `auth setup` and `generate-skills`.
- Unit test: with `META_ADS_CLI_ACCESS_TOKEN` set, `initialize()` never calls keytar (mock the module).
- E2E: `DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent node dist/index.js schema` finishes in under 2s. Run it 20 times in a loop with no run over 2s.
- The two e2e tests pass under the full suite with the 10s timeout.

### BUG-02: IDs are never validated, so injection bypasses the spend-cap guard

**Location:** `src/meta-client.ts:141-150` (`buildUrl` concatenates `endpoint` raw), `src/meta-client.ts:203` (POST URL built from raw endpoint), every command that interpolates `<campaignId>`, `<adsetId>`, `--account-id` or `--ids`. `src/validate.ts` (`validateAccountId`, `validateEntityId`, `validateSafeFilePath`, `rejectControlChars`) is **never imported anywhere** (grep confirms).

**What's wrong:** Positional IDs and `--account-id` go straight into the URL path. A value containing `?`, `&`, `/` or `..` changes which endpoint is hit and adds query parameters. Graph API reads query parameters on POST. The spend-cap guard only inspects `options.body`.

**Failure scenario:**
- `meta-ads --max-spend-cap 1000 campaigns update '1234?daily_budget=5000000' --name x` sends POST `…/v25.0/1234?daily_budget=5000000` with body `name=x`. The guard sees no budget field and $50,000/day is set.
- `bulk update-status --ids 'act_1/campaigns?…'` or `'../v18.0/…'` reaches arbitrary endpoints.
- Any agent given "spend-capped" access can defeat the cap this way.

**Fix:**
- Validate every ID before building URLs: `validateEntityId` (digits only) for object IDs and `validateAccountId` (`act_\d+`, auto-prefix) for accounts. A central option is to have `MetaClient.request()` reject endpoints whose path segments are not `^[A-Za-z0-9_]+$` and that contain `?`, `#`, `&`, `..` or `%`.
- Build URLs by `encodeURIComponent`-ing each segment.
- Also run `enforceSpendCap` over query params on POST, or reject query strings on POST entirely.

**Acceptance / tests:**
- `campaigns update '123?daily_budget=1'` errors with "Invalid campaign ID" before any fetch.
- `request('123?x=1', {method:'POST'})` throws.
- `--account-id 123` becomes `act_123`.
- Table test: `act_1/../x`, `1%2F2` and `1#a` are all rejected.

---

## High

### BUG-03: The spend cap can be raised, silently disabled, or overridden

**Location:** `src/index.ts:67-73`, `src/meta-client.ts:107-108`, `src/profiles.ts:366-369`, error text at `src/meta-client.ts:125`

**What's wrong:**
1. `maxSpendCapCents || envCap` means the CLI flag **replaces** the env/profile cap. An agent can pass `--max-spend-cap 999999999` to get past `META_ADS_CLI_MAX_SPEND_CAP`, and the error message tells it to "Raise --max-spend-cap". `docs/SPENDING_CAPS.md` says the env var "can't be forgotten" for delegated access, which this undermines.
2. Values are parsed by hand from argv. `--max-spend-cap=500` (a form Commander accepts) is not seen, so there is **no cap**. `--max-spend-cap 5,000`, `$50` or `abc` gives NaN and is silently ignored. A non-numeric env value gives NaN, which becomes 0, which disables the guard. Every bad input fails open.
3. A profile's `maxSpendCap` only applies when the env var is unset. A looser `.env` value (loaded first by `dotenv`) wins over a stricter profile cap.

**Failure scenario:** An operator sets `META_ADS_CLI_MAX_SPEND_CAP=1000`. The agent hits the guard, follows the error hint, and re-runs with `--max-spend-cap 100000`. The write goes through.

**Fix:**
- Effective cap = **minimum** of all configured, non-zero sources (flag, env, profile). A flag can only lower the cap.
- Read the value from Commander (`program.opts().maxSpendCap`) in `preAction`, or at least handle `--x=value`.
- Reject invalid values with an error instead of ignoring them (flag, env, and profile JSON).
- Change the error text so it does not tell the user to raise the cap.

**Acceptance / tests:**
- env=1000 plus flag=100000: a 5000 budget is blocked.
- env=100000 plus flag=1000: a 5000 budget is blocked.
- `--max-spend-cap=1000` blocks 5000.
- `--max-spend-cap abc` and `META_ADS_CLI_MAX_SPEND_CAP=abc` both exit non-zero with a clear error.
- `.env` cap 100000 plus profile cap 1000: 5000 is blocked.

### BUG-04: The spend-cap guard misses budget fields and fails open

**Location:** `src/meta-client.ts:88` (`BUDGET_FIELDS`), `src/meta-client.ts:115-129`

**What's wrong:** Only `daily_budget`, `lifetime_budget`, `spend_cap` and `bid_amount` are checked. These money fields are written but not checked:

| Field | Written at |
|-------|-----------|
| `bid_cap` | `campaigns.ts:107,149`, `ab-testing.ts:62` |
| `daily_spend_cap`, `lifetime_spend_cap`, `daily_min_spend_target`, `lifetime_min_spend_target` | `adsets.ts:121-123,201-204`, backup restore via `ADSET_CREATE` |
| `budget_value` (ABSOLUTE amount on `budget_schedules`, which raises budget during the window) | `bidding.ts:119` |
| `budget` | `reach-frequency.ts:32` |

Also, `Number.isFinite(cents)` false (`"Infinity"`, `"1_000"`, full-width digits, `"5000abc"`) is skipped instead of blocked.

**Failure scenario:**
- `meta-ads bidding budget-schedule --campaign-id X --budget-value 10000000 --budget-type ABSOLUTE …` passes a 1000¢ cap.
- `adsets create --daily-min-spend-target 9000000` passes too.

**Fix:**
- Extend the list: `bid_cap`, `daily_spend_cap`, `lifetime_spend_cap`, `daily_min_spend_target`, `lifetime_min_spend_target`, `budget_value` (when `budget_value_type=ABSOLUTE`), and `budget` (reach-frequency).
- Better: match any key ending in `_budget`, `_cap`, `_spend_target`, `bid_amount` or `budget_value`.
- When a cap is set, treat a present but non-numeric budget value as a violation (fail closed).

**Acceptance / tests:**
- A parameterised unit test over every field above: value above the cap is blocked, value below is allowed.
- `daily_budget: "Infinity"` and `"5000abc"` are blocked when a cap is set.

### BUG-05: `uploadFile()` skips `--read-only`

**Location:** `src/meta-client.ts:362-377`. Callers: `creatives upload-video --file` (`creatives.ts:366`) and `pages upload-video` (`pages.ts:294`).

**What's wrong:** `request()` checks `this.readOnly` (line 155). `uploadFile()` checks only `dryRun`, so a POST goes out under `--read-only`. `docs/SPENDING_CAPS.md` promises read-only "physically cannot" write.

**Failure scenario:** An analytics agent running with `--read-only` uploads a video to an ad account, or publishes one to a Page.

**Fix:** At the top of `uploadFile`, add `if (this.readOnly) throw new Error('Read-only mode: …')`. Route all mutating HTTP through one private `assertWritable(method)` helper.

**Acceptance / tests:** A unit test where `new MetaClient(auth, false, undefined, true).uploadFile(...)` rejects with "Read-only mode" and `fetch` is never called.

### BUG-06: Credentials written world-readable

**Location:**
- `src/auth.ts:18-22` (mkdir without mode), `src/auth.ts:89` (`token-cache.json` written with default mode)
- `src/profiles.ts:19-23` and `src/profiles.ts:38` (`profiles.json` holds access tokens and app secrets)
- `src/commands/setup.ts:77` (`.env` with app secret)

**What's wrong:** With the usual umask 022, files are created `0644` and directories `0755`. Any local user or process can read long-lived ads tokens and app secrets. (The `profiles.json` on this machine happens to be `0600`, presumably set by hand; the code does not guarantee it.)

**Failure scenario:** On a shared build box, another account reads `~/.config/meta-ads-cli/token-cache.json` and gets a 60-day `ads_management` token.

**Fix:**
- Create the directory with `mkdirSync(dir, { recursive: true, mode: 0o700 })`.
- Write files with `writeFileSync(path, data, { mode: 0o600 })`, then `chmodSync(path, 0o600)` (mode is ignored when the file already exists).
- Write atomically: temp file plus rename.
- Optionally warn in `doctor` when the permissions are too open.

**Acceptance / tests:** Run with `umask 022` and a temp `HOME`. After `saveTokenCache()` (keytar mocked to throw), `setProfile()` and `setup`, `fs.statSync(...).mode & 0o077 === 0` for each file and the directory is `0700`.

### BUG-07: POSTs retried on 5xx create duplicate objects

**Location:** `src/meta-client.ts:234-241` (the retry applies to every method). The same retry loop handles POST creates (`…/campaigns`, `/adsets`, `/ads`, `/copies`, `/messages`, `/events`).

**What's wrong:** Meta often returns 500/502/503 or times out *after* committing a create. Retrying a non-idempotent POST creates the object a second or third time. The rate-limit retry (codes 4/17/…) is safe because those requests were rejected. The 5xx retry is not.

**Failure scenario:**
- `bulk create-campaigns` with `status: ACTIVE` hits a transient 502 and ends up with two live campaigns, each under the spend cap, doubling spend.
- `whatsapp send-template` sends the same message to a customer twice.

**Fix:**
- Retry 5xx only for GET/DELETE. For POST, retry only on rate-limit codes and connection errors that happen before the request is sent.
- Alternatively, before retrying a create, look for an object with the same name created in the last N seconds.
- Document the behaviour.

**Acceptance / tests:** Mock fetch to return 500 then 200 for a POST: `request` throws on the 500 and fetch is called once. The same mock for a GET retries and succeeds.

### BUG-08: `setup` wizard deletes the token, spend cap and other settings from `.env`

**Location:** `src/commands/setup.ts:61-77`

**What's wrong:** Every existing line starting with `META_ADS_CLI_`, `META_APP_` or `META_ACCESS_TOKEN` is dropped. Only `APP_ID`, an optional `APP_SECRET` and `ACCOUNT_ID` are written back. That deletes:
- `META_ADS_CLI_ACCESS_TOKEN` (the wizard even shows "Found access token" first)
- `META_ADS_CLI_MAX_SPEND_CAP`, which silently removes the guard
- `META_ADS_CLI_API_VERSION`, `META_ADS_CLI_LOG_*`, `META_ADS_CLI_ANTHROPIC_API_KEY`
- the existing `APP_SECRET`, whenever the user presses Enter at that prompt

The file is written `0644` (see BUG-06). `setup` is also not wrapped in `handleErrors`, and an EOF on stdin leaves the `rl.question` promise pending so the process exits 0 halfway through.

**Failure scenario:** The operator runs `meta-ads setup` to change the default account. The spend cap and the token disappear without a word.

**Fix:**
- Edit only the keys the wizard prompts for and keep every other line.
- Keep existing values when the user leaves a prompt blank.
- Write with mode `0600`.
- Wrap the action in `handleErrors` and handle `rl.on('close')`.

**Acceptance / tests:** Start from a `.env` containing `META_ADS_CLI_MAX_SPEND_CAP=1000`, `META_ADS_CLI_ACCESS_TOKEN=x`, `META_ADS_CLI_APP_SECRET=s` and an unrelated `FOO=1`. After setup with blank answers, all four lines are unchanged.

### BUG-09: `leads export` drops every lead answer

**Location:** `src/formatter.ts:29-38` (arrays of objects collapse to `name || id || …`), `src/commands/leads.ts:129-141` (default `-o csv`)

**What's wrong:** Lead `field_data` is `[{name:'email', values:['a@b.com']}, …]`. `flattenObject` reduces each element to its `name`, so the CSV column `field_data` contains `"email, full_name"` and no values. Verified by running the formatter: the output is `1,"email, full_name"`. Table and text formats lose the values the same way.

**Failure scenario:** A marketer runs `meta-ads leads export <form>` and gets a CSV with no emails or phone numbers. The leads are effectively lost for CRM import.

**Fix:**
- In `leads export`, pivot `field_data` into columns before formatting: `{id, created_time, ad_id, …, email: 'a@b.com', full_name: '…'}`, joining multiple values with `;`.
- More generally, for arrays of `{name, values}` emit `name=values` pairs instead of names only.

**Acceptance / tests:** Snapshot test: a fixture with two leads gives a CSV header containing `email,full_name` and the rows contain the actual values.

---

## Medium

### BUG-10: Dead "too long to wait" branch in rate-limit handling

**Location:** `src/meta-client.ts:266-284`

**What's wrong:** `waitMs = Math.min(MAX_AUTO_WAIT_MS, estMs)`, so the check `waitMs <= MAX_AUTO_WAIT_MS` is always true. When Meta's `estimated_time_to_regain_access` is 30 minutes, the client sleeps 90s, retries (still blocked), sleeps 90s again, and only then throws. That is about 3 minutes of pointless blocking plus two extra calls against an already-throttled budget.

**Fix:** Compare the raw estimate. If `estMs > MAX_AUTO_WAIT_MS`, throw immediately with the estimate. Otherwise sleep `estMs`.

**Acceptance / tests:** Mock a response with code 17 and a header estimate of 30 min, with fake timers. `request` rejects without calling `sleep` and fetch is called once. With a 10s estimate it sleeps 10s and retries.

### BUG-11: No timeouts and no retry on network errors

**Location:** every `fetch` call: `src/meta-client.ts:200,208,400`; `src/auth.ts:242,268`; `src/commands/doctor.ts:102`; `src/commands/creatives.ts:408`; `src/commands/auth.ts:104`; `src/llm.ts:127`

**What's wrong:**
- There is no `AbortSignal.timeout`. A half-open TCP connection or a stalled proxy hangs the CLI indefinitely (undici's default headers timeout is 300s, and the body has no timeout).
- `fetch` throwing (`ECONNRESET`, `ENOTFOUND`, `UND_ERR_SOCKET`) escapes the retry loop on the first try. `lastError` at line 307 is never assigned.

**Fix:**
- Add `signal: AbortSignal.timeout(Number(process.env.META_ADS_CLI_HTTP_TIMEOUT_MS) || 60000)`. Use a larger timeout for uploads.
- Catch network errors inside the loop and retry them for GET (and for POST only when the request was not sent, see BUG-07).
- Assign `lastError`.

**Acceptance / tests:**
- A mock fetch that never resolves makes `request` reject with a timeout error within the configured time (fake timers).
- A mock that throws `TypeError('fetch failed')` once and then succeeds makes a GET succeed.

### BUG-12: OAuth local callback allows token injection

**Location:** `src/auth.ts:121-224`

**What's wrong:**
- `server.listen(8899)` binds every interface, not loopback.
- There is no OAuth `state` parameter.
- `/token` accepts any POST and does not check `Content-Type` or `Origin`. Any web page the user visits during the 5-minute window can `fetch('http://localhost:8899/token', {method:'POST', body: JSON.stringify({access_token: ATTACKER_TOKEN})})` with `text/plain`, a CORS "simple request" that needs no preflight. A LAN host can do the same directly.
- The CLI then caches the attacker's token, and later audience uploads, CAPI events and lead webhooks go into the attacker's account.

**Fix:**
- `listen(8899, '127.0.0.1')`.
- Generate a random `state`, include it in the auth URL, and require it to match in the `/token` POST (the callback page forwards `params.get('state')`).
- Require `Content-Type: application/json` and that `Origin` is either absent or `http://localhost:8899`.
- Optionally verify the token's `app_id` via `debug_token`.

**Acceptance / tests:**
- A POST to `/token` without the correct `state` gets a 400 and the token is not cached.
- The server address is `127.0.0.1`.

### BUG-13: `ab-test create` budget logic is wrong

**Location:** `src/commands/ab-testing.ts:35-63`

**What's wrong:**
1. The control copy (line 39-45) never gets its budget adjusted. It keeps 100% of the original budget while the variant gets `(1-split)`, and the original campaign still exists, so total exposure is 1 + (1 - split) times the original.
2. For campaigns without `daily_budget` (ABO or lifetime-budget), `totalBudget` defaults to `10000`. The variant campaign then has `daily_budget=5000` forced on it, which turns an ABO campaign into CBO with a budget nobody set.
3. A lifetime-budget campaign gets `daily_budget` added, and Meta rejects it with an error after both copies already exist.

**Fix:**
- Read `daily_budget`/`lifetime_budget`. If neither exists at campaign level, refuse to split (or split ad-set budgets).
- Update both copies: control = `split`, variant = `1 - split`, using the same budget field as the original.
- Validate `0 < split < 1`.

**Acceptance / tests:**
- Mocked campaign with `daily_budget=10000` and split 0.5: control and variant each get a POST with `daily_budget=5000`.
- Campaign with no daily budget: no `daily_budget` in any POST, or a clear error.

### BUG-14: Campaign and ad-set budget set together, orphaned campaigns

**Location:** `src/commands/workflows.ts:147,160`; `src/commands/retargeting.ts:216,229`

**What's wrong:** Both commands create a campaign with `daily_budget` (CBO) and then an ad set with `daily_budget` too. Meta rejects ad-set budgets under a campaign budget, so the ad-set POST fails. The already-created campaign is left behind, and re-running creates another one. `launch-campaign` also sends no targeting by default, while Meta requires `geo_locations`.

**Fix:**
- Put the budget at one level only (campaign by default, with a flag for ad-set level).
- Require or default targeting.
- If a later step fails, delete or archive the objects already created, or print their IDs in the error.

**Acceptance / tests:**
- With a mocked client, the ad-set POST body has no `daily_budget` when the campaign has one.
- A simulated ad-set failure produces a request to delete or archive the campaign, or an error message containing the campaign ID.

### BUG-15: `monitor auto-pause`/`check` safety options are no-ops or use the wrong units

**Location:** `src/commands/monitoring.ts:15-131` (options at lines 15-20 and 70-75, list at line 81-87, loop at 98-119)

**What's wrong:**
- `--min-roas` (auto-pause) and `--min-conversions` (check) are accepted but **never evaluated**.
- Only the first `limit: 100` entities are listed, with no pagination, so entities past 100 are never checked.
- Insights are requested without `time_range`/`date_preset`, so Meta's default window applies, while `--max-spend` is described as "daily spend".
- `spend` and `cpc` come back in currency units (dollars), while the rest of the CLI uses cents. A user passing `--max-spend 5000` thinking in cents gets a $5,000 threshold.
- When `--confirm` is set, the first failed pause throws and the remaining pauses never run, with no report of which ones succeeded.

**Failure scenario:** An operator schedules `monitor auto-pause --min-roas 1.5 --confirm` as a guardrail. Nothing is ever paused.

**Fix:**
- Implement ROAS (`purchase_roas`) and conversions, or remove the options.
- Paginate with `requestAllPages`.
- Add `--date-preset` (default `today`).
- Document the units explicitly in the option help text, or accept cents to match the rest of the CLI.
- Wrap each pause in a try/catch and report successes and failures.

**Acceptance / tests:**
- A fixture with ROAS 0.8 and `--min-roas 1` includes the entity in `toPause`.
- 150 mocked entities across 2 pages are all checked.
- One failed pause still pauses the rest and reports the failure.

### BUG-16: Placement-only update wipes targeting

**Location:** `src/commands/adsets.ts:214-224`

**What's wrong:** Without `--targeting`, the code starts from `{}`, adds the placement keys and sends `targeting={"facebook_positions":[…]}`. Meta replaces the whole spec, dropping geo, age and audiences, or rejects it for missing `geo_locations`.

**Fix:** When placement flags are given without `--targeting`, GET the current `targeting`, merge the placement keys in, and POST the result.

**Acceptance / tests:** Mock GET targeting `{geo_locations:{countries:['US']}}`, then `update --facebook-positions feed` POSTs targeting containing both `geo_locations` and `facebook_positions`.

### BUG-17: `bulk create-campaigns` infinite loop or silent no-op

**Location:** `src/commands/bulk.ts:30-36`

**What's wrong:** `--batch-size 0` makes `i += 0` loop forever at 100% CPU and never print anything. `--batch-size abc` gives NaN, the loop condition is false immediately, and the command reports `created: 0, failed: 0` for N configs. The same parsing pattern repeats with `--delay-ms`.

**Fix:** Validate that batch size is an integer of at least 1 and delay is an integer of at least 0. Throw otherwise.

**Acceptance / tests:** `--batch-size 0` and `--batch-size abc` exit non-zero with a validation error within 1s.

### BUG-18: CSV formula injection and YAML type confusion

**Location:** `src/formatter.ts:215-220` (`csvEscape`), `src/formatter.ts:139-203` (`toYaml`/`inlineValue`)

**What's wrong:**
- CSV cells starting with `=`, `+`, `-`, `@`, tab or CR are not neutralised. Lead form answers, ad names and comments are attacker-controlled (anyone can submit a lead form), so `leads export` can deliver `=HYPERLINK(...)` or DDE payloads into Excel or Sheets.
- `\r` is not quoted.
- YAML does not quote numeric-looking strings, `true`/`false`/`null`, empty strings, or values starting with `-`, `*`, `&`, `!`, `{`, `[`. Verified: `id: 120210000000000001` loads as a number in YAML parsers and loses precision past 2^53, `name: true` becomes a boolean, `e:` becomes null. Agents that use `-o yaml` will act on the wrong IDs.

**Fix:**
- CSV: prefix risky leading characters with `'` and quote `\r`.
- YAML: quote any string that doesn't match a conservative plain-scalar regex such as `^[A-Za-z_][A-Za-z0-9_ ./-]*$` and isn't a YAML keyword. Or use a small YAML library.

**Acceptance / tests:**
- `formatOutput([{a:'=1+1'}],'csv')` contains `'=1+1`.
- YAML round-trip through the `yaml` package returns `'120210000000000001'` as a string and `'true'` as a string.

### BUG-19: Page, Messenger and Threads writes use the wrong token or host

**Location:**
- `src/commands/pages.ts` (create-post/update/delete/reply/upload-video/create-live/create-event)
- `src/commands/messenger.ts:36,58,94`
- `src/commands/webhooks.ts:65,77`
- `src/commands/threads.ts` (all commands)
- `src/auth.ts:15` (scopes)

**What's wrong:**
- Page and Messenger endpoints require a **Page access token**. The client always sends the user token and nothing fetches `/{page-id}?fields=access_token`.
- Threads lives on `graph.threads.net` with Threads-specific tokens, but `MetaClient` always targets `graph.facebook.com`.
- `AUTH_SCOPE` lacks `pages_manage_posts`, `pages_manage_engagement`, `pages_messaging`, `instagram_basic`/`instagram_content_publish`, `whatsapp_business_messaging` and `threads_*`.
- These command groups fail with `(#200)`/`(#190)` for OAuth users.

**Fix:**
- Add a `getPageToken(pageId)` helper (cached) and let `request()` take a token override.
- Give `MetaClient` a `baseHost` option for Threads.
- Extend the scopes, or let users choose them with `auth login --scopes`.

**Acceptance / tests:**
- With mocked fetch, `pages create-post P` first GETs `P?fields=access_token`, then POSTs with that token.
- `threads create` targets `https://graph.threads.net/…`.

### BUG-20: `auth refresh-token` discards the new token

**Location:** `src/commands/auth.ts:208-242` (line 115 prints `slice(0, 20)`)

**What's wrong:** The exchanged long-lived token is neither cached nor printed in full. The user is told to "set META_ADS_CLI_ACCESS_TOKEN=<token>" with a token they can't see, so the command does nothing useful. It also doesn't use the configured API version.

**Fix:** Save it through `AuthManager` (`tokenData` plus `saveTokenCache`). Add `--print` to emit the full token on stdout for piping.

**Acceptance / tests:** After a mocked exchange, `loadTokenCache()` returns the new token.

### BUG-21: `claude` CLI provider can hang, overflow argv, or hide errors

**Location:** `src/llm.ts:196-238`

**What's wrong:**
- There is no timeout or kill on the spawned `claude` process, so `ai recommendations` can hang forever (for example on an auth prompt or a network stall).
- The whole prompt (system, campaign JSON and schema) is passed as one argv string. Linux `MAX_ARG_STRLEN` is 128 KiB, so large accounts get `E2BIG` from spawn.
- `if (envelope.is_error) throw …` sits inside the `try` whose `catch` swallows it and falls back to raw stdout, which then produces a confusing JSON parse error.

**Fix:**
- Send the prompt through stdin (`claude -p` reads stdin) with `stdio: ['pipe', …]`.
- Add a timeout (e.g. 120s, configurable) that kills the child.
- Move the `is_error` check outside the parse `try`.

**Acceptance / tests:**
- A fake `claude` binary that sleeps forever makes the call reject at the timeout.
- A 500 KB prompt succeeds with a fake binary that echoes stdin.
- An `is_error: true` envelope rejects with that message.

### BUG-22: CAPI sends unhashed PII

**Location:** `src/commands/conversions.ts:19,33,124-137`

**What's wrong:** Meta requires `em`, `ph`, `fn`, `ln`, `ct`, `st`, `zp`, `db`, `ge` and `country` in `user_data` to be normalised and SHA-256 hashed. The CLI forwards whatever JSON it is given, and the help text ("em, ph, …") doesn't mention hashing. Plaintext emails and phone numbers get sent, which is a privacy and compliance problem, and Meta discards or mis-matches them.

**Fix:**
- Normalise and hash these fields automatically (lowercase and trim; digits only for `ph`) unless the value already looks like 64-hex.
- Add `--no-hash` for pre-hashed input.

**Acceptance / tests:** `send-event --user-data '{"em":" A@B.com "}' --dry-run` shows `em` equal to `sha256("a@b.com")` in the body.

### BUG-23: `backup restore` aborts without reporting what it created

**Location:** `src/commands/backup.ts:240-313`

**What's wrong:** Any API error (one invalid field on one ad set, for example) propagates to `handleErrors` and exits. The objects already created and the ID map are never printed. The user can't clean up, and re-running duplicates everything. Snapshot budget fields also feed BUG-04's unchecked fields.

**Fix:**
- Wrap each `create()` in a try/catch and record the failure in `warnings`.
- Keep going for independent objects and skip the children of failed parents.
- Always print the summary and ID map. Optionally write a resumable `--state-file`.

**Acceptance / tests:** A mock where the 2nd ad-set POST fails still prints JSON with `id_map.campaigns` populated and a warning naming the failed ad set, and exits non-zero.

### BUG-24: `creatives update` edits immutable creative fields

**Location:** `src/commands/creatives.ts:286-314`

**What's wrong:** The Marketing API allows updates to an existing AdCreative only for a few fields (`name`, `status`, `adlabels`, etc.). `object_story_spec` cannot be changed after creation; the usual approach is to create a new creative and point the ad at it. `--caption`, `--message`, `--headline`, `--description`, `--link-url` and `--cta` therefore always fail with an API error. This should be confirmed against the current v25 AdCreative reference.

**Fix:** For story fields, create a new creative from the merged spec (as `duplicate creative` already does). Optionally add `--ad-id` to re-point an ad, and print the new creative ID.

**Acceptance / tests:** `creatives update C --headline X --dry-run` shows a POST to `act_…/adcreatives`, not to `C`.

---

## Low

### BUG-25: `catalog` custom labels and price parsing

**Location:** `src/commands/catalog.ts:161-162` and `src/commands/catalog.ts:138-139,157-158,193-199`

**What's wrong:**
- Commander camel-cases `--custom-label-0` to `customLabel0` (verified), but the code reads `opts.customLabel_0`, so custom labels are never sent.
- `parseFloat("29,99")` is 29.
- `"abc"` produces `"NaN"` in the request.
- `×100` is wrong for zero-decimal currencies (JPY, KRW).

**Fix:** Use `opts.customLabel0` and `opts.customLabel1`. Validate the price with a regex. Use the currency's minor-unit exponent (e.g. from `Intl.NumberFormat(...).resolvedOptions().maximumFractionDigits`).

**Acceptance / tests:**
- `--custom-label-0 foo --dry-run` shows `custom_label_0=foo` in the body.
- `--price "1000 JPY"` sends `price=1000`.
- `--price abc` errors.

### BUG-26: `duplicate`: suffix and account ignored

**Location:** `src/commands/duplication.ts:28-36` (body built and never used), `12/58/86` (`--name-suffix` never sent), `src/commands/duplication.ts:143` (creative dup reads only the env var)

**What's wrong:** Copies keep Meta's default name. The `rename_options` parameter (`{rename_suffix}`) exists for this but isn't used. `duplicate creative` ignores `--account-id`/`--profile` semantics.

**Fix:** Send `rename_options` and add `--account-id` to the creative duplicate.

**Acceptance / tests:** `--dry-run` shows `rename_options` containing the suffix.

### BUG-27: Instagram publish flow edge cases

**Location:** `src/commands/instagram.ts:156-176` (after 30 tries still `IN_PROGRESS`, it publishes anyway), `268-283` (story: `ERROR` status never checked), `199-214` (carousel video children are not polled to `FINISHED` before the parent container is created)

**Fix:** Share one `waitForContainer(id)` helper that throws on `ERROR`/`EXPIRED` and on timeout, and use it for every video container, including carousel children.

**Acceptance / tests:**
- A mocked status that stays `IN_PROGRESS` throws a timeout and makes no `media_publish` call.
- A mocked story status of `ERROR` throws.

### BUG-28: `save-image` ignores the HTTP status

**Location:** `src/commands/creatives.ts:407-417`

**What's wrong:** A 403/404 HTML body (for example an expired CDN URL) is written to `ad-image.jpg` and reported as saved.

**Fix:** Check `imgResponse.ok` and throw on failure.

**Acceptance / tests:** A mocked 404 makes the command exit non-zero and writes no file.

### BUG-29: API version precedence

**Location:** `src/index.ts:75-83`; `src/auth.ts:225,241,269`; `src/commands/auth.ts:203,224`; `src/commands/doctor.ts:100`

**What's wrong:** `META_ADS_CLI_API_VERSION` overrides an explicit `--api-version`, the opposite of the usual "flag beats env" rule. Auth and doctor always use `v25.0`.

**Fix:** Use flag > profile > env > default, and pass the resolved version into `AuthManager`.

**Acceptance / tests:** With env `v24.0` and `--api-version v25.0 --dry-run`, the printed URL contains `v25.0`.

### BUG-30: Global flags parsed by hand from argv

**Location:** `src/index.ts:57-83`

**What's wrong:**
- `--profile=x`, `--api-version=x` and `--max-spend-cap=x` are ignored (BUG-03 covers the security side).
- `includes('--dry-run')` also matches the value of another option (e.g. `--name --dry-run`).
- `applyProfile` throws at module top level for an unknown profile, which prints an uncaught stack trace.

**Fix:** Resolve these in the `preAction` hook from `program.opts()`. That requires lazy client construction, which already exists. Show profile errors through the normal error path.

**Acceptance / tests:**
- `--profile=prod` applies the profile.
- `--profile nope` prints `Error: Profile "nope" not found` with no stack trace and exits 1.

### BUG-31: Time range math

**Location:** `src/time-range.ts:6-46`

**What's wrong:**
- `setDate` works on local time while `toISOString` formats UTC, so near midnight in non-UTC timezones the dates shift by a day.
- `last_7d` spans 8 calendar days including partial today, while Meta's `last_7d` preset is the 7 days excluding today.
- Unknown names (e.g. `last7d`) silently return `undefined`, which quietly changes the reporting window.

**Fix:** Do the date math in the account timezone (or pass Meta's `date_preset` directly for named ranges). Throw on unknown names.

**Acceptance / tests:**
- With a fixed clock, `last_7d` gives `since = today-7`, `until = today-1`.
- `resolveTimeRange('bogus')` throws.

### BUG-32: Pagination artefacts

**Location:** `src/meta-client.ts:299-355`

**What's wrong:**
- The merged result keeps the first page's `paging` (with a stale `next` and cursors), which misleads callers and agents into thinking more pages exist.
- The loop follows `cursors.after` even when `paging.next` is absent. Meta documents `next` as the end-of-list signal, so this wastes one extra request per listing and risks looping on endpoints that echo the cursor back.

**Fix:** Stop when `!paging.next`. Delete `data.paging` (or set `paging: {complete: true/false}`) in the merged result.

**Acceptance / tests:** A two-page mock where page 2 has no `next` results in exactly two fetches, and the returned object has no `paging.next`.

### BUG-33: Upload implementation limits

**Location:** `src/meta-client.ts:358-421`; `src/commands/creatives.ts:364-367`

**What's wrong:**
- The whole file is read into memory, so multi-GB videos cause out-of-memory crashes. The docstring claims a chunked resumable upload above 25 MB that doesn't exist.
- The `filename` is inserted unescaped into the `Content-Disposition` header, so a quote in the name breaks the multipart body.
- `upload-video --file` ignores `--title` and `--description`.
- There is no retry and no rate-limit handling.

**Fix:**
- Stream the file, or use the resumable `upload_phase=start/transfer/finish` flow for large files.
- Escape the filename.
- Include `title` and `description` as form parts.
- Reuse the request error mapping.

**Acceptance / tests:** A unit test asserts the multipart body contains `name="title"`. A filename containing `"` is escaped.

### BUG-34: `validateSafeOutputDir` prefix check

**Location:** `src/validate.ts:6-16`

**What's wrong:** `resolved.startsWith(cwd)` accepts `../proj-evil` when cwd is `/x/proj`. This is harmless today because the function is unused, but it will matter once BUG-02 wires the validators up.

**Fix:** Use `path.relative(cwd, resolved)` and reject results that start with `..` or are absolute.

**Acceptance / tests:** `validateSafeOutputDir('../<cwdname>-evil')` throws.

### BUG-35: Lookalike ignores extra countries

**Location:** `src/commands/audiences.ts:95-101`

**What's wrong:** `--countries US,GB` creates a US-only lookalike without saying so.

**Fix:** Use `location_spec: {geo_locations: {countries: [...]}}` for multi-country lookalikes, or reject more than one country.

**Acceptance / tests:** `--dry-run` with `US,GB` shows both countries in `lookalike_spec`.

---

## Notes and conventions observed (no separate ID)

- **`handleErrors` not used:** `setup`, `auth *`, `schema` and `generate-skills` actions aren't wrapped in `handleErrors`, which goes against CLAUDE.md. `auth`/`setup` partly handle their own errors.
- **API data handed to an external LLM without notice:** `ai recommendations` sends account performance data to whichever LLM provider it auto-detects, including `ANTHROPIC_AUTH_TOKEN` or `OPENAI_API_KEY` that happen to be in the environment. Consider an explicit opt-in, or at least a one-line stderr notice naming the provider.
- **Suggested fix order:** BUG-01 (unblocks tests and agent use), then BUG-02 to BUG-05 (the spend and write guardrails `docs/SPENDING_CAPS.md` promises), then BUG-06 to BUG-09.
