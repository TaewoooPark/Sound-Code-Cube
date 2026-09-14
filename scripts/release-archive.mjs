import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid release version.');
const git = args => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'A committed Git repository is required.');
  return result.stdout.trim();
};
try {
  if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Commit the release files before creating an archive.');
  const name = `sound-code-cube-v${version}`;
  mkdirSync(resolve(root, 'release'), { recursive: true });
  const destination = resolve(root, 'release', `${name}.tar.gz`);
  git(['archive', '--format=tar.gz', `--prefix=${name}/`, `--output=${destination}`, 'HEAD']);
  console.info(destination);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
