# AGENTS.md

Guidelines for AI agents working on the meta-ads-cli codebase.

## Project Overview

Meta Ads CLI is a TypeScript CLI wrapping the Meta Graph API for Facebook/Instagram advertising. 29 command groups, 150 subcommands covering campaigns, ad sets, ads, creatives, audiences, insights, bidding, retargeting, conversions, and more.

> [!IMPORTANT]
> All commands are statically defined in `src/commands/*.ts`. Adding a new command means adding code.

## Build & Test

```bash
npm install          # Install dependencies
npm run build        # Build with tsup → dist/index.js
npm run dev -- --help  # Run without building (tsx)
```

> [!NOTE]
> There are no tests yet. When adding tests, use `vitest` and follow the async patterns in the codebase.

## Source Layout

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point: program setup, lazy singletons, command registration, pre-action hooks |
| `src/auth.ts` | Meta OAuth flow, token cache (keytar + file fallback), long-lived token exchange |
| `src/meta-client.ts` | Graph API HTTP client: retry, pagination, dry-run, read-only, multipart upload |
| `src/formatter.ts` | Output formatting: json, table, csv, text, yaml with object flattening |
| `src/errors.ts` | `handleErrors()` HOF for consistent error handling |
| `src/logger.ts` | Structured JSON logging singleton with daily rotation |
| `src/validate.ts` | Input validation: safe paths, control chars, account/entity ID formats |
| `src/mime.ts` | MIME type detection for file uploads (40+ types) |
| `src/commands/*.ts` | 27 command modules, each exporting `registerXxxCommands()` |

## Adding a New Command

1. Create `src/commands/<service>.ts`
2. Export `registerXxxCommands(program: Command, getClient: () => MetaClient)`
3. Wrap every `.action()` with `handleErrors(async (opts) => { ... })`
4. Use `formatOutput(data, opts.output as OutputFormat)` for all output
5. Accept `-o, --output <format>` on every subcommand (default: `'json'`)
6. Import and register in `src/index.ts`
7. Run `npm run build` to verify

**Template:**

```typescript
import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

export function registerXxxCommands(program: Command, getClient: () => MetaClient): void {
  const xxx = program.command('xxx').description('...');

  xxx
    .command('list')
    .description('List items')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const response = await client.request('endpoint', { params: { fields: '...' } });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
```

## Meta API Patterns

- **Base URL:** `https://graph.facebook.com/v24.0`
- **Auth:** `access_token` as query param (injected by MetaClient)
- **GET:** Query params for `fields`, `limit`, `after`, filters
- **POST:** `application/x-www-form-urlencoded` (not JSON body)
- **Pagination:** Response has `paging.cursors.after` → pass as `after` param
- **Errors:** Check for `response.error` object with `message` and `code` fields

> [!IMPORTANT]
> Meta API POST requests use form-encoded data, not JSON. The `MetaClient.request()` method handles this automatically via `URLSearchParams`. Complex objects (targeting, rules) must be `JSON.stringify()`-ed into a string value.

## Conventions

- Use `getDefaultAccountId()` helper in commands that need `--account-id`
- Ensure `act_` prefix on account IDs before API calls
- Default status for create operations: `PAUSED` (safe default)
- Delete operations use `POST` with `status: 'DELETED'` (not HTTP DELETE, except audiences)
- Use `client.requestAllPages()` for `--all` pagination
- Use `client.uploadFile()` for multipart image/video uploads

## Changesets

When making changes:
- Update `CLAUDE.md` if command groups or key patterns change
- Update `README.md` command tables if adding/removing commands
- Run `npm run build` to verify compilation
- Test with `--dry-run` for any new write commands
