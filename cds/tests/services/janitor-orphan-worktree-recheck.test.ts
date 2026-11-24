import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as janitor from '../../src/services/janitor.js';
import * as state from '../../src/services/state.js';
import { runOrphanRecheckProbe, probeEnumerationYield, type RecheckCase } from '../../scripts/orphan-worktree-recheck-probe.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('实际目录回收临删认领复核', () => {
  it('原磁盘枚举期间控制面仍能获得事件循环时间片', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cds-orphan-recheck-')); roots.push(root);
    const result = await probeEnumerationYield(janitor, root);
    expect(result.ticksDuringEnumeration).toBeGreaterThan(0);
  });
  it.each<RecheckCase>(['claim-during-stat', 'claim-during-previous-remove', 'claim-real-during-stat'])(
    '%s：原台账新认领后保留真实文件，其他孤儿仍回收', async scenario => {
      const root = await mkdtemp(path.join(tmpdir(), 'cds-orphan-recheck-')); roots.push(root);
      const result = await runOrphanRecheckProbe(janitor, state, root, scenario);
      expect(result.markerSurvived).toBe(true);
      expect(result.actualStateClaimConfirmed).toBe(true);
      expect(result.keptReason).toContain('台账');
      expect(result.removed).toHaveLength(1); expect(result.errors).toEqual([]);
    });
});
