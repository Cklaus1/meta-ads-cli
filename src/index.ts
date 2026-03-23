import 'dotenv/config';
import { Command } from 'commander';
import { AuthManager } from './auth.js';
import { MetaClient } from './meta-client.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerAccountCommands } from './commands/accounts.js';
import { registerCampaignCommands } from './commands/campaigns.js';
import { registerAdSetCommands } from './commands/adsets.js';
import { registerAdCommands } from './commands/ads.js';
import { registerCreativeCommands } from './commands/creatives.js';
import { registerInsightCommands } from './commands/insights.js';
import { registerTargetingCommands } from './commands/targeting.js';
import { registerAudienceCommands } from './commands/audiences.js';
import { registerPageCommands } from './commands/pages.js';
import { registerLeadCommands } from './commands/leads.js';
import { registerCatalogCommands } from './commands/catalog.js';
import { registerBiddingCommands } from './commands/bidding.js';
import { registerDuplicationCommands } from './commands/duplication.js';
import { registerAdsLibraryCommands } from './commands/ads-library.js';
import { registerConversionCommands } from './commands/conversions.js';
import { registerRetargetingCommands } from './commands/retargeting.js';
import { registerAbTestingCommands } from './commands/ab-testing.js';
import { registerAnalyticsCommands } from './commands/analytics.js';
import { registerAiCommands } from './commands/ai.js';
import { registerBulkCommands } from './commands/bulk.js';
import { registerInstagramCommands } from './commands/instagram.js';
import { registerMonitoringCommands } from './commands/monitoring.js';
import { registerWorkflowCommands } from './commands/workflows.js';
import { registerSchemaCommands } from './commands/schema.js';
import { registerGenerateSkillsCommand } from './commands/generate-skills.js';
import { registerThreadsCommands } from './commands/threads.js';
import { registerBusinessCommands } from './commands/business.js';
import { registerWhatsAppCommands } from './commands/whatsapp.js';
import { registerMessengerCommands } from './commands/messenger.js';
import { registerReachFrequencyCommands } from './commands/reach-frequency.js';
import { registerBrandedContentCommands } from './commands/branded-content.js';
import { registerWebhookCommands } from './commands/webhooks.js';
import { registerSetupCommand } from './commands/setup.js';
import { registerProfileCommands } from './commands/profile.js';
import { applyProfile } from './profiles.js';
import logger from './logger.js';

const program = new Command();

program
  .name('meta-ads')
  .description('Meta Ads CLI - Manage Facebook & Instagram advertising via the Graph API')
  .version('0.2.0')
  .option('--dry-run', 'Preview the API request without executing it')
  .option('--read-only', 'Restrict to read-only operations (block POST/DELETE)')
  .option('--api-version <version>', 'Graph API version (default: v25.0)', 'v25.0')
  .option('--profile <name>', 'Use a named profile for credentials and account');

// Apply profile before anything else (sets env vars)
const profileIdx = process.argv.indexOf('--profile');
if (profileIdx !== -1 && process.argv[profileIdx + 1]) {
  applyProfile(process.argv[profileIdx + 1]);
}

// Determine flags from env or argv
const dryRun = process.argv.includes('--dry-run');
const readOnly = process.argv.includes('--read-only');

// Extract --api-version value
let apiVersion = 'v25.0';
const apiIdx = process.argv.indexOf('--api-version');
if (apiIdx !== -1 && process.argv[apiIdx + 1]) {
  apiVersion = process.argv[apiIdx + 1];
}
if (process.env.META_ADS_CLI_API_VERSION) {
  apiVersion = process.env.META_ADS_CLI_API_VERSION;
}

// Lazy-initialized singletons
let authManager: AuthManager | null = null;
let metaClient: MetaClient | null = null;

function getAuth(): AuthManager {
  if (!authManager) {
    authManager = new AuthManager();
  }
  return authManager;
}

function getClient(): MetaClient {
  if (!metaClient) {
    const auth = getAuth();
    metaClient = new MetaClient(auth, dryRun, apiVersion, readOnly);
  }
  return metaClient;
}

// Register all command modules — Core CRUD
registerAuthCommands(program, getAuth);
registerAccountCommands(program, getClient);
registerCampaignCommands(program, getClient);
registerAdSetCommands(program, getClient);
registerAdCommands(program, getClient);
registerCreativeCommands(program, getClient);
registerInsightCommands(program, getClient);

// Targeting & Audiences
registerTargetingCommands(program, getClient);
registerAudienceCommands(program, getClient);
registerRetargetingCommands(program, getClient);

// Pages & Leads
registerPageCommands(program, getClient);
registerLeadCommands(program, getClient);

// E-commerce & Instagram
registerCatalogCommands(program, getClient);
registerInstagramCommands(program, getClient);

// Bidding & Budget
registerBiddingCommands(program, getClient);

// Operations
registerDuplicationCommands(program, getClient);
registerBulkCommands(program, getClient);

// Analytics & Intelligence
registerAdsLibraryCommands(program, getClient);
registerAnalyticsCommands(program, getClient);
registerAiCommands(program, getClient);
registerAbTestingCommands(program, getClient);

// Conversion Tracking & Monitoring
registerConversionCommands(program, getClient);
registerMonitoringCommands(program, getClient);

// Cross-service workflows
registerWorkflowCommands(program, getClient);

// Threads (content publishing & insights)
registerThreadsCommands(program, getClient);

// Business Management
registerBusinessCommands(program, getClient);

// Messaging platforms
registerWhatsAppCommands(program, getClient);
registerMessengerCommands(program, getClient);

// Media planning & creator partnerships
registerReachFrequencyCommands(program, getClient);
registerBrandedContentCommands(program, getClient);

// Webhooks
registerWebhookCommands(program, getClient);

// Profiles & Utilities
registerProfileCommands(program);
registerSchemaCommands(program);
registerGenerateSkillsCommand(program);
registerSetupCommand(program, getAuth);

// Ensure auth is initialized before non-auth commands
program.hook('preAction', async (thisCommand) => {
  const commandChain: string[] = [];
  let cmd: Command | null = thisCommand;
  while (cmd) {
    commandChain.unshift(cmd.name());
    cmd = cmd.parent;
  }

  // Skip auth initialization for auth/setup/schema/generate-skills commands and dry-run
  const skipAuth = ['auth', 'setup', 'schema', 'generate-skills', 'profile'];
  if (skipAuth.some(s => commandChain.includes(s))) return;
  if (dryRun) return;

  logger.info(`Running: meta-ads ${commandChain.slice(1).join(' ')}`);

  const auth = getAuth();
  await auth.initialize();
});

program.parseAsync(process.argv).catch((err) => {
  logger.error(err.message);
  console.error('Error:', err.message);
  process.exit(1);
});
