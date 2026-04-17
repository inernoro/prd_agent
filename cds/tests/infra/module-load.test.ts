/**
 * Module-load smoke test — P4 Part 18 hardening.
 *
 * This test exists to catch the exact class of bug that crashed
 * CDS during the Phase E self-update: an ESM `require()` call
 * that compiled clean but threw at runtime. Type-checks don't
 * catch it, unit tests don't exercise it unless they happen to
 * import the file, and the first thing that hits it is a real
 * self-update triggering a real crash on the real server.
 *
 * The strategy: import every route and service module from
 * src/ at test time. Any module that throws during its own
 * top-level evaluation (ReferenceError, SyntaxError, missing
 * dependency) will fail the test with a clear message pointing
 * at the offending file.
 *
 * This test is paired with the /api/self-update-dry-run endpoint
 * and the self-update route's pre-restart validation — together
 * they make it very hard for CDS to brick itself during an
 * in-place upgrade.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '..', '..', 'src');

/**
 * Walk the src/ tree and collect all .ts files we want to load.
 * We exclude:
 *   - test files (won't be in src/ anyway, but defensive)
 *   - index.ts (it has side-effects like listen() that break tests)
 */
function collectTsFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      collectTsFiles(full, out);
      continue;
    }
    if (!name.endsWith('.ts')) continue;
    if (name.endsWith('.test.ts') || name.endsWith('.spec.ts')) continue;
    // index.ts is the process entry point — it has top-level await
    // initStateService() and tries to bind ports. Skip it.
    if (full === path.join(srcDir, 'index.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('Module load smoke (P4 Part 18 hardening)', () => {
  const files = collectTsFiles(srcDir);

  it('finds modules to load', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  // Each module gets its own it() so a failure points at the
  // specific file, not a generic "30 files failed to load". This
  // matters enormously when debugging — the previous ESM require()
  // bug would now flag exactly server.ts in the test output.
  for (const file of files) {
    const rel = path.relative(srcDir, file);
    it(`loads ${rel}`, async () => {
      // Vitest resolves .ts extensions automatically via its
      // dev server, so we import the source path directly.
      await expect(import(file)).resolves.toBeDefined();
    });
  }
});
