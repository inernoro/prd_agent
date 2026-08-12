/**
 * 「目标忙不忙」判定源守卫 + 定时发布接线守卫。
 *
 * 两件事焊死，都是「删掉不会红、只会静默出错」的形状：
 *
 *   1. **判据只有一份**：ReleaseService.isTargetBusy 是唯一判定源，assertTargetFree
 *      消费它。定时发布若在自己那边重写一遍 in-flight/settling/lock 三段谓词，
 *      两处必然漂移，而漂移的表现是「一边说忙、一边真发了」——两个 SSH 部署并发写生产。
 *      本仓库已经为「判定散成多份」付过学费（发布步骤三份、终态两份、模型解析两遍）。
 *
 *   2. **只有一个 ReleaseService 实例参与调度**：inFlight 表是实例私有的，settling
 *      判定只看得见自己那张表。server.ts 与 routes/releases.ts 已经各 new 了一个
 *      （debt #6），调度器再 new 第三个就等于让并发闸再瞎一只眼。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateService } from '../../src/services/state.js';
import { ReleaseService } from '../../src/services/release-service.js';
import { acquireReleaseTargetLock } from '../../src/services/release-target-lock.js';
import type { ReleaseRun, ReleaseRunStatus } from '../../src/types.js';

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMMIT = 'a'.repeat(40);

function readSource(relative: string): string {
  return fs.readFileSync(path.join(CDS_ROOT, relative), 'utf8');
}

/** 剥注释：解释性文字里会原样写出被禁的符号名，不剥会被自己的说明触发。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('isTargetBusy 是「目标忙不忙」的唯一判定源', () => {
  let tmpDir: string;
  let stateService: StateService;
  let service: ReleaseService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-busy-guard-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    stateService.addProject({ id: 'p1', slug: 'p1', name: 'P1' } as never);
    stateService.upsertReleaseTarget({
      id: 'target-prod', projectId: 'p1', name: '生产站点', type: 'ssh',
      createdAt: '2026-07-28T00:00:00.000Z', isEnabled: true,
      ssh: { host: '127.0.0.1', port: 22, user: 'deploy', privateKeyRef: 'h1', appPath: '/opt/app', deployCommand: './deploy.sh', healthcheckUrl: 'https://prod.test' },
    } as never);
    service = new ReleaseService(stateService);
  });

  afterEach(async () => {
    await stateService.flush();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function seedRun(status: ReleaseRunStatus): ReleaseRun {
    return stateService.addReleaseRun({
      releaseId: `rel_${status}`,
      projectId: 'p1',
      branchId: 'b1',
      commitSha: COMMIT,
      artifact: { type: 'branch-preview', commitSha: COMMIT },
      targetId: 'target-prod',
      planId: 'p1:ssh-script',
      status,
      startedAt: '2026-07-29T00:00:00.000Z',
      logs: [],
      seq: 0,
    });
  }

  it('空闲目标判定为不忙', () => {
    expect(service.isTargetBusy('target-prod')).toEqual({ busy: false });
  });

  it('有在途 run 时判定为忙（kind=in-flight），且与 assertTargetFree 同结论', async () => {
    seedRun('running');
    const state = service.isTargetBusy('target-prod');
    expect(state.busy).toBe(true);
    expect(state.kind).toBe('in-flight');
    expect(state.releaseId).toBe('rel_running');
    // 同一判据的另一面：抛错路径必须一起变。
    await expect(service.startRollback('rel_running')).rejects.toThrow(/进行中的发布|回滚/);
  });

  it('终态 run 不算忙（否则目标发一次就永远发不出去）', () => {
    seedRun('success');
    expect(service.isTargetBusy('target-prod').busy).toBe(false);
  });

  it('回收锁持有时判定为忙（kind=lock），声明自己持锁则放行', () => {
    const lock = acquireReleaseTargetLock('target-prod', '产物回收');
    try {
      const state = service.isTargetBusy('target-prod');
      expect(state.busy).toBe(true);
      expect(state.kind).toBe('lock');
      // 回收路径自己持锁，不给这个出口就会自锁（它会把自己的锁读成「目标忙」）。
      expect(service.isTargetBusy('target-prod', { holdsTargetLock: true }).busy).toBe(false);
    } finally {
      lock?.();
    }
  });
});

describe('接线守卫：判据不分裂、实例不增殖', () => {
  it('scheduled-job-service 不直接调用 in-flight / 回收锁的底层谓词', () => {
    const source = stripComments(readSource('src/services/scheduled-job-service.ts'));
    for (const banned of ['isReleaseRunInFlight', 'peekReleaseTargetLock', 'acquireReleaseTargetLock']) {
      expect(
        source.includes(banned),
        `scheduled-job-service.ts 不得直接调用 ${banned}：「目标忙不忙」只许读 ReleaseService.isTargetBusy，`
        + '自己再判一遍就是判据分裂，两处必然漂移成「一边说忙一边真发了」。',
      ).toBe(false);
    }
  });

  it('assertTargetFree 真的消费 isTargetBusy（不是各写各的三段谓词）', () => {
    const source = stripComments(readSource('src/services/release-service.ts'));
    const body = source.slice(source.indexOf('private assertTargetFree('));
    const end = body.indexOf('\n  }');
    expect(body.slice(0, end)).toContain('this.isTargetBusy(');
  });

  it('server.ts 把同一个 releaseService 注入了 ScheduledJobService', () => {
    const source = stripComments(readSource('src/server.ts'));
    const start = source.indexOf('new ScheduledJobService({');
    expect(start, 'server.ts 必须构造 ScheduledJobService').toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf('});', start));
    // 必须是那个既有实例的标识符本身，不是一个新 new 出来的。
    expect(block).toMatch(/release:\s*releaseService\b/);
    expect(block).not.toContain('new ReleaseService(');
  });

  it('server.ts 把事件出口接给了 ScheduledJobService（否则治理通知永远不响）', () => {
    const source = stripComments(readSource('src/server.ts'));
    const start = source.indexOf('new ScheduledJobService({');
    const block = source.slice(start, source.indexOf('});', start));
    expect(block).toMatch(/publishEvent:\s*\(type,\s*data\)\s*=>\s*\{\s*cdsEventsBus\.publish\(type,\s*data\);?\s*\}/);
  });

  it('全仓 new ReleaseService( 的出现次数不超过既有基线（debt #6，只许减不许增）', () => {
    const files = ['src/server.ts', 'src/routes/releases.ts', 'src/services/scheduled-job-service.ts'];
    const count = files
      .map((file) => stripComments(readSource(file)).match(/new ReleaseService\(/g)?.length || 0)
      .reduce((sum, n) => sum + n, 0);
    // 基线 2 = server.ts 一个 + routes/releases.ts 一个（debt #6 记在案，待收敛为单实例）。
    expect(count, '不得再 new 第三个 ReleaseService：每多一个实例就多一张互不可见的 inFlight 表').toBeLessThanOrEqual(2);
  });
});
