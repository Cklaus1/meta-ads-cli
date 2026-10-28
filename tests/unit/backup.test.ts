import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerBackupCommands } from '../../src/commands/backup.js';
import { mockClient, run } from './command-helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
afterEach(() => { /* files are per-test */ });

function writeSnapshot(): string {
  const file = path.join(tmp, `snap-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify({
    snapshot_version: 1, exported_at: '', api_version: 'v25.0', account_id: 'act_1',
    campaigns: [{ id: 'c1', name: 'C1' }],
    adsets: [{ id: 's1', name: 'S1', campaign_id: 'c1' }, { id: 's2', name: 'S2', campaign_id: 'c1' }],
    ads: [{ id: 'a1', name: 'A1', adset_id: 's1' }, { id: 'a2', name: 'A2', adset_id: 's2' }],
    creatives: [],
  }));
  return file;
}

describe('backup restore', () => {
  it('keeps going after a failed ad set, skips its children, and still prints the id map', async () => {
    let seq = 0;
    const { client } = mockClient(async (endpoint, opts) => {
      if (endpoint === 'act_1/adsets' && opts?.body?.name === 'S2') throw new Error('Invalid targeting');
      return { data: { id: `new${++seq}` }, status: 200 };
    });
    const { stdout, exitCode } = await run(registerBackupCommands, client, ['backup', 'restore', '--file', writeSnapshot(), '--yes']);
    const out = JSON.parse(stdout);
    expect(out.id_map.campaigns.c1).toBeDefined();
    expect(out.id_map.adsets.s1).toBeDefined();
    expect(out.id_map.adsets.s2).toBeUndefined();
    expect(out.failures).toEqual([{ type: 'adset', id: 's2', error: 'Invalid targeting' }]);
    expect(out.warnings.some((w: string) => w.includes('Ad a2 skipped'))).toBe(true);
    expect(exitCode).toBe(1);
  });

  it('uses the client dry-run state instead of argv', async () => {
    const { client } = mockClient(async () => ({ data: { dryRun: true }, status: 0 }), true);
    const { stdout } = await run(registerBackupCommands, client, ['backup', 'restore', '--file', writeSnapshot()]);
    const out = JSON.parse(stdout);
    expect(out.dry_run).toBe(true);
    expect(out.created_objects).toBe(5);
  });
});

describe('backup restore resume', () => {
  it('skips ads that already exist by name in a reused ad set', async () => {
    const file = path.join(tmp, `snap-num-${Math.random()}.json`);
    fs.writeFileSync(file, JSON.stringify({
      snapshot_version: 1, exported_at: '', api_version: 'v26.0', account_id: 'act_1',
      campaigns: [{ id: '10', name: 'C1' }],
      adsets: [{ id: '11', name: 'S1', campaign_id: '10' }, { id: '12', name: 'S2', campaign_id: '10' }],
      ads: [{ id: '21', name: 'A1', adset_id: '11' }, { id: '22', name: 'A2', adset_id: '12' }],
      creatives: [],
    }));
    const { client: c2, request } = mockClient(async (endpoint, opts) => {
      if (endpoint === '31/ads') return { data: { data: [{ id: 'x', name: 'A1' }] }, status: 200 };
      if (endpoint === '32/ads') return { data: { data: [] }, status: 200 };
      return { data: { id: 'new' }, status: 200 };
    });
    const res = await run(registerBackupCommands, c2, ['backup', 'restore', '--file', file, '--yes',
      '--campaign-map', '10=30', '--adset-map', '11=31,12=32']);
    const out = JSON.parse(res.stdout);
    const adPosts = request.mock.calls.filter(([e, o]) => e === 'act_1/ads' && o?.method === 'POST').map(([, o]) => o?.body?.name);
    expect(adPosts).toEqual(['A2']);
    expect(out.warnings.some((w: string) => w.includes('A1') && w.includes('already exists'))).toBe(true);
  });
});
