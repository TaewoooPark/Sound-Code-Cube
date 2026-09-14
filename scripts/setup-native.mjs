import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = resolve(root, '.runtime');
mkdirSync(runtime, { recursive: true });
const run = (bin, args, extraEnv = {}) => new Promise((accept, reject) => {
  const child = spawn(bin, args, { cwd: root, stdio: 'inherit', env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', ...extraEnv } });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? accept() : reject(new Error(`${bin} exited with ${code}`)));
});

try {
  if (process.platform !== 'darwin') throw new Error('Automatic native setup supports macOS/Homebrew. See README.md for other platforms.');
  if (spawnSync('brew', ['--version'], { stdio: 'ignore' }).status !== 0) throw new Error('Install Homebrew first, then run this command again.');
  const brewPrefix = spawnSync('brew', ['--prefix'], { encoding: 'utf8' }).stdout.trim();
  await run('brew', ['install', 'ghc@9.6', 'cabal-install', 'libffi']);
  if (!existsSync('/Applications/SuperCollider.app')) await run('brew', ['install', '--cask', 'supercollider']);
  for (const [name, url] of [
    ['SuperDirt', 'https://github.com/musikinformatik/SuperDirt.git'],
    ['Vowel', 'https://github.com/supercollider-quarks/Vowel.git'],
    ['Dirt-Samples', 'https://github.com/tidalcycles/Dirt-Samples.git'],
  ]) {
    if (!existsSync(resolve(runtime, name))) await run('git', ['clone', '--depth', '1', url, resolve(runtime, name)]);
  }
  await run('cabal', ['update']);
  await run('cabal', [
    'install', '--lib', 'tidal-1.10.3', `--with-compiler=${brewPrefix}/opt/ghc@9.6/bin/ghc`,
    `--package-env=${resolve(runtime, 'tidal.environment')}`,
    `--extra-include-dirs=${brewPrefix}/opt/libffi/include`,
    `--extra-lib-dirs=${brewPrefix}/opt/libffi/lib`,
  ], { CPATH: `${brewPrefix}/opt/libffi/include${process.env.CPATH ? `:${process.env.CPATH}` : ''}`,
    LIBRARY_PATH: `${brewPrefix}/opt/libffi/lib${process.env.LIBRARY_PATH ? `:${process.env.LIBRARY_PATH}` : ''}` });
  console.log('Native Tidal is installed. Run npm run dev:native.');
} catch (error) { console.error(error.message); process.exit(1); }
