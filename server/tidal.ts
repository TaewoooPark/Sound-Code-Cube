import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Loop } from '../shared/music.ts';
import { BridgeError } from './validation.ts';
import { runProcess } from './process.ts';

export interface TidalStatus {
  enabled: boolean;
  available: boolean;
  running: boolean;
  superDirtAvailable: boolean;
  reason: string | null;
}

function oscString(value: string): Buffer {
  const result = Buffer.alloc(Math.ceil((Buffer.byteLength(value) + 1) / 4) * 4);
  result.write(value);
  return result;
}

type OscArgument = number | string;

function superDirtCommand(path: string, values: OscArgument[], replyPath: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolveMute, rejectMute) => {
    const socket = createSocket('udp4');
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) rejectMute(error); else resolveMute();
    };
    const timer = setTimeout(() => finish(new BridgeError(503, 'TIDAL_UNAVAILABLE', 'SuperDirt did not acknowledge the command.')), timeoutMs);
    socket.once('error', error => finish(error));
    socket.on('message', (message, sender) => {
      if (sender.address === '127.0.0.1' && message.subarray(0, Buffer.byteLength(replyPath) + 1).toString() === replyPath + '\0') finish();
    });
    socket.bind(0, '127.0.0.1', () => {
      const args = [...values, socket.address().port];
      const tags = ',' + args.map(value => typeof value === 'string' ? 's' : Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? 'i' : 'd').join('');
      const bytes = args.map(value => {
        if (typeof value === 'string') return oscString(value);
        const integer = Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
        const buffer = Buffer.alloc(integer ? 4 : 8);
        if (integer) buffer.writeInt32BE(value); else buffer.writeDoubleBE(value);
        return buffer;
      });
      socket.send(Buffer.concat([oscString(path), oscString(tags), ...bytes]), 57120, '127.0.0.1', error => { if (error) finish(error); });
    });
  });
}

interface OperationGuard { epoch: number; signal?: AbortSignal; }

interface DeckState {
  loops: Map<number, Loop>;
  anchor?: { startAt: number; cycle: number; bpm: number };
  pausedCycle: number;
  bpm: number;
  fullScore: boolean;
}

const emptyDeck = (): DeckState => ({ loops: new Map(), pausedCycle: 0, bpm: 112, fullScore: false });

/** The supplied SuperDirt startup registers this readiness reply after sample loading. */
async function probeSuperDirt(): Promise<boolean> {
  return new Promise(resolveProbe => {
    const socket = createSocket('udp4');
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolveProbe(value);
    };
    const timer = setTimeout(() => finish(false), 350);
    socket.once('error', () => finish(false));
    socket.on('message', (message, sender) => {
      if (sender.address === '127.0.0.1' && message.subarray(0, 10).toString() === '/scc/pong\0') finish(true);
    });
    socket.bind(0, '127.0.0.1', () => {
      const address = socket.address();
      const port = Buffer.alloc(4);
      port.writeInt32BE(address.port);
      socket.send(Buffer.concat([oscString('/scc/ping'), oscString(',i'), port]), 57120, '127.0.0.1', error => { if (error) finish(false); });
    });
  });
}

export class TidalBridge {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<void>;
  private commandQueue: Promise<void> = Promise.resolve();
  private operationQueue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private nativeEpoch = Date.now();
  private paused = true;
  private lastFailure: string | null = null;
  private decks: [DeckState, DeckState] = [emptyDeck(), emptyDeck()];
  private activeDeck = 0;
  private fade?: { from: number; to: number; endAt: number };
  private fadeTimer?: ReturnType<typeof setTimeout>;
  private nextHitAt = new Map<number, number>();
  private cachedAvailability?: { at: number; ghci: boolean; dirt: boolean };
  readonly enabled = process.env.TIDAL_ENABLED === '1';
  get bpm(): number { return this.decks[this.activeDeck].bpm; }

  async status(): Promise<TidalStatus> {
    if (!this.enabled) return { enabled: false, available: false, running: false, superDirtAvailable: false, reason: 'disabled' };
    if (!this.cachedAvailability || Date.now() - this.cachedAvailability.at > 5000) {
      const [ghci, dirt] = await Promise.all([
        runProcess(process.env.GHCI_BIN || 'ghci', ['--numeric-version'], { timeoutMs: 3000, maxBytes: 8192 }).then(result => result.code === 0).catch(() => false),
        probeSuperDirt(),
      ]);
      this.cachedAvailability = { at: Date.now(), ghci, dirt };
    }
    const { ghci, dirt } = this.cachedAvailability;
    return {
      enabled: true, available: ghci && dirt, running: Boolean(this.child && this.child.exitCode === null && !this.startPromise),
      superDirtAvailable: dirt,
      reason: !ghci ? 'ghci-not-found' : !dirt ? 'superdirt-not-running' : this.lastFailure,
    };
  }

  private guard(signal?: AbortSignal): OperationGuard { return { epoch: this.nativeEpoch, signal }; }

  private check(guard?: OperationGuard): void {
    if (guard && (guard.epoch !== this.nativeEpoch || guard.signal?.aborted)) {
      throw new BridgeError(409, 'STALE_SESSION', 'This native operation has been cancelled.');
    }
  }

  play(loop: Loop, bpm: number, cycle?: number, signal?: AbortSignal): Promise<void> {
    const guard = this.guard(signal);
    const operation = this.operationQueue.catch(() => {}).then(async () => {
      this.check(guard);
      await this.start(guard);
      this.check(guard);
      const deck = this.decks[this.activeDeck];
      const initial = deck.loops.size === 0;
      await this.execute(`${initial ? `sccTempo ${this.activeDeck} ${bpm}\nsccCycle ${this.activeDeck} (${cycle ?? 0})\n` : ''}${this.pattern(loop, this.activeDeck, deck.fullScore)}`, guard);
      this.check(guard);
      deck.loops.set(loop.id, loop);
      deck.bpm = bpm;
    });
    this.operationQueue = operation;
    return operation;
  }

  /** Hits bypass the score queue but share its revocation fence. */
  async trigger(loop: Loop, bpm: number, velocity = 1, signal?: AbortSignal): Promise<void> {
    const guard = this.guard(signal);
    this.check(guard);
    const status = await this.status();
    this.check(guard);
    if (this.paused) throw new BridgeError(409, 'TRANSPORT_PAUSED', 'Start playback before triggering an instrument.');
    if (!status.enabled || !status.superDirtAvailable) throw new BridgeError(503, 'TIDAL_UNAVAILABLE', 'Native instruments are unavailable.');
    const firstStep = Math.min(...loop.events.map(event => event.step));
    const [sound, sample] = loop.sound.split(':');
    const now = Date.now();
    const onset = Math.max(now, this.nextHitAt.get(loop.id) ?? 0);
    this.nextHitAt.set(loop.id, onset + 35);
    const delaySeconds = Math.max(0, (onset - now) / 1000);
    await Promise.all(loop.events.filter(event => event.step === firstStep).map(event =>
      superDirtCommand('/scc/hit', [sound, event.note, (loop.gain * event.velocity * velocity) ** 0.25,
        Math.min(1.2, event.duration * 60 / bpm / 4), (loop.pan + 1) / 2, loop.cutoff, Number(sample ?? 0), delaySeconds, guard.epoch], '/scc/hit-done')));
    this.check(guard);
  }

  transition(loops: Loop[], bpm: number, durationSeconds = 8, signal?: AbortSignal): Promise<{ startAt: number; durationSeconds: number; cycle: number }> {
    const guard = this.guard(signal);
    const operation = this.operationQueue.catch(() => {}).then(async () => {
      this.check(guard);
      if (this.paused) throw new BridgeError(409, 'TRANSPORT_PAUSED', 'Start playback before changing genres.');
      if (this.fade && Date.now() < this.fade.endAt) throw new BridgeError(409, 'TRANSITION_BUSY', 'A genre transition is already in progress.');
      if (this.fade) await this.finishFade(guard);
      await this.start(guard);
      this.check(guard);
      const from = this.activeDeck;
      const to = 1 - from;
      this.decks[to] = { loops: new Map(loops.map(loop => [loop.id, loop])), bpm, pausedCycle: 0, fullScore: true };
      await this.installDeck(to, 0, guard);
      this.check(guard);
      const startAt = Date.now() + 700;
      await this.setDeckClock(to, 0, startAt, guard);
      this.check(guard);
      await superDirtCommand('/scc/mix', [to, durationSeconds, Math.max(0, (startAt - Date.now()) / 1000), guard.epoch], '/scc/mixed');
      this.check(guard);
      this.activeDeck = to;
      this.fade = { from, to, endAt: startAt + durationSeconds * 1000 };
      this.fadeTimer = setTimeout(() => {
        const cleanup = this.operationQueue.catch(() => {}).then(() => { this.check(guard); return this.finishFade(guard); });
        this.operationQueue = cleanup;
        cleanup.catch(() => { if (guard.epoch === this.nativeEpoch) this.lastFailure = 'tidal-transition-cleanup-failed'; });
      }, Math.max(0, this.fade.endAt - Date.now()));
      this.fadeTimer.unref();
      return { startAt, durationSeconds, cycle: 0 };
    });
    this.operationQueue = operation;
    return operation;
  }

  transport(action: 'start' | 'pause' | 'resume' | 'reset', loops: Loop[] | undefined, bpm: number, cycle?: number, signal?: AbortSignal, fullScore?: boolean): Promise<{ startAt?: number; cycle?: number }> {
    if (action === 'pause' || action === 'reset') {
      if (signal?.aborted) return Promise.reject(new BridgeError(409, 'STALE_SESSION', 'This native operation has been cancelled.'));
      return this.stop(action);
    }
    const guard = this.guard(signal);
    const operation = this.operationQueue.catch(() => {}).then(async () => {
      this.check(guard);
      await this.start(guard);
      this.check(guard);
      this.cancelFade();
      if (action === 'start') { this.activeDeck = 0; this.decks = [emptyDeck(), emptyDeck()]; }
      const deck = this.decks[this.activeDeck];
      if (loops) deck.loops = new Map(loops.map(loop => [loop.id, loop]));
      if (fullScore !== undefined) deck.fullScore = fullScore;
      deck.bpm = bpm;
      const beginCycle = action === 'start' ? 0 : (cycle ?? deck.pausedCycle);
      await this.execute('sccHush 0\nsccHush 1', guard);
      await this.installDeck(this.activeDeck, beginCycle, guard);
      this.check(guard);
      await superDirtCommand('/scc/transport', [0, this.activeDeck, guard.epoch], '/scc/transported');
      this.check(guard);
      this.paused = false;
      const startAt = Date.now() + 700;
      await this.setDeckClock(this.activeDeck, beginCycle, startAt, guard);
      this.check(guard);
      return { startAt, cycle: beginCycle };
    });
    this.operationQueue = operation;
    return operation;
  }

  /** Priority stop: revoke queued work synchronously, mute now, then hush after any in-flight IO. */
  stop(action: 'pause' | 'reset'): Promise<{ cycle: number }> {
    this.nativeEpoch = Math.max(Date.now(), this.nativeEpoch + 1);
    const guard = this.guard();
    this.paused = true;
    this.cancelFade();
    this.nextHitAt.clear();
    this.decks.forEach((deck, index) => { deck.pausedCycle = this.currentCycle(index); deck.anchor = undefined; });
    const cycle = action === 'reset' ? 0 : this.decks[this.activeDeck].pausedCycle;
    const active = this.activeDeck;
    if (action === 'reset') { this.decks = [emptyDeck(), emptyDeck()]; this.activeDeck = 0; }
    // A boot in progress has no useful saved score and must not finish after stop.
    if (this.startPromise && this.child) this.child.kill();
    const pendingCommands = this.commandQueue.catch(() => {});
    let unavailable = false;
    const mute = async () => {
      if (!this.enabled || unavailable || guard.epoch !== this.nativeEpoch) return;
      try { await superDirtCommand('/scc/transport', [action === 'reset' ? 2 : 1, active, guard.epoch], '/scc/transported'); }
      catch (error) {
        if (guard.epoch !== this.nativeEpoch) return;
        const available = await probeSuperDirt();
        if (guard.epoch !== this.nativeEpoch) return;
        if (available) throw error;
        unavailable = true;
        this.close();
        this.cachedAvailability = undefined;
      }
    };
    const muted = mute();
    const operation = (async () => {
      await muted;
      await pendingCommands;
      if (guard.epoch !== this.nativeEpoch) return { cycle };
      if (this.child && !this.startPromise) await this.execute('sccHush 0\nsccHush 1', guard);
      // Also clear events which were already in the Tidal/OSC look-ahead window.
      await mute();
      return { cycle };
    })();
    this.operationQueue = operation;
    return operation;
  }

  private pattern(loop: Loop, deckIndex: number, fullScore: boolean): string {
    const pattern = loop.tidal.replace(/^d[1-8]\s*\$\s*/, '');
    return `streamReplace (sccStream ${deckIndex}) ${loop.id + 1} $ (filterWhen (>= ${fullScore ? 0 : loop.id * 2}) $ ${pattern}) # orbit ${deckIndex * 8 + loop.id}`;
  }

  private currentCycle(index = this.activeDeck): number {
    const deck = this.decks[index];
    if (!deck.anchor) return deck.pausedCycle;
    return Math.max(deck.anchor.cycle, deck.anchor.cycle + (Date.now() - deck.anchor.startAt) / 1000 * (deck.bpm / 60 / 4));
  }

  private async installDeck(index: number, beginCycle: number, guard: OperationGuard): Promise<void> {
    this.check(guard);
    const deck = this.decks[index];
    await this.execute(`sccHush ${index}\nsccTempo ${index} ${deck.bpm}\nsccCycle ${index} (-1000)\n${[...deck.loops.values()].map(loop => this.pattern(loop, index, deck.fullScore)).join('\n')}`, guard);
    this.check(guard);
    deck.pausedCycle = beginCycle;
  }

  private async setDeckClock(index: number, beginCycle: number, startAt: number, guard: OperationGuard): Promise<void> {
    this.check(guard);
    const deck = this.decks[index];
    const leadCycles = (Math.max(0, startAt - Date.now()) + 50) / 1000 * (deck.bpm / 60 / 4);
    await this.execute(`sccCycle ${index} (${beginCycle - leadCycles})`, guard);
    this.check(guard);
    deck.anchor = { startAt, cycle: beginCycle, bpm: deck.bpm };
    deck.pausedCycle = beginCycle;
  }

  private cancelFade(): void {
    if (this.fadeTimer) clearTimeout(this.fadeTimer);
    this.fadeTimer = undefined;
    this.fade = undefined;
  }

  private async finishFade(guard: OperationGuard): Promise<void> {
    this.check(guard);
    const fade = this.fade;
    if (!fade) return;
    this.cancelFade();
    await this.execute(`sccHush ${fade.from}`, guard);
    this.check(guard);
    await superDirtCommand('/scc/clear-deck', [fade.from, guard.epoch], '/scc/deck-cleared');
    this.check(guard);
    this.decks[fade.from] = emptyDeck();
  }

  private async start(guard: OperationGuard): Promise<void> {
    this.check(guard);
    if (this.startPromise) return this.startPromise;
    if (this.child && this.child.exitCode === null) return;
    const status = await this.status();
    this.check(guard);
    if (!status.enabled || !status.available) throw new BridgeError(503, 'TIDAL_UNAVAILABLE', status.reason || 'Native TidalCycles is unavailable.');
    const bootFile = process.env.TIDAL_BOOT_FILE ? resolve(process.env.TIDAL_BOOT_FILE) : fileURLToPath(new URL('../native/BootTidal.hs', import.meta.url));
    await access(bootFile).catch(() => { throw new BridgeError(503, 'TIDAL_UNAVAILABLE', 'Tidal boot file is missing.'); });
    this.check(guard);
    this.startPromise = new Promise<void>((resolveStart, rejectStart) => {
      const child = spawn(process.env.GHCI_BIN || 'ghci', ['-ignore-dot-ghci', '-v0', '-ghci-script', bootFile], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      let output = '';
      const cleanup = () => { clearTimeout(timer); child.stdout.off('data', onData); child.stderr.off('data', onData); };
      const fail = () => { cleanup(); this.lastFailure = 'tidal-boot-failed'; child.kill(); if (this.child === child) this.child = undefined; rejectStart(new BridgeError(503, 'TIDAL_UNAVAILABLE', 'TidalCycles could not start. Check its package and boot file.')); };
      const onData = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-32768);
        if (/error:|Could not find module|Variable not in scope/i.test(output)) { fail(); return; }
        if (output.includes('__SCC_TIDAL_READY__')) { cleanup(); this.lastFailure = null; resolveStart(); }
      };
      const timer = setTimeout(fail, 20000);
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      // Drain both streams even between commands so a verbose native process cannot stall.
      child.stdout.on('data', () => {});
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => {});
      child.once('error', fail);
      child.once('exit', () => { if (this.child === child) this.child = undefined; if (!output.includes('__SCC_TIDAL_READY__')) fail(); });
    }).finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  private execute(code: string, guard?: OperationGuard): Promise<void> {
    const operation = this.commandQueue.catch(() => {}).then(() => {
      this.check(guard);
      return new Promise<void>((resolveCommand, rejectCommand) => {
      const child = this.child;
      if (!child || child.exitCode !== null) return rejectCommand(new BridgeError(503, 'TIDAL_UNAVAILABLE', 'TidalCycles is not running.'));
      const marker = `__SCC_ACK_${++this.sequence}__`;
      let output = '';
      const cleanup = () => { clearTimeout(timer); child.stdout.off('data', onData); child.stderr.off('data', onData); child.off('exit', onExit); };
      const onExit = () => { cleanup(); rejectCommand(new BridgeError(503, 'TIDAL_UNAVAILABLE', 'TidalCycles stopped.')); };
      const onData = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-32768);
        if (/error:|Variable not in scope|Exception/i.test(output)) {
          cleanup();
          rejectCommand(new BridgeError(502, 'TIDAL_FAILED', 'The validated pattern was rejected by TidalCycles.'));
          return;
        }
        if (!output.includes(marker)) return;
        cleanup();
        try { this.check(guard); resolveCommand(); } catch (error) { rejectCommand(error); }
      };
      const timer = setTimeout(() => { cleanup(); this.close(); rejectCommand(new BridgeError(504, 'TIDAL_TIMEOUT', 'TidalCycles did not acknowledge its pattern.')); }, 5000);
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', onExit);
      // A single Haskell IO expression typechecks in full before any side effect;
      // its acknowledgement cannot run after a rejected pattern.
      const actions = code.split('\n').map(line => line.trim()).filter(Boolean).map(line => `(${line})`);
      child.stdin.write(`do { ${actions.join('; ')}; putStrLn "${marker}" }\n`);
      });
    });
    this.commandQueue = operation;
    return operation;
  }

  close(): void {
    this.cancelFade();
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.stdin.end('sccHush 0\nsccHush 1\n:quit\n');
    const timer = setTimeout(() => child.kill(), 1500);
    timer.unref();
  }
}
