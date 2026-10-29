import { describe, it, expect } from 'vitest';
import { parseIdList, mergeRetried } from '../../src/commands/targeting.js';
import { registerTargetingCommands } from '../../src/commands/targeting.js';
import { mockClient, run } from './command-helpers.js';

describe('targeting validate --ids', () => {
  it('splits typed and bare ids and rejects unknown types', () => {
    expect(parseIdList('education_majors:1, 2')).toEqual({ typed: [{ type: 'education_majors', id: '1' }], untyped: ['2'] });
    expect(() => parseIdList('bogus:1')).toThrow('Unknown targeting type');
  });

  it('lists every type a bare id is valid as', () => {
    const merged = mergeRetried(
      [{ id: '1', valid: false }],
      [{ id: '1', type: 'work_employers', valid: true, name: 'CS' }, { id: '1', type: 'education_majors', valid: true, name: 'CS' }],
      ['1'],
    );
    expect(merged[0]).toMatchObject({ id: '1', valid: true });
    expect((merged[0].matched_types as Array<{ type: string }>).map(m => m.type)).toEqual(['work_employers', 'education_majors']);
  });

  it('keeps the type Meta recognises for a bare id', () => {
    const merged = mergeRetried(
      [{ id: '1', valid: false }, { id: '2', valid: true, type: 'interests' }],
      [{ id: '1', type: 'interests', valid: false }, { id: '1', type: 'education_majors', valid: true, name: 'Computer science' }],
      ['1'],
    );
    expect(merged).toEqual([{ id: '1', type: 'education_majors', valid: true, name: 'Computer science' }, { id: '2', valid: true, type: 'interests' }]);
  });

  it('does not report a valid education major as a problem', async () => {
    const { client } = mockClient(async (_endpoint, opts) => {
      if (opts?.params?.id_list) return { data: { data: [{ id: '104076956295773', valid: false }] }, status: 200 };
      return { data: { data: [{ id: '104076956295773', type: 'education_majors', name: 'Computer science', valid: true }] }, status: 200 };
    });
    const { stdout, exitCode } = await run(registerTargetingCommands, client, ['targeting', 'validate', '--account-id', 'act_1', '--ids', '104076956295773']);
    const out = JSON.parse(stdout);
    expect(out.valid).toBe(true);
    expect(out.entries[0]).toMatchObject({ type: 'education_majors', valid: true });
    expect(exitCode).not.toBe(1);
  });

  it('still reports an id that matches no type', async () => {
    const { client } = mockClient(async () => ({ data: { data: [{ id: '9', valid: false }] }, status: 200 }));
    const { stdout } = await run(registerTargetingCommands, client, ['targeting', 'validate', '--account-id', 'act_1', '--ids', '9']);
    expect(JSON.parse(stdout).valid).toBe(false);
  });
});
