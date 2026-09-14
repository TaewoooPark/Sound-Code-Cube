import { createApp } from './app.ts';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireCodex } from '../scripts/check-codex.ts';

try { await requireCodex(true); }
catch (error) {
  console.error(error instanceof Error ? error.message : 'Codex check failed.');
  process.exit(1);
}
const staticDirectory = process.env.SCC_SERVE_DIST === '1' ? fileURLToPath(new URL('../dist/', import.meta.url)) : undefined;
if (staticDirectory && !existsSync(`${staticDirectory}/index.html`)) {
  console.error('The release client is not built. Run npm run build before npm start.');
  process.exit(1);
}
const { app, tidal, sessions } = createApp(undefined, undefined, { staticDirectory });
const port = Number(process.env.SCC_BRIDGE_PORT) || 4318;
const server = app.listen(port, '127.0.0.1', () => {
  console.info(`Sound Code Cube${staticDirectory ? '' : ' bridge'}: http://127.0.0.1:${port}`);
  if (staticDirectory) console.info('Open this local address and press Play to compose. Ctrl+C stops the app.');
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => { server.closeAllConnections(); tidal.close(); process.exit(0); }, 4000);
  deadline.unref();
  const requests = sessions.close();
  // Revoke the native clock/OSC fence while the composer is being cancelled.
  await Promise.allSettled([requests, tidal.stop('reset')]);
  tidal.close();
  server.close(() => { clearTimeout(deadline); process.exit(0); });
  server.closeIdleConnections();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
server.once('error', error => {
  console.error(error.message);
  void sessions.close().finally(() => { tidal.close(); process.exit(1); });
});
