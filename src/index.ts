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
import { registerBackupCommands } from './commands/backup.js';
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
import { registerDoctorCommand } from './commands/doctor.js';
import { applyProfile } from './profiles.js';
import { parseCents, validateAccountId } from './validate.js';
import { API_VERSION } from './meta-client.js';
import logger from './logger.js';

const program = new Command();

program
  .name('meta-ads')
  .description('Meta Ads CLI - Manage Facebook & Instagram advertising via the Graph API')
  .version('0.3.0')
  .option('--dry-run', 'Preview the API request without executing it')
  .option('--read-only', 'Restrict to read-only operations (block POST/DELETE)')
  .option('--max-spend-cap <cents>', 'Block any write whose budget field (daily/lifetime/spend_cap/bid) exceeds this many cents')
  .option('--api-version <version>', `Graph API version (default: ${API_VERSION})`)
  .option('--profile <name>', 'Use a named profile for credentials and account');

/**
 * Read a global option's value from argv before Commander parses it.
 * Handles both `--name value` and `--name=value`, and stops at `--`.
 */
function readArgvOption(name: string): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === name) return args[i + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

// Apply the profile before command registration, because option defaults
// (e.g. --account-id) read the env vars it sets.
const profileName = readArgvOption('--profile');
if (profileName) {
  try {
    applyProfile(profileName);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

// Global flags are resolved from Commander in the preAction hook, before any
// action can construct the client.
let dryRun = false;
let readOnly = false;
let maxSpendCapCents = 0;
let apiVersion = process.env.META_ADS_CLI_API_VERSION || API_VERSION;

// Lazy-initialized singletons
let authManager: AuthManager | null = null;
let metaClient: MetaClient | null = null;

function getAuth(): AuthManager {
  if (!authManager) {
    authManager = new AuthManager(apiVersion);
  }
  return authManager;
}

function getClient(): MetaClient {
  if (!metaClient) {
    const auth = getAuth();
    metaClient = new MetaClient(auth, dryRun, apiVersion, readOnly, maxSpendCapCents);
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
registerBackupCommands(program, getClient);

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
registerDoctorCommand(program, getAuth, getClient);

// Ensure auth is initialized before non-auth commands
program.hook('preAction', async (_root, actionCommand) => {
  const globals = program.opts();
  dryRun = Boolean(globals.dryRun);
  readOnly = Boolean(globals.readOnly);
  if (globals.apiVersion) apiVersion = globals.apiVersion;
  maxSpendCapCents = parseCents(globals.maxSpendCap, '--max-spend-cap') ?? 0;

  // Normalize --account-id to the act_ form and reject anything else, so a
  // bad value can't be spliced into the request path.
  const accountId = actionCommand.getOptionValue('accountId');
  if (typeof accountId === 'string' && accountId) {
    actionCommand.setOptionValue('accountId', validateAccountId(accountId));
  }

  // The hook is attached to the root program, so walk up from the command
  // that is actually running.
  const commandChain: string[] = [];
  let cmd: Command | null = actionCommand;
  while (cmd) {
    commandChain.unshift(cmd.name());
    cmd = cmd.parent;
  }

  // Skip auth initialization for auth/setup/schema/generate-skills commands and dry-run
  const skipAuth = ['auth', 'setup', 'schema', 'generate-skills', 'profile', 'doctor'];
  if (skipAuth.includes(commandChain[1])) return;
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
