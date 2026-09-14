import { GENRE_IDS } from '../../shared/profiles';
import type { GenreId } from '../../shared/music';

export interface GenreHistory { last: GenreId | null; remaining: GenreId[] }
const isGenre = (value: unknown): value is GenreId => GENRE_IDS.includes(value as GenreId);

export function readGenreHistory(value: unknown): GenreHistory {
  if (!value || typeof value !== 'object') return { last: null, remaining: [] };
  const history = value as Partial<GenreHistory>;
  return {
    last: isGenre(history.last) ? history.last : null,
    remaining: Array.isArray(history.remaining) ? [...new Set(history.remaining.filter(isGenre))] : [],
  };
}

/** A shuffle bag prevents repeats across reloads and visits every genre per bag. */
export function chooseGenre(history: GenreHistory, random: () => number = Math.random, preferred?: GenreId): GenreId {
  let available = history.remaining.filter(id => id !== history.last);
  if (!available.length) available = GENRE_IDS.filter(id => id !== history.last);
  if (preferred && preferred !== history.last && available.includes(preferred)) return preferred;
  return available[Math.min(available.length - 1, Math.max(0, Math.floor(random() * available.length)))];
}

export function commitGenre(history: GenreHistory, genre: GenreId): GenreHistory {
  const remaining = history.remaining.some(id => id !== history.last) ? history.remaining : [...GENRE_IDS];
  return { last: genre, remaining: remaining.filter(id => id !== genre) };
}
