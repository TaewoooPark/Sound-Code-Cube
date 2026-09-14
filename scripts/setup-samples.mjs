import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = resolve(root, '.runtime');
const destination = resolve(runtime, 'Dirt-Samples');
mkdirSync(runtime, { recursive: true });
if (existsSync(destination)) {
  console.info('Dirt-Samples already exists in .runtime/Dirt-Samples; keeping your local copy.');
} else {
  console.info('Downloading Dirt-Samples from its upstream repository. Its own license applies.');
  const child = spawn('git', ['clone', '--depth', '1', 'https://github.com/tidalcycles/Dirt-Samples.git', destination], {
    cwd: root, stdio: 'inherit',
  });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => {
    process.exitCode = code ?? 1;
    if (code === 0) console.info('Samples are ready. The downloaded assets stay outside the source release.');
  });
}
