import fs from 'fs';
import path from 'path';
import os from 'os';

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'meta-ads-cli');

/** Create a directory readable only by the current user. */
export function ensurePrivateDir(dir: string = CONFIG_DIR): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
}

/** Atomically write a file that holds credentials, with mode 0600. */
export function writePrivateFile(filePath: string, data: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}
