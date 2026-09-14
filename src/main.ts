import './style.css';
import { type Composition, type Loop, type GenreId } from '../shared/music';
import { GENRE_IDS } from '../shared/profiles';
import { AudioEngine } from './audio/AudioEngine';
import { WaveCube } from './visual/WaveCube';
import { CodeTerminal } from './terminal';
import { ColorControls } from './color-controls';
import { chooseGenre, commitGenre, readGenreHistory } from './music/genre-rotation';

interface BridgeStatus {
  codex: { authenticated: boolean; available: boolean; busy: boolean; ready: boolean; authMethod: string; reason: string; action: string; version: string | null };
  tidal: { enabled: boolean; available: boolean; running: boolean; reason: string | null };
}
interface Deck {
  engine: AudioEngine;
  score: Composition | null;
  active: Loop[];
  assets: { loaded: string[]; missing: string[] };
  full: boolean;
}
interface Work { revision: number; signal: AbortSignal }
interface Mix { from: Deck; to: Deck; duration: number; progress: number }

const stage = document.querySelector<HTMLElement>('#space')!;
const resetButton = document.querySelector<HTMLButtonElement>('#reset')!;
const transportButton = document.querySelector<HTMLButtonElement>('#transport')!;
const terminal = new CodeTerminal(document.querySelector('#code')!, document.querySelector('#terminal')!);
const cube = new WaveCube(stage, { onCorner: id => void hitCorner(id), onThrow: () => void requestMix() });
const colorControls = new ColorControls(settings => cube.setColorMap(settings));
const query = new URLSearchParams(location.search);
const preferredGenre = GENRE_IDS.includes(query.get('genre') as GenreId) ? query.get('genre') as GenreId : undefined;
const sessionId = crypto.randomUUID();
const HISTORY_KEY = 'sound-code-cube:genres:v1';
const genreHue: Record<GenreId, number> = {
  'deep-house': 0, techno: .125, 'uk-garage': .25, 'drum-and-bass': .375,
  'trip-hop': .5, ambient: .625, electro: .75, dub: .875,
};
let history = readGenreHistory(null);
try { history = readGenreHistory(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? 'null')); } catch { /* Optional storage. */ }
const random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
const seed = () => crypto.getRandomValues(new Uint32Array(1))[0];
function rememberGenre(genre: GenreId) {
  history = commitGenre(history, genre);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* In-memory fallback. */ }
}

let revision = 0;
let controller = new AbortController();
let wantsPlayback = false;
let ready = false;
let native = false;
let claimed = false;
let status: BridgeStatus | null = null;
let composerError: string | null = null;
let phase = 'idle';
let current = createDeck();
let prepared: Deck | null = null;
let pendingDeck: Deck | null = null;
let preparation: Promise<Deck | null> | null = null;
let preparingGenre: GenreId | null = null;
let mix: Mix | null = null;
let mixPending = false;
let throwRequested = false;
let manualHits = 0;
let transitions = 0;
let stopBarrier: Promise<void> = Promise.resolve();
let selectedGenre: GenreId;
let scoreSeed: number;

class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
function scope(): Work { return { revision, signal: controller.signal }; }
function live(work: Work): boolean { return wantsPlayback && work.revision === revision && !work.signal.aborted; }
function advanceWork(): Work {
  controller.abort();
  controller = new AbortController();
  revision++;
  return scope();
}
function cancelled(error: unknown): boolean {
  return (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof ApiError && (error.code.includes('SESSION') || error.code.includes('REVISION') || error.code.includes('EPOCH')))
    || (error instanceof ApiError && ['CANCELLED', 'STALE_SESSION', 'SESSION_SUPERSEDED', 'STALE_REVISION', 'SESSION_STOPPED'].includes(error.code));
}

async function api<T>(path: string, data: Record<string, unknown> | undefined, work: Work): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify({ ...data, sessionId, revision: work.revision }),
    signal: work.signal,
  });
  const result = await response.json();
  if (!response.ok) throw new ApiError(result.message ?? result.error ?? `Bridge returned ${response.status}`, response.status, result.error ?? 'BRIDGE_ERROR');
  return result as T;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Stopped', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
async function requestScore(value: number, genre: GenreId, work: Work, previous?: Composition): Promise<Composition> {
  for (let attempt = 0; live(work); attempt++) {
    try { return await api<Composition>('compose', { seed: value, genre, previous }, work); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'CODEX_BUSY' || attempt >= 16) throw error;
      await delay(250, work.signal);
    }
  }
  throw new DOMException('Stopped', 'AbortError');
}

function createDeck(): Deck {
  const deck = { score: null, active: [], assets: { loaded: [], missing: [] }, full: false } as unknown as Deck;
  deck.engine = new AudioEngine({
    onLoop(loop) {
      if (!wantsPlayback || (deck !== current && deck !== mix?.to)) return;
      if (!deck.active.some(item => item.id === loop.id)) deck.active.push(loop);
      if (deck === current && !deck.full) terminal.append(loop.tidal);
      cube.setActive(Math.max(current.active.length, mix?.to.active.length ?? 0));
    },
    onPulse(pulse) {
      if (wantsPlayback && (deck === current || deck === mix?.to)) {
        cube.pulse(pulse.id, pulse.velocity * deck.engine.mixLevel, pulse.frequency, pulse.manual);
      }
    },
  });
  return deck;
}

function setPlaying(playing: boolean) {
  transportButton.dataset.playing = String(playing);
  transportButton.setAttribute('aria-label', playing ? '정지' : '재생');
  transportButton.setAttribute('aria-pressed', String(playing));
  document.body.dataset.paused = String(!playing);
  cube.setPaused(!playing);
  terminal.setPaused(!playing);
}
function clearError() {
  composerError = null;
  resetButton.dataset.error = 'false';
  transportButton.removeAttribute('title');
  transportButton.removeAttribute('aria-description');
}
function reportError(error: unknown) {
  composerError = error instanceof Error ? error.message : String(error);
  resetButton.dataset.error = 'true';
  transportButton.title = composerError;
  transportButton.setAttribute('aria-description', composerError);
  console.error(composerError, error);
}
function chooseNewScore() {
  selectedGenre = chooseGenre(history, random, preferredGenre);
  scoreSeed = seed();
  rememberGenre(selectedGenre);
  const hue = genreHue[selectedGenre];
  cube.setGenreTransition(hue, hue, 1);
}
function showHush() {
  terminal.reset();
  terminal.append('hush', true, .01);
  terminal.update(1);
  terminal.setPaused(true);
}

async function loadDeck(deck: Deck, genre: GenreId, value: number, work: Work): Promise<boolean> {
  let score = deck.score;
  if (!score) {
    if (!status?.codex.ready) throw new Error(status?.codex.action ?? 'Run npm run doctor and sign in to the local Codex CLI with your own ChatGPT account.');
    score = await requestScore(value, genre, work, deck === current ? undefined : current.score ?? undefined);
    if (score.profile.id !== genre || score.source !== 'codex') throw new Error('Codex did not return the requested musical score.');
    if (!live(work)) return false;
    // A finished score may be reused after Stop; unfinished requests are always discarded.
    deck.score = score;
  }
  if (!live(work)) return false;
  deck.engine.setMuted(native);
  deck.engine.setBpm(score.bpm);
  try {
    const assets = await deck.engine.prepareAssets(score.loops, work.signal);
    if (!live(work)) return false;
    deck.assets = assets;
    deck.engine.setComposition(score.loops);
    return true;
  } catch (error) {
    if (!live(work)) return false;
    throw error;
  }
}

function prepareNext(work: Work): Promise<Deck | null> {
  if (!live(work)) return Promise.resolve(null);
  if (prepared) return Promise.resolve(prepared);
  if (preparation) return preparation;
  const deck = createDeck();
  const genre = chooseGenre(history, random);
  pendingDeck = deck;
  preparingGenre = genre;
  preparation = (async () => {
    const loaded = await loadDeck(deck, genre, seed(), work);
    if (!live(work) || !loaded) { await deck.engine.dispose(); return null; }
    pendingDeck = null;
    prepared = deck;
    return deck;
  })().catch(error => {
    if (live(work)) {
      if (cancelled(error)) void stopPlayback(false);
      else reportError(error);
    }
    void deck.engine.dispose();
    return null;
  }).finally(() => {
    if (work.revision === revision) { preparation = null; if (pendingDeck === deck) pendingDeck = null; }
  });
  return preparation;
}

async function startPlayback() {
  if (wantsPlayback) return;
  wantsPlayback = true;
  const work = advanceWork();
  clearError();
  phase = ready ? 'starting' : 'preparing';
  setPlaying(true);
  // Unlock only on this explicit Play gesture. No canvas gesture starts a stopped transport.
  const unlocking = current.engine.state === 'idle' ? current.engine.unlock() : Promise.resolve();
  try {
    await Promise.all([stopBarrier, unlocking]);
    if (!live(work)) return;
    status = await api<BridgeStatus>('status', undefined, work).catch(error => {
      if (!live(work) || cancelled(error)) throw error;
      throw new Error('The local bridge is unavailable. Start Sound Code Cube on this computer with npm run dev or npm start, then press Play again.');
    });
    if (!live(work)) return;
    if (!status.codex.ready || !status.codex.available || !status.codex.authenticated || status.codex.authMethod !== 'chatgpt') {
      throw new Error(status.codex.action ?? 'Run npm run doctor, install Codex, and sign in with your own ChatGPT account.');
    }
    native = !!status.tidal.enabled && !!status.tidal.available;
    const lease = await api<{ epoch: number }>('session', undefined, work);
    if (!live(work)) return;
    await api('session/claim', { expectedEpoch: lease.epoch }, work);
    if (!live(work)) return;
    claimed = true;
    if (!ready) {
      resetButton.dataset.loading = 'true';
      if (!await loadDeck(current, selectedGenre, scoreSeed, work) || !live(work)) return;
      terminal.setBpm(current.score!.bpm);
      terminal.append(`setcps (${current.score!.bpm}/60/4)`, true);
      ready = true;
      resetButton.dataset.loading = 'false';
    }
    if (!live(work) || !current.score) return;
    phase = 'starting';
    let startAt: number | undefined;
    current.engine.setMuted(native);
    if (native) {
      // Each claim resets native ownership; resume with the browser's explicit score/phase.
      const result = await api<{ startAt: number }>('tidal/transport', {
        action: current.engine.state === 'paused' ? 'resume' : 'start',
        loops: current.score.loops, bpm: current.score.bpm,
        cycle: current.engine.currentCycle, fullScore: current.full,
      }, work);
      if (!live(work)) return;
      startAt = result.startAt;
    }
    if (!live(work)) return;
    if (current.engine.state === 'paused') await current.engine.resume(startAt);
    else await current.engine.start(startAt, { full: current.full });
    if (!live(work)) return;
    phase = 'playing';
    void prepareNext(work);
  } catch (error) {
    if (!live(work)) return;
    if (!cancelled(error)) reportError(error);
    void stopPlayback(false);
  }
}

function settleMix() {
  if (!mix) return;
  const old = mix.from;
  current = mix.to;
  current.engine.setMixLevel(1);
  old.engine.setMixLevel(0);
  terminal.setBpm(current.score!.bpm);
  const hue = genreHue[current.score!.profile.id];
  cube.setGenreTransition(hue, hue, 1);
  cube.setActive(current.active.length);
  mix = null;
  void old.engine.dispose();
}

async function sendStop(action: 'pause' | 'reset', stopRevision: number): Promise<void> {
  try {
    const response = await fetch('/api/session/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, revision: stopRevision, action }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Stop returned ${response.status}`);
  } catch (error) {
    if (stopRevision === revision && (claimed || native)) {
      resetButton.dataset.error = 'true';
      console.error('Could not acknowledge the native stop.', error);
    }
  }
}

/** Cancellation precedes every await, and Stop is never gated by an in-flight operation. */
function stopPlayback(reset: boolean): Promise<void> {
  wantsPlayback = false;
  const work = advanceWork();
  phase = reset ? 'idle' : 'paused';
  throwRequested = false;
  mixPending = false;
  resetButton.dataset.loading = 'false';
  setPlaying(false);
  const decks = new Set([current, prepared, pendingDeck, mix?.from, mix?.to]);
  const pausing = [...decks].map(deck => deck?.engine.pause());
  if (!reset) settleMix();
  const keep = reset ? null : current;
  for (const deck of decks) if (deck && deck !== keep) void deck.engine.dispose();
  prepared = null;
  pendingDeck = null;
  preparation = null;
  preparingGenre = null;
  mix = null;
  if (reset) {
    current = createDeck();
    ready = false;
    clearError();
    cube.reset();
    chooseNewScore();
    showHush();
  }
  // The server raises the revision fence before waiting for any queued native command.
  const stopping = sendStop(reset ? 'reset' : 'pause', work.revision);
  stopBarrier = Promise.all([...pausing, stopping]).then(() => {});
  return stopBarrier;
}

async function requestMix() {
  if (!wantsPlayback || !ready || !current.score || current.engine.state !== 'running' || mix || mixPending) return;
  const work = scope();
  throwRequested = true;
  mixPending = true;
  const next = await prepareNext(work);
  if (!live(work) || !next?.score || !throwRequested || mix) {
    if (work.revision === revision) { mixPending = false; throwRequested = false; }
    return;
  }
  try {
    let duration = Math.max(6, Math.min(12, 960 / current.score.bpm));
    let startAt = Date.now() + 160;
    if (native) {
      const timing = await api<{ startAt: number; durationSeconds: number }>('tidal/transition', {
        loops: next.score.loops, bpm: next.score.bpm, durationSeconds: duration,
      }, work);
      if (!live(work)) return;
      startAt = timing.startAt;
      duration = timing.durationSeconds;
    }
    if (!live(work)) return;
    next.full = true;
    next.engine.setMuted(native);
    next.engine.setMixLevel(0);
    mix = { from: current, to: next, duration, progress: 0 };
    phase = 'mixing';
    prepared = null;
    preparingGenre = null;
    throwRequested = false;
    rememberGenre(next.score.profile.id);
    transitions++;
    terminal.append(`setcps (${next.score.bpm}/60/4)`, true, .3);
    for (const loop of next.score.loops) terminal.append(loop.tidal, false, duration / 8);
    await next.engine.start(startAt, { full: true });
    if (!live(work) || mix?.to !== next) return;
    mix.from.engine.scheduleMixFade('out', startAt, duration);
    next.engine.scheduleMixFade('in', startAt, duration);
  } catch (error) {
    if (!live(work)) return;
    console.error('Genre transition stopped.', error);
    resetButton.dataset.error = 'true';
    void stopPlayback(false);
  } finally { if (work.revision === revision) mixPending = false; }
}

function manualCode(loop: Loop, bpm: number, mixLevel = 1): string {
  const firstStep = Math.min(...loop.events.map(event => event.step));
  const notes = loop.events.filter(event => event.step === firstStep).sort((a, b) => a.note - b.note);
  const voices = notes.map(event => {
    const pitch = loop.sound.includes(':') ? '' : `midinote ${event.note} # `;
    return `${pitch}s "${loop.sound}" # gain ${((loop.gain * event.velocity * mixLevel) ** .25).toFixed(3)} # sustain ${Math.min(1.2, event.duration * 60 / bpm / 4).toFixed(3)}`;
  });
  return `once $ ${voices.length === 1 ? voices[0] : `stack [${voices.join(', ')}]`} # pan ${((loop.pan + 1) / 2).toFixed(3)} # cutoff ${loop.cutoff}`;
}
async function hitCorner(id: number) {
  if (!wantsPlayback || !ready || current.engine.state !== 'running') return;
  const work = scope();
  const deck = mix && mix.progress >= .5 ? mix.to : current;
  const loop = deck.score?.loops.find(item => item.id === id);
  if (!loop || !deck.score) return;
  manualHits++;
  terminal.appendHit(manualCode(loop, deck.score.bpm, deck.engine.mixLevel));
  void deck.engine.trigger(id).catch(error => { if (live(work) && !cancelled(error)) console.error('Corner audition failed.', error); });
  if (native) {
    try { await api('tidal/trigger', { loop, bpm: deck.score.bpm, velocity: deck.engine.mixLevel }, work); }
    catch (error) {
      if (!live(work)) return;
      console.error('Native corner trigger stopped.', error);
      void stopPlayback(false);
    }
  }
}

transportButton.addEventListener('click', () => wantsPlayback ? void stopPlayback(false) : void startPlayback());
resetButton.addEventListener('click', () => void stopPlayback(true));
window.addEventListener('keydown', event => {
  if (event.code === 'Space' && !event.repeat && !(event.target as HTMLElement)?.closest('button, input')) {
    event.preventDefault();
    if (wantsPlayback) void stopPlayback(false); else void startPlayback();
  }
});

const levels = new Float32Array(8);
const waveforms = Array.from({ length: 8 }, () => new Float32Array(512));
let lastFrame = performance.now();
let visualTime = 0;
function render(now: number) {
  const delta = Math.min((now - lastFrame) / 1000, .05);
  lastFrame = now;
  if (wantsPlayback && current.engine.state === 'running') visualTime += delta;
  if (wantsPlayback && mix) {
    mix.progress = Math.min(1, mix.to.engine.currentCycle * 240 / mix.to.score!.bpm / mix.duration);
    cube.setGenreTransition(genreHue[mix.from.score!.profile.id], genreHue[mix.to.score!.profile.id], mix.progress);
    if (mix.progress >= 1) { settleMix(); phase = 'playing'; void prepareNext(scope()); }
  } else if (wantsPlayback && throwRequested && preparingGenre && current.score) {
    cube.setGenreTransition(genreHue[current.score.profile.id], genreHue[preparingGenre], .025 + Math.sin(now / 220) * .015);
  }
  levels.fill(0);
  waveforms.forEach(wave => wave.fill(0));
  if (wantsPlayback) for (const deck of [current, mix?.to]) {
    if (!deck) continue;
    const gain = deck.engine.mixLevel;
    const sourceLevels = deck.engine.getLevels();
    const sourceWaves = deck.engine.getWaveforms();
    for (let id = 0; id < 8; id++) {
      levels[id] += sourceLevels[id] * gain;
      for (let sample = 0; sample < 512; sample++) waveforms[id][sample] += (sourceWaves[id]?.[sample] ?? 0) * gain;
    }
  }
  cube.update(delta, visualTime, levels, waveforms);
  colorControls.setGenreHue(cube.currentGenreHue);
  terminal.update(delta);
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

Object.defineProperty(window, 'soundCodeCube', {
  value: Object.freeze({
    snapshot: () => ({
      state: current.engine.state, phase, wantsPlayback, revision, sessionId,
      cycle: current.engine.currentCycle, activeLoops: current.active.length, roles: current.active.map(loop => loop.role),
      source: current.score?.source ?? 'pending', genre: current.score?.profile.id ?? selectedGenre,
      bpm: current.score?.bpm ?? null, key: current.score?.key ?? null,
      sounds: current.active.map(loop => loop.sound), assets: current.assets,
      loopSources: current.active.map(loop => loop.source), native, ready, composerError,
      codex: status?.codex ?? null,
      levels: Array.from(levels), manualHits, transitions,
      nextGenre: prepared?.score?.profile.id ?? preparingGenre, nextReady: !!prepared,
      preparing: !!preparation, throwPending: throwRequested,
      mix: mix ? { from: mix.from.score?.profile.id, to: mix.to.score?.profile.id, progress: mix.progress, duration: mix.duration,
        gains: [mix.from.engine.mixLevel, mix.to.engine.mixLevel] } : null,
      corners: cube.projectedCorners(), gesture: cube.gestureDiagnostics(),
    }),
    requestMidi: () => current.engine.requestMidi(),
  }),
});
window.addEventListener('pagehide', () => {
  wantsPlayback = false;
  const work = advanceWork();
  for (const deck of new Set([current, prepared, pendingDeck, mix?.from, mix?.to])) void deck?.engine.dispose();
  cube.dispose();
  colorControls.dispose();
  void fetch('/api/session/stop', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, revision: work.revision, action: 'reset' }), keepalive: true,
  }).catch(() => {});
});

chooseNewScore();
showHush();
setPlaying(false);
