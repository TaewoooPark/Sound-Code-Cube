import { PALETTES, paletteGradient, type ColorMapSettings, type PaletteName } from './visual/colormap';

const DEFAULTS: ColorMapSettings = { palette: 'turbo', min: 0, max: 1, intensity: 1 };
const STORAGE_KEY = 'sound-code-cube:colors:v1';

/** Icon-only controls keep every visible word on the canvas actual Tidal source. */
export class ColorControls {
  private settings: ColorMapSettings = { ...DEFAULTS };
  readonly element = document.createElement('aside');
  private readonly toggle: HTMLButtonElement;
  private readonly panel: HTMLDivElement;
  private readonly gradient: HTMLDivElement;
  private readonly minInput: HTMLInputElement;
  private readonly maxInput: HTMLInputElement;
  private readonly intensityInput: HTMLInputElement;
  private readonly indicator: HTMLElement;
  private readonly paletteButtons: HTMLButtonElement[] = [];
  private genreHue = 0;
  private renderedHueKey = 0;

  constructor(private readonly onChange: (settings: ColorMapSettings) => void) {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      if (value && PALETTES.some(p => p.id === value.palette)
        && Number.isFinite(value.min) && Number.isFinite(value.max) && value.min >= 0 && value.max <= 1 && value.max - value.min >= .039
        && Number.isFinite(value.intensity) && value.intensity >= .25 && value.intensity <= 4) {
        this.settings = { palette: value.palette, min: value.min, max: value.max, intensity: value.intensity };
      }
    } catch { /* Storage may be disabled; defaults remain fully functional. */ }
    this.element.className = 'color-controls';
    this.element.setAttribute('aria-label', '파동 컬러맵 설정');
    this.element.innerHTML = `
      <button class="color-toggle" type="button" aria-label="컬러맵 설정 열기" aria-expanded="false" aria-controls="color-panel">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h7m4 0h5M4 17h3m4 0h9"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>
        <span class="palette-indicator" aria-hidden="true"></span>
      </button>
      <div id="color-panel" class="color-panel" hidden>
        <div class="palette-options" role="group" aria-label="컬러맵 선택"></div>
        <div class="range-control" role="group" aria-label="컬러맵에서 사용할 색상 구간">
          <div class="range-gradient" aria-hidden="true"><span class="range-mask left"></span><span class="range-mask right"></span></div>
          <input class="range-min" type="range" min="0" max="100" step="1" aria-label="컬러맵 시작 색상" />
          <input class="range-max" type="range" min="0" max="100" step="1" aria-label="컬러맵 끝 색상" />
        </div>
        <div class="intensity-control">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M1 12h4l2-6 3 13 3-16 3 13 2-4h5"/></svg>
          <input class="intensity" type="range" min="25" max="400" step="5" aria-label="파동 진폭의 색상 감도" />
        </div>
      </div>`;
    this.toggle = this.element.querySelector('.color-toggle')!;
    this.panel = this.element.querySelector('.color-panel')!;
    this.gradient = this.element.querySelector('.range-gradient')!;
    this.minInput = this.element.querySelector('.range-min')!;
    this.maxInput = this.element.querySelector('.range-max')!;
    this.intensityInput = this.element.querySelector('.intensity')!;
    this.indicator = this.element.querySelector('.palette-indicator')!;
    const options = this.element.querySelector('.palette-options')!;
    for (const palette of PALETTES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'palette-option';
      button.dataset.palette = palette.id;
      button.style.backgroundImage = palette.gradient;
      button.setAttribute('aria-label', `${palette.label} 컬러맵`);
      button.addEventListener('click', () => {
        this.settings.palette = palette.id as PaletteName;
        this.sync();
      });
      options.append(button);
      this.paletteButtons.push(button);
    }
    this.toggle.addEventListener('click', () => this.setOpen(this.panel.hidden));
    this.minInput.addEventListener('input', () => {
      this.settings.min = Math.min(Number(this.minInput.value) / 100, this.settings.max - .04);
      this.sync();
    });
    this.maxInput.addEventListener('input', () => {
      this.settings.max = Math.max(Number(this.maxInput.value) / 100, this.settings.min + .04);
      this.sync();
    });
    this.intensityInput.addEventListener('input', () => {
      this.settings.intensity = Number(this.intensityInput.value) / 100;
      this.sync();
    });
    document.addEventListener('pointerdown', this.outside);
    document.addEventListener('keydown', this.escape);
    document.querySelector('#app')!.append(this.element);
    this.sync();
  }

  /** Preview the same genre hue offset as the cube, without changing settings. */
  setGenreHue(hue: number): void {
    if (!Number.isFinite(hue)) return;
    const normalized = ((hue % 1) + 1) % 1;
    const key = Math.round(normalized * 360) % 360;
    if (key === this.renderedHueKey) return;
    this.renderedHueKey = key;
    this.genreHue = key / 360;
    this.renderGradients();
  }

  private renderGradients(): void {
    const { palette, min, max } = this.settings;
    this.gradient.style.backgroundImage = paletteGradient(palette, 0, 1, this.genreHue);
    this.indicator.style.backgroundImage = paletteGradient(palette, min, max, this.genreHue);
    for (const button of this.paletteButtons) {
      button.style.backgroundImage = paletteGradient(button.dataset.palette as PaletteName, 0, 1, this.genreHue);
    }
  }

  private sync() {
    const { palette, min, max, intensity } = this.settings;
    this.minInput.value = String(Math.round(min * 100));
    this.maxInput.value = String(Math.round(max * 100));
    this.intensityInput.value = String(Math.round(intensity * 100));
    this.minInput.setAttribute('aria-valuetext', `${Math.round(min * 100)}%`);
    this.maxInput.setAttribute('aria-valuetext', `${Math.round(max * 100)}%`);
    this.intensityInput.setAttribute('aria-valuetext', `${intensity.toFixed(2)}×`);
    this.renderGradients();
    (this.element.querySelector('.range-mask.left') as HTMLElement).style.width = `${min * 100}%`;
    (this.element.querySelector('.range-mask.right') as HTMLElement).style.width = `${(1 - max) * 100}%`;
    this.paletteButtons.forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.palette === palette));
    });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings)); } catch { /* Optional persistence. */ }
    this.onChange({ ...this.settings });
  }

  private setOpen(open: boolean) {
    this.panel.hidden = !open;
    this.toggle.setAttribute('aria-expanded', String(open));
    this.toggle.setAttribute('aria-label', open ? '컬러맵 설정 닫기' : '컬러맵 설정 열기');
  }

  private outside = (event: PointerEvent) => {
    if (!this.element.contains(event.target as Node)) this.setOpen(false);
  };
  private escape = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !this.panel.hidden) { this.setOpen(false); this.toggle.focus(); }
  };

  dispose() {
    document.removeEventListener('pointerdown', this.outside);
    document.removeEventListener('keydown', this.escape);
    this.element.remove();
  }
}
