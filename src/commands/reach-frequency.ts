import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerReachFrequencyCommands(program: Command, getClient: () => MetaClient): void {
  const rf = program.command('reach-frequency').alias('rf').description('Reach & Frequency: reserved buying and media planning');

  rf
    .command('predict')
    .description('Create a reach & frequency prediction for media planning')
    .requiredOption('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .requiredOption('--objective <objective>', 'Campaign objective')
    .requiredOption('--start-time <timestamp>', 'Campaign start (Unix timestamp)')
    .requiredOption('--end-time <timestamp>', 'Campaign end (Unix timestamp)')
    .requiredOption('--budget <cents>', 'Total budget in cents')
    .requiredOption('--targeting <json>', 'Targeting spec as JSON')
    .option('--frequency-cap <n>', 'Max frequency per user')
    .option('--prediction-mode <mode>', 'Mode: REACH, BUDGET', 'REACH')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const body: Record<string, string> = {
        objective: opts.objective,
        start_time: opts.startTime,
        stop_time: opts.endTime,
        budget: opts.budget,
        targeting_spec: opts.targeting,
        prediction_mode: opts.predictionMode,
      };
      if (opts.frequencyCap) body.frequency_cap = opts.frequencyCap;

      const response = await client.request(`${opts.accountId}/reachfrequencypredictions`, {
        method: 'POST',
        body,
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  rf
    .command('get <predictionId>')
    .description('Get a reach & frequency prediction result')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (predictionId: string, opts) => {
      const client = getClient();
      const response = await client.request(predictionId, {
        params: { fields: 'id,status,prediction_progress,curve_budget_reach,external_reach,external_budget,external_impression,frequency_cap,target_spec,time_created' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  rf
    .command('list')
    .description('List reach & frequency predictions for an account')
    .option('--account-id <id>', 'Ad account ID (act_XXX)', getDefaultAccountId())
    .option('--limit <n>', 'Maximum results', '10')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      if (!opts.accountId) throw new Error('Account ID required');
      const client = getClient();
      const response = await client.request(`${opts.accountId}/reachfrequencypredictions`, {
        params: { fields: 'id,status,prediction_progress,time_created', limit: opts.limit },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  rf
    .command('reserve <predictionId>')
    .description('Reserve (book) a reach & frequency prediction as a campaign')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (predictionId: string, opts) => {
      const client = getClient();
      const response = await client.request(predictionId, {
        method: 'POST',
        body: { status: 'RESERVED' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));

  rf
    .command('cancel <predictionId>')
    .description('Cancel a reach & frequency reservation')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (predictionId: string, opts) => {
      const client = getClient();
      const response = await client.request(predictionId, {
        method: 'POST',
        body: { status: 'CANCELLED' },
      });
      console.log(formatOutput(response.data, opts.output as OutputFormat));
    }));
}
