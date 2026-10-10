import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorktreeService } from '../../src/services/worktree.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';

describe('P3-02 pull execution cancellation', () => {
  it('kills an in-progress fetch and never starts the reset when cancelled', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-pull-cancel-'));
    const shell = new ShellExecutor(); const abort = new AbortController();
    const git = path.join(root, 'git'); const started = path.join(root, 'started'); const reset = path.join(root, 'reset');
    await fs.writeFile(git, '#!/bin/sh\ncase "$1" in\nfetch) printf ready > started; exec sleep 1;;\nreset) printf called > reset;;\n*) printf abc123;;\nesac\n', { mode: 0o700 });
    const executor = { exec: (command: string, options?: Parameters<ShellExecutor['exec']>[1]) =>
      shell.exec(command, { ...options, env: { ...options?.env, PATH: root + ':' + process.env.PATH }, timeout: 2000 }) };
    try {
      const pull = new WorktreeService(executor).pull('test', root, abort.signal);
      const outcome = pull.then(() => ({ ok: true }), error => ({ ok: false, error }));
      for (let i = 0; i < 100; i++) { if (await fs.stat(started).catch(() => null)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
      expect(await fs.stat(started).catch(() => null)).not.toBeNull();
      const start = Date.now(); abort.abort();
      expect((await outcome).ok).toBe(false);
      expect(Date.now() - start).toBeLessThan(300);
      expect(await fs.stat(reset).catch(() => null)).toBeNull();
      expect((await shell.exec('printf released')).stdout).toBe('released');
    } finally { abort.abort(); await shell.close(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
