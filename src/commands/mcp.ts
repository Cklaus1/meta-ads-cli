import { Command } from 'commander';
import { spawn } from 'child_process';
import { handleErrors } from '../errors.js';
import { leafCommands, type CliCommandSchema } from './schema.js';

// Commands that are interactive, print secrets, or manage this server.
const EXCLUDED_ROOTS = new Set(['auth', 'setup', 'mcp', 'completion', 'profile', 'generate-skills', 'help']);

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: false;
  };
  command: CliCommandSchema;
}

/** MCP tool name for a command path, e.g. ["campaigns", "list"] → "campaigns_list". */
export function toolName(path: string[]): string {
  return path.join('_').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** JSON property name for an option, from its long flag: --account-id → account_id. */
export function optionProperty(flags: string): string | undefined {
  const long = flags.split(/[ ,|]+/).find(f => f.startsWith('--'));
  return long?.replace(/^--/, '').replace(/-/g, '_');
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** Build one MCP tool per runnable leaf command, filtered by an optional glob allowlist. */
export function buildTools(program: Command, allow?: string): McpTool[] {
  const patterns = allow ? allow.split(',').filter(Boolean).map(globToRegExp) : undefined;
  return leafCommands(program)
    .filter(cmd => !EXCLUDED_ROOTS.has(cmd.path[0]))
    .map(cmd => {
      const properties: Record<string, Record<string, unknown>> = {};
      const required: string[] = [];
      for (const arg of cmd.arguments) {
        properties[arg.name] = arg.variadic
          ? { type: 'array', items: { type: 'string' }, description: arg.description || `Argument <${arg.name}>` }
          : { type: 'string', description: arg.description || `Argument <${arg.name}>` };
        if (arg.required) required.push(arg.name);
      }
      for (const opt of cmd.options) {
        const prop = optionProperty(opt.flags);
        if (!prop || prop === 'output' || prop === 'help') continue;
        const schema: Record<string, unknown> = {
          type: opt.type === 'boolean' ? 'boolean' : 'string',
          description: opt.description,
        };
        if (opt.choices) schema.enum = opt.choices;
        if (opt.default !== undefined && typeof opt.default !== 'object') schema.default = opt.default;
        properties[prop] = schema;
        if (opt.required && opt.default === undefined) required.push(prop);
      }
      return {
        name: toolName(cmd.path),
        description: `${cmd.description} (meta-ads ${cmd.name})`.trim(),
        inputSchema: { type: 'object' as const, properties, required, additionalProperties: false as const },
        command: cmd,
      };
    })
    .filter(tool => !patterns || patterns.some(re => re.test(tool.name)));
}

/** Turn MCP tool arguments into CLI argv for the tool's command. */
export function toolArgv(tool: McpTool, input: Record<string, unknown>, globalArgs: string[], extra: string[]): string[] {
  const argv = [...globalArgs, ...tool.command.path];
  for (const arg of tool.command.arguments) {
    const value = input[arg.name];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) argv.push(...value.map(String));
    else argv.push(String(value));
  }
  for (const opt of tool.command.options) {
    const prop = optionProperty(opt.flags);
    if (!prop || !(prop in input)) continue;
    const value = input[prop];
    const long = opt.flags.split(/[ ,|]+/).find(f => f.startsWith('--'))!;
    if (opt.type === 'boolean') {
      if (value === true) argv.push(long);
    } else if (value !== undefined && value !== null) {
      argv.push(long, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
  return [...argv, ...extra];
}

/** Global flags to forward to every tool call, so the server's guardrails apply. */
export function forwardedGlobals(program: Command): string[] {
  const g = program.opts();
  const args: string[] = [];
  if (g.readOnly) args.push('--read-only');
  if (g.dryRun) args.push('--dry-run');
  if (g.profile) args.push('--profile', String(g.profile));
  if (g.maxSpendCap) args.push('--max-spend-cap', String(g.maxSpendCap));
  if (g.apiVersion) args.push('--api-version', String(g.apiVersion));
  return args;
}

function runCli(argv: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise(resolve => {
    // execArgv keeps loaders (e.g. tsx in dev) for the subprocess.
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...argv], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += `\nTimed out after ${Math.round(timeoutMs / 1000)}s`;
    }, timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${err.message}`, exitCode: 1 });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Run an MCP (Model Context Protocol) server over stdio, exposing CLI commands as tools')
    .option('--tools <globs>', 'Only expose tools matching these comma-separated globs (e.g. "campaigns_*,insights_*")')
    .option('--tool-timeout <seconds>', 'Per-call timeout in seconds', '600')
    .addHelpText('after', `
Each runnable command becomes a tool (campaigns list → campaigns_list) that runs
the CLI in a subprocess. Global guardrails are forwarded to every call:

  meta-ads --read-only mcp                                  # reads only
  meta-ads --max-spend-cap 5000 --profile client-a mcp      # capped, one account
  meta-ads mcp --tools "campaigns_*,adsets_*,insights_*"    # allowlist

auth, setup, profile, completion and generate-skills are never exposed.`)
    .action(handleErrors(async (opts) => {
      const timeoutMs = Number(opts.toolTimeout) * 1000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--tool-timeout must be a positive number of seconds');

      const tools = buildTools(program, opts.tools);
      if (tools.length === 0) throw new Error(`No tools match --tools "${opts.tools}"`);
      const byName = new Map(tools.map(t => [t.name, t]));
      const globals = forwardedGlobals(program);
      const supportsErrorFormat = program.options.some(o => o.long === '--error-format');

      // Imported here so normal CLI startup doesn't load the SDK.
      const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
      const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

      const server = new Server(
        { name: program.name(), version: program.version() || '0.0.0' },
        { capabilities: { tools: {} } },
      );

      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      }));

      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const tool = byName.get(request.params.name);
        if (!tool) {
          return { isError: true, content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }] };
        }
        const extra: string[] = [];
        if (tool.command.options.some(o => optionProperty(o.flags) === 'output')) extra.push('-o', 'json');
        if (supportsErrorFormat) extra.unshift('--error-format', 'json');
        const argv = toolArgv(tool, (request.params.arguments ?? {}) as Record<string, unknown>, globals, extra);
        const result = await runCli(argv, timeoutMs);
        const text = result.exitCode === 0
          ? (result.stdout || '(no output)') + (result.stderr ? `\n\n[stderr]\n${result.stderr}` : '')
          : `Exit code ${result.exitCode}\n${result.stderr}${result.stdout ? `\n\n[stdout]\n${result.stdout}` : ''}`;
        return { isError: result.exitCode !== 0, content: [{ type: 'text' as const, text }] };
      });

      await server.connect(new StdioServerTransport());
      console.error(`meta-ads MCP server ready: ${tools.length} tools${globals.length ? ` (forwarding ${globals.join(' ')})` : ''}`);
      // Keep running until the client closes stdin.
      await new Promise<void>(resolve => process.stdin.on('close', () => resolve()));
    }));
}
