/**
 * Codex review（PR #1532）六条意见的回归守卫。
 *
 * 六条里有两条是同一个病根：**同一个判据存在两份实现，各判各的**。
 * 「三段分流」在总览与每行各写了一份（一份逐级夹取、一份各段单独夹），
 * 「陈旧墓碑」在 proxy 里有、在流水线聚合里没有。这类缺陷不报错、
 * 通读单边代码也挑不出来，只有把两份并排看才显形。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildPipelineOverview, branchLiveSince, tombstoneIsStale,
} from '../../src/services/acceptance-pipeline.js';
import { reportObjectKey, reportObjectStoreFromEnv } from '../../src/services/report-object-store.js';
import type { AcceptanceReportMeta, BranchEntry, BranchTombstone, Project } from '../../src/types.js';

const project = (id: string): Project => ({
  id, slug: id, name: id, kind: 'git',
  createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
} as unknown as Project);

const branch = (p: Partial<BranchEntry> & { branch: string }): BranchEntry => ({
  id: `b-${p.branch}`, projectId: 'p1', worktreePath: '/tmp/x', status: 'running',
  createdAt: '2026-09-10T00:00:00.000Z', services: {}, ...p,
} as unknown as BranchEntry);

const tomb = (p: Partial<BranchTombstone> & { branch: string }): BranchTombstone => ({
  branchId: `old-${p.branch}`, projectId: 'p1', reason: 'merged',
  removedAt: '2026-09-01T00:00:00.000Z', ...p,
} as unknown as BranchTombstone);

describe('墓碑作用域：分支名复用时，上一代的墓碑不许套到新分支上', () => {
  it('墓碑早于当前 incarnation 就是上一代的', () => {
    expect(tombstoneIsStale(tomb({ branch: 'feat/x' }), Date.parse('2026-09-10T00:00:00.000Z'))).toBe(true);
    expect(tombstoneIsStale(tomb({ branch: 'feat/x' }), Date.parse('2026-08-01T00:00:00.000Z'))).toBe(false);
  });

  it('没有同名活分支时，墓碑是它自己的历史，不算陈旧', () => {
    expect(tombstoneIsStale(tomb({ branch: 'feat/x' }), undefined)).toBe(false);
  });

  it('墓碑没有可解析的时间时按不陈旧处理，宁可少判一次复用也不丢真实合并记录', () => {
    expect(tombstoneIsStale(tomb({ branch: 'feat/x', removedAt: '' }), Date.parse('2026-09-10T00:00:00.000Z')))
      .toBe(false);
  });

  it('incarnation 基准取 createdAt / lastPushAt / lastDeployAt 最近者', () => {
    const b = branch({
      branch: 'feat/x',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastPushAt: '2026-09-12T00:00:00.000Z',
    } as never);
    expect(branchLiveSince(b)).toBe(Date.parse('2026-09-12T00:00:00.000Z'));
  });

  it('复用名字的活分支不会被报成「已合并」', () => {
    // 这正是首页最不能做的事：把一条正在跑的分支报成「没验就合并」。
    const o = buildPipelineOverview(
      [project('p1')],
      [branch({ branch: 'feat/x', createdAt: '2026-09-10T00:00:00.000Z' })],
      [tomb({ branch: 'feat/x', removedAt: '2026-09-01T00:00:00.000Z' })],
      [],
      {},
    );
    expect(o.total.merged, '上一代的墓碑被套到了新分支上').toBe(0);
    expect(o.totalLeaks['merged-not-accepted']).toBe(0);
  });

  it('真正属于这条分支的墓碑照常采用', () => {
    const o = buildPipelineOverview(
      [project('p1')],
      [branch({ branch: 'feat/y', createdAt: '2026-09-01T00:00:00.000Z' })],
      [tomb({ branch: 'feat/y', removedAt: '2026-09-12T00:00:00.000Z' })],
      [],
      {},
    );
    expect(o.total.merged, '同一代的墓碑被误当成陈旧丢掉了').toBe(1);
  });
});

describe('报告对象存储：凭据不全必须拒绝，不许静默退回本地', () => {
  const full = {
    R2_ENDPOINT: 'https://x.r2.example',
    R2_BUCKET: 'b',
    R2_ACCESS_KEY_ID: 'k',
    R2_SECRET_ACCESS_KEY: 's',
  };

  it('四个全空 = 有意只用本地，返回 null', () => {
    expect(reportObjectStoreFromEnv({})).toBeNull();
  });

  it('配全了就给配置', () => {
    expect(reportObjectStoreFromEnv(full)).not.toBeNull();
  });

  it.each([
    ['R2_ENDPOINT', 'R2_ENDPOINT'],
    ['R2_BUCKET', 'CDS_REPORTS_R2_BUCKET'],
    ['R2_ACCESS_KEY_ID', 'R2_ACCESS_KEY_ID'],
    ['R2_SECRET_ACCESS_KEY', 'R2_SECRET_ACCESS_KEY'],
  ])('少了 %s 就抛错，而不是安静地退回本地', (drop, mention) => {
    const env: Record<string, string | undefined> = { ...full };
    delete env[drop];
    expect(() => reportObjectStoreFromEnv(env)).toThrow(new RegExp(mention.split('(')[0]));
  });

  it('报错要说清缺了哪一个，不是一句「配置错误」', () => {
    expect(() => reportObjectStoreFromEnv({ R2_ENDPOINT: 'https://x' }))
      .toThrow(/R2_ACCESS_KEY_ID/);
  });
});

describe('报告对象键必须带上配置的前缀', () => {
  const meta = { id: 'r1', format: 'html' as const, projectId: 'p1' };

  it('默认前缀进键里', () => {
    expect(reportObjectKey(meta)).toBe('cds-acceptance-reports/reports/p1/r1.html');
  });

  it('自定义前缀生效', () => {
    expect(reportObjectKey(meta, 'custom/ns')).toBe('custom/ns/reports/p1/r1.html');
  });

  it('前缀为空时不留空段，不拼出 //', () => {
    expect(reportObjectKey(meta, '')).toBe('reports/p1/r1.html');
    expect(reportObjectKey(meta, '/x/')).toBe('x/reports/p1/r1.html');
  });

  it('projectId 缺失归到 _unassigned', () => {
    expect(reportObjectKey({ id: 'r2', format: 'md', projectId: null }))
      .toBe('cds-acceptance-reports/reports/_unassigned/r2.md');
  });

  it('put 用的是配置里的前缀，不是写死的默认值', () => {
    const src = readFileSync(
      resolve(__dirname, '../..', 'src/services/report-object-store.ts'), 'utf8',
    );
    expect(src, 'put 里没把 config.prefix 传下去，前缀就又成了死配置')
      .toMatch(/reportObjectKey\(meta, config\.prefix\)/);
  });
});
