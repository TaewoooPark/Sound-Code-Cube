import { readdir, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_BANK_COUNTS } from '../shared/profiles.ts';
import { BridgeError } from './validation.ts';

const sampleRoot = process.env.SCC_SAMPLE_ROOT ? resolve(process.env.SCC_SAMPLE_ROOT)
  : fileURLToPath(new URL('../.runtime/Dirt-Samples/', import.meta.url));
const bankCache = new Map<string, string[]>();

/** The bank and index address the same sorted WAV files that SuperDirt loads. */
export async function sampleFile(bank: unknown, index: unknown): Promise<string> {
  if (typeof bank !== 'string' || !Object.hasOwn(SAMPLE_BANK_COUNTS, bank)
    || typeof index !== 'string' || !/^(0|[1-9]\d{0,2})$/.test(index)) {
    throw new BridgeError(404, 'SAMPLE_NOT_FOUND', 'No such sample.');
  }
  const number = Number(index);
  if (number >= SAMPLE_BANK_COUNTS[bank as keyof typeof SAMPLE_BANK_COUNTS]) throw new BridgeError(404, 'SAMPLE_NOT_FOUND', 'No such sample.');
  try {
    const root = await realpath(sampleRoot);
    const directory = await realpath(resolve(root, bank));
    if (!directory.startsWith(root + sep)) throw new Error('Sample directory escapes its root.');
    let files = bankCache.get(bank);
    if (!files) {
      files = (await readdir(directory, { withFileTypes: true })).filter(file => file.isFile() && /\.wav$/i.test(file.name)).map(file => file.name).sort();
      bankCache.set(bank, files);
    }
    if (!files[number]) throw new Error('Sample index is unavailable.');
    const file = await realpath(resolve(directory, files[number]));
    if (!file.startsWith(directory + sep)) throw new Error('Sample file escapes its bank.');
    const information = await stat(file);
    if (!information.isFile() || information.size > 32 * 1024 * 1024) throw new Error('Sample is not a bounded WAV file.');
    return file;
  } catch {
    throw new BridgeError(404, 'SAMPLE_NOT_FOUND', 'The local Dirt sample is unavailable.');
  }
}
