/**
 * 全零权重的占比渲染（Codex 第三十七轮 P2）。
 *
 * 权重 0 是合法值。primaryWeight=0 且全部运行中成员也是 0 时总权重为 0，
 * 原实现直接 weight/total 渲染出 NaN%；而 forwarder 在这种情况下**回落到主实例**
 * （route-resolver 的 total <= 0 分支），所以画布必须显示「主 100% / 副本 0%」——
 * 既不是 NaN，也不能装作还在按权重分流。
 */
import { describe, it, expect } from 'vitest';
import { replicaSharePct } from '../../web/src/lib/replicaGroups';

describe('replicaSharePct', () => {
  it('正常权重按比例四舍五入', () => {
    expect(replicaSharePct(100, 200, true)).toBe(50);
    expect(replicaSharePct(50, 200, false)).toBe(25);
    expect(replicaSharePct(1, 3, false)).toBe(33);
  });

  it('全零权重：主 100%、副本 0%，与 resolver 的回落行为一致', () => {
    expect(replicaSharePct(0, 0, true)).toBe(100);
    expect(replicaSharePct(0, 0, false)).toBe(0);
    expect(Number.isNaN(replicaSharePct(0, 0, true))).toBe(false);
  });

  it('负总权重同样按回落处理（不产生负百分比）', () => {
    expect(replicaSharePct(0, -5, true)).toBe(100);
    expect(replicaSharePct(0, -5, false)).toBe(0);
  });
});
