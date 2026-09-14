import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WaveField } from './wave-field.ts';
import { PressureVolume } from './PressureVolume.ts';
import { sampleColorMap, type ColorMapSettings } from './colormap.ts';
import { CubeGesture, hitTestProjectedCorner, type GestureResult, type ProjectedCorner } from './gestures.ts';

export interface WaveCubeOptions {
  /** One callback per completed corner tap; deliberately no debounce. */
  onCorner?: (id: number) => void;
  /** A deliberate zigzag and fast release, at most once per 2.5 seconds. */
  onThrow?: () => void;
}

interface WavePulse {
  id: number;
  born: number;
  velocity: number;
  frequency: number;
}

const HALF = 1.5;
const CORNERS = Array.from({ length: 8 }, (_, id) => new THREE.Vector3(id & 1 ? HALF : -HALF, id & 2 ? HALF : -HALF, id & 4 ? HALF : -HALF));

/**
 * A continuous translucent heatmap of pressure waves in a rigid volume.
 * `update` advances the fixed-step simulation and renders. Orbit interaction
 * remains enabled while paused; simulation time and source motion are frozen.
 */
export class WaveCube {
  readonly field = new WaveField();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 80);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly observer: ResizeObserver;
  private readonly cube = new THREE.Group();
  private readonly markers: THREE.Mesh[] = [];
  private readonly halos: THREE.LineLoop[] = [];
  private readonly envelope = new Float32Array(8);
  private readonly sourceCursor = new Uint32Array(8);
  private readonly forces: WavePulse[] = [];
  private readonly volume: PressureVolume;
  private readonly paletteLut = new Float32Array(256 * 3);
  private readonly pointerEvents = new AbortController();
  private readonly gesture = new CubeGesture();
  private readonly pointerIds = new Set<number>();
  private readonly inertia = new THREE.Vector2();
  private readonly projectedPoint = new THREE.Vector3();
  private readonly genreAccent = new THREE.Color();
  private trackedPointer: number | null = null;
  private pressedCorner: number | null = null;
  private hoveredCorner: number | null = null;
  private lastThrowAt = -Infinity;
  private lastGesture: GestureResult | null = null;
  private genreHue = 0;
  private genreProgress = 1;
  private manualLife = 0;
  private colorSettings: ColorMapSettings = { palette: 'turbo', min: 0, max: 1, intensity: 1 };
  private active = 0;
  private paused = false;
  private simulationTime = 0;
  private accumulator = 0;
  private frame = 0;
  private disposed = false;

  constructor(private readonly container: HTMLElement, private readonly options: WaveCubeOptions = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:grab;';
    this.renderer.domElement.setAttribute('aria-label', 'Interactive three-dimensional sound wave cube');
    this.renderer.domElement.setAttribute('role', 'img');
    container.appendChild(this.renderer.domElement);
    this.scene.add(this.cube);

    this.camera.position.set(4.65, 3.6, 6.15);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.enablePan = false;
    this.controls.enableZoom = false;
    this.controls.rotateSpeed = 0.55;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.15;
    this.controls.addEventListener('start', () => {
      this.renderer.domElement.style.cursor = 'grabbing';
      this.controls.autoRotate = false;
    });
    this.controls.addEventListener('end', () => { this.renderer.domElement.style.cursor = this.hoveredCorner === null ? 'grab' : 'pointer'; });

    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(3, 3, 3));
    const cage = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }));
    cage.renderOrder = 2;
    this.cube.add(cage);
    this.addReferenceGrid();
    this.addCorners();

    this.volume = new PressureVolume(this.field.size);
    this.cube.add(this.volume.object);
    this.setColorMap(this.colorSettings);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.installPointerEvents();
  }

  /** Read-only viewport/client pixel coordinates, including occluded corners. */
  projectedCorners(): ProjectedCorner[] {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.cube.updateMatrixWorld(true);
    this.camera.updateMatrixWorld();
    return CORNERS.map((corner, id) => {
      const point = this.projectedPoint.copy(corner).applyMatrix4(this.cube.matrixWorld).project(this.camera);
      return { id, x: rect.left + (point.x + 1) * rect.width / 2, y: rect.top + (1 - point.y) * rect.height / 2, depth: point.z };
    });
  }

  hitTestCorner(clientX: number, clientY: number, radius = 22): number | null {
    return hitTestProjectedCorner(this.projectedCorners(), clientX, clientY, radius);
  }

  gestureDiagnostics(): { last: GestureResult | null; active: boolean; pointers: number } {
    return { last: this.lastGesture ? { ...this.lastGesture } : null, active: this.gesture.active, pointers: this.pointerIds.size };
  }

  private installPointerEvents(): void {
    const canvas = this.renderer.domElement;
    const signal = this.pointerEvents.signal;
    canvas.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      this.pointerIds.add(event.pointerId);
      this.inertia.set(0, 0);
      if (this.pointerIds.size > 1) {
        this.gesture.cancel();
        this.trackedPointer = null;
        this.pressedCorner = null;
        return;
      }
      this.trackedPointer = event.pointerId;
      this.pressedCorner = this.hitTestCorner(event.clientX, event.clientY, event.pointerType === 'touch' ? 29 : 22);
      this.gesture.begin({ x: event.clientX, y: event.clientY, time: event.timeStamp });
    }, { signal });
    canvas.addEventListener('pointermove', event => {
      if (event.pointerId === this.trackedPointer) {
        const samples = event.getCoalescedEvents?.() ?? [];
        for (const sample of samples) this.gesture.move({ x: sample.clientX, y: sample.clientY, time: sample.timeStamp });
        this.gesture.move({ x: event.clientX, y: event.clientY, time: event.timeStamp });
      }
      this.hoveredCorner = this.hitTestCorner(event.clientX, event.clientY, event.pointerType === 'touch' ? 29 : 22);
      if (!this.gesture.active) canvas.style.cursor = this.hoveredCorner === null ? 'grab' : 'pointer';
    }, { signal });
    canvas.addEventListener('pointerup', event => {
      this.pointerIds.delete(event.pointerId);
      if (event.pointerId !== this.trackedPointer) return;
      const result = this.gesture.end({ x: event.clientX, y: event.clientY, time: event.timeStamp });
      this.lastGesture = result;
      const corner = this.pressedCorner;
      this.trackedPointer = null;
      this.pressedCorner = null;
      if (result.kind === 'tap' && corner !== null) {
        this.envelope[corner] = 1;
        this.options.onCorner?.(corner);
      } else if (result.kind === 'throw') {
        const radiansPerPixel = Math.PI * 2 * this.controls.rotateSpeed / Math.max(240, canvas.clientHeight);
        this.inertia.set(THREE.MathUtils.clamp(result.vx * 1000 * radiansPerPixel, -9, 9), THREE.MathUtils.clamp(result.vy * 1000 * radiansPerPixel, -6, 6));
        this.controls.autoRotate = false;
        if (event.timeStamp - this.lastThrowAt >= 2500) {
          this.lastThrowAt = event.timeStamp;
          this.options.onThrow?.();
        }
      }
      canvas.style.cursor = this.hoveredCorner === null ? 'grab' : 'pointer';
    }, { signal });
    const cancel = (event: PointerEvent): void => {
      this.pointerIds.delete(event.pointerId);
      if (event.pointerId === this.trackedPointer) {
        this.gesture.cancel();
        this.trackedPointer = null;
        this.pressedCorner = null;
      }
    };
    canvas.addEventListener('pointercancel', cancel, { signal });
    canvas.addEventListener('lostpointercapture', cancel, { signal });
    canvas.addEventListener('pointerleave', () => {
      this.hoveredCorner = null;
      if (!this.gesture.active) canvas.style.cursor = 'grab';
    }, { signal });
  }

  private advanceInertia(elapsed: number): void {
    if (this.gesture.active || this.inertia.lengthSq() < 0.0001) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= this.inertia.x * elapsed;
    spherical.phi = THREE.MathUtils.clamp(spherical.phi - this.inertia.y * elapsed, 0.15, Math.PI - 0.15);
    this.camera.position.copy(this.controls.target).add(offset.setFromSpherical(spherical));
    this.inertia.multiplyScalar(Math.exp(-elapsed * 1.65));
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    // A bounding sphere preserves all eight corners at every drag orientation.
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect);
    const distance = 2.6 / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.05;
    this.camera.position.normalize().multiplyScalar(distance);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.volume.setQuality(width);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private addReferenceGrid(): void {
    const vertices: number[] = [];
    // Three rear planes supply a delicate spatial reference without a solid box.
    for (let i = 1; i < 6; i++) {
      const p = -HALF + i * 0.5;
      vertices.push(-HALF, -HALF, p, HALF, -HALF, p, p, -HALF, -HALF, p, -HALF, HALF);
      vertices.push(-HALF, p, -HALF, HALF, p, -HALF, p, -HALF, -HALF, p, HALF, -HALF);
      vertices.push(-HALF, -HALF, p, -HALF, HALF, p, -HALF, p, -HALF, -HALF, p, HALF);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    this.cube.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.035, depthWrite: false })));
  }

  private addCorners(): void {
    const ringVertices: number[] = [];
    for (let i = 0; i < 48; i++) {
      const angle = i / 48 * Math.PI * 2;
      ringVertices.push(Math.cos(angle) * 0.052, Math.sin(angle) * 0.052, 0);
    }
    for (let id = 0; id < 8; id++) {
      const marker = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.38 }));
      marker.position.copy(CORNERS[id]);
      marker.renderOrder = 3;
      this.cube.add(marker);
      this.markers.push(marker);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(ringVertices, 3));
      const halo = new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
      halo.position.copy(CORNERS[id]);
      halo.renderOrder = 3;
      this.cube.add(halo);
      this.halos.push(halo);
    }
  }

  setActive(count: number): void { this.active = Math.max(0, Math.min(8, Math.floor(count))); }
  get currentGenreHue(): number { return this.genreHue; }
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.forces.length = 0;
      this.manualLife = 0;
      this.inertia.set(0, 0);
    }
  }

  /**
   * Genre hues are turns (0..1), not degrees. The hue offset layers onto the
   * selected palette; palette name, lookup range, and intensity remain intact.
   * Call with progress 0..1 throughout a transition. At 1 the new hue persists.
   */
  setGenreTransition(fromHue: number, toHue: number, progress: number): void {
    const p = THREE.MathUtils.clamp(Number.isFinite(progress) ? progress : 1, 0, 1);
    const from = Number.isFinite(fromHue) ? fromHue : this.genreHue;
    const to = Number.isFinite(toHue) ? toHue : from;
    const difference = THREE.MathUtils.euclideanModulo(to - from + 0.5, 1) - 0.5;
    const eased = p * p * (3 - 2 * p);
    const hue = THREE.MathUtils.euclideanModulo(from + difference * eased, 1);
    if (Math.abs(hue - this.genreHue) > 0.0001) {
      this.genreHue = hue;
      this.rebuildPalette();
    }
    this.genreProgress = p;
    this.genreAccent.setHSL(THREE.MathUtils.euclideanModulo(hue + 0.55, 1), 0.94, 0.62);
    this.volume.setTransition(p, this.genreAccent);
  }

  setColorMap(settings: ColorMapSettings): void {
    const low = Number.isFinite(settings.min) ? Math.max(0, Math.min(1, settings.min)) : 0;
    const high = Number.isFinite(settings.max) ? Math.max(0, Math.min(1, settings.max)) : 1;
    this.colorSettings = {
      palette: settings.palette,
      min: Math.min(low, high),
      max: Math.max(low, high),
      intensity: Number.isFinite(settings.intensity) ? Math.max(0.1, Math.min(4, settings.intensity)) : 1,
    };
    this.rebuildPalette();
  }

  private rebuildPalette(): void {
    const color = new THREE.Color();
    for (let i = 0; i < 256; i++) {
      const rgb = sampleColorMap(this.colorSettings.palette, this.colorSettings.min + (this.colorSettings.max - this.colorSettings.min) * i / 255);
      color.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
      color.offsetHSL(this.genreHue, 0, 0);
      this.paletteLut[i * 3] = color.r;
      this.paletteLut[i * 3 + 1] = color.g;
      this.paletteLut[i * 3 + 2] = color.b;
    }
    this.volume.setPalette(this.paletteLut, this.colorSettings.intensity);
  }

  pulse(id: number, velocity: number, frequency: number, manual = false): void {
    if ((this.paused && !manual) || id < 0 || id > 7 || !Number.isInteger(id)) return;
    if (manual) this.manualLife = 1.4;
    const pulse = { id, velocity: Math.max(0, Math.min(1, velocity)), frequency: Math.max(20, frequency || 100), born: this.simulationTime };
    this.envelope[id] = Math.max(this.envelope[id], pulse.velocity);
    this.forces.push(pulse);
    if (this.forces.length > 80) this.forces.shift();
  }

  update(delta: number, _time: number, levels: ArrayLike<number>, waveforms?: Float32Array[]): void {
    if (this.disposed) return;
    const elapsed = Math.max(0, Math.min(0.075, delta));
    const advancing = !this.paused || this.manualLife > 0;
    this.manualLife = Math.max(0, this.manualLife - elapsed);
    if (advancing) {
      this.accumulator += elapsed;
      while (this.accumulator >= this.field.timeStep) {
        this.simulationTime += this.field.timeStep;
        this.driveSources(this.paused ? undefined : waveforms);
        this.field.step();
        this.accumulator -= this.field.timeStep;
      }
      for (let id = 0; id < 8; id++) {
        this.envelope[id] = Math.max(this.envelope[id] * Math.exp(-elapsed * 4.5), this.paused ? 0 : Math.min(1, levels[id] || 0) * 1.6);
      }
      if (this.frame++ % 2 === 0) this.refreshVolume();
      if (!this.paused) this.cube.position.y = Math.sin(this.simulationTime * 0.42) * 0.035;
    }
    this.advanceInertia(elapsed);
    const transition = Math.sin(this.genreProgress * Math.PI);
    for (let id = 0; id < 8; id++) {
      const level = this.envelope[id];
      const enabled = id < this.active;
      const hovered = id === this.hoveredCorner || id === this.pressedCorner;
      const material = this.markers[id].material as THREE.MeshBasicMaterial;
      material.opacity = hovered ? 1 : enabled ? 0.75 + level * 0.25 : 0.35 + level * 0.65;
      this.markers[id].scale.setScalar(1 + level * 1.25 + (hovered ? 1 : 0));
      const halo = this.halos[id];
      halo.quaternion.copy(this.camera.quaternion);
      halo.scale.setScalar(1 + level * 0.9 + (hovered ? 1.1 : 0) + transition * 1.9);
      const haloMaterial = halo.material as THREE.LineBasicMaterial;
      haloMaterial.opacity = Math.max(hovered ? 0.95 : 0, transition * 0.85, enabled ? 0.15 + level * 0.35 : level * 0.6);
      if (transition > 0.01 || hovered) haloMaterial.color.copy(this.genreAccent);
      else haloMaterial.color.set(0xffffff);
    }
    // Orbit damping works during pause, but automatic movement does not.
    const autoRotate = this.controls.autoRotate;
    if (this.paused) this.controls.autoRotate = false;
    this.controls.update(elapsed);
    this.controls.autoRotate = autoRotate;
    this.renderer.render(this.scene, this.camera);
  }

  private driveSources(waveforms?: Float32Array[]): void {
    for (let i = this.forces.length - 1; i >= 0; i--) {
      const pulse = this.forces[i];
      const age = this.simulationTime - pulse.born;
      if (age > 0.65) { this.forces.splice(i, 1); continue; }
      // A compact, approximately zero-mean Ricker pressure pulse. Audible
      // pitch is mapped to resolvable visual bandwidth below the grid Nyquist.
      const width = 8 + Math.min(5, Math.log2(pulse.frequency / 40 + 1));
      const phase = (age - 0.2) * width;
      const pressure = (1 - 2 * phase * phase) * Math.exp(-phase * phase);
      this.field.forceCorner(pulse.id, pressure * pulse.velocity * 360);
    }
    for (let id = 0; id < this.active; id++) {
      const signal = waveforms?.[id];
      if (!signal?.length) continue;
      // Time-domain channel samples drive the same pressure field. Reading
      // sparse samples slows their visible phase without simulating ultrasound.
      const sample = signal[(this.sourceCursor[id]++ * 5) % signal.length];
      this.field.forceCorner(id, Math.max(-1, Math.min(1, sample)) * 60);
    }
  }

  private refreshVolume(): void {
    const pressure = this.field.current;
    let sum = 0, squares = 0;
    for (let i = 0; i < pressure.length; i++) {
      sum += pressure[i];
      squares += pressure[i] * pressure[i];
    }
    const mean = sum / pressure.length;
    const rms = Math.sqrt(Math.max(0, squares / pressure.length - mean * mean));
    this.volume.updateField(pressure, mean, rms);
  }

  reset(): void {
    this.field.clear();
    this.forces.length = 0;
    this.envelope.fill(0);
    this.sourceCursor.fill(0);
    this.simulationTime = 0;
    this.accumulator = 0;
    this.active = 0;
    this.manualLife = 0;
    this.volume.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pointerEvents.abort();
    this.gesture.cancel();
    this.observer.disconnect();
    this.controls.dispose();
    this.scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach(material => material.dispose());
      else mesh.material?.dispose();
    });
    this.volume.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
