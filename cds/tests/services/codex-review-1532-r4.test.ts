/**
 * Codex review（PR #1532）第四轮的服务端两条。
 *
 * 一条是第三轮那条的更彻底版本：放弃的分支不该只是「不算漏」，它压根不该进漏斗——
 * 之前它照样撑着「在改的分支」与「待验收」，撑的还正好是这个项目历年放弃过多少次。
 * 一条是缓存：对象存储收下了新正文、本地缓存没写成功，而读路径永远本地优先，
 * 于是「改成功了，但页面上永远是改之前那一版」，而且不报错。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPipelineOverview } from '../../src/services/acceptance-pipeline.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { AcceptanceReportMeta, BranchEntry, BranchTombstone, Project } from '../../src/types.js';

const project = (id: string): Project => ({
  id, slug: id, name: id, kind: 'git',
  createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
} as unknown as Project);

const branch = (p: Partial<BranchEntry> & { branch: string }): BranchEntry => ({
  id: `b-${p.branch}`, projectId: 'p1', worktreePath: '/tmp/x', status: 'running',
  createdAt: '2026-09-10T00:00:00.000Z', services: {}, lastDeployAt: '2026-09-11T00:00:00.000Z', ...p,
} as unknown as BranchEntry);

const tomb = (p: Partial<BranchTombstone> & { branch: string }): BranchTombstone => ({
  previewSlug: `s-${p.branch}`, branchId: `old-${p.branch}`, projectId: 'p1',
  reason: 'abandoned', removedAt: '2026-09-05T00:00:00.000Z', ...p,
} as unknown as BranchTombstone);

const report = (p: Partial<AcceptanceReportMeta> & { title: string }): AcceptanceReportMeta => ({
  id: 'r1', format: 'md', sizeBytes: 1, projectId: 'p1', verdict: 'pass',
  createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z', ...p,
} as unknown as AcceptanceReportMeta);

const overview = (
  tombstones: BranchTombstone[],
  branches: BranchEntry[] = [],
  reports: AcceptanceReportMeta[] = [],
) => buildPipelineOverview([project('p1')], branches, tombstones, reports, {
  now: new Date('2026-09-15T00:00:00.000Z'),
});

describe('放弃的分支根本不是一件待办的改动，不许进漏斗', () => {
  it('三条放弃的分支：改动数为 0，已部署也为 0', () => {
    // 之前它们各让 changes 与 deployed +1，紧凑态据此标「待验收」、
    // 头条据此算「在改的分支」——数的却是这个项目放弃过多少次。
    const t = overview(['feat/a', 'feat/b', 'feat/c'].map((b) => tomb({ branch: b }))).total;
    expect(t.changes).toBe(0);
    expect(t.deployed).toBe(0);
  });

  it('合并过的墓碑照常进漏斗（别修过头把真实合并记录也扔了）', () => {
    const t = overview([tomb({ branch: 'feat/m', reason: 'merged' })]).total;
    expect(t.changes).toBe(1);
    expect(t.merged).toBe(1);
  });

  it('在途分支照常进漏斗', () => {
    const t = overview([], [branch({ branch: 'feat/live' })]).total;
    expect(t.changes).toBe(1);
    expect(t.deployed).toBe(1);
  });

  it('放弃的墓碑仍可给同名活分支补上 PR 号，只是自己不单独成行', () => {
    // 跳过的条件是「abandoned 且没有对应活分支」，不是「abandoned 一律不看」——
    // 它带着的 PR 号对那条活分支的报告认领仍然有用。
    // 判据落在结果上：报告只记了 PR 号、分支名对不上，能不能认领全看这次补没补。
    // 墓碑必须晚于这条分支最后一次动静，否则会被「上一代墓碑」的判据先一步剔除。
    const live = branch({
      branch: 'feat/live',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastDeployAt: '2026-09-02T00:00:00.000Z',
    } as never);
    const r = report({ title: 'PR验收 · X · 2026-09-12', branch: 'renamed/later', prNumber: 1532 } as never);
    const withTomb = overview([tomb({ branch: 'feat/live', prNumber: 1532 })], [live], [r]);
    expect(withTomb.total.changes).toBe(1);
    expect(withTomb.total.accepted, '墓碑带的 PR 号没被补进活分支，报告认领不上').toBe(1);
    // 反证：没有那块墓碑就认领不上，说明上面那条确实是墓碑补出来的。
    expect(overview([], [live], [r]).total.accepted).toBe(0);
  });
});

describe('本地缓存写不进去时必须作废，不许把旧正文一直端出去', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await flushAllJsonStateStores();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function freshState(): { svc: StateService; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-cache-'));
    dirs.push(dir);
    const svc = new StateService(path.join(dir, 'state.json'));
    return { svc, dir };
  }

  it('对象存储收下新正文、缓存写失败 → 旧缓存被删掉，下一次读回源', async () => {
    const { svc } = freshState();
    const store = new Map<string, string>();
    // 装一个「上传成功、但本地写不进去」的组合：对象存储正常，缓存目录被换成一个文件。
    (svc as unknown as { reportObjects: unknown }).reportObjects = {
      isConfigured: () => true,
      put: async (meta: { id: string }, content: string) => { store.set(meta.id, content); return `k/${meta.id}`; },
      get: async (key: string) => store.get(key.slice(2)) ?? null,
    };

    const meta = await svc.createAcceptanceReportAsync({
      title: '[验收] 缓存作废', kind: '验收', format: 'md', content: '第一版',
    } as never);
    const cachePath = (svc as unknown as { reportFilePath: (m: unknown) => string }).reportFilePath(meta);
    expect(fs.existsSync(cachePath), '第一次归档应当写出缓存').toBe(true);

    // 让缓存写入必然失败：把缓存文件换成目录，writeFile/rename 都过不去。
    fs.rmSync(cachePath);
    fs.mkdirSync(cachePath);

    await (svc as unknown as {
      persistAcceptanceReportContent: (m: unknown, c: string) => Promise<void>;
    }).persistAcceptanceReportContent(meta, '第二版');

    // 对象存储里必须是新正文，本地那个坏缓存必须已经不在了。
    expect(store.get(meta.id)).toBe('第二版');
    expect(fs.existsSync(cachePath), '坏掉的旧缓存还在，读路径本地优先会一直端出旧正文').toBe(false);
    expect(await svc.readAcceptanceReportContentAsync(meta.id)).toBe('第二版');
  });

  it('没配对象存储时本地盘是唯一副本，写不进去必须抛而不是静默', async () => {
    const { svc } = freshState();
    const meta = await svc.createAcceptanceReportAsync({
      title: '[验收] 唯一副本', kind: '验收', format: 'md', content: '正文',
    } as never);
    const cachePath = (svc as unknown as { reportFilePath: (m: unknown) => string }).reportFilePath(meta);
    fs.rmSync(cachePath);
    fs.mkdirSync(cachePath);
    await expect((svc as unknown as {
      persistAcceptanceReportContent: (m: unknown, c: string) => Promise<void>;
    }).persistAcceptanceReportContent(meta, '新正文')).rejects.toThrow();
  });

  it('临时文件不许留在报告目录里当垃圾', async () => {
    const { svc } = freshState();
    const meta = await svc.createAcceptanceReportAsync({
      title: '[验收] 无残留', kind: '验收', format: 'md', content: '正文',
    } as never);
    const base = (svc as unknown as { getReportsBase: () => string }).getReportsBase();
    expect(fs.readdirSync(base).filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(meta.id).toBeTruthy();
  });
});
