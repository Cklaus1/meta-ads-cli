# Meta Ads CLI

A standalone command-line tool for managing Facebook, Instagram, Threads & WhatsApp advertising via the Meta Graph API. Built for both humans and AI agents.

**30 command groups | 170+ subcommands | Graph API v25.0 | Full Meta platform coverage**

## Features

- **Full campaign lifecycle** — Create, read, update, delete campaigns, ad sets, ads, and creatives
- **All Meta platforms** — Facebook, Instagram, Threads, Messenger, WhatsApp, Audience Network
- **Placement targeting** — Control exactly where ads appear across 25+ positions
- **Advantage+ support** — Unified campaign structure with automation levers
- **Audience management** — Custom audiences, lookalikes, retargeting funnels, overlap analysis
- **Performance analytics** — Insights, trends, creative fatigue detection, anomaly detection
- **AI intelligence** — Performance scoring, optimization recommendations, ML dataset export
- **Conversion tracking** — Conversions API (server-side events, batch, offline), pixels, custom conversions
- **E-commerce** — Product catalogs (full CRUD), feeds, dynamic ads, collection ads, Instagram Shopping
- **Pages management** — Posts, comments, replies, page insights, post insights
- **Instagram management** — Media, stories, reels insights, comments, account metrics
- **Threads** — Post, reply, search, insights, conversation threads
- **Lead generation** — Forms CRUD, lead export, quality analysis, webhooks
- **Bidding & budget** — Strategy validation, automated adjustments, seasonal scheduling
- **Creative management** — Clone with overrides, upload image/video, carousel support
- **Bulk operations** — Batch campaign creation, status updates, parallel analysis
- **A/B testing** — Create and analyze bid strategy experiments
- **Competitive intelligence** — Ads Library search, batch brand monitoring
- **Cross-service workflows** — Campaign health checks, full audits, one-command launches
- **Multi-format output** — JSON, table, CSV, text, YAML (`-o` flag)
- **Safety** — `--dry-run`, `--read-only`, input validation
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

# 6. Get insights with time range
meta-ads insights account --time-range last_7d

# 7. Break down by platform (Facebook, Instagram, Threads, etc.)
meta-ads insights get act_123 --level account --breakdown publisher_platform
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
| `--api-version <version>` | Graph API version (default: `v25.0`) |
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
| `campaigns` | list, get, create, update, delete | Campaign CRUD with Advantage+ fields |
| `adsets` | list, get, create, update, delete | Ad set CRUD with placement targeting |
| `ads` | list, get, create, update, delete | Ad CRUD with scheduling & review feedback |
| `creatives` | list, get, get-for-ad, create-image, create-video, clone, update, upload-image, upload-video, save-image | Creative management |
| `insights` | get, account, video | Performance metrics with time-range filtering |

### Targeting & Audiences

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `targeting` | search-interests, suggest-interests, search-behaviors, search-demographics, search-geo, estimate-audience | Audience research |
| `audiences` | list, get, create-custom, create-lookalike, update, overlap, delete | Audience management |
| `retargeting` | website-behavior, video-engagement, app-event, product, funnel, dynamic-campaign, frequency-optimization | Retargeting strategies |
| `pixels` | list, create, events | Pixel management |

### Pages & Content

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `pages` | list, get, search, posts, create-post, update-post, delete-post, comments, reply, delete-comment, insights, post-insights | Facebook Page management |
| `threads` | profile, create, list, get, replies, conversation, delete, hide-reply, insights, post-insights, search | Threads publishing & insights |
| `instagram` | sync-catalog, create-shopping-ad, profile, media, media-get, media-insights, stories, story-insights, comments, reply-comment, delete-comment, insights, shopping-insights | Instagram management |

### Leads & E-commerce

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `leads` | forms, get, create-form, update-form, delete-form, export, quality, webhooks | Lead generation |
| `catalog` | list, get, products, get-product, create-product, update-product, delete-product, feeds, create-feed, product-sets, create-product-set, upload-feed, dynamic-template, collection-ad, product-performance | Product catalog |

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
| `conversions` | send-event, send-batch, custom-conversions, create-custom, setup-tracking, validate-setup, offline-events, offline-event-sets, create-offline-set | Server-side & offline tracking |
| `monitor` | check, auto-pause, dashboard | Performance monitoring |

### Workflows & Utilities

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `workflow` | campaign-health, full-audit, launch-campaign, duplicate-and-test | Multi-step workflows |
| `schema` | (service) (operation) | API endpoint introspection |
| `generate-skills` | | Generate SKILL.md files for AI agents |
| `setup` | | Interactive configuration wizard |

## Placement Targeting

Control exactly where ads appear:

```bash
# Facebook + Instagram + Threads only
meta-ads adsets create \
  --campaign-id 123 --name "Multi-platform" \
  --optimization-goal LINK_CLICKS --billing-event IMPRESSIONS \
  --publisher-platforms facebook,instagram,threads \
  --facebook-positions feed,reels,story \
  --instagram-positions stream,reels,explore \
  --threads-positions threads_stream \
  --daily-budget 5000

# WhatsApp Status ads
meta-ads adsets create \
  --campaign-id 123 --name "WhatsApp Status" \
  --destination-type WHATSAPP \
  --publisher-platforms whatsapp \
  --whatsapp-positions status \
  --optimization-goal CONVERSATIONS --billing-event IMPRESSIONS \
  --daily-budget 5000
```

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
# [dry-run] POST https://graph.facebook.com/v25.0/act_123/campaigns
# [dry-run] Body: {"name":"Test","objective":"OUTCOME_TRAFFIC",...}
```

## Testing

```bash
# Run all tests
npm test

# Unit tests only
npm run test:unit

# Integration tests
npm run test:integration

# E2E tests
npm run test:e2e

# Watch mode
npm run test:watch
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `META_ADS_CLI_APP_ID` | Meta App ID | For OAuth |
| `META_ADS_CLI_APP_SECRET` | Meta App Secret | For long-lived tokens |
| `META_ADS_CLI_ACCESS_TOKEN` | Direct access token | Alternative to OAuth |
| `META_ADS_CLI_ACCOUNT_ID` | Default ad account ID | Optional |
| `META_ADS_CLI_API_VERSION` | Graph API version | Optional (default: v25.0) |
| `META_ADS_CLI_LOG_LEVEL` | Log level (debug/info/warn/error/none) | Optional |
| `META_ADS_CLI_LOG_FILE` | Log file path (daily rotation) | Optional |

Alternate names: `META_ACCESS_TOKEN`, `META_APP_ID`, `META_APP_SECRET` are also accepted.

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

**Build:** `tsup` (esbuild) → `dist/index.js` (ESM, shebang banner)

## License

CC-BY-NC-4.0
