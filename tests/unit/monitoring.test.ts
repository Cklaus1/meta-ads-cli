import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  registerMonitoringCommands, pauseReasons, getRoas, getConversions, parseInterval, parseNotifyTarget, newAlerts, sendNotification,
} from '../../src/commands/monitoring.js';
import { mockClient, run } from './command-helpers.js';

const purchases = (n: number) => [
  { action_type: 'purchase', value: String(n) },
  { action_type: 'omni_purchase', value: String(n) },
  { action_type: 'offsite_conversion.fb_pixel_purchase', value: String(n) },
];

describe('monitoring helpers', () => {
  it('computes ROAS from revenue / spend, falling back to purchase_roas', () => {
    expect(getRoas({ spend: '100', action_values: [{ action_type: 'omni_purchase', value: '250' }] })).toBe(2.5);
    expect(getRoas({ purchase_roas: [{ action_type: 'x', value: '3' }, { action_type: 'omni_purchase', value: '0.8' }] })).toBe(0.8);
    expect(getRoas({})).toBeUndefined();
  });

  it('counts each purchase once and follows the objective', () => {
    expect(getConversions({ objective: 'OUTCOME_SALES', actions: purchases(4) })).toBe(4);
    expect(getConversions({ objective: 'OUTCOME_LEADS', actions: [{ action_type: 'lead', value: '7' }, { action_type: 'offsite_conversion.fb_pixel_lead', value: '7' }] })).toBe(7);
    expect(getConversions({ actions: [{ action_type: 'link_click', value: '9' }] }, 'link_click')).toBe(9);
  });

  it('judges ROAS only with enough delivery', () => {
    const row = { spend: '50', impressions: '5000', action_values: [{ action_type: 'omni_purchase', value: '40' }] };
    expect(pauseReasons(row, { minRoas: '1' })).toEqual(['ROAS 0.8 < 1']);
    expect(pauseReasons({ ...row, impressions: '200' }, { minRoas: '1' })).toEqual([]);
    expect(pauseReasons({ spend: '0' }, { minRoas: '1' })).toEqual([]);
  });

  it('applies CPA with a results floor, or 2× target spend with no results', () => {
    const base = { objective: 'OUTCOME_SALES', impressions: '5000' };
    expect(pauseReasons({ ...base, spend: '100', actions: purchases(2) }, { maxCpa: '20' })).toEqual([]); // below 3 results
    expect(pauseReasons({ ...base, spend: '100', actions: purchases(4) }, { maxCpa: '20' })[0]).toContain('Cost per purchase 25.00 > 20');
    expect(pauseReasons({ ...base, spend: '30', actions: [] }, { maxCpa: '20' })).toEqual([]);
    expect(pauseReasons({ ...base, spend: '45', actions: [] }, { maxCpa: '20' })[0]).toContain('No purchase results');
  });

  it('rejects non-numeric thresholds', () => {
    expect(() => pauseReasons({}, { maxSpend: 'abc' })).toThrow('--max-spend');
  });

  it('parses intervals and notify targets', () => {
    expect(parseInterval('15m')).toBe(900_000);
    expect(() => parseInterval('30s')).toThrow('at least 60s');
    expect(() => parseInterval('soon')).toThrow('--interval');
    expect(parseNotifyTarget('slack:https://hooks.slack.com/x')).toEqual({ kind: 'slack', url: 'https://hooks.slack.com/x' });
    expect(() => parseNotifyTarget('email:a@b.c')).toThrow('--notify');
  });

  it('only reports alerts that are new since the last run', () => {
    const prev = new Set(['1|ROAS 0.5 < 1']);
    expect(newAlerts(prev, [{ id: '1', name: 'a', reason: 'ROAS 0.5 < 1' }, { id: '2', name: 'b', reason: 'x' }])).toEqual([{ id: '2', name: 'b', reason: 'x' }]);
  });
});

describe('notifications', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts Slack text and reports failures without throwing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200 } as Response);
    expect(await sendNotification('slack:https://hooks.slack.com/x', { title: 'T', lines: ['• a'], data: {} })).toBe(true);
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]!.body))).toEqual({ text: '*T*\n• a' });

    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy.mockRejectedValue(new Error('down'));
    expect(await sendNotification('webhook:https://example.com/h', { title: 'T', lines: [], data: {} })).toBe(false);
  });
});

describe('monitor auto-pause', () => {
  const entities = Array.from({ length: 150 }, (_, i) => ({
    id: String(i + 1), name: `e${i + 1}`,
    // Entity 75 is still learning, so it must be skipped.
    learning_stage_info: { status: i + 1 === 75 ? 'LEARNING' : 'SUCCESS' },
  }));
  // Every 50th entity (and 75) has poor ROAS.
  const insights = entities.map(e => ({
    adset_id: e.id, spend: '50', impressions: '5000',
    action_values: [{ action_type: 'omni_purchase', value: Number(e.id) % 50 === 0 || e.id === '75' ? '25' : '150' }],
  }));

  function client(failPauseId?: string) {
    return mockClient(async (endpoint, opts) => {
      if (endpoint === 'act_1/adsets') return { data: { data: entities }, status: 200 };
      if (endpoint === 'act_1/insights') return { data: { data: insights }, status: 200 };
      if (opts?.method === 'POST') {
        if (endpoint === failPauseId) throw new Error('nope');
        return { data: { success: true }, status: 200 };
      }
      return { data: {}, status: 200 };
    });
  }

  it('uses one account insights query, defaults to last_7d, and skips learning ad sets', async () => {
    const { client: c, requestAllPages } = client();
    const { stdout } = await run(registerMonitoringCommands, c, ['monitor', 'auto-pause', '--account-id', 'act_1', '--min-roas', '1']);
    const out = JSON.parse(stdout);
    expect(out.entities_checked).toBe(150);
    expect(out.details.map((d: { id: string }) => d.id)).toEqual(['50', '100', '150']);
    expect(out.skipped_learning).toEqual(['75']);
    expect(out.date_preset).toBe('last_7d');
    const insightsCall = requestAllPages.mock.calls.find(([e]) => e === 'act_1/insights');
    expect(insightsCall?.[1]?.params).toMatchObject({ level: 'adset', date_preset: 'last_7d' });
  });

  it('keeps pausing after one failure and reports it', async () => {
    const { client: c } = client('100');
    const { stdout, exitCode } = await run(registerMonitoringCommands, c, ['monitor', 'auto-pause', '--account-id', 'act_1', '--min-roas', '1', '--confirm']);
    const out = JSON.parse(stdout);
    expect(out.paused).toEqual(['50', '150']);
    expect(out.failed).toEqual([{ id: '100', error: 'nope' }]);
    expect(exitCode).toBe(1);
  });

  it('acts on learning ad sets only with --include-learning', async () => {
    const { client: c } = client();
    const { stdout } = await run(registerMonitoringCommands, c, ['monitor', 'auto-pause', '--account-id', 'act_1', '--min-roas', '1', '--include-learning']);
    expect(JSON.parse(stdout).details.map((d: { id: string }) => d.id)).toContain('75');
  });
});

describe('monitor watch', () => {
  it('prints one JSON line per run', async () => {
    const { client: c } = mockClient(async (endpoint) => {
      if (endpoint === 'act_1/adsets') return { data: { data: [{ id: '1', name: 'a' }] }, status: 200 };
      return { data: { data: [{ adset_id: '1', spend: '100', impressions: '5000', action_values: [] }] }, status: 200 };
    });
    const { stdout } = await run(registerMonitoringCommands, c, ['monitor', 'watch', '--account-id', 'act_1', '--interval', '1m', '--min-roas', '1', '--max-runs', '1']);
    const tick = JSON.parse(stdout.trim());
    expect(tick.run).toBe(1);
    expect(tick.new_alerts[0].id).toBe('1');
  });
});

describe('monitor check', () => {
  it('alerts on --min-conversions using the objective\'s result, counted once', async () => {
    const { client: c, request } = mockClient(async () => ({
      data: { data: [{ objective: 'OUTCOME_SALES', spend: '10', impressions: '1000', actions: purchases(1) }] }, status: 200,
    }));
    const { stdout } = await run(registerMonitoringCommands, c, ['monitor', 'check', '123', '--min-conversions', '5', '--date-preset', 'yesterday']);
    const out = JSON.parse(stdout);
    expect(out.alerts[0].type).toBe('LOW_CONVERSIONS');
    expect(out.alerts[0].current).toBe(1);
    expect(request.mock.calls[0][1]?.params?.date_preset).toBe('yesterday');
  });

  it('rejects unknown date presets', async () => {
    const { client: c } = mockClient(async () => ({ data: {}, status: 200 }));
    await expect(run(registerMonitoringCommands, c, ['monitor', 'check', '1', '--date-preset', 'lastweek'])).rejects.toThrow('Unknown --date-preset');
  });
});
