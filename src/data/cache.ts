import * as fs from 'fs';
import * as path from 'path';
import { paths } from '../config/config';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export function readCache<T>(key: string): T | null {
  const file = path.join(paths.cache, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const entry: CacheEntry<T> = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() > entry.expiresAt) return null;
    return entry.value;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, value: T, ttlMs: number): void {
  const file = path.join(paths.cache, `${key}.json`);
  const entry: CacheEntry<T> = { expiresAt: Date.now() + ttlMs, value };
  fs.writeFileSync(file, JSON.stringify(entry));
}
