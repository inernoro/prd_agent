import { createHash, randomBytes } from 'node:crypto';

function digest(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** In-process credentials that expire or fail closed after a control-plane restart. */
export class ExpiringTokens<T> {
  private readonly entries = new Map<string, { value: T; deadline: number }>();
  private nextSweep = 0;

  constructor(private readonly maxEntries: number) {}

  issue(value: T, lifetimeMs: number): string | undefined {
    const now = Date.now();
    if (now >= this.nextSweep) {
      this.nextSweep = now + 15_000;
      for (const [key, entry] of this.entries) {
        if (entry.deadline <= now) this.entries.delete(key);
      }
    }
    if (this.entries.size >= this.maxEntries) return undefined;
    const token = randomBytes(32).toString('base64url');
    this.entries.set(digest(token), { value, deadline: now + lifetimeMs });
    return token;
  }

  read(token: unknown, consume = false): T | undefined {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const key = digest(token);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (consume || entry.deadline <= Date.now()) this.entries.delete(key);
    return entry.deadline > Date.now() ? entry.value : undefined;
  }
}
