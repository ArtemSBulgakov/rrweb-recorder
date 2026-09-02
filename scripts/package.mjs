import { mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
await rm('packages', { recursive: true, force: true });
await mkdir('packages');
for (const browser of ['chromium', 'firefox']) {
  await exec('zip', ['-qr', `../../packages/rrweb-recorder-${browser}.zip`, '.'], { cwd: `dist/${browser}` });
}
