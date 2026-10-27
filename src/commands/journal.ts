import { Command } from 'commander';
import { MetaClient } from '../meta-client.js';
import { formatOutput, type OutputFormat } from '../formatter.js';
import { handleErrors, UsageError } from '../errors.js';
import { journalPath, readJournal } from '../journal.js';

export function registerJournalCommands(program: Command, getClient: () => MetaClient): void {
  const journal = program.command('journal').description('Log of writes made by this CLI, with undo');

  journal
    .command('list')
    .description('Show recent writes (newest first)')
    .option('--limit <n>', 'Number of entries', '20')
    .option('--endpoint <text>', 'Only entries whose endpoint contains this text')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (opts) => {
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive integer');
      const file = journalPath();
      if (!file) {
        console.log(formatOutput({ message: 'Journal is disabled (META_ADS_CLI_NO_JOURNAL is set).' }, opts.output as OutputFormat));
        return;
      }
      let entries = readJournal().reverse();
      if (opts.endpoint) entries = entries.filter(e => e.endpoint.includes(opts.endpoint));
      console.log(formatOutput(entries.slice(0, limit), opts.output as OutputFormat));
    }));

  journal
    .command('undo <entryId>')
    .description('Restore the previous values recorded for a write')
    .option('--force', 'Undo even if the object was changed again afterwards')
    .option('-o, --output <format>', 'Output format', 'json')
    .action(handleErrors(async (entryId: string, opts) => {
      const all = readJournal();
      const index = all.findIndex(e => e.id === entryId);
      const entry = all[index];
      if (!entry) throw new UsageError(`No journal entry "${entryId}". See: meta-ads journal list`);
      if (entry.undo_of) throw new UsageError(`Entry ${entryId} is itself an undo; undo the original change instead.`);
      if (all.some(e => e.undo_of === entryId && e.status === 'ok')) {
        throw new UsageError(`Entry ${entryId} was already undone.`);
      }
      // Undoing an older change would overwrite newer edits to the same fields.
      const touched = Object.keys(entry.previous || {});
      const newer = all.slice(index + 1).find(e => e.status === 'ok' && e.endpoint === entry.endpoint
        && Object.keys(e.body || {}).some(k => touched.includes(k)));
      if (newer && !opts.force) {
        throw new UsageError(`${entry.endpoint} was changed again later (entry ${newer.id}). Undo that first, or pass --force.`);
      }
      if (entry.status !== 'ok') throw new UsageError(`Entry ${entryId} failed, so there is nothing to undo.`);
      if (!entry.previous || Object.keys(entry.previous).length === 0) {
        const hint = entry.result_id
          ? ` It created ${entry.result_id}; pause or delete that object instead.`
          : '';
        throw new UsageError(`Entry ${entryId} has no recorded previous values, so it can't be undone automatically.${hint}`);
      }
      const body: Record<string, string> = {};
      for (const [k, v] of Object.entries(entry.previous)) {
        body[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
      const client = getClient();
      const response = await client.request(entry.endpoint, { method: 'POST', body, undoOf: entryId });
      console.log(formatOutput({ undone: entryId, endpoint: entry.endpoint, restored: body, response: response.data }, opts.output as OutputFormat));
    }));
}
