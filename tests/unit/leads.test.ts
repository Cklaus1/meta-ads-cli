import { describe, it, expect } from 'vitest';
import { pivotLeads } from '../../src/commands/leads.js';
import { formatOutput } from '../../src/formatter.js';

describe('pivotLeads (BUG-09)', () => {
  const leads = [
    { id: '1', created_time: 't1', field_data: [{ name: 'email', values: ['a@b.com'] }, { name: 'full_name', values: ['Ann'] }] },
    { id: '2', created_time: 't2', field_data: [{ name: 'email', values: ['c@d.com', 'e@f.com'] }, { name: 'phone', values: ['555'] }] },
  ];

  it('turns field_data into one column per field', () => {
    const rows = pivotLeads(leads);
    expect(rows[0]).toEqual({ id: '1', created_time: 't1', email: 'a@b.com', full_name: 'Ann', phone: '' });
    expect(rows[1]).toEqual({ id: '2', created_time: 't2', email: 'c@d.com;e@f.com', full_name: '', phone: '555' });
  });

  it('keeps the answers in CSV output', () => {
    const csv = formatOutput(pivotLeads(leads), 'csv');
    expect(csv.split('\n')[0]).toContain('email');
    expect(csv).toContain('a@b.com');
    expect(csv).toContain('555');
  });

  it('does not let a field named like metadata overwrite it', () => {
    const rows = pivotLeads([{ id: '1', field_data: [{ name: 'id', values: ['x'] }] }]);
    expect(rows[0]).toEqual({ id: '1', field_id: 'x' });
  });
});
