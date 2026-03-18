# Meta Ads CLI

A standalone command-line tool for managing Facebook & Instagram advertising via the Meta Graph API. Built for both humans and AI agents.

**29 command groups | 150 subcommands | Full Meta Ads API coverage**

## Features

- **Full campaign lifecycle** — Create, read, update, delete campaigns, ad sets, ads, and creatives
- **Audience management** — Custom audiences, lookalikes, retargeting funnels, overlap analysis
- **Performance analytics** — Insights, trends, creative fatigue detection, anomaly detection
- **AI intelligence** — Performance scoring, optimization recommendations, ML dataset export
- **Conversion tracking** — Conversions API (server-side events), pixels, custom conversions
- **E-commerce** — Product catalogs, dynamic ads, collection ads, Instagram Shopping
- **Bidding & budget** — Strategy validation, automated adjustments, seasonal scheduling, scaling recommendations
- **Bulk operations** — Batch campaign creation, status updates, parallel analysis
- **A/B testing** — Create and analyze bid strategy experiments
- **Competitive intelligence** — Ads Library search, batch brand monitoring
- **Cross-service workflows** — Campaign health checks, full audits, one-command launches
- **Multi-format output** — JSON, table, CSV, text, YAML (`-o` flag)
- **Safety** — `--dry-run`, `--read-only`, input validation
- **Environment compatibility** — Accepts common Meta env vars for easy integration
- **Agent skills** — Generate SKILL.md files for Claude Code / OpenClaw agents

## Requirements

- Node.js >= 18
- A Meta App with Marketing API access ([developers.facebook.com](https://developers.facebook.com/apps))

## Installation

```bash
# Clone and build
git clone git@github.com:Cklaus1/meta-ads-cli.git
cd meta-ads-cli
npm install
npm run build

# Link globally
npm link
meta-ads --help
```

## Quick Start

```bash
# 1. Configure
meta-ads setup

# 2. Authenticate
meta-ads auth login

# 3. Verify
meta-ads auth status

# 4. List your ad accounts
meta-ads accounts list

# 5. List campaigns
meta-ads campaigns list --account-id act_123456789
```

## Authentication

The CLI resolves access tokens in this order:

1. `META_ADS_CLI_ACCESS_TOKEN` environment variable
2. `META_ACCESS_TOKEN` environment variable (alternate name)
3. Cached OAuth token (OS keychain via keytar, file fallback)
4. Interactive OAuth flow (`meta-ads auth login`)

```bash
# Set up credentials
cp .env.example .env
# Edit .env with your App ID and Secret

# Login (opens browser)
meta-ads auth login

# Check status
meta-ads auth status

# Generate login URL (headless environments)
meta-ads auth login-link

# Refresh for long-lived token
meta-ads auth refresh-token
```

Token storage: OS keychain via `keytar`, fallback to `~/.config/meta-ads-cli/token-cache.json`.

## Global Options

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview API requests without executing |
| `--read-only` | Block all POST/DELETE requests |
| `--api-version <version>` | Graph API version (default: `v24.0`) |
| `-V, --version` | Show CLI version |

## Output Formats

All commands support `-o, --output <format>`:

| Format | Description |
|--------|-------------|
| `json` | Pretty-printed JSON (default) |
| `table` | Columnar table with headers |
| `csv` | CSV with proper escaping |
| `text` | Key-value pairs |
| `yaml` | YAML document |

```bash
meta-ads campaigns list --account-id act_123 -o table
meta-ads insights get 12345 -o csv > report.csv
```

## Commands

### Core CRUD

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `auth` | login, logout, status, setup, login-link, refresh-token | Authentication management |
| `accounts` | list, get | Ad account management |
| `campaigns` | list, get, create, update, delete | Campaign CRUD |
| `adsets` | list, get, create, update, delete | Ad set CRUD |
| `ads` | list, get, create, update, delete | Ad CRUD |
| `creatives` | list, get, get-for-ad, create-image, create-video, update, upload-image, upload-video, save-image | Creative management |
| `insights` | get, account, video | Performance metrics |

### Targeting & Audiences

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `targeting` | search-interests, suggest-interests, search-behaviors, search-demographics, search-geo, estimate-audience | Audience research |
| `audiences` | list, get, create-custom, create-lookalike, update, overlap, delete | Audience management |
| `retargeting` | website-behavior, video-engagement, app-event, product, funnel, dynamic-campaign, frequency-optimization | Retargeting strategies |
| `pixels` | list, create, events | Pixel management |

### Pages, Leads & E-commerce

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `pages` | list, search | Facebook Page management |
| `leads` | forms, get, create-form, export, quality, webhooks | Lead generation |
| `catalog` | list, get, products, product-sets, create, create-product-set, upload-feed, dynamic-template, collection-ad, product-performance | Product catalog |
| `instagram` | sync-catalog, create-shopping-ad, profile, shopping-insights | Instagram Shopping |

### Bidding & Budget

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `bidding` | validate, analyze, learning-phase, budget-schedule, seasonal-schedule, competitor-analysis, optimize-budget, recommendations, auto-adjustments, cross-campaign-coordination, scaling-recommendation | Bid strategy management |

### Operations

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `duplicate` | campaign, adset, ad, creative | Duplication with modifications |
| `bulk` | create-campaigns, update-status, analyze, upload-creatives | Batch operations |

### Analytics & Intelligence

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `library` | search, page-ads, batch-search | Ads Library search |
| `analytics` | trends, creative-fatigue, competitive-intel, report, optimization-insights | Advanced analytics |
| `ai` | score, anomalies, recommendations, export-dataset | AI-powered insights |
| `ab-test` | create, analyze | A/B testing |

### Tracking & Monitoring

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `conversions` | send-event, custom-conversions, create-custom, setup-tracking, validate-setup | Server-side tracking |
| `monitor` | check, auto-pause, dashboard | Performance monitoring |

### Workflows

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `workflow` | campaign-health, full-audit, launch-campaign, duplicate-and-test | Multi-step workflows |

### Utilities

| Command | Description |
|---------|-------------|
| `schema [service] [operation]` | API endpoint introspection |
| `generate-skills` | Generate SKILL.md files for AI agents |
| `setup` | Interactive configuration wizard |

## Pagination

```bash
# Fetch all pages
meta-ads campaigns list --account-id act_123 --all

# Limit pages
meta-ads ads list --account-id act_123 --all --page-limit 5

# Delay between pages (rate limit safety)
meta-ads ads list --account-id act_123 --all --page-delay 500
```

## Dry Run

Preview any API request without executing it:

```bash
meta-ads campaigns create --account-id act_123 --name "Test" --objective OUTCOME_TRAFFIC --dry-run
# [dry-run] POST https://graph.facebook.com/v24.0/act_123/campaigns
# [dry-run] Body: {"name":"Test","objective":"OUTCOME_TRAFFIC",...}
```

## Workflows

Combine multiple API calls in a single command:

```bash
# Full campaign health check (details + insights + adsets + ads)
meta-ads workflow campaign-health 12345

# Full account audit with recommendations
meta-ads workflow full-audit --account-id act_123

# Launch campaign + adset + ad in one step
meta-ads workflow launch-campaign \
  --account-id act_123 \
  --name "My Campaign" \
  --objective OUTCOME_TRAFFIC \
  --daily-budget 5000 \
  --creative-id 67890

# Duplicate and set up A/B test
meta-ads workflow duplicate-and-test 12345 --variant-strategy COST_CAP
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `META_ADS_CLI_APP_ID` | Meta App ID | For OAuth |
| `META_ADS_CLI_APP_SECRET` | Meta App Secret | For long-lived tokens |
| `META_ADS_CLI_ACCESS_TOKEN` | Direct access token | Alternative to OAuth |
| `META_ADS_CLI_ACCOUNT_ID` | Default ad account ID | Optional |
| `META_ADS_CLI_API_VERSION` | Graph API version | Optional (default: v24.0) |
| `META_ADS_CLI_LOG_LEVEL` | Log level (debug/info/warn/error/none) | Optional |
| `META_ADS_CLI_LOG_FILE` | Log file path (daily rotation) | Optional |

Alternate names: `META_ACCESS_TOKEN`, `META_APP_ID`, `META_APP_SECRET` are also accepted.

## Environment Compatibility

The CLI accepts common Meta Ads environment variables (`META_ACCESS_TOKEN`, `META_APP_ID`, `META_APP_SECRET`) alongside its own `META_ADS_CLI_*` variants, making it easy to integrate into existing workflows.

## Architecture

```
src/
├── index.ts           # Entry point, command registration, pre-action hooks
├── auth.ts            # Meta OAuth, token cache (keytar + file fallback)
├── meta-client.ts     # Graph API client (retry, pagination, dry-run, read-only, upload)
├── formatter.ts       # Output formatting (json, table, csv, text, yaml)
├── errors.ts          # handleErrors() wrapper
├── logger.ts          # Structured JSON logging with daily rotation
├── validate.ts        # Input validation (paths, control chars, IDs)
├── mime.ts            # MIME type detection for uploads
└── commands/          # 27 command modules
    ├── auth.ts        # 7 subcommands
    ├── accounts.ts    # 3 subcommands
    ├── campaigns.ts   # 6 subcommands
    ├── adsets.ts      # 6 subcommands
    ├── ads.ts         # 6 subcommands
    ├── creatives.ts   # 10 subcommands
    ├── insights.ts    # 4 subcommands
    ├── targeting.ts   # 7 subcommands
    ├── audiences.ts   # 8 subcommands (+ pixels: 4)
    ├── retargeting.ts # 8 subcommands
    ├── pages.ts       # 3 subcommands
    ├── leads.ts       # 7 subcommands
    ├── catalog.ts     # 11 subcommands
    ├── instagram.ts   # 5 subcommands
    ├── bidding.ts     # 12 subcommands
    ├── duplication.ts # 5 subcommands
    ├── bulk.ts        # 5 subcommands
    ├── ads-library.ts # 4 subcommands
    ├── analytics.ts   # 6 subcommands
    ├── ai.ts          # 5 subcommands
    ├── ab-testing.ts  # 3 subcommands
    ├── conversions.ts # 6 subcommands
    ├── monitoring.ts  # 4 subcommands
    ├── workflows.ts   # 5 subcommands
    ├── schema.ts      # API introspection
    ├── generate-skills.ts
    └── setup.ts       # Interactive wizard
```

**Key patterns:**
- Commander.js with lazy-initialized singletons
- Pre-action hooks for auth (skip for auth/setup/schema)
- Dependency injection (`getClient()` callbacks)
- `handleErrors()` wrapper on all actions
- Retry with exponential backoff (429/5xx)
- Cursor-based pagination via `paging.cursors.after`

## Development

```bash
# Install
npm install

# Dev mode (no build needed)
npm run dev -- campaigns list --account-id act_123 --dry-run

# Build
npm run build

# Run built CLI
node dist/index.js --help
```

**Build:** `tsup` (esbuild) → `dist/index.js` (ESM, shebang banner, ~194KB)

## License

CC-BY-NC-4.0
