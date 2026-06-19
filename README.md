# Meta Ads CLI

A standalone command-line tool for managing Facebook, Instagram, Threads & WhatsApp advertising via the Meta Graph API. Built for both humans and AI agents.

**37 command groups | 250+ subcommands | Graph API v25.0 | Full Meta platform coverage**

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
- **Instagram publishing** — Publish photos, Reels, carousels, stories + media insights, comments
- **Threads** — Post, reply, search, insights, conversation threads
- **Lead generation** — Forms CRUD, lead export, quality analysis, webhooks
- **Business Manager** — Ad accounts, pages, pixels, users, permissions, partner sharing
- **WhatsApp messaging** — Send text/template/media/interactive messages, template CRUD, analytics
- **Messenger** — Send messages, bot profiles, conversations, sponsored messages
- **Reach & Frequency** — Reserved buying, media planning predictions
- **Branded content** — Creator partnerships, influencer ad boosting
- **Webhooks** — Real-time notifications for leads, campaigns, messages
- **Multi-account profiles** — Named profiles for managing multiple clients/accounts
- **Bidding & budget** — Strategy validation, automated adjustments, seasonal scheduling
- **Creative management** — Clone with overrides, upload image/video, carousel support
- **Bulk operations** — Batch campaign creation, status updates, parallel analysis
- **A/B testing** — Create and analyze bid strategy experiments
- **Competitive intelligence** — Ads Library search, batch brand monitoring
- **Cross-service workflows** — Campaign health checks, full audits, one-command launches
- **Multi-format output** — JSON, table, CSV, text, YAML (`-o` flag)
- **Safety** — `--dry-run`, `--read-only`, `--max-spend-cap` budget guard, input validation
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
| `--max-spend-cap <cents>` | Block any write whose budget exceeds this ceiling (see [docs/SPENDING_CAPS.md](docs/SPENDING_CAPS.md)) |
| `--api-version <version>` | Graph API version (default: `v25.0`) |
| `--profile <name>` | Use a named profile for credentials and account |
| `-V, --version` | Show CLI version |

For limiting spend risk with delegated or automated (agent) access, see
**[docs/SPENDING_CAPS.md](docs/SPENDING_CAPS.md)**.

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
| `pages` | list, get, search, posts, create-post, update-post, delete-post, comments, reply, delete-comment, insights, post-insights, videos, upload-video, live-videos, create-live, events, create-event | Facebook Page management |
| `threads` | profile, create, list, get, replies, conversation, delete, hide-reply, insights, post-insights, search | Threads publishing & insights |
| `instagram` | publish, publish-carousel, publish-story, profile, media, media-get, media-insights, stories, story-insights, comments, reply-comment, delete-comment, insights, shopping-insights, sync-catalog, create-shopping-ad | Instagram publishing & management |

### Leads & E-commerce

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `leads` | forms, get, create-form, update-form, delete-form, export, quality, webhooks | Lead generation |
| `catalog` | list, get, products, get-product, create-product, update-product, delete-product, feeds, create-feed, product-sets, create-product-set, batch, batch-status, upload-feed, dynamic-template, collection-ad, product-performance | Product catalog & batch API |

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
| `conversions` | send-event, send-batch, send-app-event, custom-conversions, create-custom, setup-tracking, validate-setup, offline-events, offline-event-sets, create-offline-set, datasets, dataset-send | Server-side, offline & app tracking |
| `accounts` | list, get, activity | Ad accounts & audit trail |
| `monitor` | check, auto-pause, dashboard | Performance monitoring |

### Business & Messaging

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `business` | get, ad-accounts, pages, pixels, users, system-users, create-system-user, assign-ad-account, assign-page, share-ad-account, credit-lines | Business Manager |
| `whatsapp` | profile, phone-numbers, send-text, send-template, send-media, send-interactive, templates, create-template, delete-template, analytics, conversation-analytics | WhatsApp Business |
| `messenger` | send, send-template, get-profile, set-profile, conversations, messages | Messenger Platform |

### Media Planning & Creators

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `reach-frequency` | predict, get, list, reserve, cancel | Reserved buying & media planning |
| `branded-content` | eligible-sponsors, approve-creator, revoke-creator, boost-post, search-creators | Influencer partnerships |

### Webhooks

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `webhooks` | list, subscribe, unsubscribe, page-subscribe, page-unsubscribe | Real-time event notifications |

### Workflows & Utilities

| Command | Subcommands | Description |
|---------|-------------|-------------|
| `workflow` | campaign-health, full-audit, launch-campaign, duplicate-and-test | Multi-step workflows |
| `profile` | list, get, create, delete, use | Named profiles for multi-account management |
| `schema` | (service) (operation) | API endpoint introspection |
| `generate-skills` | | Generate SKILL.md files for AI agents |
| `setup` | | Interactive configuration wizard |

## Profiles (Multi-Account)

Manage multiple Meta accounts with named profiles:

```bash
# Create profiles for different clients
meta-ads profile create --name buildify --access-token EAAJ... --account-id act_698886266210181
meta-ads profile create --name kava --access-token EAAX... --account-id act_1964457533866685

# Use with any command via --profile flag
meta-ads --profile buildify campaigns list
meta-ads --profile kava insights account --time-range last_7d

# List all profiles (tokens masked)
meta-ads profile list -o table

# Show export commands for shell usage
meta-ads profile use buildify
# export META_ADS_CLI_ACCESS_TOKEN="EAAJ..."
# export META_ADS_CLI_ACCOUNT_ID="act_698886266210181"
```

Profiles stored in `~/.config/meta-ads-cli/profiles.json`.

## Organic Publishing

### Facebook Pages

```bash
# Create a text post
meta-ads pages create-post 643329395521111 --message "Hello from the CLI!"

# Share a link with text
meta-ads pages create-post 643329395521111 --message "Check this out" --link https://buildify.dev

# Schedule a post (Unix timestamp)
meta-ads pages create-post 643329395521111 --message "Coming soon" --scheduled-time 1711900800

# List and manage posts
meta-ads pages posts 643329395521111 --limit 10
meta-ads pages comments 12345_67890
meta-ads pages reply 11111 --message "Thanks!"
```

### Instagram

```bash
# Publish a photo post
meta-ads ig publish 17841473456331621 --image-url https://example.com/photo.jpg --caption "New post!"

# Publish a Reel (video)
meta-ads ig publish 17841473456331621 --video-url https://example.com/reel.mp4 --caption "Check this out"

# Publish a carousel (2-10 items)
meta-ads ig publish-carousel 17841473456331621 \
  --items '[{"image_url":"https://example.com/1.jpg"},{"image_url":"https://example.com/2.jpg"}]' \
  --caption "Swipe through!"

# Publish a story
meta-ads ig publish-story 17841473456331621 --image-url https://example.com/story.jpg
```

### Threads

```bash
# Post to Threads
meta-ads threads create --text "Hello Threads!"

# Post with image
meta-ads threads create --text "Check this out" --image-url https://example.com/image.jpg

# Reply to a thread
meta-ads threads create --text "Great point!" --reply-to 12345

# Search and explore
meta-ads threads search "buildify"
meta-ads threads replies 12345
meta-ads threads conversation 12345
```

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
