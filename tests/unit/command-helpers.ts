import { vi } from 'vitest';
import { Command } from 'commander';
import type { MetaClient } from '../../src/meta-client.js';

export type RequestFn = (endpoint: string, options?: { method?: string; params?: Record<string, string>; body?: Record<string, string> }) => Promise<{ data: unknown; status: number }>;

/** A minimal MetaClient stand-in whose request/requestAllPages call `impl`. */
export function mockClient(impl: RequestFn, dryRun = false) {
  const request = vi.fn(impl);
  const client = {
    request,
    requestAllPages: vi.fn(impl),
    isDryRun: () => dryRun,
  };
  return { client: client as unknown as MetaClient, request, requestAllPages: client.requestAllPages };
}

/**
 * Run a command and capture stdout. handleErrors calls process.exit(1) on
 * error; that is turned into a thrown error carrying the message.
 */
export async function run(register: (p: Command, g: () => MetaClient) => void, client: MetaClient, args: string[]) {
  const program = new Command();
  program.exitOverride();
  register(program, () => client);
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  const error = vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}: ${err.join('\n')}`);
  }) as never);
  const prevExitCode = process.exitCode;
  try {
    await program.parseAsync(['node', 'meta-ads', ...args]);
    const exitCode = process.exitCode;
    return { stdout: out.join('\n'), stderr: err.join('\n'), exitCode };
  } finally {
    process.exitCode = prevExitCode;
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
}
