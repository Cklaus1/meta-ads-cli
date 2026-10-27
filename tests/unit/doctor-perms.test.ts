import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { credentialPermissionChecks } from '../../src/commands/doctor.js';

describe('credentialPermissionChecks', () => {
  it('warns about world-readable credential files and passes private ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-ads-perm-'));
    const file = path.join(dir, 'token-cache.json');
    fs.writeFileSync(file, '{}');
    fs.chmodSync(file, 0o644);
    expect(credentialPermissionChecks([file])[0]).toMatchObject({ status: 'warn' });
    fs.chmodSync(file, 0o600);
    expect(credentialPermissionChecks([file, path.join(dir, 'missing')])[0]).toMatchObject({ status: 'ok' });
  });
});
