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
