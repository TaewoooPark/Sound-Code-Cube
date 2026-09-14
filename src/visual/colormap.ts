export type PaletteName = 'turbo' | 'plasma' | 'viridis' | 'icefire' | 'spectral';

export interface ColorMapSettings {
  palette: PaletteName;
  /** Portion of the palette to use; these are color coordinates, not cutoffs. */
  min: number;
  max: number;
  intensity: number;
}

const STOPS: Record<PaletteName, readonly string[]> = {
  turbo: ['#30123b', '#4662d7', '#36aaf9', '#1ae4b6', '#72fe5e', '#c8ef34', '#faba39', '#f66b19', '#c52603', '#7a0403'],
  plasma: ['#0d0887', '#4903a0', '#7e03a8', '#aa2395', '#cc4778', '#e66c5c', '#f89540', '#fdc328', '#f0f921'],
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  icefire: ['#b4e4df', '#55a2ce', '#3263b4', '#343d75', '#202027', '#361d29', '#7d233c', '#bd3c37', '#ed8249', '#f9db91'],
  spectral: ['#5e4fa2', '#3288bd', '#66c2a5', '#abdda4', '#e6f598', '#ffffbf', '#fee08b', '#fdae61', '#f46d43', '#d53e4f', '#9e0142'],
};

const RGB_STOPS = Object.fromEntries(Object.entries(STOPS).map(([id, stops]) => [id, stops.map(hex => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
])])) as Record<PaletteName, number[][]>;

/** Return an interpolated normalized sRGB color. No time or random input. */
export function sampleColorMap(palette: PaletteName, t: number): [number, number, number] {
  const stops = RGB_STOPS[palette] ?? RGB_STOPS.turbo;
  const position = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const lower = Math.min(stops.length - 2, Math.floor(position));
  const fraction = position - lower;
  const a = stops[lower], b = stops[lower + 1];
  return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction, a[2] + (b[2] - a[2]) * fraction];
}

/** Match Three.js's linear working-space hue rotation, then return sRGB. */
export function sampleGenreColorMap(palette: PaletteName, t: number, hue = 0): [number, number, number] {
  const rgb = sampleColorMap(palette, t);
  const color = new Color().setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace);
  color.offsetHSL(Number.isFinite(hue) ? hue : 0, 0, 0);
  const result = color.getRGB({ r: 0, g: 0, b: 0 }, SRGBColorSpace);
  return [result.r, result.g, result.b];
}

export function paletteGradient(palette: PaletteName, min = 0, max = 1, hue = 0): string {
  const colors = Array.from({ length: 17 }, (_, index) => {
    const color = sampleGenreColorMap(palette, min + (max - min) * index / 16, hue);
    return `rgb(${color.map(channel => Math.round(channel * 255)).join(' ')}) ${index / 16 * 100}%`;
  });
  return `linear-gradient(90deg, ${colors.join(', ')})`;
}

export const PALETTES: ReadonlyArray<{ id: PaletteName; label: string; gradient: string }> = (Object.keys(STOPS) as PaletteName[]).map(id => ({
  id,
  label: id[0].toUpperCase() + id.slice(1),
  gradient: paletteGradient(id),
}));
import { Color, SRGBColorSpace } from 'three';
