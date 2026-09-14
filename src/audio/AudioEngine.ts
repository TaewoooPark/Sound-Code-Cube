import { BPM, PHRASE_STEPS, ROLES, STEPS_PER_CYCLE, type AudioPulse, type Loop, type NoteEvent, type Role } from '../../shared/music';
import { isSupportedSound } from '../../shared/profiles';

export type AudioState = 'idle' | 'running' | 'paused' | 'disposed';
export interface AudioCallbacks {
  onLoop: (loop: Loop, cycle: number) => void;
  onPulse: (pulse: AudioPulse) => void;
  onCycle?: (cycle: number) => void;
}
export interface StartOptions { full?: boolean }
interface Channel { input: GainNode; filter: BiquadFilterNode; analyser: AnalyserNode; pan: StereoPannerNode; send: GainNode; waveform: Float32Array<ArrayBuffer> }
interface AudibleEvent { time: number; run: () => void }
interface MidiOutput { state: string; send: (data: number[], timestamp?: number) => void; clear?: () => void }

const SENDS = [0.012, 0.018, 0.07, 0.04, 0.12, 0.23, 0.19, 0.35];
const midiFrequency = (note: number) => 440 * 2 ** ((note - 69) / 12);
const aborted = () => new DOMException('Audio work was cancelled.', 'AbortError');

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise<T>((resolve, reject) => {
    const cancel = () => { cleanup(); reject(aborted()); };
    const cleanup = () => signal.removeEventListener('abort', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** A sample-clock sequencer. The UI follows audible events, never lookahead events. */
export class AudioEngine {
  state: AudioState = 'idle';
  private context?: AudioContext;
  private channels: Channel[] = [];
  private master?: GainNode;
  private deckGain?: GainNode;
  private mix?: GainNode;
  private reverb?: ConvolverNode;
  private noise?: AudioBuffer;
  private voices = new Set<AudioScheduledSourceNode>();
  private composition: Loop[] = [];
  private queued: Loop[] = [];
  private active: Loop[] = [];
  private audible: AudibleEvent[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private frame?: number;
  private origin = 0;
  private nextStep = 0;
  private generation = 0;
  private contextWanted = false;
  private transportStarted = false;
  private pendingResumes = new Set<() => void>();
  private resumeDelay?: { timer: ReturnType<typeof setTimeout>; cancel: () => void };
  private disposal?: Promise<void>;
  private muted: boolean;
  private midi?: MidiOutput;
  private lastCycle = 0;
  private tempo = BPM;
  private sampleBuffers = new Map<string, AudioBuffer>();
  private assetControllers = new Set<AbortController>();
  private assetGeneration = 0;
  private levels = new Float32Array(8);
  private emptyWaveforms = Array.from({ length: 8 }, () => new Float32Array(512));
  private combinedLevels = new Float32Array(8);
  private combinedWaveforms = Array.from({ length: 8 }, () => new Float32Array(512));
  private audition?: AudioEngine;
  private manualEvents: AudibleEvent[] = [];
  private manualTimer?: ReturnType<typeof setInterval>;
  private manualUntil = 0;
  private lastManualOnset = new Float64Array(8).fill(-Infinity);
  private fullStart = false;
  private mixRamp = { from: 1, to: 1, start: 0, end: 0 };
  private mixCurve?: { direction: 'in' | 'out'; start: number; end: number; duration: number };
  private mixCalibration?: ReturnType<typeof setTimeout>;
  private mixGeneration = 0;

  constructor(private callbacks: AudioCallbacks, options: { muteOutput?: boolean } = {}) {
    this.muted = options.muteOutput ?? false;
  }

  get currentCycle(): number {
    if (!this.context || this.state === 'idle' || this.state === 'disposed') return 0;
    return Math.max(0, (this.context.currentTime - this.origin) / (this.stepSeconds * STEPS_PER_CYCLE));
  }
  get activeLoopCount(): number { return this.active.length; }
  get audioTime(): number { return this.context?.currentTime ?? 0; }
  get bpm(): number { return this.tempo; }
  get stepSeconds(): number { return 60 / this.tempo / 4; }
  get mixLevel(): number {
    if (this.mixCurve) {
      const { direction, start, end } = this.mixCurve;
      const progress = Math.max(0, Math.min(1, ((this.context ? this.audibleTime() : end) - start) / (end - start)));
      return direction === 'in' ? Math.sin(progress * Math.PI / 2) : Math.cos(progress * Math.PI / 2);
    }
    const { from, to, start, end } = this.mixRamp;
    const now = this.context?.currentTime ?? end;
    if (end <= start || now >= end) return to;
    return from + (to - from) * Math.max(0, (now - start) / (end - start));
  }

  /** Independent deck volume; muting native shadow synthesis never changes this value. */
  setMixLevel(level: number, durationSeconds = 0): void {
    if (this.state === 'disposed') return;
    if (!Number.isFinite(level) || !Number.isFinite(durationSeconds)) throw new Error('Invalid mix level.');
    const target = Math.max(0, Math.min(1, level));
    const duration = Math.max(0, durationSeconds);
    const now = this.context?.currentTime ?? 0;
    const current = this.mixLevel;
    if (this.mixCalibration !== undefined) clearTimeout(this.mixCalibration);
    this.mixCalibration = undefined;
    ++this.mixGeneration;
    this.mixCurve = undefined;
    this.mixRamp = { from: current, to: target, start: now, end: now + duration };
    if (this.deckGain) {
      this.deckGain.gain.cancelScheduledValues(0);
      this.deckGain.gain.setValueAtTime(current, now);
      if (duration > 0) this.deckGain.gain.linearRampToValueAtTime(target, now + duration);
      else this.deckGain.gain.setValueAtTime(target, now);
    }
    this.audition?.setMixLevel(target, duration);
  }

  /** Audio-clock equal-power fades continue smoothly even when animation frames are throttled. */
  scheduleMixFade(direction: 'in' | 'out', startAtEpoch: number, durationSeconds: number): void {
    if (this.state === 'disposed') return;
    if (!Number.isFinite(startAtEpoch) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error('Invalid fade timing.');
    }
    this.initialize();
    const context = this.context!;
    if (this.mixCalibration !== undefined) clearTimeout(this.mixCalibration);
    this.mixCalibration = undefined;
    const token = ++this.mixGeneration;
    const apply = () => {
      const now = context.currentTime;
      const start = this.rawTimeAtEpoch(startAtEpoch);
      const end = start + durationSeconds;
      const scheduleAt = Math.max(now + 1 / context.sampleRate, start);
      if (end <= scheduleAt) { this.setMixLevel(direction === 'in' ? 1 : 0); return; }
      const current = this.mixLevel;
      this.deckGain!.gain.cancelScheduledValues(0);
      this.deckGain!.gain.setValueAtTime(current, now);
      const curve = Float32Array.from({ length: 128 }, (_, index) => {
        const time = scheduleAt + (end - scheduleAt) * index / 127;
        const progress = Math.max(0, Math.min(1, (time - start) / durationSeconds));
        return direction === 'in' ? Math.sin(progress * Math.PI / 2) : Math.cos(progress * Math.PI / 2);
      });
      this.deckGain!.gain.setValueCurveAtTime(curve, scheduleAt, end - scheduleAt);
      this.mixCurve = { direction, start, end, duration: durationSeconds };
    };
    apply();
    // A newly resumed context may report zero output latency until its first hardware block.
    // Calibrate once when that timestamp arrives; the fade itself runs wholly on the audio thread.
    const stampReady = () => {
      const stamp = context.getOutputTimestamp?.();
      return typeof stamp?.contextTime === 'number' && stamp.contextTime > 0
        && typeof stamp.performanceTime === 'number' && stamp.performanceTime > 0
        && Math.abs(performance.now() - stamp.performanceTime) < 100;
    };
    if (token === this.mixGeneration && typeof context.getOutputTimestamp === 'function' && !stampReady()) {
      const deadline = performance.now() + 160;
      const calibrate = () => {
        this.mixCalibration = undefined;
        if (token !== this.mixGeneration || this.state === 'disposed') return;
        if (stampReady()) apply();
        else if (performance.now() < deadline) this.mixCalibration = setTimeout(calibrate, 8);
      };
      this.mixCalibration = setTimeout(calibrate, 8);
    }
    this.audition?.scheduleMixFade(direction, startAtEpoch, durationSeconds);
  }

  /** Every invocation schedules one distinct hit, including while the transport is paused. */
  async trigger(id: number, velocity = 1): Promise<void> {
    if (this.state === 'disposed' || !Number.isInteger(id) || id < 0 || id > 7 || !Number.isFinite(velocity) || velocity <= 0) return;
    const loop = this.composition.find(candidate => candidate.id === id);
    if (!loop?.events.length) return;
    // An independent rendering context leaves all suspended sequencer voices and its clock untouched.
    if (!this.audition) {
      this.audition = new AudioEngine({ onLoop: () => {}, onPulse: pulse => this.callbacks.onPulse(pulse) }, { muteOutput: this.muted });
      this.audition.setMixLevel(this.mixLevel);
    }
    const renderer = this.audition;
    renderer.tempo = this.tempo;
    renderer.initialize();
    renderer.setMixLevel(this.mixLevel);
    if (this.state === 'running' && this.mixCurve) {
      const elapsed = this.audibleTime() - this.mixCurve.start;
      renderer.scheduleMixFade(this.mixCurve.direction, Date.now() - elapsed * 1000, this.mixCurve.duration);
    } else {
      const remainingFade = this.state === 'running' ? Math.max(0, this.mixRamp.end - (this.context?.currentTime ?? 0)) : 0;
      if (remainingFade > 0) renderer.setMixLevel(this.mixRamp.to, remainingFade);
    }
    for (const [sound, buffer] of this.sampleBuffers) renderer.sampleBuffers.set(sound, buffer);
    const parentToken = this.generation;
    const token = renderer.generation;
    // Invoked in the original pointer gesture, before yielding.
    if (!await renderer.resumeContext(token)) return;
    if (parentToken !== this.generation || token !== renderer.generation) return;
    const nextEvent = [...loop.events].sort((a, b) => a.step - b.step || a.note - b.note)[0];
    const notes = loop.events.filter(event => event.step === nextEvent.step).map(event => ({
      ...event, velocity: Math.min(1, event.velocity * velocity), duration: Math.min(event.duration, 1.2 / renderer.stepSeconds),
    }));
    const time = Math.max(renderer.context!.currentTime + 0.008, renderer.lastManualOnset[id] + 0.035);
    renderer.lastManualOnset[id] = time;
    const channel = renderer.channels[id];
    channel.pan.pan.setValueAtTime(loop.pan, time);
    channel.filter.frequency.setValueAtTime(Math.min(loop.cutoff, renderer.context!.sampleRate * 0.45), time);
    for (const event of notes) renderer.play(loop, event, time);
    renderer.manualUntil = Math.max(renderer.manualUntil, time + 3.5);
    renderer.manualEvents.push({ time, run: () => {
      this.callbacks.onPulse({ id, velocity: Math.max(...notes.map(note => note.velocity)) * loop.gain,
        frequency: midiFrequency(nextEvent.note), time, manual: true });
      for (const event of notes) this.sendMidi(loop, event);
    } });
    renderer.manualEvents.sort((a, b) => a.time - b.time);
    renderer.runManualClock();
  }

  setBpm(bpm: number): void {
    if (!Number.isFinite(bpm) || bpm < 60 || bpm > 180) throw new Error('Tempo must be 60–180 BPM.');
    if (bpm === this.tempo) return;
    if (this.state === 'running' || this.state === 'paused') throw new Error('Reset playback before changing tempo.');
    this.tempo = bpm;
  }

  /** Fetch the selected local Dirt assets. Missing files retain the synthesized fallback. */
  async prepareAssets(loops: Loop[], signal?: AbortSignal): Promise<{ loaded: string[]; missing: string[] }> {
    if (this.state === 'disposed' || signal?.aborted) throw aborted();
    this.initialize();
    const context = this.context!;
    const token = this.assetGeneration;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    this.assetControllers.add(controller);
    const check = () => {
      if (controller.signal.aborted || token !== this.assetGeneration || this.state === 'disposed') throw aborted();
    };
    const sounds = [...new Set(loops.map(loop => loop.sound).filter(sound => sound.includes(':')))];
    try {
      const results = await Promise.all(sounds.map(async sound => {
        check();
        if (!isSupportedSound(sound)) return false;
        if (this.sampleBuffers.has(sound)) return true;
        const [bank, index] = sound.split(':');
        const request = new AbortController();
        const stopRequest = () => request.abort();
        controller.signal.addEventListener('abort', stopRequest, { once: true });
        const timeout = setTimeout(stopRequest, 6000);
        try {
          const response = await abortable(fetch(`/api/samples/${bank}/${index}`, { signal: request.signal }), request.signal);
          check();
          if (!response.ok) return false;
          const data = await abortable(response.arrayBuffer(), request.signal);
          check();
          if (data.byteLength > 12 * 1024 * 1024) return false;
          const buffer = await abortable(context.decodeAudioData(data), request.signal);
          check();
          this.sampleBuffers.set(sound, buffer);
          return true;
        } catch { check(); return false; }
        finally {
          clearTimeout(timeout);
          controller.signal.removeEventListener('abort', stopRequest);
        }
      }));
      check();
      return { loaded: sounds.filter((_, index) => results[index]), missing: sounds.filter((_, index) => !results[index]) };
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.assetControllers.delete(controller);
    }
  }

  queueLoop(loop: Loop): void {
    if (this.state === 'disposed' || this.active.some(item => item.id === loop.id)) return;
    const storedIndex = this.composition.findIndex(item => item.id === loop.id);
    const queuedIndex = this.queued.findIndex(item => item.id === loop.id);
    if (storedIndex >= 0) this.composition[storedIndex] = loop;
    else this.composition.push(loop);
    if (queuedIndex >= 0) this.queued[queuedIndex] = loop;
    else this.queued.push(loop);
  }

  setComposition(loops: Loop[]): void {
    if (this.state === 'disposed') return;
    this.composition = [...loops];
    this.queued = loops.filter(loop => !this.active.some(active => active.id === loop.id));
  }

  /** Call directly from the initial user gesture; this does not start the sequencer. */
  async unlock(): Promise<void> {
    if (this.state === 'disposed') return;
    this.initialize();
    await this.resumeContext(this.generation);
  }

  async start(startAt?: number, options: StartOptions = {}): Promise<void> {
    if (this.state === 'disposed' || this.state === 'running') return;
    if (this.state === 'paused') return this.resume(startAt);
    const token = ++this.generation;
    this.initialize();
    this.state = 'running';
    this.fullStart = options.full ?? false;
    if (!await this.resumeContext(token) || token !== this.generation) return;
    this.origin = startAt === undefined ? this.context!.currentTime + 0.08 : this.timeAtEpoch(startAt);
    this.nextStep = 0;
    this.lastCycle = 0;
    this.transportStarted = true;
    this.runClock();
  }

  async pause(): Promise<void> {
    if (this.state === 'disposed') return;
    this.cancelWork(false);
    this.state = this.transportStarted ? 'paused' : 'idle';
    // Suspend both contexts immediately, without an await between the two requests.
    await Promise.all([this.suspendContext(), this.audition?.reset()]);
  }

  async resume(startAt?: number): Promise<void> {
    if (this.state !== 'paused' || !this.context) return;
    if (!this.transportStarted || (startAt !== undefined && this.context.currentTime < this.origin)) {
      // A native resume already supplies a new lead-in. Do not replay a suspended old lead-in too.
      const full = this.fullStart;
      const resetting = this.reset();
      const token = this.generation;
      await resetting;
      if (token === this.generation && (this.state as AudioState) === 'idle') return this.start(startAt, { full });
      return;
    }
    const token = ++this.generation;
    this.state = 'running';
    if (startAt !== undefined) {
      const delay = startAt - Date.now() - (this.context.outputLatency || this.context.baseLatency || 0) * 1000;
      if (delay > 0) await new Promise<void>(resolve => {
        const finish = () => { this.resumeDelay = undefined; resolve(); };
        const timer = setTimeout(finish, delay);
        this.resumeDelay = { timer, cancel: finish };
      });
      if (token !== this.generation) return;
    }
    if (await this.resumeContext(token) && token === this.generation) this.runClock();
  }

  async reset(): Promise<void> {
    if (this.state === 'disposed') return;
    this.cancelWork(true);
    this.state = 'idle';
    await Promise.all([this.suspendContext(), this.audition?.reset()]);
  }

  /** All state changes happen before yielding so an older stop cannot erase a newer start. */
  private cancelWork(reset: boolean): void {
    ++this.generation;
    this.contextWanted = false;
    this.applyOutputGate();
    for (const cancel of this.pendingResumes) cancel();
    this.pendingResumes.clear();
    if (this.resumeDelay) {
      clearTimeout(this.resumeDelay.timer);
      this.resumeDelay.cancel();
    }
    ++this.assetGeneration;
    for (const controller of this.assetControllers) controller.abort();
    this.assetControllers.clear();
    this.setMixLevel(this.mixLevel);
    this.stopClock();
    this.silenceMidi();
    if (reset || !this.transportStarted) this.stopVoices();
    if (this.manualTimer !== undefined) clearInterval(this.manualTimer);
    this.manualTimer = undefined;
    this.manualEvents = [];
    this.lastManualOnset.fill(-Infinity);
    this.manualUntil = 0;
    this.levels.fill(0);
    if (reset) {
      this.transportStarted = false;
      this.active = [];
      this.queued = [...this.composition];
      this.audible = [];
      this.nextStep = 0;
      this.lastCycle = 0;
      this.origin = 0;
      // Replacing the convolver clears its history, including long pad tails.
      if (this.reverb) { const impulse = this.reverb.buffer; this.reverb.buffer = null; this.reverb.buffer = impulse; }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.cancelWork(true);
    this.state = 'disposed';
    const closing = this.context?.close().catch(() => {});
    const auditionClosing = this.audition?.dispose();
    this.audition = undefined;
    this.sampleBuffers.clear();
    this.channels = [];
    this.context = undefined;
    this.disposal = Promise.all([closing, auditionClosing]).then(() => {});
    return this.disposal;
  }

  private applyOutputGate(): void {
    if (!this.master || !this.context || this.context.state === 'closed') return;
    this.master.gain.cancelScheduledValues(0);
    this.master.gain.setValueAtTime(this.contextWanted && !this.muted ? 0.8 : 0, this.context.currentTime);
  }

  private async suspendContext(): Promise<void> {
    const context = this.context;
    if (context && context.state !== 'closed') await context.suspend().catch(() => {});
  }

  private async resumeContext(token: number): Promise<boolean> {
    const context = this.context!;
    if (token !== this.generation || this.state === 'disposed') return false;
    this.contextWanted = true;
    this.applyOutputGate();
    let cancel!: () => void;
    const cancellation = new Promise<boolean>(resolve => { cancel = () => resolve(false); });
    this.pendingResumes.add(cancel);
    // The actual resume can resolve after cancellation (for example after an autoplay prompt).
    // Its completion must restore the latest intent, without interrupting a newer explicit play.
    const resumed = context.resume().then(async () => {
      if (token !== this.generation || context !== this.context || this.state === 'disposed') {
        if ((!this.contextWanted || this.state === 'disposed') && context.state !== 'closed') {
          await context.suspend().catch(() => {});
        }
        return false;
      }
      return true;
    }, error => {
      if (token !== this.generation || this.state === 'disposed') return false;
      this.contextWanted = false;
      this.applyOutputGate();
      this.state = this.transportStarted ? 'paused' : 'idle';
      throw error;
    });
    try { return await Promise.race([resumed, cancellation]); }
    finally { this.pendingResumes.delete(cancel); }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyOutputGate();
    this.audition?.setMuted(muted);
  }

  getLevels(): Float32Array {
    const own = this.readLevels();
    if (!this.audition) return own;
    const audition = this.audition.readLevels();
    for (let id = 0; id < 8; id++) this.combinedLevels[id] = Math.min(1, Math.hypot(own[id], audition[id]));
    return this.combinedLevels;
  }

  private readLevels(): Float32Array {
    if (!this.context || this.context.state !== 'running') {
      for (let id = 0; id < 8; id++) this.levels[id] *= 0.9;
      return this.levels;
    }
    for (let id = 0; id < this.channels.length; id++) {
      const channel = this.channels[id];
      channel.analyser.getFloatTimeDomainData(channel.waveform);
      let energy = 0;
      for (const sample of channel.waveform) energy += sample * sample;
      const level = Math.min(1, Math.sqrt(energy / channel.waveform.length) * 10);
      this.levels[id] = Math.max(level, this.levels[id] * 0.82);
    }
    return this.levels;
  }

  getWaveforms(): Float32Array[] {
    const own = this.readWaveforms();
    if (!this.audition) return own;
    const audition = this.audition.readWaveforms();
    for (let id = 0; id < 8; id++) {
      for (let sample = 0; sample < 512; sample++) this.combinedWaveforms[id][sample] =
        Math.max(-1, Math.min(1, own[id][sample] + audition[id][sample]));
    }
    return this.combinedWaveforms;
  }

  private readWaveforms(): Float32Array[] {
    if (!this.channels.length) return this.emptyWaveforms;
    for (const channel of this.channels) {
      if (this.context?.state === 'running') channel.analyser.getFloatTimeDomainData(channel.waveform);
      else channel.waveform.fill(0);
    }
    return this.channels.map(channel => channel.waveform);
  }

  async requestMidi(): Promise<boolean> {
    const navigatorWithMidi = navigator as Navigator & {
      requestMIDIAccess?: () => Promise<{ outputs: Map<string, MidiOutput> }>;
    };
    if (!navigatorWithMidi.requestMIDIAccess) return false;
    try {
      const access = await navigatorWithMidi.requestMIDIAccess();
      this.midi = [...access.outputs.values()].find(output => output.state === 'connected');
      return !!this.midi;
    } catch { return false; }
  }

  private initialize(): void {
    if (this.context) return;
    this.context = new AudioContext({ latencyHint: 'interactive' });
    const context = this.context;
    this.mix = context.createGain();
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 16;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.18;
    this.master = context.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.deckGain = context.createGain();
    this.deckGain.gain.value = this.mixRamp.to;
    this.mixRamp = { from: this.mixRamp.to, to: this.mixRamp.to, start: 0, end: 0 };
    this.mix.connect(compressor).connect(this.deckGain).connect(this.master).connect(context.destination);

    this.reverb = context.createConvolver();
    const impulse = context.createBuffer(2, Math.floor(context.sampleRate * 1.9), context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let index = 0; index < data.length; index++) {
        data[index] = (Math.random() * 2 - 1) * (1 - index / data.length) ** 3.3 * 0.62;
      }
    }
    this.reverb.buffer = impulse;
    const reverbHighpass = context.createBiquadFilter();
    reverbHighpass.type = 'highpass'; reverbHighpass.frequency.value = 280;
    const reverbLowpass = context.createBiquadFilter();
    reverbLowpass.frequency.value = 5700;
    this.reverb.connect(reverbHighpass).connect(reverbLowpass).connect(this.mix);

    this.noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const noise = this.noise.getChannelData(0);
    for (let index = 0; index < noise.length; index++) noise[index] = Math.random() * 2 - 1;

    this.channels = ROLES.map((_, id) => {
      const input = context.createGain();
      const filter = context.createBiquadFilter(); filter.frequency.value = 18000;
      const analyser = context.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.65;
      const pan = context.createStereoPanner();
      const send = context.createGain(); send.gain.value = SENDS[id];
      input.connect(filter).connect(analyser).connect(pan).connect(this.mix!);
      pan.connect(send).connect(this.reverb!);
      return { input, filter, analyser, pan, send, waveform: new Float32Array(512) };
    });
  }

  private timeAtEpoch(epochMilliseconds: number): number {
    return Math.max(this.context!.currentTime + 0.01, this.rawTimeAtEpoch(epochMilliseconds));
  }

  private rawTimeAtEpoch(epochMilliseconds: number): number {
    const context = this.context!;
    const stamp = context.getOutputTimestamp?.();
    const targetPerformanceTime = performance.now() + epochMilliseconds - Date.now();
    if (typeof stamp?.performanceTime === 'number' && stamp.performanceTime > 0 && typeof stamp.contextTime === 'number'
      && Math.abs(performance.now() - stamp.performanceTime) < 100) {
      return stamp.contextTime + (targetPerformanceTime - stamp.performanceTime) / 1000;
    }
    return context.currentTime + (epochMilliseconds - Date.now()) / 1000
      - (context.outputLatency || 0) - (context.baseLatency || 0);
  }

  private runClock(): void {
    this.stopClock();
    this.schedule();
    this.timer = setInterval(() => this.schedule(), 25);
    const draw = () => {
      if (this.state !== 'running') return;
      this.dispatchAudible();
      this.frame = requestAnimationFrame(draw);
    };
    this.frame = requestAnimationFrame(draw);
  }

  private runManualClock(): void {
    if (this.manualTimer !== undefined) return;
    this.manualTimer = setInterval(() => {
      if (!this.context || this.state === 'disposed') return;
      const now = this.audibleTime();
      while (this.manualEvents[0] && this.manualEvents[0].time <= now) this.manualEvents.shift()!.run();
      if (!this.manualEvents.length && !this.pendingResumes.size && this.context.currentTime > this.manualUntil) {
        clearInterval(this.manualTimer);
        this.manualTimer = undefined;
        this.contextWanted = false;
        this.applyOutputGate();
        void this.suspendContext();
      }
    }, 8);
  }

  private stopClock(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.timer = undefined;
    this.frame = undefined;
  }

  private schedule(): void {
    if (!this.context || this.state !== 'running') return;
    const now = this.context.currentTime;
    // If a background tab misses its lookahead, continue from the current grid.
    // Do not replay a backlog of missed drum hits as one burst.
    if (this.origin + this.nextStep * this.stepSeconds < now - this.stepSeconds) {
      const oldStep = this.nextStep;
      this.nextStep = Math.ceil((now - this.origin) / this.stepSeconds);
      // A waiting layer still enters only at a genuine two-cycle boundary.
      if (Math.floor(oldStep / PHRASE_STEPS) !== Math.floor(this.nextStep / PHRASE_STEPS)) {
        this.lastCycle = Math.floor(this.nextStep / STEPS_PER_CYCLE);
      }
    }
    while (this.origin + this.nextStep * this.stepSeconds < now + 0.12) {
      const time = this.origin + this.nextStep * this.stepSeconds;
      const step = this.nextStep % PHRASE_STEPS;
      const cycle = Math.floor(this.nextStep / STEPS_PER_CYCLE);
      if (step === 0 && this.queued.length && this.active.length < 8) {
        const count = this.fullStart && this.nextStep === 0 ? Math.min(this.queued.length, 8 - this.active.length) : 1;
        for (let index = 0; index < count; index++) {
          const loop = this.queued.shift()!;
          this.active.push(loop);
          const channel = this.channels[loop.id];
          channel.pan.pan.setValueAtTime(loop.pan, time);
          channel.filter.frequency.setValueAtTime(Math.min(loop.cutoff, this.context.sampleRate * 0.45), time);
          this.audible.push({ time, run: () => this.callbacks.onLoop(loop, cycle) });
        }
      }
      if (this.nextStep % STEPS_PER_CYCLE === 0) {
        this.audible.push({ time, run: () => { this.lastCycle = cycle; this.callbacks.onCycle?.(cycle); } });
      }
      for (const loop of this.active) {
        for (const event of loop.events) {
          if (event.step !== step) continue;
          this.play(loop, event, time);
          this.audible.push({ time, run: () => {
            this.callbacks.onPulse({ id: loop.id, velocity: event.velocity * loop.gain,
              frequency: midiFrequency(event.note), time });
            this.sendMidi(loop, event);
          } });
        }
      }
      this.nextStep++;
    }
    this.dispatchAudible();
  }

  private dispatchAudible(): void {
    if (!this.context || this.state !== 'running') return;
    const now = this.audibleTime();
    while (this.audible[0] && this.audible[0].time <= now) this.audible.shift()!.run();
  }

  private audibleTime(): number {
    if (!this.context) return 0;
    // getOutputTimestamp accounts for hardware output latency when available.
    const stamp = this.context.getOutputTimestamp?.();
    return typeof stamp?.performanceTime === 'number' && stamp.performanceTime > 0 && typeof stamp.contextTime === 'number'
      && Math.abs(performance.now() - stamp.performanceTime) < 100
      ? Math.min(this.context.currentTime, stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000)
      : Math.max(0, this.context.currentTime - (this.context.baseLatency || 0) - (this.context.outputLatency || 0));
  }

  private envelope(target: AudioNode | AudioParam, time: number, duration: number, peak: number, attack = 0.003, release = 0.05): GainNode {
    const node = this.context!.createGain();
    const end = time + Math.max(duration, attack + 0.008);
    node.gain.setValueAtTime(0, time);
    node.gain.linearRampToValueAtTime(Math.max(0.0001, peak), time + attack);
    node.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.42), Math.max(time + attack, end - release));
    node.gain.exponentialRampToValueAtTime(0.0001, end);
    node.gain.setValueAtTime(0, end + 0.005);
    if ('context' in target) node.connect(target);
    else node.connect(target);
    return node;
  }

  private track(source: AudioScheduledSourceNode, time: number, duration: number, nodes: AudioNode[] = []): void {
    this.voices.add(source);
    source.onended = () => { this.voices.delete(source); source.disconnect(); for (const node of nodes) node.disconnect(); };
    source.start(time);
    source.stop(time + duration + 0.02);
  }

  private oscillator(type: OscillatorType, frequency: number, target: AudioNode, time: number,
    duration: number, detune = 0, nodes: AudioNode[] = []): OscillatorNode {
    const oscillator = this.context!.createOscillator();
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, time); oscillator.detune.value = detune;
    oscillator.connect(target);
    this.track(oscillator, time, duration, nodes);
    return oscillator;
  }

  private noiseHit(target: AudioNode, time: number, duration: number, peak: number,
    frequency: number, type: BiquadFilterType = 'highpass', q = 0.7): void {
    const source = this.context!.createBufferSource(); source.buffer = this.noise!;
    const filter = this.context!.createBiquadFilter(); filter.type = type; filter.frequency.value = frequency; filter.Q.value = q;
    const gain = this.envelope(target, time, duration, peak, 0.001, duration * 0.8);
    source.connect(filter).connect(gain);
    this.track(source, time, duration, [filter, gain]);
  }

  private play(loop: Loop, event: NoteEvent, time: number): void {
    const context = this.context!;
    const target = this.channels[loop.id].input;
    const velocity = Math.min(1, event.velocity) * loop.gain;
    const duration = event.duration * this.stepSeconds;
    const frequency = midiFrequency(event.note);
    const sample = this.sampleBuffers.get(loop.sound);
    if (sample) {
      const length = Math.max(0.012, Math.min(sample.duration, duration));
      const source = context.createBufferSource(); source.buffer = sample;
      const envelope = context.createGain();
      envelope.gain.setValueAtTime(velocity * 0.62, time);
      envelope.gain.setValueAtTime(velocity * 0.62, time + Math.max(0, length - 0.008));
      envelope.gain.linearRampToValueAtTime(0, time + length);
      source.connect(envelope).connect(target);
      this.track(source, time, length, [envelope]);
      return;
    }
    if (this.playSelectedSynth(loop.sound, target, time, duration, frequency, velocity, loop.cutoff)) return;
    const defaultVoice: Record<string, Role> = { sccbass: 'bass', sccchords: 'chords', sccmelody: 'melody', scctexture: 'texture' };
    switch (defaultVoice[loop.sound] ?? loop.role) {
      case 'kick': {
        const length = 0.42;
        const envelope = this.envelope(target, time, length, velocity * 0.95, 0.002, 0.34);
        const oscillator = this.oscillator('sine', 145, envelope, time, length, 0, [envelope]);
        oscillator.frequency.exponentialRampToValueAtTime(48, time + 0.065);
        oscillator.frequency.exponentialRampToValueAtTime(42, time + length);
        this.noiseHit(target, time, 0.014, velocity * 0.05, 4900);
        break;
      }
      case 'bass': {
        const length = Math.max(0.1, duration + 0.055);
        const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.Q.value = 1.1;
        filter.frequency.setValueAtTime(Math.min(1800, loop.cutoff), time);
        filter.frequency.exponentialRampToValueAtTime(Math.max(120, Math.min(400, loop.cutoff * 0.28)), time + length * 0.8);
        const envelope = this.envelope(target, time, length, velocity * 0.27, 0.006, 0.08);
        filter.connect(envelope);
        this.oscillator('sawtooth', frequency, filter, time, length, -4);
        this.oscillator('sawtooth', frequency, filter, time, length + 0.001, 4, [filter, envelope]);
        const subEnvelope = this.envelope(target, time, length, velocity * 0.21, 0.004, 0.07);
        this.oscillator('sine', frequency / 2, subEnvelope, time, length, 0, [subEnvelope]);
        break;
      }
      case 'snare': {
        this.noiseHit(target, time, 0.185, velocity * 0.34, 1650, 'highpass');
        this.noiseHit(target, time, 0.065, velocity * 0.2, 2600, 'bandpass', 0.65);
        const envelope = this.envelope(target, time, 0.13, velocity * 0.25, 0.001, 0.115);
        const oscillator = this.oscillator('triangle', 195, envelope, time, 0.13, 0, [envelope]);
        oscillator.frequency.exponentialRampToValueAtTime(135, time + 0.1);
        break;
      }
      case 'hats': {
        const length = Math.max(0.03, Math.min(0.3, duration));
        this.noiseHit(target, time, length, velocity * 0.27, 7200, 'highpass', 0.6);
        this.noiseHit(target, time, length * 0.65, velocity * 0.12, 10200, 'bandpass', 1.5);
        break;
      }
      case 'percussion': {
        const length = Math.max(0.06, Math.min(0.25, duration + 0.04));
        const envelope = this.envelope(target, time, length, velocity * 0.27, 0.001, length * 0.85);
        const oscillator = this.oscillator('sine', frequency * 1.2, envelope, time, length, 0, [envelope]);
        oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.6, time + length * 0.45);
        this.noiseHit(target, time, 0.038, velocity * 0.08, 2100, 'bandpass', 1.8);
        break;
      }
      case 'chords': {
        const length = duration + 0.45;
        const envelope = this.envelope(target, time, length, velocity * 0.13, 0.045, 0.4);
        this.oscillator('triangle', frequency, envelope, time, length, -5);
        this.oscillator('sine', frequency * 2, envelope, time, length, 3);
        this.oscillator('triangle', frequency, envelope, time, length + 0.001, 5, [envelope]);
        break;
      }
      case 'melody': {
        const length = duration + 0.38;
        const envelope = this.envelope(target, time, length, velocity * 0.3, 0.002, length * 0.88);
        this.oscillator('sine', frequency, envelope, time, length, 0, [envelope]);
        const overtone = this.envelope(target, time, length * 0.45, velocity * 0.075, 0.001, length * 0.39);
        this.oscillator('sine', frequency * 3.01, overtone, time, length * 0.45, 0, [overtone]);
        break;
      }
      case 'texture': {
        const length = Math.max(0.6, duration + 0.8);
        const envelope = this.envelope(target, time, length, velocity * 0.16, Math.min(0.4, length * 0.2), length * 0.45);
        this.oscillator('sine', frequency * 0.5, envelope, time, length, -9);
        this.oscillator('sine', frequency, envelope, time, length + 0.001, 9, [envelope]);
        this.noiseHit(target, time, length, velocity * 0.055, 1900, 'bandpass', 2.4);
        break;
      }
    }
  }

  private playSelectedSynth(sound: string, target: AudioNode, time: number, duration: number,
    frequency: number, velocity: number, cutoff: number): boolean {
    const context = this.context!;
    const length = Math.max(0.06, duration);
    switch (sound) {
      case 'sccacid': {
        const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.Q.value = 7;
        filter.frequency.setValueAtTime(Math.min(cutoff, frequency * 13 + 500), time);
        filter.frequency.exponentialRampToValueAtTime(Math.max(90, frequency * 1.3), time + length * 0.85);
        const drive = context.createWaveShaper();
        drive.curve = Float32Array.from({ length: 256 }, (_, index) => Math.tanh((index / 127.5 - 1) * 2.2) / 1.2);
        drive.oversample = '2x';
        const envelope = this.envelope(target, time, length, velocity * 0.26, length * 0.02, length * 0.26);
        filter.connect(drive).connect(envelope);
        this.oscillator('sawtooth', frequency, filter, time, length, 0, [filter, drive, envelope]);
        return true;
      }
      case 'sccpluck': {
        // Karplus–Strong: an actual noise impulse circulating through a damped delay.
        const delay = context.createDelay(0.1); delay.delayTime.value = Math.min(0.09, 1 / frequency);
        const damping = context.createBiquadFilter(); damping.frequency.value = Math.min(14000, frequency * 7);
        const feedback = context.createGain(); feedback.gain.value = 0.985;
        const envelope = this.envelope(target, time, length, velocity * 0.6, 0.002, length * 0.35);
        delay.connect(damping).connect(feedback).connect(delay);
        delay.connect(envelope);
        const impulseLength = Math.max(8, Math.floor(context.sampleRate / frequency));
        const buffer = context.createBuffer(1, impulseLength, context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let index = 0; index < data.length; index++) data[index] = Math.random() * 2 - 1;
        const excitation = context.createBufferSource(); excitation.buffer = buffer; excitation.connect(delay);
        this.track(excitation, time, impulseLength / context.sampleRate);
        const lifetime = context.createConstantSource(); lifetime.offset.value = 0; lifetime.connect(envelope);
        this.track(lifetime, time, length, [delay, damping, feedback, envelope]);
        return true;
      }
      case 'sccbell': {
        const envelope = this.envelope(target, time, length, velocity * 0.27, 0.002, length * 0.9);
        const carrier = this.oscillator('sine', frequency, envelope, time, length + 0.002, 0, [envelope]);
        const modulation = this.envelope(carrier.frequency, time, length * 0.8,
          frequency * 0.9, 0.001, length * 0.7);
        this.oscillator('sine', frequency * 2.76, modulation, time, length * 0.8, 0, [modulation]);
        const overtone = this.envelope(target, time, length * 0.48, velocity * 0.07, 0.001, length * 0.4);
        this.oscillator('sine', frequency * 4.07, overtone, time, length * 0.48, 0, [overtone]);
        return true;
      }
      case 'sccpad': {
        const envelope = this.envelope(target, time, length, velocity * 0.17, length * 0.28, length * 0.28);
        this.oscillator('triangle', frequency, envelope, time, length, -8);
        this.oscillator('sine', frequency * 0.5, envelope, time, length, 0);
        this.oscillator('triangle', frequency, envelope, time, length + 0.002, 8, [envelope]);
        return true;
      }
      case 'sccorgan': {
        const envelope = this.envelope(target, time, length, velocity * 0.28, 0.003, Math.min(0.04, length * 0.2));
        const weights = [0.2, 0.75, 0.32, 0.15];
        [0.5, 1, 2, 3].forEach((ratio, index) => {
          const partial = context.createGain(); partial.gain.value = weights[index]; partial.connect(envelope);
          this.oscillator('sine', frequency * ratio, partial, time, length + index * 0.001,
            0, index === 3 ? [partial, envelope] : [partial]);
        });
        return true;
      }
      case 'sccfm': {
        const envelope = this.envelope(target, time, length, velocity * 0.31, 0.004, length * 0.8);
        const carrier = this.oscillator('sine', frequency, envelope, time, length + 0.002, 0, [envelope]);
        const modulation = this.envelope(carrier.frequency, time, length * 0.7,
          frequency * 1.4, 0.001, length * 0.65);
        this.oscillator('sine', frequency * 2, modulation, time, length * 0.7, 0, [modulation]);
        return true;
      }
      default: return false;
    }
  }

  private sendMidi(loop: Loop, event: NoteEvent): void {
    if (!this.midi || this.midi.state !== 'connected' || loop.role !== 'melody') return;
    const note = Math.max(0, Math.min(127, Math.round(event.note)));
    try {
      this.midi.send([0x90, note, Math.round(event.velocity * 127)]);
      this.midi.send([0x80, note, 0], performance.now() + event.duration * this.stepSeconds * 1000);
    } catch { this.midi = undefined; }
  }

  private silenceMidi(): void {
    if (!this.midi) return;
    try { this.midi.clear?.(); this.midi.send([0xb0, 123, 0]); } catch { /* An unplugged output is harmless. */ }
  }

  private stopVoices(): void {
    for (const voice of this.voices) { try { voice.stop(); } catch { /* Already stopped. */ } }
    this.voices.clear();
  }
}
