/**
 * Guard: no CommonJS `require(...)` in CDS source (ESM runtime).
 *
 * CDS ships as an ESM module (package.json "type":"module"). At runtime there
 * is no `require()`, so any `const x = require('node:crypto')` throws
 * "require is not defined" the moment that code path executes. vitest masks
 * this (its CJS interop provides a `require`), so unit tests pass while the
 * real server 500s — exactly the bug found in the 2026-06-20 visual acceptance
 * pass (memory-store auth fully broken under CDS_AUTH_BACKEND=memory, plus
 * projects.ts compose fallback). This static scan fails the build if the
 * anti-pattern reappears in real TS code, since runtime tests cannot catch it.
 *
 * A `require(...)` that lives inside a backtick template literal — e.g. the
 * RESOURCE_TCP_PROXY_SCRIPT injected as a standalone CJS sidecar process — is
 * NOT a violation (require() is real in that separate process). We detect that
 * by backtick parity: if an odd number of unescaped backticks precede the
 * match, it sits inside a template literal and is skipped.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Strip // line comments and block comments (newlines preserved). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1);
}

/** True when an odd number of unescaped backticks precede `idx`. */
function insideTemplate(text: string, idx: number): boolean {
  let count = 0;
  for (let i = 0; i < idx; i++) {
    if (text[i] === '`' && text[i - 1] !== '\\') count++;
  }
  return count % 2 === 1;
}

const REQUIRE_CALL = /(^|[^.\w])require\s*\(/g;

describe('ESM hygiene — no CommonJS require() in src', () => {
  it('contains zero runtime require() call expressions', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const text = stripComments(readFileSync(file, 'utf8'));
      let m: RegExpExecArray | null;
      REQUIRE_CALL.lastIndex = 0;
      while ((m = REQUIRE_CALL.exec(text)) !== null) {
        const matchAt = m.index + m[1].length;
        if (insideTemplate(text, matchAt)) continue;
        const line = text.slice(0, matchAt).split('\n').length;
        offenders.push(`${file}:${line}`);
      }
    }
    expect(
      offenders,
      `ESM modules cannot call require() at runtime. Use a top-level import instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
