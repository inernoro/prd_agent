import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorktreePathActivity } from '../../src/services/worktree-path-activity.js';

describe('工作树活动归属', () => {
  it('认领占用覆盖子操作返回后的受理窗口，兄弟子操作仍分别互斥', async () => {
    const guard = new WorktreePathActivity();
    await guard.withClaim(['/owned/new-branch'], async () => {
      await guard.run(['/owned/new-branch'], async () => {
        expect(guard.tryAcquire(['/owned/new-branch'])).toBeNull();
        await expect(guard.run(['/owned/new-branch'], async () => {})).rejects.toThrow('正在');
      });
      expect(guard.tryAcquire(['/owned/new-branch'])).toBeNull();
      expect(() => guard.assertClaimable(['/owned/new-branch'])).not.toThrow();
      await Promise.all([guard.run(['/owned/new-branch'], async () => {}, true),
        guard.run(['/owned/new-branch'], async () => {}, true)]);
    });
    expect(guard.getStats().active).toBe(0);
  });
  it('仅破坏性派发后拦台账认领；普通检查时允许新认领，互不相关路径不受影响', () => {
    const guard = new WorktreePathActivity(), lease = guard.tryAcquire(['/owned/orphan'])!;
    expect(() => guard.assertClaimable(['/owned/orphan'])).not.toThrow();
    expect(lease.markDestructive()).toBe(true);
    expect(() => guard.assertClaimable(['/owned/orphan'])).toThrow('回收');
    expect(() => guard.assertClaimable(['/owned/another-project'])).not.toThrow();
    lease.release(); expect(() => guard.assertClaimable(['/owned/orphan'])).not.toThrow();
  });
  it('独立源码准备共享根归属，但任一准备未结束时禁止排他创建、更新和回收', () => {
    const guard = new WorktreePathActivity();
    const a = guard.tryAcquire(['/owned/root', '/owned/sources'], true);
    const b = guard.tryAcquire(['/owned/root', '/owned/sources'], true);
    expect(a).not.toBeNull(); expect(b).not.toBeNull();
    expect(guard.tryAcquire(['/owned'])).toBeNull(); a!.release();
    expect(guard.tryAcquire(['/owned/root'])).toBeNull(); b!.release();
    const exclusive = guard.tryAcquire(['/owned/root']); expect(exclusive).not.toBeNull(); exclusive!.release();
  });
  it('共享准备遇未知清理也禁止新的共享准备，不能绕过未知占用', async () => {
    const guard = new WorktreePathActivity();
    const failure = Object.assign(new Error('owned cleanup not confirmed'), { code: 'cleanup' });
    await expect(guard.run(['/owned/root'], async () => { throw failure; }, true)).rejects.toBe(failure);
    expect(guard.tryAcquire(['/owned/root'], true)).toBeNull();
    expect(guard.tryAcquire(['/owned/root'])).toBeNull();
  });
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
