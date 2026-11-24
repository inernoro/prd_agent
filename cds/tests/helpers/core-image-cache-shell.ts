import type { ExecResult } from '../../src/types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach } from 'vitest';
export const CORE_TEST_IMAGE_A = 'sha256:' + 'a'.repeat(64);
export const CORE_TEST_IMAGE_B = 'sha256:' + 'b'.repeat(64);

/** Isolate default runtime data as well as image receipts between test cases. */
export function installCoreImageCacheTestRoot() {
  let root: string, previous: string | undefined;
  beforeEach(() => {
    previous = process.env.CDS_AGENT_WORKSPACE_ROOT;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-core-cache-test-'));
    process.env.CDS_AGENT_WORKSPACE_ROOT = root;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.CDS_AGENT_WORKSPACE_ROOT; else process.env.CDS_AGENT_WORKSPACE_ROOT = previous;
    fs.rmSync(root, { force: true, recursive: true });
    fs.rmSync(root + '-core-image-cache', { force: true, recursive: true });
  });
}

/** Stateful Docker metadata/tag responses for the core cache protocol only.
 * Existing capability command and fault responses remain owned by each fixture. */
export function createCoreImageCacheShell() {
  const tags = new Map<string, string>();
  return (command: string): ExecResult | undefined => {
    if (!command.startsWith("'docker' ")) return;
    const args = [...command.matchAll(/'([^']*)'/g)].map(x => x[1]);
    const result = (stdout = '', stderr = '', exitCode = 0): ExecResult => ({ stdout, stderr, exitCode });
    if (args[1] === 'info') return result('owned-test-daemon');
    if (args[1] !== 'image') return;
    if (args[2] === 'inspect') {
      const id = /^sha256:[a-f0-9]{64}$/.test(args[3]) ? args[3] : tags.get(args[3]);
      return id ? result(args.at(-1)?.includes('.Size') ? `${id} 4096` : id) : result('', 'No such image', 1);
    }
    if (args[2] === 'tag') { tags.set(args[4], args[3]); return result(); }
    if (args[2] === 'rm') { tags.delete(args.at(-1)!); return result(); }
  };
}
