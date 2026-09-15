import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const STATE = path.join(process.cwd(), 'src/services/state.ts');

/**
 * 维护 job 的遗留收敛（Codex P2，2026-09-15）：
 *
 * 维护 job 的执行体只活在进程内存里。CDS 在 begin 与 finish 之间重启，这条 active
 *    记录就永远留着，让此后每一次凭据轮换都撞 rotation.active_jobs_in_progress，
 *    且没有任何途径清掉（concurrency-gate-discipline：并发闸必须有周期收敛）。
 */
describe('维护 job 的遗留收敛', () => {
  const source = fs.readFileSync(STATE, 'utf8');

  it('开启 job 时盖上进程代次', () => {
    const begin = source.slice(source.indexOf('async beginInfraMaintenanceJob('));
    expect(begin.slice(0, 1600)).toContain('ownerGeneration: INFRA_MAINTENANCE_OWNER_GENERATION');
  });

  it('收敛只针对别的代次，且真的写终态', () => {
    const fn = source.slice(source.indexOf('reconcileOrphanedInfraMaintenanceJobs()'));
    const body = fn.slice(0, fn.indexOf('\n  listActiveInfraMaintenanceJobs'));
    expect(body).toContain("job.status !== 'active'");
    expect(body).toContain('job.ownerGeneration === INFRA_MAINTENANCE_OWNER_GENERATION');
    expect(body).toContain("job.status = 'failed'");
    expect(body).toContain('job.finishedAt');
  });

  it('读取点先收割再判定——否则一次重启就能把轮换永久钉死', () => {
    const list = source.slice(source.indexOf('listActiveInfraMaintenanceJobs(filter:'));
    const body = list.slice(0, 900);
    expect(body).toContain('this.reconcileOrphanedInfraMaintenanceJobs();');
    expect(
      body.indexOf('this.reconcileOrphanedInfraMaintenanceJobs();'),
      '收割必须排在过滤之前',
    ).toBeLessThan(body.indexOf('.filter(('));
  });
});

/**
 * 落盘失败必须摘掉预约（Codex P2，2026-09-15）。
 *
 * job 先进内存再落盘；save 或 flush 抛出时，beginInfraMaintenanceJob 在拿到 handle 之前
 * 就 reject 了，于是没有任何调用方能 finish 它。而它盖的是**当前**代次，收割器只收
 * 上一代的遗留（那是有意的：本代的 job 可能正在跑）——两条合起来，一次写盘抖动就把
 * 这个服务的凭据轮换钉死到进程重启。这正是上一条修复带来的新边界，一起补上。
 */
describe('维护 job 落盘失败时的预约', () => {
  it('抛出之前先把内存里那条摘掉，闸不会被永久钉死', async () => {
    const os = await import('node:os');
    const { StateService } = await import('../../src/services/state.js');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-imj-'));
    const svc = new StateService(path.join(tmp, 'state.json'), tmp);
    svc.addInfraService({
      id: 'mongodb',
      projectId: 'p1',
      scope: 'project',
      type: 'mongodb',
      status: 'running',
    } as never);

    // companion：前置条件成立，这次 begin 本来是能开起来的。
    expect(svc.canStartInfraMaintenance('p1', 'mongodb')).toBe(true);

    let flushes = 0;
    (svc as unknown as { flush: () => Promise<void> }).flush = async () => {
      flushes += 1;
      throw new Error('disk_full');
    };

    await expect(svc.beginInfraMaintenanceJob({
      projectId: 'p1',
      serviceId: 'mongodb',
      runtime: 'mongodb',
      kind: 'manual-backup',
    })).rejects.toThrow('disk_full');

    expect(flushes, '摘除本身也该尽力落盘一次').toBeGreaterThanOrEqual(2);
    expect(
      svc.listActiveInfraMaintenanceJobs({ projectId: 'p1', serviceId: 'mongodb' }),
      '落盘失败的预约留在了内存里：这个服务的凭据轮换到重启为止都进不来',
    ).toHaveLength(0);
    expect(svc.canStartInfraMaintenance('p1', 'mongodb')).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
