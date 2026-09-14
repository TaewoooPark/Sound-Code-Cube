export interface GesturePoint { x: number; y: number; time: number }
export interface GestureResult {
  kind: 'tap' | 'drag' | 'throw';
  /** Release velocity in CSS pixels per millisecond. */
  vx: number;
  vy: number;
  reversals: number;
  travel: number;
}

export interface ProjectedCorner { id: number; x: number; y: number; depth: number }

/** Screen-space picking also reaches the far corners of a wireframe cube. */
export function hitTestProjectedCorner(corners: readonly ProjectedCorner[], x: number, y: number, radius = 22): number | null {
  let best: ProjectedCorner | undefined;
  let bestDistance = radius * radius;
  for (const corner of corners) {
    if (corner.depth < -1 || corner.depth > 1) continue;
    const distance = (corner.x - x) ** 2 + (corner.y - y) ** 2;
    if (distance < bestDistance - 0.1 || (Math.abs(distance - bestDistance) < 0.1 && (!best || corner.depth < best.depth))) {
      best = corner;
      bestDistance = distance;
    }
  }
  return best?.id ?? null;
}

/**
 * A deliberately conservative, DOM-independent gesture recognizer. A throw
 * needs three substantial opposing strokes, followed by a fast release. Small
 * tremors, circular drags, single flicks, and stopped zigzags stay ordinary drags.
 */
export class CubeGesture {
  private samples: GesturePoint[] = [];
  private startPoint: GesturePoint | null = null;
  private lastPoint: GesturePoint | null = null;
  private direction = { x: 0, y: 0 };
  private legLength = 0;
  private reverseVector = { x: 0, y: 0 };
  private reverseDistance = 0;
  private lastMotionTime = 0;
  private maxDistance = 0;
  private travel = 0;
  private reversals = 0;

  get active(): boolean { return this.startPoint !== null; }

  begin(point: GesturePoint): void {
    this.cancel();
    this.startPoint = { ...point };
    this.lastPoint = { ...point };
    this.lastMotionTime = point.time;
    this.samples.push({ ...point });
  }

  move(point: GesturePoint): void {
    if (!this.startPoint || !this.lastPoint || point.time < this.lastPoint.time) return;
    const dx = point.x - this.lastPoint.x;
    const dy = point.y - this.lastPoint.y;
    const distance = Math.hypot(dx, dy);
    this.maxDistance = Math.max(this.maxDistance, Math.hypot(point.x - this.startPoint.x, point.y - this.startPoint.y));
    this.travel += distance;
    if (distance > 0.4) {
      this.lastMotionTime = point.time;
      const ux = dx / distance, uy = dy / distance;
      if (this.legLength === 0) {
        this.direction = { x: ux, y: uy };
        this.legLength = distance;
      } else {
        const dot = ux * this.direction.x + uy * this.direction.y;
        if (dot < -0.55 && this.legLength >= 35) {
          this.reverseVector.x += dx;
          this.reverseVector.y += dy;
          this.reverseDistance += distance;
          if (Math.hypot(this.reverseVector.x, this.reverseVector.y) >= 35) {
            this.reversals++;
            const length = Math.hypot(this.reverseVector.x, this.reverseVector.y);
            this.direction = { x: this.reverseVector.x / length, y: this.reverseVector.y / length };
            this.legLength = this.reverseDistance;
            this.reverseVector = { x: 0, y: 0 };
            this.reverseDistance = 0;
          }
        } else {
          this.reverseVector = { x: 0, y: 0 };
          this.reverseDistance = 0;
          // Follow a smooth arc rather than comparing every movement to the
          // initial axis; a normal circular orbit must not become a zigzag.
          const mix = dot > 0 ? 0.22 : 0.4;
          const x = this.direction.x * (1 - mix) + ux * mix;
          const y = this.direction.y * (1 - mix) + uy * mix;
          const length = Math.hypot(x, y) || 1;
          this.direction = { x: x / length, y: y / length };
          this.legLength += distance;
        }
      }
    }
    this.lastPoint = { ...point };
    this.samples.push({ ...point });
    if (this.samples.length > 180) this.samples.shift();
  }

  end(point: GesturePoint): GestureResult {
    if (!this.startPoint) return { kind: 'drag', vx: 0, vy: 0, reversals: 0, travel: 0 };
    this.move(point);
    const duration = point.time - this.startPoint.time;
    const recent = this.samples.filter(sample => sample.time >= point.time - 90);
    const first = recent[0] ?? point;
    const dt = Math.max(8, point.time - first.time);
    const vx = point.time - this.lastMotionTime <= 65 ? (point.x - first.x) / dt : 0;
    const vy = point.time - this.lastMotionTime <= 65 ? (point.y - first.y) / dt : 0;
    const tap = this.maxDistance <= 9 && duration <= 500;
    const intentionalThrow = !tap && duration <= 2600 && this.reversals >= 2 && this.travel >= 220 && Math.hypot(vx, vy) >= 0.8;
    const result: GestureResult = { kind: tap ? 'tap' : intentionalThrow ? 'throw' : 'drag', vx, vy, reversals: this.reversals, travel: this.travel };
    this.cancel();
    return result;
  }

  cancel(): void {
    this.samples.length = 0;
    this.startPoint = null;
    this.lastPoint = null;
    this.direction = { x: 0, y: 0 };
    this.legLength = 0;
    this.reverseVector = { x: 0, y: 0 };
    this.reverseDistance = 0;
    this.maxDistance = 0;
    this.travel = 0;
    this.reversals = 0;
  }
}
