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
import { registerPolicyCommands } from './commands/policy.js';
import { registerJournalCommands } from './commands/journal.js';
import { registerLimitsCommand } from './commands/limits.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerCompletionCommand } from './commands/completion.js';
import { registerExperimentCommands } from './commands/experiments.js';
import { registerRuleCommands } from './commands/rules.js';
import { registerPlanCommands } from './commands/plan.js';
import { applyProfile, getDefaultProfileName } from './profiles.js';
import { parseCents, validateAccountId } from './validate.js';
import { API_VERSION, assertApiVersion, type ClientOptions } from './meta-client.js';
import { CliError, ExitCode, UsageError, exitCodeFor, reportError, setErrorFormat } from './errors.js';
import { loadPolicy } from './policy.js';
import logger from './logger.js';

// Exit quietly when the reader closes the pipe early (e.g. `meta-ads ... | head`).
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
}

const program = new Command();

program
  .name('meta-ads')
  .description('Meta Ads CLI - Manage Facebook & Instagram advertising via the Graph API')
  .version('0.4.1')
  .option('--dry-run', 'Preview the API request without executing it (no API calls at all)')
  .option('--plan', 'Run reads for real but only record writes; prints the plan as JSON to stderr')
  .option('--validate', 'Send writes with validate_only so Meta checks them without applying anything')
  .option('--read-only', 'Restrict to read-only operations (block POST/DELETE)')
  .option('--max-spend-cap <cents>', 'Block any write whose budget field (daily/lifetime/spend_cap/bid) exceeds this many cents')
  .option('--allow-live', 'Confirm writes that set objects ACTIVE (when the policy blocks going live)')
  .option('--allow-delete', 'Confirm deletes/archives (when the policy blocks deletes)')
  .option('--allow-messaging', 'Confirm sending messages (when the policy blocks messaging)')
  .option('--api-version <version>', `Graph API version (default: ${API_VERSION})`)
  .option('--profile <name>', 'Use a named profile for credentials and account')
  .option('--error-format <format>', 'text (default) or json: errors as one JSON object on stderr')
  .option('--verbose', 'Print each request with its status, timing and fbtrace_id to stderr')
  // Usage errors (unknown option, missing argument) exit 2; must be set before
  // subcommands are created so they inherit it.
  .exitOverride();

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

/** Every value given for a global option, in both `--name value` and `--name=value` forms. */
function readAllArgvOptions(name: string): string[] {
  const args = process.argv.slice(2);
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === name && args[i + 1] !== undefined) values.push(args[i + 1]);
    else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
  }
  return values;
}

/** Commands that must work without the default profile (help, version, fixing profiles). */
function skipsDefaultProfile(): boolean {
  const args = process.argv.slice(2);
  if (args.some(a => ['--help', '-h', '--version', '-V'].includes(a))) return true;
  const first = args.find(a => !a.startsWith('-'));
  return first === undefined || ['profile', 'help', 'completion'].includes(first);
}

// Global flags are resolved from Commander in the preAction hook, before any
// action can construct the client.
let dryRun = false;
let readOnly = false;
let maxSpendCapCents = 0;
let apiVersion = process.env.META_ADS_CLI_API_VERSION || API_VERSION;
let clientOptions: ClientOptions = {};

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
    metaClient = new MetaClient(auth, dryRun, apiVersion, readOnly, maxSpendCapCents, clientOptions);
  }
  return metaClient;
}

function fail(err: unknown): never {
  logger.error(err instanceof Error ? err.message : String(err));
  reportError(err);
  process.exit(exitCodeFor(err));
}

async function main(): Promise<void> {
  // Error format first, so even startup errors honour it.
  setErrorFormat(readArgvOption('--error-format'));

  // A policy file that exists but is broken must stop the CLI rather than
  // silently turning the guardrails off.
  loadPolicy();

  // Apply the profile before command registration, because option defaults
  // (e.g. --account-id) read the env vars it sets. The default profile only
  // fills values not already set in the environment.
  const profileName = readArgvOption('--profile');
  if (profileName) {
    await applyProfile(profileName);
  } else if (!skipsDefaultProfile()) {
    const defaultProfile = getDefaultProfileName();
    if (defaultProfile) {
      try {
        await applyProfile(defaultProfile, { onlyUnset: true });
      } catch (err) {
        // A broken default profile mustn't lock out every command (including
        // the ones needed to fix it); warn and carry on without it.
        console.error(`Warning: default profile "${defaultProfile}" not applied: ${(err as Error).message}`);
      }
    }
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
  registerPolicyCommands(program);
  registerJournalCommands(program, getClient);
  registerLimitsCommand(program, getClient);
  registerExperimentCommands(program, getClient);
  registerRuleCommands(program, getClient);
  registerPlanCommands(program, getClient);
  registerMcpCommand(program);
  registerCompletionCommand(program);

  // Ensure auth is initialized before non-auth commands
  program.hook('preAction', async (_root, actionCommand) => {
    const globals = program.opts();
    dryRun = Boolean(globals.dryRun);
    readOnly = Boolean(globals.readOnly);
    // Read after the profile was applied, and validated so it can't carry a
    // path or query string into the base URL.
    apiVersion = assertApiVersion(globals.apiVersion || process.env.META_ADS_CLI_API_VERSION || API_VERSION);
    // Every --max-spend-cap occurrence counts and the lowest wins, so a later
    // (e.g. injected) occurrence can't raise an earlier one.
    try {
      const caps = readAllArgvOptions('--max-spend-cap').map(v => parseCents(v, '--max-spend-cap') ?? 0).filter(c => c > 0);
      maxSpendCapCents = caps.length ? Math.min(...caps) : 0;
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    // In an MCP tool subprocess, --allow-* only work if the server itself was
    // started with them (passed down via env), so tool arguments can't unlock them.
    const mcpChild = process.env.META_ADS_CLI_MCP_CHILD === '1';
    const serverAllows = new Set((process.env.META_ADS_CLI_MCP_ALLOW || '').split(',').filter(Boolean));
    const allowed = (flag: 'live' | 'delete' | 'messaging', value: unknown) => mcpChild ? serverAllows.has(flag) : Boolean(value);
    if (globals.plan && globals.dryRun) throw new UsageError('Use either --plan or --dry-run, not both');
    clientOptions = {
      plan: Boolean(globals.plan),
      validateOnly: Boolean(globals.validate),
      verbose: Boolean(globals.verbose),
      allowLive: allowed('live', globals.allowLive),
      allowDelete: allowed('delete', globals.allowDelete),
      allowMessaging: allowed('messaging', globals.allowMessaging),
    };

    // Normalize --account-id to the act_ form and reject anything else, so a
    // bad value can't be spliced into the request path.
    const accountId = actionCommand.getOptionValue('accountId');
    if (typeof accountId === 'string' && accountId) {
      try {
        actionCommand.setOptionValue('accountId', validateAccountId(accountId));
      } catch (err) {
        throw new UsageError((err as Error).message);
      }
    }

    // The hook is attached to the root program, so walk up from the command
    // that is actually running.
    const commandChain: string[] = [];
    let cmd: Command | null = actionCommand;
    while (cmd) {
      commandChain.unshift(cmd.name());
      cmd = cmd.parent;
    }

    // Skip auth initialization for commands that don't need a token, and dry-run
    const skipAuth = ['auth', 'setup', 'schema', 'generate-skills', 'profile', 'doctor', 'policy', 'journal', 'mcp', 'completion'];
    if (skipAuth.includes(commandChain[1]) && commandChain.slice(1, 3).join(' ') !== 'journal undo') return;
    if (dryRun) return;

    logger.info(`Running: meta-ads ${commandChain.slice(1).join(' ')}`);

    const auth = getAuth();
    await auth.initialize();
  });

  // --plan: print the collected writes once the command finishes.
  process.on('exit', () => {
    if (clientOptions.plan && metaClient) {
      const plan = metaClient.getPlan();
      console.error(JSON.stringify({ plan: { writes: plan, count: plan.length } }, null, 2));
    }
  });

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (typeof code === 'string' && code.startsWith('commander.')) {
      // Commander already printed its message (or the help/version text).
      const helpOrVersion = code === 'commander.helpDisplayed' || code === 'commander.version' || code === 'commander.help';
      process.exit(helpOrVersion ? (err as { exitCode?: number }).exitCode ?? 0 : ExitCode.USAGE);
    }
    throw err;
  }
}

main().catch((err) => fail(err instanceof CliError || err instanceof Error ? err : new Error(String(err))));
