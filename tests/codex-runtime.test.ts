import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { CodexComposer, detectCodexRuntime } from '../server/codex.ts';
import { BridgeError } from '../server/validation.ts';
import { codexEnvironment } from '../server/process.ts';

const flags = '--ignore-user-config --ephemeral --skip-git-repo-check --sandbox --config --color --json --output-schema --output-last-message --cd';
async function fixture(t: TestContext, config: { login?: string; loginCode?: number; versionCode?: number; help?: string; hang?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'scc-codex-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = join(directory, 'codex');
  const marker = join(directory, 'generated');
  const probeMarker = join(directory, 'probe');
  await writeFile(command, `#!${process.execPath}
const args = process.argv.slice(2);
const fs = require('node:fs');
const config = ${JSON.stringify(config)};
const operation = args.includes('--version') ? 'version' : args.includes('--help') ? 'help' : args[0] === 'login' ? 'login' : 'generate';
fs.writeFileSync(${JSON.stringify(probeMarker)}, operation);
if (operation === config.hang) { setInterval(() => {}, 1000); }
else if (operation === 'version') { console.log('codex-cli 0.154.0'); process.exitCode = config.versionCode ?? 0; }
else if (operation === 'help') { console.log(config.help ?? ${JSON.stringify(flags)}); }
else if (operation === 'login') { console.error(config.login ?? 'Logged in using ChatGPT'); process.exitCode = config.loginCode ?? 0; }
else { fs.writeFileSync(${JSON.stringify(marker)}, 'unexpected generation'); process.exitCode = 7; }
`, { mode: 0o700 });
  await chmod(command, 0o700);
  return { command, marker, probeMarker };
}

test('Codex detector requires a compatible executable and the current computer\'s ChatGPT login', async t => {
  const { command } = await fixture(t);
  const detected = await detectCodexRuntime({ command });
  assert.equal(detected.available, true);
  assert.equal(detected.authenticated, true);
  assert.equal(detected.ready, true);
  assert.equal(detected.authMethod, 'chatgpt');
  assert.equal(detected.version, '0.154.0');
  assert.equal(detected.reason, 'ready');
  assert.equal(detected.binary, command);
  const status = await new CodexComposer({ command }).status();
  assert.equal('binary' in status, false, 'HTTP status does not expose a local executable path');
  assert.equal(status.busy, false);
});

test('missing, outdated, API-key, logged-out and unknown Codex states stay distinct and never compose', async t => {
  const missing = await detectCodexRuntime({ command: join(tmpdir(), 'scc-no-such-codex', 'codex') });
  assert.equal(missing.reason, 'not-installed');
  assert.equal(missing.available, false);
  assert.equal(missing.ready, false, 'an explicit missing CODEX_BIN must not fall back to a different installation');
  const cases = [
    { config: { help: '--json --output-schema' }, reason: 'incompatible-cli' },
    { config: { versionCode: 1 }, reason: 'probe-failed' },
    { config: { login: 'Logged in using an API key: SAMPLE_REDACTED_CREDENTIAL' }, reason: 'api-key-login' },
    { config: { login: 'Not logged in', loginCode: 1 }, reason: 'not-authenticated' },
    { config: { login: 'Unrecognized authentication status' }, reason: 'probe-failed' },
  ];
  for (const { config, reason } of cases) {
    const { command, marker } = await fixture(t, config);
    const status = await detectCodexRuntime({ command });
    assert.equal(status.reason, reason);
    assert.equal(status.ready, false);
    assert.equal(status.authenticated, false);
    assert.ok(!JSON.stringify(status).includes('SAMPLE_REDACTED_CREDENTIAL'), 'no raw CLI login output escapes');
    const composer = new CodexComposer({ command });
    await assert.rejects(composer.compose(4, 'dub'), (error: BridgeError) => error.code === 'CODEX_UNAVAILABLE');
    assert.equal((await composer.status()).busy, false);
    await assert.rejects(readFile(marker), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  }
});

test('Codex probe timeouts are reported separately and stop cancels even an in-flight auth probe', async t => {
  const { command, marker, probeMarker } = await fixture(t, { hang: 'login' });
  const status = await detectCodexRuntime({ command, timeoutMs: 1500 });
  assert.equal(status.reason, 'probe-timeout');
  assert.equal(status.available, true);
  assert.equal(status.ready, false);
  const composer = new CodexComposer({ command, timeoutMs: 5000 });
  const controller = new AbortController();
  await writeFile(probeMarker, 'waiting');
  const generation = composer.compose(4, 'dub', controller.signal);
  const cancelled = assert.rejects(generation, (error: BridgeError) => error.code === 'CANCELLED');
  for (let attempts = 0; attempts < 500 && await readFile(probeMarker, 'utf8') !== 'login'; attempts++) await wait(10);
  assert.equal(await readFile(probeMarker, 'utf8'), 'login', 'wait for the actual auth probe before pressing Stop');
  controller.abort();
  await cancelled;
  await assert.rejects(readFile(marker), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('the composer does not trust a cached login after a user signs out', async t => {
  const { command } = await fixture(t);
  const composer = new CodexComposer({ command });
  assert.equal((await composer.status()).ready, true);
  const source = await readFile(command, 'utf8');
  await writeFile(command, source.replace('Logged in using ChatGPT', 'Not logged in'));
  await assert.rejects(composer.compose(4, 'dub'), (error: BridgeError) => error.code === 'CODEX_UNAVAILABLE');
  assert.equal((await composer.status()).ready, false);
});

test('cancelling one request-scoped OAuth probe does not cancel another caller\'s check', async t => {
  const { command, probeMarker } = await fixture(t, { hang: 'login' });
  const composer = new CodexComposer({ command, timeoutMs: 5000 });
  const controller = new AbortController();
  const first = composer.status(true, controller.signal);
  const cancelled = assert.rejects(first, (error: BridgeError) => error.code === 'CANCELLED');
  for (let attempts = 0; attempts < 500 && await readFile(probeMarker, 'utf8').catch(() => '') !== 'login'; attempts++) await wait(10);
  assert.equal(await readFile(probeMarker, 'utf8'), 'login');
  const source = await readFile(command, 'utf8');
  await writeFile(command, source.replace('"hang":"login"', '"hang":"none"'));
  const second = composer.status(true);
  controller.abort();
  await cancelled;
  assert.equal((await second).ready, true);
});

test('Codex subprocess environment never inherits API keys or browser/session credentials', () => {
  const environment = codexEnvironment();
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CHATGPT_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN']) {
    assert.equal(key in environment, false);
  }
});
