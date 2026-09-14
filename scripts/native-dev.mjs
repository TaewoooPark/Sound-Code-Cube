import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = resolve(root, '.runtime');
const release = process.argv.includes('--release');
// Fail before starting SuperCollider if this computer cannot compose with its own OAuth login.
const preflight = spawnSync(process.execPath, ['--import', 'tsx', resolve(root, 'scripts/check-codex.ts'), '--quiet'], {
  cwd: root, stdio: 'inherit',
});
if (preflight.status !== 0) process.exit(preflight.status ?? 1);
if (release && !existsSync(resolve(root, 'dist/index.html'))) {
  console.error('The release client is not built. Run npm run build before npm run start:native.');
  process.exit(1);
}
const command = (name, candidates) => process.env[name] || candidates.find(path => existsSync(path)) || candidates.at(-1);
const ghci = command('GHCI_BIN', ['/opt/homebrew/opt/ghc@9.6/bin/ghci', '/usr/local/opt/ghc@9.6/bin/ghci', '/usr/local/bin/ghci', 'ghci']);
const sclang = command('SCLANG_BIN', ['/Applications/SuperCollider.app/Contents/MacOS/sclang', '/usr/local/bin/sclang', 'sclang']);
const environment = process.env.GHC_ENVIRONMENT || resolve(runtime, 'tidal.environment');
if (!existsSync(environment) || spawnSync(ghci, ['--numeric-version']).status !== 0) {
  console.error('Native Tidal is not installed. Run npm run setup:native first.');
  process.exit(1);
}

const children = [];
let closing = false;
let timeout;
async function requireFreePort(port, udp = false) {
  await new Promise((accept, reject) => {
    const socket = udp ? createSocket('udp4') : createServer();
    socket.once('error', () => reject(new Error(`Port ${port} is already in use. Stop the existing Sound Code Cube process first.`)));
    const release = () => socket.close(accept);
    if (udp) socket.bind(port, '127.0.0.1', release);
    else socket.listen(port, '127.0.0.1', release);
  });
}
try {
  for (const port of release ? [4318] : [4318, 5173]) await requireFreePort(port);
  for (const port of [57110, 57120]) await requireFreePort(port, true);
} catch (error) { console.error(error.message); process.exit(1); }

async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  clearTimeout(timeout);
  // The launcher created this local synthesis server; do not leave sound running.
  await new Promise(accept => {
    const socket = createSocket('udp4');
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* Socket not bound after an early failure. */ }
      accept();
    };
    const timer = setTimeout(finish, 250);
    socket.once('error', finish);
    socket.send(Buffer.from('/quit\0\0\0,\0\0\0'), 57110, '127.0.0.1', finish);
  });
  // Let the bridge abort detached Codex jobs before ending its process group.
  for (const child of children) {
    if (!child.pid) continue;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
  // npm may exit ahead of its grandchildren. Observe the owned groups, not just npm.
  const exits = children.map(child => new Promise(accept => {
    const probe = () => {
      try {
        if (child.pid) process.kill(-child.pid, 0);
        else { accept(); return; }
        setTimeout(probe, 50);
      } catch { accept(); }
    };
    probe();
  }));
  let forceTimer;
  await Promise.race([Promise.all(exits), new Promise(accept => { forceTimer = setTimeout(accept, 4500); })]);
  clearTimeout(forceTimer);
  for (const child of children) {
    if (!child.pid) continue;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The whole owned group already exited. */ }
  }
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown(0));

const args = [];
for (const name of ['SuperDirt', 'Vowel']) {
  const path = resolve(runtime, name);
  if (existsSync(path)) args.push('--include-path', path);
}
args.push(resolve(root, 'native/superdirt.scd'));
const synth = spawn(sclang, args, { cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
children.push(synth);
let ready = false;
let recentOutput = '';
timeout = setTimeout(() => {
  console.error('SuperDirt did not start. Check the output above.');
  void shutdown(1);
}, 60000);

synth.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  recentOutput = (recentOutput + chunk.toString()).slice(-1024);
  if (!ready && recentOutput.includes('Sound Code Cube: SuperDirt is ready')) {
    ready = true;
    clearTimeout(timeout);
    const web = spawn('npm', ['run', release ? 'start' : 'dev:browser'], {
      cwd: root, detached: true, stdio: 'inherit',
      env: { ...process.env, TIDAL_ENABLED: '1', GHCI_BIN: ghci, GHC_ENVIRONMENT: environment },
    });
    children.push(web);
    web.once('error', error => { console.error(error.message); void shutdown(1); });
    web.once('exit', code => void shutdown(code ?? 0));
  }
});
synth.stderr.on('data', chunk => process.stderr.write(chunk));
synth.once('error', error => { console.error(error.message); void shutdown(1); });
synth.once('exit', code => {
  clearTimeout(timeout);
  if (!closing) void shutdown(code ?? 1);
});
