import fs from 'node:fs';
import path from 'node:path';

const CACHE_TTL_MS = 60_000;

const cache = new Map<string, { version: string | null; at: number }>();

export function readBundledCdsCliVersion(repoRoot: string): string | null {
  const key = path.resolve(repoRoot || '.');
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.version;
  }

  try {
    const cliPath = path.join(key, '.claude', 'skills', 'cds', 'cli', 'cdscli.py');
    if (!fs.existsSync(cliPath)) {
      cache.set(key, { version: null, at: now });
      return null;
    }
    const content = fs.readFileSync(cliPath, 'utf-8');
    const match = content.match(/^VERSION\s*=\s*"([^"]+)"/m);
    const version = match ? match[1] : null;
    cache.set(key, { version, at: now });
    return version;
  } catch {
    cache.set(key, { version: null, at: now });
    return null;
  }
}

export function clearBundledCdsCliVersionCache(): void {
  cache.clear();
}
