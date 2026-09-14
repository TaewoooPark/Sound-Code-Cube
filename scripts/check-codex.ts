import { detectCodexRuntime } from '../server/codex.ts';

export function requireNode(): void {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(`Node.js 22.12 or newer is required; found ${process.versions.node}.`);
  }
  if (process.platform === 'win32') {
    throw new Error('Run Sound Code Cube inside WSL on Windows. Native Windows execution is not supported.');
  }
}

export async function requireCodex(quiet = false): Promise<void> {
  requireNode();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const status = await detectCodexRuntime({ signal: controller.signal });
    if (!status.ready) throw new Error(`Codex check failed (${status.reason}). ${status.action}`);
    if (!quiet) {
      console.info(`Node.js ${process.versions.node}; Codex ${status.version ?? 'detected'}; ChatGPT OAuth ready.`);
      console.info('Sound Code Cube uses this computer’s own Codex login. No credentials are copied into the project.');
    }
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  requireCodex(process.argv.includes('--quiet')).catch(error => {
    console.error(error instanceof Error ? error.message : 'Codex check failed.');
    process.exitCode = 1;
  });
}
