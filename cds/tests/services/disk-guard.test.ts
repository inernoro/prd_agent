import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  classifyDiskTier, shouldFreezeDeploys, imageKeepGenerationsFor, imageMaxRemovalsFor, describeDiskTier, diskGuard,
  resolveDockerDataRoot, resetDockerDataRootCache,
} from '../../src/services/disk-guard.js';

/**
 * 2026-07-27 宕机复盘 P0 的回归护栏：磁盘从 80% 一路涨到 100% 全程只有一句
 * console.warn，没有任何一处会因此少做点什么。以下断言把「多少算危险、危险了
 * 做什么」钉死成可回归的事实。
 */
describe('磁盘分档刹车', () => {
  beforeEach(() => diskGuard.reset());

  it('按阈值归档，边界值归到更严的一档', () => {
    expect(classifyDiskTier(10)).toBe('ok');
    expect(classifyDiskTier(74.9)).toBe('ok');
    expect(classifyDiskTier(75)).toBe('notice');
    expect(classifyDiskTier(84)).toBe('notice');
    expect(classifyDiskTier(85)).toBe('reclaim');
    expect(classifyDiskTier(89)).toBe('reclaim');
    expect(classifyDiskTier(90)).toBe('freeze');
    expect(classifyDiskTier(100)).toBe('freeze');
  });

  it('事故当时的读数（100%）落在 freeze 档，事故前的 85% 落在 reclaim 档', () => {
    // 事故实测值直接入例：100% 必须冻结；人工清理后的 85% 必须仍在主动回收档，
    // 不能因为「看起来还有 54GB」就回到 ok。
    expect(classifyDiskTier(100)).toBe('freeze');
    expect(classifyDiskTier(85)).toBe('reclaim');
  });

  it('探测失败一律 fail-open，不把平台冻住', () => {
    expect(classifyDiskTier(null)).toBe('ok');
    expect(classifyDiskTier(undefined)).toBe('ok');
    expect(classifyDiskTier(Number.NaN)).toBe('ok');
    expect(classifyDiskTier(-1)).toBe('ok');
  });

  it('只有 freeze 档冻结部署派发', () => {
    expect(shouldFreezeDeploys('ok')).toBe(false);
    expect(shouldFreezeDeploys('notice')).toBe(false);
    expect(shouldFreezeDeploys('reclaim')).toBe(false);
    expect(shouldFreezeDeploys('freeze')).toBe(true);
  });

  it('越紧张镜像保留代数越少，但永不为 0（至少留得下一次回滚）', () => {
    expect(imageKeepGenerationsFor('ok')).toBe(5);
    expect(imageKeepGenerationsFor('notice')).toBe(3);
    expect(imageKeepGenerationsFor('reclaim')).toBe(2);
    expect(imageKeepGenerationsFor('freeze')).toBe(1);
    expect(imageKeepGenerationsFor('freeze')).toBeGreaterThan(0);
  });

  it('diskGuard 更新后能给出拒绝理由；未到 freeze 档返回 null', () => {
    diskGuard.update(86);
    expect(diskGuard.get().tier).toBe('reclaim');
    expect(diskGuard.blockReasonForDeploy()).toBeNull();

    diskGuard.update(97);
    expect(diskGuard.get().tier).toBe('freeze');
    const reason = diskGuard.blockReasonForDeploy();
    expect(reason).toContain('97%');
    expect(reason).toContain('冻结');
    // 理由必须告诉用户「停止/删除不受影响」，否则磁盘满时用户会以为连自救都做不了
    expect(reason).toContain('停止/删除类操作不受影响');
  });

  it('描述文案里带上真实使用率，未知时不编造数字', () => {
    expect(describeDiskTier('freeze', 93)).toContain('93%');
    expect(describeDiskTier('ok', null)).toContain('未知');
  });
});

describe('磁盘刹车自带测量能力（Codex 第二十八轮 P1）', () => {
  beforeEach(() => diskGuard.reset());

  it('进程刚重启、还没有任何 sweep 时，部署闸门会就地测一次而不是放行', () => {
    // 事故语义：CDS 刚被磁盘打满打死并重启，此刻档位还是初始的 'ok'。
    // 若闸门直接读这个未初始化值，最危险的恢复窗口反而全程放行。
    diskGuard.setProbe(() => ({ totalBytes: 100, freeBytes: 3 })); // 97% used
    expect(diskGuard.get().tier).toBe('ok'); // 尚未测量
    const reason = diskGuard.blockReasonForDeploy();
    expect(reason).toContain('97%');
    expect(diskGuard.get().tier).toBe('freeze');
  });

  it('探测器抛异常时保持现状放行，不把平台锁死', () => {
    diskGuard.setProbe(() => { throw new Error('statfs failed'); });
    expect(diskGuard.blockReasonForDeploy()).toBeNull();
  });

  it('未注册探测器时退回既有读数（janitor 仍可喂）', () => {
    diskGuard.update(95);
    expect(diskGuard.blockReasonForDeploy()).toContain('95%');
  });
});

describe('多挂载点探测（Codex 第二十九轮 P2）', () => {
  beforeEach(() => diskGuard.reset());

  it('worktree 宽松但 docker 数据盘吃紧时，按最紧张的那个判档', () => {
    // 事故语义：撑爆的是 containerd/docker 那一侧（159GB），worktree 可能还很空。
    // 只量 worktree 会在该拦的时候报「一切正常」。
    diskGuard.setProbe(() => [
      { totalBytes: 100, freeBytes: 60 },  // worktree 40%
      { totalBytes: 100, freeBytes: 5 },   // docker 95%
    ]);
    expect(diskGuard.blockReasonForDeploy()).toContain('95%');
    expect(diskGuard.get().tier).toBe('freeze');
  });

  it('单挂载点写法照常工作（向后兼容）', () => {
    diskGuard.setProbe(() => ({ totalBytes: 100, freeBytes: 2 }));
    expect(diskGuard.get().tier).toBe('ok');
    expect(diskGuard.blockReasonForDeploy()).toContain('98%');
  });

  it('空数组 / 全零容量不改变现状，不会误判成 0% 放行', () => {
    diskGuard.update(96);
    diskGuard.setProbe(() => []);
    diskGuard.refreshNow();
    expect(diskGuard.get().tier).toBe('freeze');
  });
});

describe('回收强度随磁盘压力放大（2026-07-27 生产实测：积压 4598 个）', () => {
  it('越紧张单轮删得越多，正常档保持保守', () => {
    expect(imageMaxRemovalsFor('ok')).toBe(40);
    expect(imageMaxRemovalsFor('notice')).toBe(100);
    expect(imageMaxRemovalsFor('reclaim')).toBe(200);
    expect(imageMaxRemovalsFor('freeze')).toBe(400);
  });

  it('配置基数更大时以基数为准（不因分档反而删得更少）', () => {
    expect(imageMaxRemovalsFor('notice', 500)).toBe(500);
    expect(imageMaxRemovalsFor('ok', 500)).toBe(500);
  });
});

describe('sweep 不得覆盖多文件系统读数（Codex 第三十轮 P1）', () => {
  beforeEach(() => diskGuard.reset());

  it('注册了探测器时，按探测器的 worst-of 刷新，忽略调用方给的单盘兜底值', () => {
    // janitor 只量 worktree；若直接拿它 update，docker 盘已到冻结线时每轮 sweep
    // 都会把闸门重新打开，同轮的镜像回收还会按低压档位执行。
    diskGuard.setProbe(() => [
      { totalBytes: 100, freeBytes: 70 }, // worktree 30%
      { totalBytes: 100, freeBytes: 4 },  // docker 96%
    ]);
    const tier = diskGuard.refreshOrUpdate(30);
    expect(tier).toBe('freeze');
    expect(diskGuard.get().usedPercent).toBe(96);
  });

  it('没有探测器时才用兜底值（janitor 单测与旧部署路径不回归）', () => {
    const tier = diskGuard.refreshOrUpdate(88);
    expect(tier).toBe('reclaim');
    expect(diskGuard.get().usedPercent).toBe(88);
  });
});

describe('docker 数据目录必须在本命名空间可见（Codex 第三十三轮 P1）', () => {
  beforeEach(() => { resetDockerDataRootCache(); delete process.env.CDS_DOCKER_DATA_ROOT; });
  afterAll(() => { resetDockerDataRootCache(); delete process.env.CDS_DOCKER_DATA_ROOT; });

  it('本命名空间看得见真正的 docker 根（有 overlay2/image）才采用', () => {
    const seen = new Set(['/var/lib/docker', '/var/lib/docker/overlay2']);
    expect(resolveDockerDataRoot(() => '/var/lib/docker', (p) => seen.has(p))).toBe('/var/lib/docker');
  });

  it('master 跑在容器里、daemon 路径在本命名空间不存在时返回 null（宁可不量也不量错）', () => {
    // docker info 给的是 daemon 侧路径；master 容器里 statfs 同名路径要么不存在、
    // 要么量了个完全无关的文件系统——那会让 docker 盘满时闸门照样放行。
    expect(resolveDockerDataRoot(() => '/var/lib/docker', () => false)).toBeNull();
  });

  it('路径存在但不像 docker 根（无 overlay2/image）也拒绝采用', () => {
    const seen = new Set(['/var/lib/docker']);
    expect(resolveDockerDataRoot(() => '/var/lib/docker', (p) => seen.has(p))).toBeNull();
  });

  it('运维显式指定的挂载点优先，且同样要求存在', () => {
    process.env.CDS_DOCKER_DATA_ROOT = '/mnt/dockerdata';
    expect(resolveDockerDataRoot(() => '/var/lib/docker', (p) => p === '/mnt/dockerdata')).toBe('/mnt/dockerdata');
    resetDockerDataRootCache();
    expect(resolveDockerDataRoot(() => '/var/lib/docker', () => false)).toBeNull();
  });

  it('docker info 不可用时返回 null，不抛', () => {
    expect(resolveDockerDataRoot(() => { throw new Error('docker missing'); }, () => true)).toBeNull();
  });
});
