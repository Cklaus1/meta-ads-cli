import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { MetaClient } from '../../src/meta-client.js';
import { PolicyError } from '../../src/errors.js';
import { registerBulkCommands, parseSetPairs, opHash, loadState } from '../../src/commands/bulk.js';
import { registerAbTestingCommands } from '../../src/commands/ab-testing.js';
import { registerWorkflowCommands } from '../../src/commands/workflows.js';
import { registerDuplicationCommands } from '../../src/commands/duplication.js';
import { registerBackupCommands } from '../../src/commands/backup.js';
import { registerExperimentCommands } from '../../src/commands/experiments.js';
import { registerPlanCommands, diffFields, isSubsetOf } from '../../src/commands/plan.js';
import { run, type RequestFn } from './command-helpers.js';

type Mode = { dryRun?: boolean; plan?: boolean; validate?: boolean; policy?: Record<string, unknown> };

/** A client stand-in with configurable preview modes and policy. */
function modeClient(impl: RequestFn, mode: Mode = {}) {
  const request = vi.fn(impl);
  const client = {
    request,
    requestAllPages: vi.fn(impl),
    uploadFile: vi.fn(async () => ({ data: mode.validate ? { skipped: true } : { id: 'v1' }, status: 200 })),
    isDryRun: () => Boolean(mode.dryRun),
    isPlanMode: () => Boolean(mode.plan),
    isValidateMode: () => Boolean(mode.validate),
    isPreviewMode: () => Boolean(mode.dryRun || mode.plan || mode.validate),
    getPolicy: () => mode.policy || {},
  };
  return { client: client as unknown as MetaClient, request };
}

const posts = (request: ReturnType<typeof vi.fn>) =>
  request.mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === 'POST') as Array<[string, { body: Record<string, string> }]>;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'h2-'));

afterEach(() => {
  delete process.env.META_ADS_CLI_ACCOUNT_ID;
});

describe('bulk state file (B2-06)', () => {
  it('is not written in preview modes', async () => {
    const state = path.join(tmp(), 's.json');
    const { client } = modeClient(async () => ({ data: { success: true }, status: 200 }), { dryRun: true });
    await run(registerBulkCommands, client, ['bulk', 'update', '--ids', '111,222', '--set', 'daily_budget=5000', '--delay-ms', '0', '--state-file', state]);
    expect(fs.existsSync(state)).toBe(false);
  });

  it('rejects a state file from a different operation', async () => {
    const state = path.join(tmp(), 's.json');
    const { client, request } = modeClient(async () => ({ data: { success: true }, status: 200 }));
    await run(registerBulkCommands, client, ['bulk', 'update', '--ids', '1', '--set', 'daily_budget=5000', '--delay-ms', '0', '--state-file', state]);
    expect(JSON.parse(fs.readFileSync(state, 'utf8'))).toMatchObject({ op_hash: opHash('update', { daily_budget: '5000' }), done: ['1'] });
    request.mockClear();
    await expect(run(registerBulkCommands, client, ['bulk', 'update-status', '--ids', '1', '--status', 'PAUSED', '--delay-ms', '0', '--state-file', state]))
      .rejects.toThrow('different operation');
    expect(request).not.toHaveBeenCalled();
    expect(() => loadState(state, 'other')).toThrow('different operation');
  });

  it('--set rejects keys that change how the request is handled (B2-09)', () => {
    for (const key of ['method', 'access_token', 'execution_options', 'batch']) {
      expect(() => parseSetPairs([`${key}=x`])).toThrow(`can't set "${key}"`);
    }
  });
});

describe('bulk create-campaigns under an account ceiling (B2-11)', () => {
  it('creates one at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { client } = modeClient(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return { data: { id: '1' }, status: 200 };
    }, { policy: { maxAccountDailyBudgetCents: 10000 } });
    const config = JSON.stringify([1, 2, 3, 4].map(i => ({ name: `c${i}`, objective: 'OUTCOME_TRAFFIC', daily_budget: 9000 })));
    await run(registerBulkCommands, client, ['bulk', 'create-campaigns', '--account-id', 'act_1', '--config', config, '--delay-ms', '0']);
    expect(maxInFlight).toBe(1);
  });
});

describe('input shapes (B2-36)', () => {
  it('rejects non-array --images', async () => {
    const { client, request } = modeClient(async () => ({ data: {}, status: 200 }));
    await expect(run(registerBulkCommands, client, ['bulk', 'upload-creatives', '--account-id', 'act_1', '--images', '{"url":"x"}']))
      .rejects.toThrow('--images must be a JSON array');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects non-array --cells and a non-numeric --confidence-level', async () => {
    const { client } = modeClient(async () => ({ data: {}, status: 200 }));
    await expect(run(registerExperimentCommands, client, ['experiments', 'create', '--business-id', '1', '--name', 'x', '--cells', '{"name":"a"}']))
      .rejects.toThrow('--cells must be a JSON array');
    await expect(run(registerExperimentCommands, client, [
      'experiments', 'create', '--business-id', '1', '--name', 'x',
      '--cell', 'name=A;campaigns=1;pct=50', '--cell', 'name=B;campaigns=2;pct=50', '--confidence-level', 'abc',
    ])).rejects.toThrow('--confidence-level');
  });
});

describe('campaign copies (B2-08)', () => {
  it('ab-test create deep-copies both arms', async () => {
    let seq = 0;
    const { client, request } = modeClient(async (endpoint, o) => {
      if (!o?.method) return { data: { id: '9', daily_budget: '10000' }, status: 200 };
      if (endpoint.endsWith('/copies')) return { data: { copied_campaign_id: `c${++seq}` }, status: 200 };
      return { data: { success: true }, status: 200 };
    });
    await run(registerAbTestingCommands, client, ['ab-test', 'create', '--account-id', 'act_1', '--name', 'T', '--campaign-id', '9', '--variant-bid-strategy', 'COST_CAP']);
    const copies = posts(request).filter(([e]) => e === '9/copies');
    expect(copies).toHaveLength(2);
    for (const [, o] of copies) expect(o.body).toMatchObject({ deep_copy: 'true', status_option: 'PAUSED' });
  });

  it('duplicate-and-test deep-copies and uses the plain id under --plan', async () => {
    let seq = 0;
    const { client, request } = modeClient(async (endpoint, o) => {
      if (!o?.method) return { data: { daily_budget: '10000' }, status: 200 };
      if (endpoint.endsWith('/copies')) return { data: { planned: true, id: `planned_${++seq}` }, status: 0 };
      return { data: { planned: true }, status: 0 };
    }, { plan: true });
    await run(registerWorkflowCommands, client, ['workflow', 'duplicate-and-test', '9', '--variant-strategy', 'COST_CAP']);
    const writes = posts(request);
    expect(writes.filter(([e]) => e === '9/copies').every(([, o]) => o.body.deep_copy === 'true')).toBe(true);
    // Two copies plus the rename/budget update of each.
    expect(writes).toHaveLength(4);
    expect(writes.map(([e]) => e)).toEqual(expect.arrayContaining(['planned_1', 'planned_2']));
  });
});

describe('multi-step creates in preview modes (B2-19)', () => {
  const launchArgs = [
    'workflow', 'launch-campaign', '--account-id', 'act_1', '--name', 'L', '--objective', 'OUTCOME_TRAFFIC',
    '--daily-budget', '5000', '--creative-id', '77', '--countries', 'US',
  ];

  it('launch-campaign under --validate skips children of a validated-only campaign', async () => {
    const { client, request } = modeClient(async () => ({ data: { validated: true, id: 'planned_1' }, status: 200 }), { validate: true });
    const { stdout } = await run(registerWorkflowCommands, client, launchArgs);
    expect(posts(request).map(([e]) => e)).toEqual(['act_1/campaigns']);
    expect(JSON.parse(stdout).adset).toMatchObject({ skipped: true });
  });

  it('launch-campaign under --dry-run never sends "undefined" as a parent id', async () => {
    const { client, request } = modeClient(async () => ({ data: { dryRun: true }, status: 0 }), { dryRun: true });
    await run(registerWorkflowCommands, client, launchArgs);
    const bodies = posts(request).map(([, o]) => JSON.stringify(o.body));
    expect(bodies).toHaveLength(3);
    expect(bodies.join()).not.toContain('undefined');
    expect(bodies[1]).toContain('planned_campaign');
  });

  it('launch-campaign fails clearly when a real create returns no id', async () => {
    const { client, request } = modeClient(async () => ({ data: {}, status: 200 }));
    await expect(run(registerWorkflowCommands, client, launchArgs)).rejects.toThrow('returned no id');
    expect(posts(request)).toHaveLength(1);
  });

  it('apply under --validate sends no placeholder or "undefined" parent ids', async () => {
    const dir = tmp();
    const spec = path.join(dir, 'spec.json');
    fs.writeFileSync(spec, JSON.stringify({
      account: 'act_1',
      campaign: { name: 'C', objective: 'OUTCOME_TRAFFIC', daily_budget: 2000 },
      adsets: [{
        name: 'S', optimization_goal: 'LINK_CLICKS', billing_event: 'IMPRESSIONS',
        targeting: { geo_locations: { countries: ['US'] } },
        ads: [{ name: 'A', creative_id: '55' }],
      }],
    }));
    const { client, request } = modeClient(async (_e, o) => (
      o?.method ? { data: { validated: true, id: 'planned_1' }, status: 200 } : { data: { data: [] }, status: 200 }
    ), { validate: true });
    const { stdout } = await run(registerPlanCommands, client, ['apply', spec]);
    const bodies = posts(request).map(([, o]) => JSON.stringify(o.body));
    expect(bodies).toHaveLength(1);
    expect(bodies.join()).not.toMatch(/undefined|<campaign-id>/);
    expect(JSON.parse(stdout).steps.filter((s: { skipped?: boolean }) => s.skipped)).toHaveLength(2);
  });
});

describe('plan targeting convergence (B2-29)', () => {
  it('treats live targeting that is a superset of the spec as unchanged', () => {
    const desired = { targeting: JSON.stringify({ geo_locations: { countries: ['US'] }, age_min: 25 }) };
    const live = { targeting: { geo_locations: { countries: ['US'], location_types: ['home', 'recent'] }, age_min: 25, targeting_automation: { advantage_audience: 1 } } };
    expect(diffFields(desired, live, ['targeting'])).toEqual({});
    expect(Object.keys(diffFields({ targeting: JSON.stringify({ age_min: 30 }) }, live, ['targeting']))).toEqual(['targeting']);
    expect(isSubsetOf({ a: ['US'] }, { a: ['US', 'GB'] })).toBe(false);
  });
});

describe('duplicate creative (B2-35)', () => {
  it("copies into the original creative's account even when an env default is set", async () => {
    process.env.META_ADS_CLI_ACCOUNT_ID = 'act_999';
    const { client, request } = modeClient(async (_e, o) => (
      o?.method ? { data: { id: 'new' }, status: 200 } : { data: { name: 'C', account_id: '42', object_story_spec: { page_id: '1' } }, status: 200 }
    ));
    await run(registerDuplicationCommands, client, ['duplicate', 'creative', '7']);
    expect(posts(request)[0][0]).toBe('act_42/adcreatives');
  });
});

describe('backup restore policy blocks (B2-38)', () => {
  it('stops with the policy exit code and still prints what was created', async () => {
    const file = path.join(tmp(), 'snap.json');
    fs.writeFileSync(file, JSON.stringify({
      snapshot_version: 1, exported_at: '', api_version: 'v26.0', account_id: 'act_1',
      campaigns: [{ id: 'c1', name: 'C1' }, { id: 'c2', name: 'C2', daily_budget: '999999' }],
      adsets: [], ads: [], creatives: [],
    }));
    const { client, request } = modeClient(async (_e, o) => {
      if (o?.body?.name === 'C2') throw new PolicyError('Spend-cap guard: daily_budget too high');
      return { data: { id: 'new1' }, status: 200 };
    });
    await expect(run(registerBackupCommands, client, ['backup', 'restore', '--file', file, '--yes'])).rejects.toThrow('exit 7');
    expect(posts(request)).toHaveLength(2);
  });
});
