# Meta Ads CLI — Agent Context

This document helps AI agents **use** the meta-ads-cli tool effectively.

## Rules of Engagement

1. **Always `--dry-run` first** for write operations (create, update, delete)
2. **Use `--read-only`** when exploring an account to prevent accidental mutations
3. **Start with `schema`** to discover available endpoints and parameters
4. **Use `-o table`** for quick overviews, `-o json` for structured data
5. **Set `META_ADS_CLI_ACCOUNT_ID`** to avoid repeating `--account-id` on every command

## Core Syntax

```
meta-ads <service> <subcommand> [args] [options]
```

### Key Flags

| Flag | Use |
|------|-----|
| `--dry-run` | Preview without executing — safe for all write ops |
| `--read-only` | Block all writes — safe for exploration |
| `-o, --output <format>` | json, table, csv, text, yaml |
| `--account-id <id>` | Target account (or set `META_ADS_CLI_ACCOUNT_ID`) |
| `--all` | Fetch all pages |
| `--limit <n>` | Limit results per page |

## Usage Patterns

### 1. Reading Data

```bash
# List accounts
meta-ads accounts list

# List campaigns (table view)
meta-ads campaigns list --account-id act_123 -o table

# Get specific campaign details
meta-ads campaigns get 12345678

# Get insights with breakdown
meta-ads insights get 12345678 --time-range last_7d --breakdown age -o csv
```

### 2. Writing Data (always dry-run first)

```bash
# Preview campaign creation
meta-ads campaigns create \
  --account-id act_123 \
  --name "Summer Sale" \
  --objective OUTCOME_SALES \
  --daily-budget 5000 \
  --dry-run

# Execute when satisfied
meta-ads campaigns create \
  --account-id act_123 \
  --name "Summer Sale" \
  --objective OUTCOME_SALES \
  --daily-budget 5000
```

### 3. Pagination

```bash
# Fetch all campaigns (auto-paginate)
meta-ads campaigns list --account-id act_123 --all

# Limit to 3 pages with delay
meta-ads campaigns list --account-id act_123 --all --page-limit 3 --page-delay 500
```

### 4. Schema Introspection

```bash
# List all services
meta-ads schema

# List operations for a service
meta-ads schema campaigns

# Get details for an operation
meta-ads schema campaigns create
```

### 5. Workflows (multi-step operations)

```bash
# Full health check for a campaign
meta-ads workflow campaign-health 12345678

# Audit entire account
meta-ads workflow full-audit --account-id act_123

# Launch campaign + adset + ad in one command
meta-ads workflow launch-campaign \
  --account-id act_123 \
  --name "Quick Launch" \
  --objective OUTCOME_TRAFFIC \
  --daily-budget 5000 \
  --creative-id 67890
```

### 6. Analytics & AI

```bash
# Performance trends
meta-ads analytics trends 12345678 --days 14

# Creative fatigue detection
meta-ads analytics creative-fatigue 12345678

# AI performance score
meta-ads ai score 12345678 --type campaign

# Anomaly detection
meta-ads ai anomalies 12345678 --type adset --sensitivity 0.8
```

### 7. Competitive Intelligence

```bash
# Search Ads Library
meta-ads library search --query "running shoes" --country US

# Batch search multiple brands
meta-ads library batch-search --brands '[{"query":"Nike"},{"query":"Adidas"}]'
```

### 8. Conversion Tracking

```bash
# Send server-side event
meta-ads conversions send-event \
  --pixel-id 123 \
  --event-name Purchase \
  --custom-data '{"value":29.99,"currency":"USD"}'

# Validate pixel setup
meta-ads conversions validate-setup 123
```

## Common Account ID Shortcut

Set once, use everywhere:

```bash
export META_ADS_CLI_ACCOUNT_ID=act_123456789

# No more --account-id needed
meta-ads campaigns list
meta-ads adsets list
meta-ads ads list
```

## Campaign Objectives (ODAX)

Use these for `--objective`:
- `OUTCOME_AWARENESS` — Brand awareness, reach
- `OUTCOME_TRAFFIC` — Website/app traffic
- `OUTCOME_ENGAGEMENT` — Post engagement, page likes
- `OUTCOME_LEADS` — Lead generation
- `OUTCOME_SALES` — Conversions, catalog sales
- `OUTCOME_APP_PROMOTION` — App installs

> Legacy objectives (BRAND_AWARENESS, LINK_CLICKS, CONVERSIONS) are not valid for new campaigns.

## Bid Strategies

Use these for `--bid-strategy`:
- `LOWEST_COST_WITHOUT_CAP` — Maximize results (default)
- `LOWEST_COST_WITH_BID_CAP` — Set max bid per action
- `COST_CAP` — Average cost per action stays near target
- `LOWEST_COST_WITH_MIN_ROAS` — Optimize for ROAS (requires target)
- `TARGET_COST` — Consistent cost at scale

## Output to Files

```bash
# Export insights as CSV
meta-ads insights get act_123 --level campaign -o csv > campaigns.csv

# Export ML dataset
meta-ads ai export-dataset --account-id act_123 -o csv > training_data.csv

# Export all leads
meta-ads leads export 12345 -o csv > leads.csv
```
