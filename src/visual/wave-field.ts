/**
 * A scalar pressure field, not a particle or spring animation.
 *
 * The six-neighbour Laplacian propagates each cell's disturbance into adjacent
 * cells: a discrete form of the secondary-wave construction behind Huygens'
 * principle. The linear update preserves superposition. Mirrored ghost cells
 * impose zero normal pressure gradient (a rigid, reflecting wall).
 *
 * Coordinates and sound speed are intentionally slowed to visual units. This
 * is a finite-resolution acoustic analogy, not an audible-frequency room model.
 */
export interface WaveFieldOptions {
  size?: number;
  length?: number;
  speed?: number;
  timeStep?: number;
  damping?: number;
}

export class WaveField {
  readonly size: number;
  readonly length: number;
  readonly speed: number;
  readonly timeStep: number;
  readonly spacing: number;
  readonly courant: number;
  readonly damping: number;
  current: Float32Array;
  previous: Float32Array;
  private next: Float32Array;

  constructor(options: WaveFieldOptions = {}) {
    this.size = options.size ?? 33;
    this.length = options.length ?? 3;
    this.speed = options.speed ?? 1.45;
    this.timeStep = options.timeStep ?? 1 / 90;
    this.damping = options.damping ?? 0.42;
    if (!Number.isInteger(this.size) || this.size < 3) throw new RangeError('Wave grid must have at least three cells per axis.');
    if (!(this.length > 0) || !(this.speed > 0) || !(this.timeStep > 0) || !(this.damping >= 0)) {
      throw new RangeError('Wave parameters must be finite and positive.');
    }
    if (![this.length, this.speed, this.timeStep, this.damping].every(Number.isFinite)) throw new RangeError('Wave parameters must be finite.');
    this.spacing = this.length / (this.size - 1);
    this.courant = this.speed * this.timeStep / this.spacing;
    // Three spatial dimensions: c * dt / dx <= 1 / sqrt(3).
    if (this.courant > 1 / Math.sqrt(3)) throw new RangeError('Time step violates the 3D wave CFL stability bound.');
    const volume = this.size ** 3;
    this.current = new Float32Array(volume);
    this.previous = new Float32Array(volume);
    this.next = new Float32Array(volume);
  }

  index(x: number, y: number, z: number): number {
    return x + this.size * (y + this.size * z);
  }

  clear(): void {
    this.current.fill(0);
    this.previous.fill(0);
    this.next.fill(0);
  }

  /** Add an external pressure acceleration, integrated over one solver step. */
  force(x: number, y: number, z: number, amplitude: number): void {
    if (!Number.isFinite(amplitude)) return;
    const n = this.size - 1;
    const i = this.index(Math.max(0, Math.min(n, Math.round(x))), Math.max(0, Math.min(n, Math.round(y))), Math.max(0, Math.min(n, Math.round(z))));
    this.current[i] += amplitude * this.timeStep ** 2;
  }

  /** Corner numbering is x + 2y + 4z, with 0 negative and 1 positive. */
  forceCorner(id: number, amplitude: number): void {
    if (!Number.isInteger(id) || id < 0 || id > 7) return;
    const last = this.size - 1;
    this.force(id & 1 ? last : 0, id & 2 ? last : 0, id & 4 ? last : 0, amplitude);
  }

  step(count = 1): void {
    const n = this.size;
    const n2 = n * n;
    const lambda2 = this.courant ** 2;
    const damping = this.damping * this.timeStep / 2;
    const invDamping = 1 / (1 + damping);
    for (let step = 0; step < count; step++) {
      const u = this.current;
      const prev = this.previous;
      const next = this.next;
      let i = 0;
      for (let z = 0; z < n; z++) {
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++, i++) {
            // Neumann ghosts are reflected about the boundary cell face.
            const laplacian = u[x > 0 ? i - 1 : i] + u[x < n - 1 ? i + 1 : i]
              + u[y > 0 ? i - n : i] + u[y < n - 1 ? i + n : i]
              + u[z > 0 ? i - n2 : i] + u[z < n - 1 ? i + n2 : i] - 6 * u[i];
            next[i] = (2 * u[i] - (1 - damping) * prev[i] + lambda2 * laplacian) * invDamping;
          }
        }
      }
      this.previous = u;
      this.current = next;
      this.next = prev;
    }
  }

  /** Trilinear pressure sample at coordinates in [-length/2, length/2]. */
  sample(x: number, y: number, z: number): number {
    const n = this.size;
    const half = this.length / 2;
    const gx = Math.max(0, Math.min(n - 1.000001, (x + half) / this.spacing));
    const gy = Math.max(0, Math.min(n - 1.000001, (y + half) / this.spacing));
    const gz = Math.max(0, Math.min(n - 1.000001, (z + half) / this.spacing));
    const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
    const fx = gx - ix, fy = gy - iy, fz = gz - iz;
    const i = this.index(ix, iy, iz);
    const u = this.current;
    const n2 = n * n;
    const a = u[i] * (1 - fx) + u[i + 1] * fx;
    const b = u[i + n] * (1 - fx) + u[i + n + 1] * fx;
    const c = u[i + n2] * (1 - fx) + u[i + n2 + 1] * fx;
    const d = u[i + n2 + n] * (1 - fx) + u[i + n2 + n + 1] * fx;
    return (a * (1 - fy) + b * fy) * (1 - fz) + (c * (1 - fy) + d * fy) * fz;
  }

  peak(): number {
    let peak = 0;
    for (let i = 0; i < this.current.length; i++) peak = Math.max(peak, Math.abs(this.current[i]));
    return peak;
  }
}
