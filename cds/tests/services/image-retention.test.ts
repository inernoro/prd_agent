import { describe, it, expect } from 'vitest';
import { computeImageRetentionPlan, isCdsShaTaggedImage } from '../../src/services/image-retention.js';

const sha = (n: number): string => String(n).padStart(40, '0');
const img = (name: string, n: number): string => `ghcr.io/acme/${name}:sha-${sha(n)}`;

/**
 * 2026-07-27 宕机复盘 P0 的核心回归：CDS 自产的部署镜像带 tag 永不悬空，
 * `docker image prune -f` 一个都清不掉，宿主实测攒到 5099 个 / 159GB。
 * 这里锁死定向回收的安全边界——删错一个正在用的镜像，代价是容器起不来。
 */
describe('部署镜像保留策略', () => {
  it('只认 CDS 的 per-SHA tag 形状', () => {
    expect(isCdsShaTaggedImage(img('api', 1))).toBe(true);
    expect(isCdsShaTaggedImage('mongo:8.0')).toBe(false);
    expect(isCdsShaTaggedImage('ghcr.io/acme/api:latest')).toBe(false);
    expect(isCdsShaTaggedImage('ghcr.io/acme/api:sha-abc')).toBe(false); // 非 40 位
  });

  it('每个 (分支, 服务) 保留最近 N 代，其余回收', () => {
    const ledger = [3, 2, 1].map((n) => ({
      image: img('api', n), branchId: 'b1', profileId: 'api', createdAt: `2026-07-2${n}T00:00:00Z`,
    }));
    const plan = computeImageRetentionPlan({
      ledger,
      hostImages: ledger.map((l) => l.image),
      inUseImages: [],
      keepGenerations: 2,
    });
    // createdAt 最新的两代（3、2）保留，最旧的 1 被回收
    expect(plan.remove).toEqual([img('api', 1)]);
    expect(plan.keptReasons[img('api', 3)]).toContain('最近 2 代');
  });

  it('在用镜像绝不回收——包括已停止容器引用的（删了就无法重启）', () => {
    const plan = computeImageRetentionPlan({
      ledger: [],
      hostImages: [img('api', 1), img('api', 2)],
      inUseImages: [img('api', 1)],
      keepGenerations: 1,
    });
    expect(plan.remove).toEqual([img('api', 2)]);
    expect(plan.keptReasons[img('api', 1)]).toContain('被容器引用');
  });

  it('台账已淘汰但宿主还留着的镜像可回收——这正是只靠台账永远够不到的存量泄漏', () => {
    // 版本台账有 100 条上限，淘汰记录时不删镜像 → CDS 从此认不出它们。
    const orphan = img('admin', 7);
    const plan = computeImageRetentionPlan({
      ledger: [{ image: img('admin', 9), branchId: 'b1', profileId: 'admin', createdAt: '2026-07-27T00:00:00Z' }],
      hostImages: [img('admin', 9), orphan],
      inUseImages: [],
      keepGenerations: 3,
    });
    expect(plan.remove).toEqual([orphan]);
  });

  it('非 CDS 镜像（基础镜像 / 别人的镜像）一律不碰', () => {
    const plan = computeImageRetentionPlan({
      ledger: [],
      hostImages: ['mongo:8.0', 'redis:7-alpine', 'ghcr.io/acme/api:latest'],
      inUseImages: [],
      keepGenerations: 1,
    });
    expect(plan.remove).toEqual([]);
    expect(plan.keptReasons['mongo:8.0']).toContain('不在回收范围');
  });

  it('悬空镜像不归本模块管（交给 image prune）', () => {
    const plan = computeImageRetentionPlan({
      ledger: [], hostImages: ['<none>:<none>'], inUseImages: [], keepGenerations: 1,
    });
    expect(plan.remove).toEqual([]);
  });

  it('单轮上限截断，且截断数量必须如实报出（不许把「跑过了」说成「清干净了」）', () => {
    const hostImages = [1, 2, 3, 4, 5].map((n) => img('api', n));
    const plan = computeImageRetentionPlan({
      ledger: [], hostImages, inUseImages: [], keepGenerations: 1, maxRemovals: 2,
    });
    expect(plan.remove).toHaveLength(2);
    expect(plan.deferred).toBe(3);
  });

  it('不同服务各自计代，不会互相挤占', () => {
    const ledger = [
      { image: img('api', 2), branchId: 'b1', profileId: 'api', createdAt: '2026-07-26T00:00:00Z' },
      { image: img('api', 1), branchId: 'b1', profileId: 'api', createdAt: '2026-07-25T00:00:00Z' },
      { image: img('admin', 2), branchId: 'b1', profileId: 'admin', createdAt: '2026-07-26T00:00:00Z' },
      { image: img('admin', 1), branchId: 'b1', profileId: 'admin', createdAt: '2026-07-25T00:00:00Z' },
    ];
    const plan = computeImageRetentionPlan({
      ledger, hostImages: ledger.map((l) => l.image), inUseImages: [], keepGenerations: 1,
    });
    expect(plan.remove.sort()).toEqual([img('admin', 1), img('api', 1)].sort());
  });

  it('keepGenerations 至少为 1（传 0 也不会把当前代删光）', () => {
    const ledger = [{ image: img('api', 1), branchId: 'b1', profileId: 'api', createdAt: '2026-07-27T00:00:00Z' }];
    const plan = computeImageRetentionPlan({
      ledger, hostImages: [img('api', 1)], inUseImages: [], keepGenerations: 0,
    });
    expect(plan.remove).toEqual([]);
  });
});
