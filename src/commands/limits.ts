import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';

function getDefaultAccountId(): string {
  return process.env.META_ADS_CLI_ACCOUNT_ID || '';
}

export function registerLimitsCommand(program: Command, getClient: () => MetaClient): void {
  program
    .command('limits')
    .description('Show current Meta rate-limit usage (makes one cheap request)')
    .option('--account-id <id>', 'Ad account to check (ad account usage needs one)', getDefaultAccountId())
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const client = getClient();
      const endpoint = opts.accountId || 'me';
      await client.request(endpoint, { params: { fields: 'id' } });
      const usage = client.getUsage();
      console.log(formatOutput({
        checked: endpoint,
        peak_usage_pct: usage.peakPct,
        peak_detail: usage.detail || undefined,
        estimated_recovery_minutes: usage.estimatedRecoverSec ? Math.round(usage.estimatedRecoverSec / 60) : undefined,
        headers: client.getUsageHeaders(),
      }, opts.output as OutputFormat));
    }));
}
