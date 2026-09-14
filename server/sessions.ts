import { BridgeError } from './validation.ts';

interface Identity { sessionId: string; revision: number; }
interface Lease extends Identity { controller: AbortController; ready: Promise<unknown>; }

function identity(input: Record<string, unknown>): Identity {
  if (typeof input.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.sessionId)
    || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0) {
    throw new BridgeError(400, 'INVALID_SESSION', 'A UUID sessionId and nonnegative integer revision are required.');
  }
  return { sessionId: input.sessionId, revision: Number(input.revision) };
}

const stale = () => new BridgeError(409, 'STALE_SESSION', 'This playback request has been superseded.');

/** Fences are advanced synchronously, before any native or subprocess await. */
export class SessionManager {
  private epoch = 0;
  private claimed = false;
  private active?: Lease;
  private revisions = new Map<string, number>();
  private legacy = new AbortController();
  private pending = new Set<Promise<unknown>>();
  private closed = false;

  snapshot(): { epoch: number } { return { epoch: this.epoch }; }

  /** Abort detached composer processes before the HTTP server exits. */
  async close(): Promise<void> {
    this.closed = true;
    this.claimed = true;
    this.epoch += 1;
    this.active?.controller.abort();
    this.legacy.abort();
    await Promise.allSettled([...this.pending]);
  }

  async claim(input: Record<string, unknown>, halt: () => Promise<unknown>): Promise<{ ok: true; epoch: number }> {
    if (this.closed) throw stale();
    const owner = identity(input);
    if (input.expectedEpoch !== this.epoch || owner.revision <= (this.revisions.get(owner.sessionId) ?? -1)) throw stale();
    const previous = [...this.pending];
    this.invalidate(owner);
    const lease: Lease = { ...owner, controller: new AbortController(), ready: Promise.resolve() };
    this.active = lease;
    // halt starts now, not after older composition/native operations complete.
    lease.ready = Promise.all([halt(), Promise.allSettled(previous)]);
    await lease.ready;
    if (lease.controller.signal.aborted || this.active !== lease) throw stale();
    return { ok: true, epoch: this.epoch };
  }

  async stop(input: Record<string, unknown>, halt: () => Promise<{ cycle?: number }>): Promise<{ ok: true; epoch: number; cycle?: number }> {
    if (this.closed) throw stale();
    const owner = identity(input);
    if ((this.active && this.active.sessionId !== owner.sessionId)
      || owner.revision <= (this.revisions.get(owner.sessionId) ?? -1)) throw stale();
    const previous = [...this.pending];
    this.invalidate(owner);
    const stopped = new AbortController();
    stopped.abort();
    this.active = { ...owner, controller: stopped, ready: Promise.resolve() };
    const epoch = this.epoch;
    const [timing] = await Promise.all([halt(), Promise.allSettled(previous)]);
    return { ok: true, epoch, ...timing };
  }

  async run<T>(input: Record<string, unknown>, disconnected: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw stale();
    let leaseSignal: AbortSignal;
    let ready: Promise<unknown> = Promise.resolve();
    if (input.sessionId === undefined && input.revision === undefined && !this.claimed) {
      leaseSignal = this.legacy.signal;
    } else {
      if (input.sessionId === undefined || input.revision === undefined) throw stale();
      const owner = identity(input);
      const lease = this.active;
      if (!lease || lease.sessionId !== owner.sessionId || lease.revision !== owner.revision || lease.controller.signal.aborted) throw stale();
      leaseSignal = lease.controller.signal;
      ready = lease.ready;
    }
    const signal = AbortSignal.any([leaseSignal, disconnected]);
    const task = (async () => {
      await ready;
      if (signal.aborted) throw stale();
      const result = await operation(signal);
      if (signal.aborted) throw stale();
      return result;
    })();
    this.pending.add(task);
    try { return await task; } finally { this.pending.delete(task); }
  }

  private invalidate(owner: Identity): void {
    this.claimed = true;
    this.epoch += 1;
    this.revisions.set(owner.sessionId, owner.revision);
    this.active?.controller.abort();
    this.legacy.abort();
  }
}
