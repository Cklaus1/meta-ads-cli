import { Command } from 'commander';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors } from '../errors.js';
import { loadPolicy, policyWritableByCurrentUser } from '../policy.js';

export function registerPolicyCommands(program: Command): void {
  const policy = program.command('policy').description('Guardrail policy for delegated/agent access');

  policy
    .command('show')
    .description('Show the policy in effect and whether it can be edited by the current user')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const loaded = loadPolicy();
      const writable = loaded.exists ? policyWritableByCurrentUser(loaded.path) : undefined;
      console.log(formatOutput({
        path: loaded.path || '(disabled)',
        exists: loaded.exists,
        policy: loaded.policy,
        tamper_resistant: loaded.exists ? !writable : undefined,
        note: loaded.exists && writable
          ? 'The current user can edit this file, so an agent running as this user could loosen it. '
            + 'Have another user (e.g. root) own it and make it read-only.'
          : undefined,
      }, opts.output as OutputFormat));
    }));
}
