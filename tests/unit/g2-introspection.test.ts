import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import { describeCommandTree, leafCommands, registerSchemaCommands } from '../../src/commands/schema.js';
import { buildTools, toolArgv, optionProperty, forwardedGlobals } from '../../src/commands/mcp.js';
import { generateCompletion } from '../../src/commands/completion.js';
import { buildSkills } from '../../src/commands/generate-skills.js';

function makeProgram(): Command {
  const program = new Command().name('meta-ads').version('9.9.9');
  program.option('--dry-run', 'Preview').option('--read-only', 'Reads only').option('--profile <name>', 'Profile');
  const camp = program.command('campaigns').alias('camp').description('Campaign management');
  camp.command('list').description('List campaigns')
    .option('--account-id <id>', 'Ad account', 'act_1')
    .option('--all', 'All pages')
    .option('-o, --output <format>', 'Output format', 'json');
  camp.command('update <campaignId>').description('Update a campaign')
    .requiredOption('--status <status>', 'New status')
    .option('--no-hash', 'Skip hashing');
  program.command('auth').description('Auth').command('login').description('Login');
  program.command('accounts').description('Accounts').command('list').description('List accounts');
  return program;
}

afterEach(() => vi.restoreAllMocks());

describe('describeCommandTree', () => {
  it('lists every command with args and options', () => {
    const tree = describeCommandTree(makeProgram());
    const update = tree.find(c => c.name === 'campaigns update')!;
    expect(update.arguments).toEqual([{ name: 'campaignId', required: true, variadic: false, description: '' }]);
    expect(update.options.find(o => o.name === 'status')).toMatchObject({ required: true, type: 'string' });
    expect(update.options.find(o => o.flags === '--no-hash')).toMatchObject({ type: 'boolean' });
    expect(tree.find(c => c.name === 'campaigns')!.aliases).toEqual(['camp']);
    expect(leafCommands(makeProgram()).map(c => c.name)).toEqual(['campaigns list', 'campaigns update', 'auth login', 'accounts list']);
  });

  it('schema --cli prints the tree with global options', async () => {
    const program = makeProgram();
    registerSchemaCommands(program);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'meta-ads', 'schema', '--cli']);
    const out = JSON.parse(String(log.mock.calls[0][0]));
    expect(out.version).toBe('9.9.9');
    expect(out.global_options.map((o: { name: string }) => o.name)).toContain('dryRun');
    expect(out.commands.some((c: { name: string }) => c.name === 'campaigns list')).toBe(true);

    log.mockClear();
    await program.parseAsync(['node', 'meta-ads', 'schema', '--cli', 'campaigns', 'list']);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toHaveLength(1);
  });
});

describe('mcp tools', () => {
  it('builds one tool per leaf command, excluding auth', () => {
    const tools = buildTools(makeProgram());
    expect(tools.map(t => t.name)).toEqual(['campaigns_list', 'campaigns_update', 'accounts_list']);
    const update = tools.find(t => t.name === 'campaigns_update')!;
    expect(update.inputSchema.required).toEqual(['campaignId', 'status']);
    expect(update.inputSchema.properties.no_hash).toMatchObject({ type: 'boolean' });
    expect(tools.find(t => t.name === 'campaigns_list')!.inputSchema.properties.output).toBeUndefined();
  });

  it('honours the --tools allowlist', () => {
    expect(buildTools(makeProgram(), 'campaigns_*').map(t => t.name)).toEqual(['campaigns_list', 'campaigns_update']);
    expect(buildTools(makeProgram(), 'accounts_list,campaigns_update').map(t => t.name)).toEqual(['campaigns_update', 'accounts_list']);
  });

  it('turns tool input into argv', () => {
    const tool = buildTools(makeProgram()).find(t => t.name === 'campaigns_update')!;
    expect(toolArgv(tool, { campaignId: '123', status: 'PAUSED', no_hash: true }, ['--read-only'], ['-o', 'json']))
      .toEqual(['--read-only', 'campaigns', 'update', '123', '--status', 'PAUSED', '--no-hash', '-o', 'json']);
    expect(optionProperty('-o, --output <format>')).toBe('output');
  });

  it('forwards guardrail globals', () => {
    const program = makeProgram();
    program.parse(['node', 'meta-ads', '--read-only', '--profile', 'client-a', 'accounts', 'list'], { from: 'node' });
    expect(forwardedGlobals(program)).toEqual(['--read-only', '--profile', 'client-a']);
  });
});

describe('completion', () => {
  it('generates bash, zsh and fish scripts from the tree', () => {
    const program = makeProgram();
    const bash = generateCompletion(program, 'bash');
    expect(bash).toContain('"campaigns") echo "list update');
    expect(bash).toContain('complete -F _meta_ads_complete meta-ads');
    expect(generateCompletion(program, 'zsh')).toContain('bashcompinit');
    const fish = generateCompletion(program, 'fish');
    expect(fish).toContain("complete -c meta-ads -n '__fish_seen_subcommand_from campaigns' -a 'list update'");
    expect(fish).toContain('-l account-id');
  });
});

describe('generate-skills', () => {
  it('derives skills from the tree and drops stale examples', () => {
    const { skills, staleExamples } = buildSkills(makeProgram());
    const names = skills.map(s => s.name);
    expect(names).toEqual(['meta-ads-campaigns', 'meta-ads-auth', 'meta-ads-accounts', 'meta-ads-shared']);
    const campaigns = skills.find(s => s.name === 'meta-ads-campaigns')!;
    expect(campaigns.reference.map(r => r.name)).toEqual(['campaigns list', 'campaigns update']);
    // Curated "campaigns get/create" examples don't exist in this test tree.
    expect(staleExamples.some(e => e.includes('campaigns get'))).toBe(true);
    expect(campaigns.examples.every(e => !e.includes('campaigns get'))).toBe(true);
  });
});
