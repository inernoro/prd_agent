import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as janitor from '../../src/services/janitor.js';
import * as state from '../../src/services/state.js';
import * as worktree from '../../src/services/worktree.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { runOrphanOwnershipProbe, type OwnershipCase } from '../../scripts/orphan-worktree-ownership-probe.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('实际创建与孤儿回收归属和目录身份', () => {
  it.each<OwnershipCase>(['create-before-state', 'directory-replaced', 'alias-retargeted'])(
    '%s：未落台账的活动及同年龄不同对象不会被旧计划删除', async scenario => {
      const root = await mkdtemp(path.join(tmpdir(), 'cds-orphan-ownership-')); roots.push(root);
      const result = await runOrphanOwnershipProbe(janitor, state, worktree, new ShellExecutor(), root, scenario);
      expect(result.noStateClaim).toBe(true); expect(result.protectedDuringOperation).toBe(true);
      expect(result.removed).toEqual([]); expect(result.keptReason).toBeTruthy(); expect(result.errors).toEqual([]);
    }, 20000);
});
