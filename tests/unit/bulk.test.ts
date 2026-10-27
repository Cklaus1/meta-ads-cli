import { describe, it, expect } from 'vitest';
import { registerBulkCommands, parseIntOption } from '../../src/commands/bulk.js';
import { mockClient, run } from './command-helpers.js';

describe('parseIntOption', () => {
  it('accepts integers at or above the minimum', () => {
    expect(parseIntOption('5', '--batch-size', 1)).toBe(5);
    expect(parseIntOption('0', '--delay-ms', 0)).toBe(0);
  });
  it.each(['0', 'abc', '1.5', '', '-1'])('rejects %j for a minimum of 1', (v) => {
    expect(() => parseIntOption(v, '--batch-size', 1)).toThrow('--batch-size must be an integer >= 1');
  });
});

describe('bulk create-campaigns', () => {
  const config = JSON.stringify([{ name: 'a' }, { name: 'b' }]);

  it.each(['0', 'abc'])('--batch-size %s exits with a validation error and makes no requests', async (size) => {
    const { client, request } = mockClient(async () => ({ data: { id: '1' }, status: 200 }));
    await expect(run(registerBulkCommands, client, [
      'bulk', 'create-campaigns', '--account-id', 'act_1', '--config', config, '--batch-size', size,
    ])).rejects.toThrow('--batch-size must be an integer >= 1');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a negative --delay-ms', async () => {
    const { client } = mockClient(async () => ({ data: { id: '1' }, status: 200 }));
    await expect(run(registerBulkCommands, client, [
      'bulk', 'create-campaigns', '--account-id', 'act_1', '--config', config, '--delay-ms', '-5',
    ])).rejects.toThrow('--delay-ms must be an integer >= 0');
  });

  it('creates every config with valid options', async () => {
    const { client, request } = mockClient(async () => ({ data: { id: '1' }, status: 200 }));
    const { stdout } = await run(registerBulkCommands, client, [
      'bulk', 'create-campaigns', '--account-id', 'act_1', '--config', config, '--batch-size', '1', '--delay-ms', '0',
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(stdout).created).toBe(2);
  });
});
