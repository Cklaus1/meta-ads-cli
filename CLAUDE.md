# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Meta Ads CLI is a standalone TypeScript CLI for managing Facebook, Instagram, Threads & WhatsApp advertising via the Meta Graph API. 37 command groups, 250+ subcommands.

**License:** CC-BY-NC-4.0 | **Node.js:** >=18 | **Framework:** Commander.js v11

## Development Commands

```bash
npm install                # Install dependencies
npm run build              # Build with tsup → dist/index.js (ESM, shebang)
npm run dev -- --help      # Run without building (tsx)
node dist/index.js --help  # Run built CLI
npm link && meta-ads --help  # Link globally
```

```bash
npm test                   # Run all tests (vitest)
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests only
npm run test:e2e           # E2E tests only
npm run test:watch         # Watch mode
```

## Architecture

### Entry Point & Initialization (`src/index.ts`)

- Commander program with lazy-initialized `AuthManager` and `MetaClient` singletons
- `getAuth()` / `getClient()` factory functions passed to command registrars
- `preAction` hook runs `auth.initialize()` before all commands except `auth`, `setup`, `schema`, `generate-skills`
- Global flags: `--dry-run`, `--read-only`, `--api-version`, `--profile`
- `--profile <name>` applies named profile credentials before command execution

### Core Modules

| File | Purpose |
|------|---------|
| `src/auth.ts` | OAuth2 flow on `localhost:8899`, token caching (keytar → file fallback at `~/.config/meta-ads-cli/token-cache.json`), long-lived token exchange |
| `src/meta-client.ts` | Graph API HTTP client: `request()`, `requestAllPages()`, `uploadFile()`. Retry 3x with backoff on 429/rate-limit codes; 5xx and network errors retried for GET/DELETE only (POST creates are not idempotent). Validates endpoint IDs, spend-cap guard. Dry-run and read-only enforcement |
| `src/formatter.ts` | `formatOutput(data, format)` — JSON, table, CSV, text, YAML. Auto-extracts from `data.data[]`. Flattens nested objects to dot-notation |
| `src/errors.ts` | `handleErrors()` — wraps async actions, catches and prints user-friendly messages |
| `src/validate.ts` | Path safety, control char rejection, `act_` prefix validation, numeric entity ID validation |
| `src/logger.ts` | JSON logger singleton. Level via `META_ADS_CLI_LOG_LEVEL`, file via `META_ADS_CLI_LOG_FILE` (daily rotation) |
| `src/mime.ts` | `detectMimeType(filename)` — extension-based MIME detection for uploads |
| `src/time-range.ts` | `insightsTimeParams()` — named ranges as Meta `date_preset` (account timezone) or `--since/--until`; legacy `resolveTimeRange()` |
| `src/profiles.ts` | Named profile management for multi-account config (`~/.config/meta-ads-cli/profiles.json`), default profile, keychain-held secrets |
| `src/policy.ts` | Safety policy file (allowlist, going-live/delete/messaging blocks, budget caps) enforced in `MetaClient` |
| `src/journal.ts` | JSONL write journal with previous values, used by `journal undo` |
| `src/metrics.ts` | Canonical action types (no double counting), result event by objective, derived cost per result / ROAS, volume floors, z-test |
| `src/json-input.ts` | `parseJsonInput()` for JSON options: inline, `@file` or `-` (stdin). Use it for every JSON option |
| `src/private-file.ts` | 0700 config dir and atomic 0600 writes for credential files |

### Command Pattern

All 35 command files in `src/commands/` follow this pattern:

```typescript
export function registerXxxCommands(program: Command, getClient: () => MetaClient): void {
  const svc = program.command('xxx').description('...');
  svc.command('action')
    .option('--account-id <id>', '...', getDefaultAccountId())
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const response = await client.request('endpoint', { params: { fields: '...' } });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
```

Key conventions:
- Every command action wrapped in `handleErrors()`; throw `UsageError`/`PolicyError` etc. from `errors.ts` so exit codes stay meaningful
- Results to stdout only; warnings and dry-run lines to stderr
- Conversions/results/ROAS via `src/metrics.ts`, never by summing action types
- Every command with API output uses `formatOutput()` with `-o` flag (default: `json`)
- `getDefaultAccountId()` reads `META_ADS_CLI_ACCOUNT_ID` env var
- POST requests: `{ method: 'POST', body: { ... } }` (url-encoded by MetaClient)
- Pagination: `--all`, `--page-limit`, `--page-delay` flags → `client.requestAllPages()`
- Budget values are in **cents**, not dollars

### Adding a New Command

1. Create `src/commands/<service>.ts`
2. Export `registerXxxCommands(program, getClient)` function
3. Wrap all actions in `handleErrors()`
4. Use `formatOutput()` for output with `-o` flag
5. Import and register in `src/index.ts`

### Authentication Priority Chain

1. `META_ADS_CLI_ACCESS_TOKEN` env var
2. `META_ACCESS_TOKEN` env var (alternate)
3. Cached OAuth token (keytar/file fallback)
4. Interactive OAuth flow (`meta-ads auth login`)

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `META_ADS_CLI_APP_ID` | Meta App ID (required for OAuth) |
| `META_ADS_CLI_APP_SECRET` | Meta App Secret (for long-lived tokens) |
| `META_ADS_CLI_ACCESS_TOKEN` | Direct access token (bypasses OAuth) |
| `META_ADS_CLI_ACCOUNT_ID` | Default ad account ID for `--account-id` |
| `META_ADS_CLI_API_VERSION` | Graph API version (default: v26.0) |
| `META_ADS_CLI_MAX_SPEND_CAP` | Cents ceiling on budget fields in writes; blocks over-budget creates/edits. The strictest of this, `--max-spend-cap` and the profile cap applies. Great for delegated/agent access |
| `META_ADS_CLI_USAGE_THRESHOLD` | Rate-limit usage % (default 75) at which the client proactively throttles |
| `META_ADS_CLI_MAX_WAIT_MS` | Max auto-wait on a rate-limit throttle (default 90000) |
| `META_ADS_CLI_HTTP_TIMEOUT_MS` / `META_ADS_CLI_UPLOAD_TIMEOUT_MS` | Per-request HTTP timeout (default 60000) / upload timeout (default 600000) |
| `META_ADS_CLI_NO_KEYCHAIN` | Skip the OS keychain and use the file token cache only |
| `META_ADS_CLI_AUTH_SCOPES` | Override the OAuth scope list requested by `auth login` |
| `META_ADS_CLI_THREADS_ACCESS_TOKEN` | Threads token for `threads` commands (graph.threads.com) |
| `META_ADS_CLI_POLICY_FILE` | Safety policy file (default `~/.config/meta-ads-cli/policy.json`) |
| `META_ADS_CLI_JOURNAL_FILE` / `META_ADS_CLI_NO_JOURNAL` | Write journal path / disable it |
| `META_ADS_CLI_ERROR_FORMAT` | `json` for machine-readable errors on stderr |
| `META_ADS_CLI_BUSINESS_ID` | Business ID for `experiments` and `ab-test create --business-id` |
| `META_ADS_CLI_DSA_BENEFICIARY` / `META_ADS_CLI_DSA_PAYOR` | Defaults for EU-targeted ad sets |
| `META_ADS_CLI_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY` | Enable LLM-backed `ai` commands (else falls back to local `claude` CLI or heuristics) |
| `META_ADS_CLI_LOG_LEVEL` | debug, info, warn, error, none |
| `META_ADS_CLI_LOG_FILE` | Log file path (daily rotation) |

### Meta Graph API

- Base URL: `https://graph.facebook.com/v26.0`
- Auth: `access_token` query parameter
- POST body: `application/x-www-form-urlencoded`
- Pagination: cursor-based via `paging.cursors.after`
- Retry: 3 attempts with exponential backoff for 429/rate-limit codes; 5xx/network errors only for GET/DELETE
