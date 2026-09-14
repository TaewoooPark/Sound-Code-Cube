import { spawn } from 'node:child_process';
import { BridgeError } from './validation.ts';

export interface ProcessOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/** Executes a fixed executable plus argument vector; never creates a shell. */
export function runProcess(command: string, args: string[], options: ProcessOptions = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) return reject(new BridgeError(499, 'CANCELLED', 'Generation cancelled.'));
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let error: Error | undefined;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGTERM');
        else process.kill(-child.pid, 'SIGTERM');
      } catch { /* Process already exited. */ }
      hardKill = setTimeout(() => {
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else process.kill(-child.pid!, 'SIGKILL');
        } catch { /* Process already exited. */ }
      }, 1000);
      hardKill.unref();
    };
    const abort = () => { error ??= new BridgeError(499, 'CANCELLED', 'Generation cancelled.'); kill(); };
    const timeout = setTimeout(() => { error ??= new BridgeError(504, 'CODEX_TIMEOUT', 'Codex generation timed out.'); kill(); }, options.timeoutMs ?? 10000);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 1024 * 1024)) { error ??= new BridgeError(502, 'OUTPUT_LIMIT', 'Process output exceeded its limit.'); kill(); return; }
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 1024 * 1024)) { error ??= new BridgeError(502, 'OUTPUT_LIMIT', 'Process output exceeded its limit.'); kill(); return; }
      stderr += chunk.toString();
    });
    const cleanup = () => { clearTimeout(timeout); if (hardKill) clearTimeout(hardKill); options.signal?.removeEventListener('abort', abort); };
    child.once('error', cause => { cleanup(); reject(cause); });
    child.once('close', code => { cleanup(); if (error) reject(error); else resolve({ stdout, stderr, code: code ?? -1 }); });
    child.stdin.on('error', () => { /* A timed-out child may close its stdin. */ });
    child.stdin.end(options.input);
  });
}

export function codexEnvironment(): NodeJS.ProcessEnv {
  const names = ['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'LANG', 'LC_ALL', 'TERM', 'NODE_EXTRA_CA_CERTS'];
  return Object.fromEntries(names.flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
}
