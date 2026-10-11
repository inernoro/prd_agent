import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorktreePathActivity } from '../../src/services/worktree-path-activity.js';

describe('工作树活动归属', () => {
  it('实际别名与真身/后代不能同时进入，失败退出后释放归属', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cds-worktree-activity-')));
    const real = path.join(root, 'real'), alias = path.join(root, 'alias');
    await mkdir(real); await symlink(real, alias, 'dir');
    const guard = new WorktreePathActivity();
    try {
      await expect(guard.run([alias], async () => {
        expect(guard.tryAcquire([path.join(real, 'child')])).toBeNull();
        expect(guard.tryAcquire([root])).toBeNull();
        throw new Error('owned operation failed');
      })).rejects.toThrow('owned operation failed');
      expect(guard.getStats()).toEqual({ active: 0, paths: 0 });
      const lease = guard.tryAcquire([real]); expect(lease).not.toBeNull(); lease!.release();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('活动容量满时明确拒绝，互不相关目录仍能独立进入', () => {
    const guard = new WorktreePathActivity(2);
    const first = guard.tryAcquire(['/owned/project-one/branch']);
    const second = guard.tryAcquire(['/owned/project-two/branch']);
    expect(first).not.toBeNull(); expect(second).not.toBeNull();
    expect(guard.tryAcquire(['/owned/project-three/branch'])).toBeNull();
    first!.release(); const third = guard.tryAcquire(['/owned/project-three/branch']); expect(third).not.toBeNull();
    second!.release(); third!.release(); expect(guard.getStats()).toEqual({ active: 0, paths: 0 });
  });
  it('执行器明确未确认归属清理时不释放路径给后续创建或回收', async () => {
    const guard = new WorktreePathActivity();
    const failure = Object.assign(new Error('owned cleanup not confirmed'), { code: 'cleanup' });
    await expect(guard.run(['/owned/private-worktree'], async () => { throw failure; })).rejects.toBe(failure);
    expect(guard.tryAcquire(['/owned/private-worktree/source'])).toBeNull();
    expect(guard.getStats().active).toBe(1);
    const unrelated = guard.tryAcquire(['/owned/unrelated-project']); expect(unrelated).not.toBeNull(); unrelated!.release();
  });
});
