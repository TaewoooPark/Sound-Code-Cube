import express, { type Request, type Response, type NextFunction } from 'express';
import { CodexComposer } from './codex.ts';
import { TidalBridge } from './tidal.ts';
import { BridgeError, parseBpm, parseComposition, parseGenre, parseId, parseLoop, parseLoops, parseProfile, parseSeed, record } from './validation.ts';
import { sampleFile } from './samples.ts';
import { SessionManager } from './sessions.ts';

function permittedOrigin(value: string): boolean {
  if (process.env.SCC_ORIGIN && value === process.env.SCC_ORIGIN) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && ['5173', '4173', '4318'].includes(url.port) && url.pathname === '/' && !url.username && !url.password;
  } catch { return false; }
}

function parseCycle(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9) throw new BridgeError(400, 'INVALID_INPUT', 'Invalid cycle.');
  return value;
}

function requestSignal(response: Response): AbortSignal {
  const controller = new AbortController();
  response.once('close', () => { if (!response.writableEnded) controller.abort(); });
  return controller.signal;
}

export function createApp(composer = new CodexComposer(), tidal = new TidalBridge(), options: { staticDirectory?: string } = {}) {
  const app = express();
  const sessions = new SessionManager();
  async function authorizedPlayback<T>(signal: AbortSignal, fresh: boolean, operation: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new BridgeError(499, 'CANCELLED', 'Playback cancelled.');
    const status = await composer.status(fresh, signal);
    if (signal.aborted) throw new BridgeError(499, 'CANCELLED', 'Playback cancelled.');
    if (!status.ready || !status.available || !status.authenticated || status.authMethod !== 'chatgpt') {
      throw new BridgeError(503, 'CODEX_UNAVAILABLE', status.action ?? 'Sign in to the local Codex CLI with your own ChatGPT account.');
    }
    return operation();
  }
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(request.hostname)) return next(new BridgeError(403, 'LOCAL_ONLY', 'The bridge accepts local hosts only.'));
    const origin = request.get('origin');
    if ((origin && !permittedOrigin(origin)) || (!origin && request.get('sec-fetch-site') === 'cross-site')) return next(new BridgeError(403, 'LOCAL_ONLY', 'The bridge accepts local origins only.'));
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (request.method === 'OPTIONS') return response.sendStatus(204);
    if (request.method === 'POST' && !request.is('application/json')) return next(new BridgeError(415, 'JSON_REQUIRED', 'Use application/json.'));
    next();
  });
  app.use(express.json({ limit: '128kb', strict: true }));

  app.get('/api/status', async (_request, response) => {
    const [codexStatus, tidalStatus] = await Promise.all([composer.status(true, requestSignal(response)), tidal.status()]);
    response.json({ codex: codexStatus, tidal: tidalStatus });
  });

  app.get('/api/session', (_request, response) => response.json(sessions.snapshot()));

  app.post('/api/session/claim', async (request, response) => {
    const input = record(request.body);
    response.json(await sessions.claim(input, () => tidal.stop('pause')));
  });

  app.post('/api/session/stop', async (request, response) => {
    const input = record(request.body);
    if (input.action !== 'pause' && input.action !== 'reset') throw new BridgeError(400, 'INVALID_INPUT', 'Stop action must be pause or reset.');
    const action = input.action;
    response.json(await sessions.stop(input, () => tidal.stop(action)));
  });

  app.get('/api/samples/:bank/:index', async (request, response) => {
    const file = await sampleFile(request.params.bank, request.params.index);
    response.setHeader('Cache-Control', 'private, max-age=3600');
    response.type('audio/wav').sendFile(file, { dotfiles: 'allow' });
  });

  app.post('/api/compose', async (request, response) => {
    const input = record(request.body);
    const seed = parseSeed(input.seed);
    const previous = input.previous === undefined ? undefined : parseComposition(input.previous);
    const composition = await sessions.run(input, requestSignal(response), signal => composer.compose(seed, parseGenre(input.genre), signal, previous));
    if (!response.destroyed) response.json(composition);
  });

  app.post('/api/next', async (request, response) => {
    const input = record(request.body);
    const profile = parseProfile(input.profile);
    const loops = parseLoops(input.loops, 'codex', false, profile.bpm, profile);
    const id = parseId(input.id);
    const seed = parseSeed(input.seed);
    if (parseBpm(input.bpm, profile.bpm) !== profile.bpm || (input.key !== undefined && input.key !== profile.key)) throw new BridgeError(400, 'INVALID_INPUT', 'The next layer must preserve the existing profile tempo and key.');
    const loop = await sessions.run(input, requestSignal(response), signal => composer.next(loops, id, seed, profile, signal));
    if (!response.destroyed) response.json(loop);
  });

  app.post('/api/tidal/play', async (request, response) => {
    const input = record(request.body);
    const bpm = parseBpm(input.bpm, tidal.bpm);
    const loop = parseLoop(input.loop, 'codex', undefined, bpm);
    await sessions.run(input, requestSignal(response), signal => authorizedPlayback(signal, false, () => tidal.play(loop, bpm, parseCycle(input.cycle), signal)));
    response.json({ ok: true });
  });

  app.post('/api/tidal/trigger', async (request, response) => {
    const input = record(request.body);
    const bpm = parseBpm(input.bpm, tidal.bpm);
    const loop = parseLoop(input.loop, 'codex', undefined, bpm);
    const velocity = input.velocity === undefined ? 1 : input.velocity;
    if (typeof velocity !== 'number' || !Number.isFinite(velocity) || velocity < 0.05 || velocity > 1) throw new BridgeError(400, 'INVALID_INPUT', 'Trigger velocity must be 0.05–1.');
    await sessions.run(input, requestSignal(response), signal => authorizedPlayback(signal, false, () => tidal.trigger(loop, bpm, velocity, signal)));
    response.json({ ok: true });
  });

  app.post('/api/tidal/transition', async (request, response) => {
    const input = record(request.body);
    const bpm = parseBpm(input.bpm);
    const loops = parseLoops(input.loops, 'codex', true, bpm);
    const durationSeconds = input.durationSeconds === undefined ? 8 : input.durationSeconds;
    if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 20) throw new BridgeError(400, 'INVALID_INPUT', 'Transition duration must be 1–20 seconds.');
    const timing = await sessions.run(input, requestSignal(response), signal => authorizedPlayback(signal, true, () => tidal.transition(loops, bpm, durationSeconds, signal)));
    response.json({ ok: true, ...timing });
  });

  app.post('/api/tidal/transport', async (request, response) => {
    const input = record(request.body);
    if (!['start', 'pause', 'resume', 'reset'].includes(String(input.action))) throw new BridgeError(400, 'INVALID_INPUT', 'Invalid transport action.');
    const action = input.action as 'start' | 'pause' | 'resume' | 'reset';
    const bpm = parseBpm(input.bpm, tidal.bpm);
    const loops = input.loops === undefined ? undefined : parseLoops(input.loops, 'codex', action === 'start', bpm);
    if (action === 'start' && !loops) throw new BridgeError(400, 'INVALID_INPUT', 'Start requires all eight loops.');
    if (input.fullScore !== undefined && typeof input.fullScore !== 'boolean') throw new BridgeError(400, 'INVALID_INPUT', 'fullScore must be boolean.');
    const timing = await sessions.run(input, requestSignal(response), signal => {
      const execute = () => tidal.transport(action, loops, bpm, parseCycle(input.cycle), signal, input.fullScore as boolean | undefined);
      // Stopping sound must remain possible after logout, expiry, or CLI removal.
      return action === 'pause' || action === 'reset' ? execute() : authorizedPlayback(signal, true, execute);
    });
    response.json({ ok: true, ...timing });
  });

  if (options.staticDirectory) app.use(express.static(options.staticDirectory, { dotfiles: 'deny', index: 'index.html' }));
  app.use((_request, _response, next) => next(new BridgeError(404, 'NOT_FOUND', 'No such bridge endpoint.')));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent || response.destroyed) return;
    if (error instanceof BridgeError) {
      response.status(error.status).json({ error: error.code, message: error.message });
    } else if (error instanceof SyntaxError) {
      response.status(400).json({ error: 'INVALID_JSON', message: 'The request must contain valid JSON.' });
    } else if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
      response.status(413).json({ error: 'INPUT_LIMIT', message: 'The request is too large.' });
    } else {
      response.status(500).json({ error: 'BRIDGE_FAILED', message: 'The local bridge could not complete the request.' });
    }
  });
  return { app, composer, tidal, sessions };
}
