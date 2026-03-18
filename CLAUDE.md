# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

Meta Ads CLI is a standalone command-line tool for managing Facebook and Instagram advertising via the Meta Graph API.

**License:** CC-BY-NC-4.0 | **Node.js:** >=18 | **Framework:** Commander.js | **Language:** TypeScript

## Development Commands

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development mode (no build required)
npm run dev -- --help

# Run built CLI
node dist/index.js --help

# Link globally
npm link
meta-ads --help
```

## Architecture

### CLI Framework

Uses `commander` v11 with lazy-initialized singletons and pre-action hooks for auth.

**Entry point:** `src/index.ts`

### Command Organization

Pattern: `meta-ads <service> <subcommand> [args] [options]`

**29 command groups, 110+ subcommands:**

Core CRUD:
- `auth` — login, logout, status, setup
- `accounts` — list, get
- `campaigns` (alias: `camp`) — list, get, create, update, delete
- `adsets` — list, get, create, update, delete
- `ads` — list, get, create, update, delete
- `creatives` — list, get, get-for-ad, create-image, create-video, update, upload-image, upload-video, save-image
- `insights` — get, account, video

Targeting & Audiences:
- `targeting` — search-interests, suggest-interests, search-behaviors, search-demographics, search-geo, estimate-audience
- `audiences` — list, get, create-custom, create-lookalike, update, overlap, delete
- `retargeting` (alias: `retar`) — website-behavior, video-engagement, app-event, product, funnel, dynamic-campaign, frequency-optimization
- `pixels` — list, create, events

Pages, Leads & E-commerce:
- `pages` — list, search
- `leads` — forms, get, create-form, export, quality, webhooks
- `catalog` — list, get, products, product-sets, create, create-product-set
- `instagram` (alias: `ig`) — sync-catalog, create-shopping-ad, profile, shopping-insights

Bidding & Budget:
- `bidding` — validate, analyze, learning-phase, budget-schedule, seasonal-schedule, competitor-analysis, optimize-budget

Operations:
- `duplicate` (alias: `dup`) — campaign, adset, ad, creative
- `bulk` — create-campaigns, update-status, analyze, upload-creatives

Analytics & Intelligence:
- `library` — search, page-ads
- `analytics` — trends, creative-fatigue, competitive-intel, report
- `ai` — score, anomalies, recommendations, export-dataset
- `ab-test` — create, analyze

Conversion Tracking & Monitoring:
- `conversions` (alias: `conv`) — send-event, custom-conversions, create-custom, setup-tracking, validate-setup
- `monitor` — check, auto-pause, dashboard

Cross-service Workflows:
- `workflow` (alias: `wf`) — campaign-health, full-audit, launch-campaign, duplicate-and-test

Utilities:
- `schema` — API introspection
- `generate-skills` — Generate SKILL.md files for agents
- `setup` — Interactive setup wizard

### Authentication

Priority chain:
1. `META_ADS_CLI_ACCESS_TOKEN` env var
2. `META_ACCESS_TOKEN` env var (alternate name)
3. Cached OAuth token (keytar/file fallback)
4. Interactive OAuth flow (`meta-ads auth login`)

Token storage: OS keychain via keytar, fallback to `~/.config/meta-ads-cli/token-cache.json`

### Key Patterns

- **Lazy initialization:** AuthManager and MetaClient only created when needed
- **Dependency injection:** Commands receive `getClient()` callback
- **Error wrapper:** `handleErrors()` catches exceptions cleanly
- **Pre-action hooks:** Ensure auth before API commands
- **Multi-format output:** json, table, csv, text, yaml via `-o` flag
- **Pagination:** `--all`, `--page-limit`, `--page-delay` flags
- **Dry-run:** `--dry-run` shows API request without executing
- **Read-only:** `--read-only` blocks POST/DELETE requests
- **Default account:** `META_ADS_CLI_ACCOUNT_ID` env var for `--account-id`
- **Input validation:** `src/validate.ts` for path safety, control chars, ID formats
- **File upload:** `uploadFile()` in MetaClient for multipart image/video uploads
- **MIME detection:** `src/mime.ts` for file type detection

### Environment Variables

- `META_ADS_CLI_APP_ID` — Meta App ID (required for OAuth)
- `META_ADS_CLI_APP_SECRET` — Meta App Secret (for long-lived tokens)
- `META_ADS_CLI_ACCESS_TOKEN` — Direct access token
- `META_ADS_CLI_ACCOUNT_ID` — Default ad account ID
- `META_ADS_CLI_API_VERSION` — Graph API version (default: v24.0)
- `META_ADS_CLI_LOG_LEVEL` — Log level (debug, info, warn, error, none)
- `META_ADS_CLI_LOG_FILE` — Log file path (daily rotation)

### Adding a New Command

1. Create `src/commands/<service>.ts`
2. Export `registerXxxCommands(program, getClient)` function
3. Use `handleErrors()` wrapper on all actions
4. Use `formatOutput()` for output with `-o` flag support
5. Import and register in `src/index.ts`

### Build

- `tsup` builds to `dist/index.js` (ESM, shebang banner)
- `npm run dev` uses `tsx` for development

### Meta API

- Base URL: `https://graph.facebook.com/v24.0`
- Auth: `access_token` query parameter
- POST uses `application/x-www-form-urlencoded`
- Pagination: cursor-based via `paging.cursors.after`
- Retry: 3 attempts with exponential backoff for 429/5xx
