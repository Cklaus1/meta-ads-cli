import { describe, it, expect } from 'vitest';
import { registerMonitoringCommands, pauseReasons, getRoas, getConversions } from '../../src/commands/monitoring.js';
import { mockClient, run } from './command-helpers.js';

describe('monitoring helpers', () => {
  it('reads purchase ROAS, preferring omni_purchase', () => {
    expect(getRoas({ purchase_roas: [{ action_type: 'x', value: '3' }, { action_type: 'omni_purchase', value: '0.8' }] })).toBe(0.8);
    expect(getRoas({})).toBeUndefined();
  });
  it('counts conversions from conversions or conversion-type actions', () => {
    expect(getConversions({ conversions: [{ value: '2' }, { value: '3' }] })).toBe(5);
    expect(getConversions({ actions: [{ action_type: 'purchase', value: '4' }, { action_type: 'link_click', value: '99' }] })).toBe(4);
  });
  it('flags low ROAS only when there was spend', () => {
    expect(pauseReasons({ spend: '10', purchase_roas: [{ action_type: 'omni_purchase', value: '0.8' }] }, { minRoas: '1' })).toEqual(['ROAS 0.8 < 1']);
    expect(pauseReasons({ spend: '0' }, { minRoas: '1' })).toEqual([]);
  });
  it('rejects non-numeric thresholds', () => {
    expect(() => pauseReasons({}, { maxSpend: 'abc' })).toThrow('--max-spend');
  });
});

describe('monitor auto-pause', () => {
  const entities = Array.from({ length: 150 }, (_, i) => ({ id: String(i + 1), name: `e${i + 1}` }));

  function client(failPauseId?: string) {
    return mockClient(async (endpoint, opts) => {
      if (endpoint === 'act_1/adsets') return { data: { data: entities }, status: 200 };
      if (endpoint.endsWith('/insights')) {
        const id = endpoint.split('/')[0];
        // Every 50th entity has a poor ROAS.
        const roas = Number(id) % 50 === 0 ? '0.5' : '2';
        return { data: { data: [{ spend: '10', purchase_roas: [{ action_type: 'omni_purchase', value: roas }] }] }, status: 200 };
      }
      if (opts?.method === 'POST') {
        if (endpoint === failPauseId) throw new Error('nope');
        return { data: { success: true }, status: 200 };
      }
      return { data: {}, status: 200 };
    });
  }

  it('checks every entity (paginated) and evaluates --min-roas', async () => {
    const { client: c, requestAllPages } = client();
    const { stdout } = await run(registerMonitoringCommands, c, ['monitor', 'auto-pause', '--account-id', 'act_1', '--min-roas', '1']);
    const out = JSON.parse(stdout);
    expect(requestAllPages).toHaveBeenCalled();
    expect(out.entities_checked).toBe(150);
    expect(out.details.map((d: { id: string }) => d.id)).toEqual(['50', '100', '150']);
    expect(out.date_preset).toBe('today');
  });

  it('keeps pausing after one failure and reports it', async () => {
    const { client: c } = client('100');
    const { stdout, exitCode } = await run(registerMonitoringCommands, c, ['monitor', 'auto-pause', '--account-id', 'act_1', '--min-roas', '1', '--confirm']);
    const out = JSON.parse(stdout);
    expect(out.paused).toEqual(['50', '150']);
    expect(out.failed).toEqual([{ id: '100', error: 'nope' }]);
    expect(exitCode).toBe(1);
  });
});

describe('monitor check', () => {
  it('alerts on --min-conversions and sends the date preset', async () => {
    const { client: c, request } = mockClient(async () => ({ data: { data: [{ conversions: [{ value: '1' }] }] }, status: 200 }));
    const { stdout } = await run(registerMonitoringCommands, c, ['monitor', 'check', '123', '--min-conversions', '5', '--date-preset', 'yesterday']);
    expect(JSON.parse(stdout).alerts[0].type).toBe('LOW_CONVERSIONS');
    expect(request.mock.calls[0][1]?.params?.date_preset).toBe('yesterday');
  });
});
