import { Command } from 'commander';
import fs from 'fs';
import path from 'path';

interface SkillDef {
  name: string;
  description: string;
  command: string;
  examples: string[];
}

const SKILLS: SkillDef[] = [
  {
    name: 'meta-ads-accounts',
    description: 'List and manage Meta ad accounts',
    command: 'meta-ads accounts',
    examples: ['meta-ads accounts list', 'meta-ads accounts get act_123456'],
  },
  {
    name: 'meta-ads-campaigns',
    description: 'Create, read, update, and delete Meta ad campaigns',
    command: 'meta-ads campaigns',
    examples: [
      'meta-ads campaigns list --account-id act_123',
      'meta-ads campaigns get 12345',
      'meta-ads campaigns create --account-id act_123 --name "My Campaign" --objective OUTCOME_TRAFFIC',
      'meta-ads campaigns update 12345 --status ACTIVE',
    ],
  },
  {
    name: 'meta-ads-adsets',
    description: 'Create, read, update, and delete Meta ad sets',
    command: 'meta-ads adsets',
    examples: [
      'meta-ads adsets list --account-id act_123',
      'meta-ads adsets create --account-id act_123 --campaign-id 456 --name "My AdSet" --optimization-goal LINK_CLICKS --billing-event IMPRESSIONS',
    ],
  },
  {
    name: 'meta-ads-ads',
    description: 'Create, read, update, and delete Meta ads',
    command: 'meta-ads ads',
    examples: [
      'meta-ads ads list --account-id act_123',
      'meta-ads ads create --account-id act_123 --name "My Ad" --adset-id 456 --creative-id 789',
    ],
  },
  {
    name: 'meta-ads-creatives',
    description: 'Manage ad creatives (images, videos)',
    command: 'meta-ads creatives',
    examples: [
      'meta-ads creatives list --account-id act_123',
      'meta-ads creatives create-image --account-id act_123 --image-hash abc123 --page-id 456 --link-url https://example.com --headline "Click here"',
    ],
  },
  {
    name: 'meta-ads-insights',
    description: 'Get performance analytics and reporting',
    command: 'meta-ads insights',
    examples: [
      'meta-ads insights get 12345 --time-range last_7d',
      'meta-ads insights get act_123 --level campaign --breakdown age',
      'meta-ads insights account --account-id act_123',
    ],
  },
  {
    name: 'meta-ads-targeting',
    description: 'Search interests, behaviors, demographics, and locations for audience targeting',
    command: 'meta-ads targeting',
    examples: [
      'meta-ads targeting search-interests "fitness"',
      'meta-ads targeting search-geo "New York"',
      'meta-ads targeting estimate-audience --account-id act_123 --targeting \'{"geo_locations":{"countries":["US"]}}\'',
    ],
  },
  {
    name: 'meta-ads-audiences',
    description: 'Manage custom and lookalike audiences',
    command: 'meta-ads audiences',
    examples: [
      'meta-ads audiences list --account-id act_123',
      'meta-ads audiences create-lookalike --account-id act_123 --source-audience-id 456 --countries US,GB',
    ],
  },
  {
    name: 'meta-ads-library',
    description: 'Search the Meta Ads Library for competitor ads',
    command: 'meta-ads library',
    examples: [
      'meta-ads library search --query "running shoes" --country US',
      'meta-ads library page-ads 12345 --active-status ACTIVE',
    ],
  },
  {
    name: 'meta-ads-bidding',
    description: 'Bid strategy validation and analysis',
    command: 'meta-ads bidding',
    examples: [
      'meta-ads bidding validate --bid-strategy COST_CAP --optimization-goal CONVERSIONS --billing-event IMPRESSIONS',
      'meta-ads bidding analyze 123,456,789 --time-range last_7d',
    ],
  },
  {
    name: 'meta-ads-duplicate',
    description: 'Duplicate campaigns, ad sets, and ads',
    command: 'meta-ads duplicate',
    examples: [
      'meta-ads duplicate campaign 12345 --deep-copy',
      'meta-ads duplicate adset 67890 --campaign-id 11111',
    ],
  },
  {
    name: 'meta-ads-leads',
    description: 'Manage lead forms and retrieve leads',
    command: 'meta-ads leads',
    examples: [
      'meta-ads leads forms --page-id 12345',
      'meta-ads leads get 67890 --all',
    ],
  },
  {
    name: 'meta-ads-catalog',
    description: 'Product catalog management for e-commerce',
    command: 'meta-ads catalog',
    examples: [
      'meta-ads catalog list --business-id 12345',
      'meta-ads catalog products 67890 --limit 50',
    ],
  },
  {
    name: 'meta-ads-pixels',
    description: 'Pixel and conversion tracking management',
    command: 'meta-ads pixels',
    examples: [
      'meta-ads pixels list --account-id act_123',
      'meta-ads pixels create --account-id act_123 --name "My Pixel"',
    ],
  },
  {
    name: 'meta-ads-conversions',
    description: 'Conversions API for server-side event tracking',
    command: 'meta-ads conversions',
    examples: [
      'meta-ads conversions send-event --pixel-id 123 --event-name Purchase --custom-data \'{"value":29.99,"currency":"USD"}\'',
      'meta-ads conversions validate-setup 123',
      'meta-ads conversions custom-conversions --account-id act_123',
    ],
  },
  {
    name: 'meta-ads-retargeting',
    description: 'Advanced retargeting strategies: website behavior, video engagement, funnels',
    command: 'meta-ads retargeting',
    examples: [
      'meta-ads retargeting website-behavior --account-id act_123 --pixel-id 456 --name "Cart Abandoners" --url-contains "/cart"',
      'meta-ads retargeting funnel --account-id act_123 --pixel-id 456 --funnel-name "Purchase Funnel"',
      'meta-ads retargeting dynamic-campaign --account-id act_123 --campaign-name "DPA" --product-set-id 789 --page-id 111',
    ],
  },
  {
    name: 'meta-ads-ab-test',
    description: 'A/B testing for bid strategies and creatives',
    command: 'meta-ads ab-test',
    examples: [
      'meta-ads ab-test create --account-id act_123 --name "Bid Test" --campaign-id 456 --variant-bid-strategy COST_CAP',
      'meta-ads ab-test analyze 111 222 --metrics impressions,clicks,spend,cpc,ctr',
    ],
  },
  {
    name: 'meta-ads-analytics',
    description: 'Advanced analytics: trends, creative fatigue, competitive intel',
    command: 'meta-ads analytics',
    examples: [
      'meta-ads analytics trends 12345 --days 14',
      'meta-ads analytics creative-fatigue 67890',
      'meta-ads analytics competitive-intel --page-ids 111,222,333',
    ],
  },
  {
    name: 'meta-ads-ai',
    description: 'AI-powered performance scoring, anomaly detection, and recommendations',
    command: 'meta-ads ai',
    examples: [
      'meta-ads ai score 12345 --type campaign',
      'meta-ads ai anomalies 12345 --type adset --sensitivity 0.8',
      'meta-ads ai recommendations --account-id act_123',
      'meta-ads ai export-dataset --account-id act_123 -o csv > data.csv',
    ],
  },
  {
    name: 'meta-ads-bulk',
    description: 'Bulk operations: batch campaign creation, status updates, analysis',
    command: 'meta-ads bulk',
    examples: [
      'meta-ads bulk update-status --ids 123,456,789 --status PAUSED',
      'meta-ads bulk analyze --ids 123,456,789',
    ],
  },
  {
    name: 'meta-ads-instagram',
    description: 'Instagram Shopping: catalog sync, shopping ads, profile management',
    command: 'meta-ads instagram',
    examples: [
      'meta-ads instagram sync-catalog --instagram-id 123 --catalog-id 456',
      'meta-ads instagram profile 123',
      'meta-ads instagram shopping-insights 123',
    ],
  },
  {
    name: 'meta-ads-monitor',
    description: 'Real-time performance monitoring, alerts, and auto-pause',
    command: 'meta-ads monitor',
    examples: [
      'meta-ads monitor check 12345 --max-cpc 3 --min-ctr 0.5',
      'meta-ads monitor auto-pause --account-id act_123 --max-cpc 5',
      'meta-ads monitor dashboard --account-id act_123 -o table',
    ],
  },
  {
    name: 'meta-ads-workflow',
    description: 'Cross-service workflows: health checks, audits, campaign launches',
    command: 'meta-ads workflow',
    examples: [
      'meta-ads workflow campaign-health 12345',
      'meta-ads workflow full-audit --account-id act_123',
      'meta-ads workflow launch-campaign --account-id act_123 --name "Quick" --objective OUTCOME_TRAFFIC --daily-budget 5000 --creative-id 67890',
      'meta-ads workflow duplicate-and-test 12345 --variant-strategy COST_CAP',
    ],
  },
  {
    name: 'meta-ads-shared',
    description: 'Shared patterns: authentication, output formats, pagination, global flags',
    command: 'meta-ads',
    examples: [
      'meta-ads auth login',
      'meta-ads auth status',
      'meta-ads campaigns list --account-id act_123 -o table',
      'meta-ads campaigns list --account-id act_123 --all --page-limit 5',
      'meta-ads campaigns create --account-id act_123 --name "Test" --objective OUTCOME_TRAFFIC --dry-run',
      'meta-ads schema campaigns create',
    ],
  },
];

function generateSkillMd(skill: SkillDef): string {
  return `---
name: ${skill.name}
description: ${skill.description}
---

# ${skill.name}

${skill.description}

## Usage

\`\`\`bash
${skill.examples.join('\n')}
\`\`\`

## Prerequisites

- Meta Ads CLI installed and authenticated (\`meta-ads auth login\`)
- Ad account configured via \`META_ADS_CLI_ACCOUNT_ID\` or \`--account-id\` flag

## Output Formats

All commands support \`-o\` / \`--output\` flag with: json, table, csv, text, yaml
`;
}

export function registerGenerateSkillsCommand(program: Command): void {
  program
    .command('generate-skills')
    .description('Generate SKILL.md files for Claude Code / OpenClaw agents')
    .option('--output-dir <dir>', 'Output directory for skills', './skills')
    .action((opts) => {
      const outDir = path.resolve(opts.outputDir);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }

      for (const skill of SKILLS) {
        const skillDir = path.join(outDir, skill.name);
        if (!fs.existsSync(skillDir)) {
          fs.mkdirSync(skillDir, { recursive: true });
        }

        const content = generateSkillMd(skill);
        const filePath = path.join(skillDir, 'SKILL.md');
        fs.writeFileSync(filePath, content);
        console.log(`Generated: ${filePath}`);
      }

      // Generate INDEX.md
      const indexLines = [
        '# Meta Ads CLI — Agent Skills Index',
        '',
        '| Skill | Description | Command |',
        '|-------|-------------|---------|',
      ];
      for (const skill of SKILLS) {
        indexLines.push(`| [${skill.name}](./${skill.name}/SKILL.md) | ${skill.description} | \`${skill.command}\` |`);
      }
      indexLines.push('');
      fs.writeFileSync(path.join(outDir, 'INDEX.md'), indexLines.join('\n'));
      console.log(`Generated: ${path.join(outDir, 'INDEX.md')}`);

      console.log(`\nGenerated ${SKILLS.length} skill files + INDEX.md in ${outDir}`);
    });
}
