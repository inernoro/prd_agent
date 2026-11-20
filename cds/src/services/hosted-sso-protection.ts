import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Shared with the local forwarder. A site is marked before its policy is published. */
export function siteProtectionMarkers(routesFile: string) {
  const directory = path.join(path.dirname(routesFile), 'site-sso-protected');
  const marker = (branchId: string) => path.join(directory, createHash('sha256').update(branchId).digest('hex'));
  return {
    mark(branchId: string): void {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(marker(branchId), 'private\n', { mode: 0o600 });
    },
    has(branchId: string): boolean { return existsSync(marker(branchId)); },
  };
}
