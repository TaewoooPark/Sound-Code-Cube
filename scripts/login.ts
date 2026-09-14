import { spawn } from 'node:child_process';
import { detectCodexRuntime } from '../server/codex.ts';
import { requireNode } from './check-codex.ts';

try {
  requireNode();
  const status = await detectCodexRuntime();
  if (!status.binary || !status.available) throw new Error(status.action);
  if (status.reason === 'incompatible-cli') throw new Error(status.action);
  console.info('Opening the installed Codex CLI login. Sign in with your own ChatGPT account.');
  // Codex owns OAuth, its browser flow, and its credential store. Never read tokens here.
  // Keep the user's interactive browser/display/proxy environment for the login flow.
  const child = spawn(status.binary, ['login'], { stdio: 'inherit', env: process.env });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Codex login could not start.');
  process.exitCode = 1;
}
