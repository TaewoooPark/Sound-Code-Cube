import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { Loop } from '../../shared/music';
import { AudioEngine } from './AudioEngine';

class Param {
  value = 0;
  events: string[] = [];
  cancelScheduledValues() { this.events.push('cancel'); }
  setValueAtTime(value: number) { this.value = value; this.events.push('value'); }
  linearRampToValueAtTime(value: number) { this.value = value; }
  exponentialRampToValueAtTime(value: number) { this.value = value; }
  setTargetAtTime(value: number) { this.value = value; }
  setValueCurveAtTime() { this.events.push('curve'); }
}
class Node {
  gain = new Param(); frequency = new Param(); detune = new Param(); Q = new Param(); pan = new Param();
  threshold = new Param(); knee = new Param(); ratio = new Param(); attack = new Param(); release = new Param();
  buffer?: object | null;
  stopped = false;
  connect(target: unknown) { return target; }
  disconnect() {}
  start() {}
  stop() { this.stopped = true; }
  getFloatTimeDomainData(data: Float32Array) { data.fill(0); }
}
class Context {
  static instances: Context[] = [];
  static deferResume = false;
  state = 'suspended'; currentTime = 0; sampleRate = 1000; baseLatency = 0; outputLatency = 0;
  destination = new Node();
  resumes = 0; suspends = 0;
  releases: (() => void)[] = [];
  constructor() { Context.instances.push(this); }
  resume() {
    this.resumes++;
    if (Context.deferResume) return new Promise<void>(resolve => this.releases.push(() => {
      if (this.state !== 'closed') this.state = 'running';
      resolve();
    }));
    if (this.state !== 'closed') this.state = 'running';
    return Promise.resolve();
  }
  suspend() { this.suspends++; if (this.state !== 'closed') this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  createGain() { return new Node(); }
  createDynamicsCompressor() { return new Node(); }
  createConvolver() { return new Node(); }
  createBiquadFilter() { return new Node(); }
  createAnalyser() { return new Node(); }
  createStereoPanner() { return new Node(); }
  createOscillator() { return new Node(); }
  createBufferSource() { return new Node(); }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { duration: length / sampleRate, getChannelData: (id: number) => data[id] };
  }
  decodeAudioData(_data: ArrayBuffer): Promise<unknown> { return Promise.resolve(this.createBuffer(1, 100, 1000)); }
  getOutputTimestamp() { return { contextTime: 0, performanceTime: 0 }; }
}

const loop: Loop = { id: 0, role: 'kick', sound: 'bd:0', gain: 0.5, pan: 0, cutoff: 9000,
  events: [{ step: 0, note: 36, duration: 1, velocity: 0.8 }], tidal: '', source: 'local' };
interface Internals {
  context: Context; audition?: AudioEngine; manualEvents: unknown[]; manualTimer?: unknown;
  voices: Set<Node>; timer?: unknown; mixCalibration?: unknown; mixCurve?: unknown;
  deckGain: Node; master: Node; nextStep: number; origin: number; resumeDelay?: unknown;
  sampleBuffers: Map<string, unknown>; assetControllers: Set<AbortController>;
}
const internals = (engine: AudioEngine) => engine as unknown as Internals;
const engines: AudioEngine[] = [];
const make = (onPulse: () => void = () => {}) => {
  const engine = new AudioEngine({ onLoop: () => {}, onPulse });
  engine.setComposition([loop]); engines.push(engine); return engine;
};
const originalFetch = globalThis.fetch;
const originalContext = globalThis.AudioContext;
const originalRaf = globalThis.requestAnimationFrame;
const originalCancelRaf = globalThis.cancelAnimationFrame;
beforeEach(() => {
  Context.instances = []; Context.deferResume = false;
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 16) as unknown as number;
  globalThis.cancelAnimationFrame = handle => clearTimeout(handle);
});
afterEach(async () => {
  await Promise.all(engines.splice(0).map(engine => engine.dispose()));
  globalThis.fetch = originalFetch; globalThis.AudioContext = originalContext;
  globalThis.requestAnimationFrame = originalRaf; globalThis.cancelAnimationFrame = originalCancelRaf;
});
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('pause cancels a pending first start and a late resume cannot reopen audio', async () => {
  Context.deferResume = true;
  const engine = make();
  const starting = engine.start();
  const context = internals(engine).context;
  await engine.pause(); await starting;
  assert.equal(engine.state, 'idle');
  assert.equal(internals(engine).master.gain.value, 0);
  for (const release of context.releases) release();
  await flush();
  assert.equal(context.state, 'suspended');
  assert.equal(engine.activeLoopCount, 0);
  assert.equal(internals(engine).timer, undefined);
});

test('idle pause cancels unlock and all three pending manual resumes', async () => {
  Context.deferResume = true;
  let pulses = 0;
  const engine = make(() => pulses++);
  const unlocking = engine.unlock();
  const hits = [engine.trigger(0), engine.trigger(0), engine.trigger(0)];
  const audition = internals(engine).audition!;
  await engine.pause(); await Promise.all([unlocking, ...hits]);
  for (const context of Context.instances) for (const release of context.releases) release();
  await flush();
  assert.ok(Context.instances.every(context => context.state === 'suspended'));
  assert.equal(internals(audition).manualEvents.length, 0);
  assert.equal(internals(audition).manualTimer, undefined);
  assert.equal(internals(audition).voices.size, 0);
  assert.equal(pulses, 0);
});

test('reset stops distinct queued manual hits and cancels a pending fade calibration', async () => {
  const engine = make();
  await Promise.all([engine.trigger(0), engine.trigger(0), engine.trigger(0)]);
  const audition = internals(engine).audition!;
  assert.equal(internals(audition).manualEvents.length, 3);
  const sources = [...internals(audition).voices];
  engine.scheduleMixFade('out', Date.now() + 100, 1);
  assert.ok(internals(engine).mixCalibration);
  await engine.reset();
  const curveEvents = internals(engine).deckGain.gain.events.length;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(sources.every(source => source.stopped));
  assert.equal(internals(audition).manualEvents.length, 0);
  assert.equal(internals(audition).manualTimer, undefined);
  assert.equal(internals(engine).mixCalibration, undefined);
  assert.equal(internals(engine).mixCurve, undefined);
  assert.equal(internals(engine).deckGain.gain.events.length, curveEvents);
});

test('pause preserves an established grid and cancels a delayed native resume', async () => {
  const engine = make(); await engine.start();
  const state = internals(engine);
  state.context.currentTime = 0.2;
  const origin = state.origin, step = state.nextStep;
  await engine.pause();
  assert.equal(engine.state, 'paused'); assert.equal(state.origin, origin); assert.equal(state.nextStep, step);
  const resumes = state.context.resumes;
  const resuming = engine.resume(Date.now() + 2000);
  assert.ok(state.resumeDelay);
  await engine.pause(); await resuming;
  assert.equal(state.resumeDelay, undefined);
  assert.equal(state.context.resumes, resumes);
  assert.equal(engine.state, 'paused');
});

test('a stop during native lead-in replacement cannot start a fresh transport', async () => {
  const engine = make(); await engine.start(Date.now() + 1000, { full: true });
  await engine.pause();
  const resuming = engine.resume(Date.now() + 1000);
  await engine.pause(); await resuming;
  assert.equal(engine.state, 'idle'); assert.equal(engine.activeLoopCount, 0);
  assert.equal(internals(engine).context.state, 'suspended');
});

test('dispose is immediate and idempotent while a start resume is pending', async () => {
  Context.deferResume = true;
  const engine = make(); const starting = engine.start();
  const context = internals(engine).context;
  const disposing = engine.dispose();
  assert.equal(engine.state, 'disposed');
  await Promise.all([disposing, engine.dispose(), engine.start(), starting, engine.trigger(0)]);
  for (const release of context.releases) release(); await flush();
  assert.equal(context.state, 'closed'); assert.equal(Context.instances.length, 1);
  assert.equal(engine.activeLoopCount, 0);
});

test('a cancelled old resume does not suspend a newer explicit play', async () => {
  Context.deferResume = true;
  const engine = make(); const oldStart = engine.start();
  const context = internals(engine).context;
  await engine.pause(); await oldStart;
  Context.deferResume = false;
  await engine.start();
  for (const release of context.releases) release(); await flush();
  assert.equal(engine.state, 'running'); assert.equal(context.state, 'running');
  assert.equal(engine.activeLoopCount, 1);
});

test('stop aborts sample fetches and does not report cancelled work as missing assets', async () => {
  const requests: AbortSignal[] = [];
  globalThis.fetch = (_url, options) => new Promise<Response>((_resolve, reject) => {
    const signal = options!.signal!; requests.push(signal);
    signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
  });
  const engine = make();
  const preparing = engine.prepareAssets([loop]);
  const rejected = assert.rejects(preparing, { name: 'AbortError' });
  await engine.pause(); await rejected;
  assert.equal(requests.length, 1); assert.ok(requests[0].aborted);
  assert.equal(internals(engine).assetControllers.size, 0);
  assert.equal(internals(engine).sampleBuffers.size, 0);
});

test('external cancellation during decoding rejects promptly and ignores a late decoded buffer', async () => {
  const engine = make(); await engine.unlock();
  let decoded!: (buffer: unknown) => void;
  internals(engine).context.decodeAudioData = () => new Promise(resolve => { decoded = resolve; });
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
  const controller = new AbortController();
  const preparing = engine.prepareAssets([loop], controller.signal);
  const rejected = assert.rejects(preparing, { name: 'AbortError' });
  await flush(); assert.ok(decoded);
  controller.abort(); await rejected;
  decoded({}); await flush();
  assert.equal(internals(engine).sampleBuffers.size, 0);
});
