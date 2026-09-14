/**
 * 分支删除时级联清理绑定监控（2026-09-09，规则 degradation-must-alarm）。
 *
 * 用户的原话是「我怕有些临时分支把自己的错误的预览地址添加进去，导致出现一些失效的问题」。
 * 这正是它：Agent 自助登记的监控指向某条分支的预览地址，而分支是会消失的。
 * 分支删了监控还在 = 一条**永远红着的死地址**——它不是故障，却长期占着故障位，
 * 把真告警淹掉，最后所有人学会无视整块面板。
 *
 * 项目删除早有同款级联，分支这一层此前是漏的。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { UptimeCustomMonitor } from '../../src/types.js';

function monitor(id: string, extra: Partial<UptimeCustomMonitor> = {}): UptimeCustomMonitor {
  return {
    id,
    name: id,
    kind: 'health-json',
    url: 'https://x.test/gw/v1/healthz/deep',
    enabled: true,
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
    ...extra,
  } as UptimeCustomMonitor;
}

describe('分支删除的监控级联', () => {
  let stateFile: string;
  let service: StateService;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-uptime-cascade-'));
    stateFile = path.join(tmpDir, 'state.json');
    process.env.CDS_CACHE_BASE = path.join(tmpDir, 'cache');
    service = new StateService(stateFile);
    service.load();
    service.addBranch({
      id: 'branch-tmp',
      branch: 'feat/tmp',
      projectId: 'proj-a',
      worktreePath: '/tmp/x',
      services: {},
      status: 'running',
      createdAt: '2026-09-09T00:00:00.000Z',
    } as never);
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    delete process.env.CDS_CACHE_BASE;
    const dir = path.dirname(stateFile);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('绑在该分支上的监控随分支一起消失', () => {
    service.upsertUptimeMonitor(monitor('m-bound', { boundBranchId: 'branch-tmp', projectId: 'proj-a' }));

    const orphaned = service.removeBranch('branch-tmp');

    expect(orphaned).toEqual(['m-bound']);
    expect(service.getUptimeMonitor('m-bound')).toBeUndefined();
  });

  it('管理员手动加的（没有分支绑定）不受影响', () => {
    // 那是人明确要盯的东西，不该因为某条分支没了就替他删掉。
    service.upsertUptimeMonitor(monitor('m-manual', { projectId: 'proj-a', origin: 'manual' }));

    const orphaned = service.removeBranch('branch-tmp');

    expect(orphaned).toEqual([]);
    expect(service.getUptimeMonitor('m-manual')).toBeDefined();
  });

  it('绑在别的分支上的不受影响', () => {
    service.upsertUptimeMonitor(monitor('m-other', { boundBranchId: 'branch-else', projectId: 'proj-a' }));

    service.removeBranch('branch-tmp');

    expect(service.getUptimeMonitor('m-other')).toBeDefined();
  });

  it('观察者被通知，运行态台账才抹得掉', () => {
    // removeBranch 有 5 个调用点，多数拿不到 uptimeMonitor 实例。
    // 少了这个通知，state 里删了、探针还在跑那条已删监控（形状 2）。
    service.upsertUptimeMonitor(monitor('m-bound', { boundBranchId: 'branch-tmp', projectId: 'proj-a' }));
    const seen: string[][] = [];
    service.onUptimeMonitorsOrphaned((ids) => seen.push(ids));

    service.removeBranch('branch-tmp');

    expect(seen).toEqual([['m-bound']]);
  });

  it('没有孤儿时不打扰观察者', () => {
    const seen: string[][] = [];
    service.onUptimeMonitorsOrphaned((ids) => seen.push(ids));

    service.removeBranch('branch-tmp');

    expect(seen).toEqual([]);
  });

  it('观察者抛异常不影响删分支本身', () => {
    service.upsertUptimeMonitor(monitor('m-bound', { boundBranchId: 'branch-tmp', projectId: 'proj-a' }));
    service.onUptimeMonitorsOrphaned(() => { throw new Error('boom'); });

    expect(() => service.removeBranch('branch-tmp')).not.toThrow();
    expect(service.getUptimeMonitor('m-bound')).toBeUndefined();
  });
});
