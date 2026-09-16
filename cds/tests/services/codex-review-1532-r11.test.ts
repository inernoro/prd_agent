/**
 * Codex review（PR #1532）第十一轮的服务端两条。
 *
 * 一条是本 PR 自己开的洞：PATCH 传空正文时，put 收不下 → objectKey 被清掉 →
 * 标成 local。元数据完好、正文只剩一个空的本地文件，重建即成幽灵，而接口回 200。
 * 这正是这个 PR 立项要根除的形状，却从侧门又漏了一次。
 *
 * 一条是项目活跃时间：对不上改动的报告（分支已被回收）没算进 lastActivityAt，
 * 于是「昨天刚验过」的项目显示成「最近动静：无」。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPipelineOverview } from '../../src/services/acceptance-pipeline.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { AcceptanceReportMeta, Project } from '../../src/types.js';

describe('配了对象存储就不许再退回本地', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await flushAllJsonStateStores();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function svcWithStore(): StateService {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-empty-'));
    dirs.push(dir);
    const svc = new StateService(path.join(dir, 'state.json'));
    const store = new Map<string, string>();
    (svc as unknown as { reportObjects: unknown }).reportObjects = {
      isConfigured: () => true,
      // 与真实实现同口径：空正文不上传，返回 null。
      put: async (m: { id: string; format: string }, c: string) => {
        if (!c) return null;
        const key = `k/${m.id}.${m.format}`;
        store.set(key, c);
        return key;
      },
      get: async (key: string) => store.get(key) ?? null,
      remove: async () => undefined,
    };
    return svc;
  }

  it('把正文改成空时当场拒绝，而不是清掉 objectKey 标成 local', async () => {
    const svc = svcWithStore();
    const meta = await svc.createAcceptanceReportAsync({
      title: '[验收] 有正文', kind: '验收', format: 'md', content: '正文',
    } as never);
    const key = meta.objectKey;
    expect(key, '前置条件：这份报告本来是对象存储托底的').toBeTruthy();

    await expect(svc.updateAcceptanceReportAsync(meta.id, { content: '' } as never))
      .rejects.toThrow(/拒绝退回本地盘|没有被收下/);

    // 内存里这条必须原封不动（回滚那一层也要跟着成立）。
    const after = svc.getAcceptanceReport(meta.id)!;
    expect(after.objectKey, 'objectKey 被清掉了，重建之后这条就打不开').toBe(key);
    expect(after.storage).toBe('object');
    expect(await svc.readAcceptanceReportContentAsync(meta.id)).toBe('正文');
  });

  it('路由层也拦一道，让用户拿到 400 而不是 500', () => {
    // StateService 那层是纵深（防住所有调用方），但只有它的话，用户看到的是一个
    // 500 加一句内部说明。创建路由本来就拒空正文，更新路由要同一口径。
    const route = fs.readFileSync(
      path.resolve(__dirname, '../..', 'src/routes/reports.ts'), 'utf8',
    );
    const patch = route.slice(route.indexOf("error: 'nothing_to_update'"));
    expect(patch.slice(0, 1200), '更新路由没拦空正文')
      .toMatch(/content !== undefined && !String\(content\)\.trim\(\)/);
  });

  it('没配对象存储时照旧走本地，不受这条影响', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-local-'));
    dirs.push(dir);
    const svc = new StateService(path.join(dir, 'state.json'));
    const meta = await svc.createAcceptanceReportAsync({
      title: '[验收] 只用本地', kind: '验收', format: 'md', content: '正文',
    } as never);
    expect(meta.storage).toBe('local');
    expect(meta.objectKey ?? null).toBeNull();
  });
});

describe('项目活跃时间要算上「对不上改动」的报告', () => {
  const project = (id: string): Project => ({
    id, slug: id, name: id, kind: 'git',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as Project);
  const report = (id: string, createdAt: string): AcceptanceReportMeta => ({
    id, format: 'md', sizeBytes: 1, projectId: 'p1', verdict: 'pass',
    title: `功能验收 · T${id} · ${createdAt.slice(0, 10)}`,
    // 记了分支名，但那条分支已被 CDS 回收——挂不上任何现存改动，落进 staleReports。
    branch: 'feat/已回收', createdAt, updatedAt: createdAt,
  } as unknown as AcceptanceReportMeta);

  it('分支已回收但报告是昨天归档的，最近动静不许显示成「无」', () => {
    const o = buildPipelineOverview(
      [project('p1')], [], [], [report('r1', '2026-09-14T10:00:00.000Z')],
      { now: new Date('2026-09-15T00:00:00.000Z') },
    );
    const row = o.projects.find((p) => p.projectId === 'p1')!;
    expect(row.staleReports, '前置条件：这份报告确实落进了「对不上」那一档').toBe(1);
    expect(row.lastActivityAt, '刚归档的报告没算进活跃时间').toBe('2026-09-14T10:00:00.000Z');
  });

  it('取的是最晚那一个，不是最后遍历到的那个', () => {
    const o = buildPipelineOverview(
      [project('p1')], [], [],
      [report('r1', '2026-09-14T10:00:00.000Z'), report('r2', '2026-09-02T10:00:00.000Z')],
      { now: new Date('2026-09-15T00:00:00.000Z') },
    );
    expect(o.projects[0].lastActivityAt).toBe('2026-09-14T10:00:00.000Z');
  });
});
