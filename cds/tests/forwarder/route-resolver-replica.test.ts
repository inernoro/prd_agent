/**
 * Forwarder 复制集分流单测 — design.cds.replica-set
 *
 * 实现位置:cds/src/forwarder/route-resolver.ts（pickReplica + resolveRoute 扩展）
 * 契约:
 *   - 不带 replicaGroup 的存量路由行为逐字节不变（weight<=0 = 禁用）
 *   - 组内选择:粘性 > 加权随机 > 主成员回落
 *   - weight=0 成员不参与随机,但可被粘性直达
 */
import { describe, it, expect } from 'vitest';
import { pickReplica, resolveRoute } from '../../src/forwarder/route-resolver.js';
import type { RouteRecord } from '../../src/forwarder/types.js';

function r(partial: Partial<RouteRecord> & { _id: string; host: string }): RouteRecord {
  return {
    upstreamPort: 9001,
    weight: 100,
    ...partial,
  } as RouteRecord;
}

const GROUP = 'br1:prd-api';

function replicaGroupRoutes(): RouteRecord[] {
  return [
    r({ _id: 'g:primary', host: 'demo.miduo.org', upstreamPort: 9100, weight: 90, replicaGroup: GROUP, replicaMemberId: 'primary' }),
    r({ _id: 'g:rs01', host: 'demo.miduo.org', upstreamPort: 9200, weight: 10, replicaGroup: GROUP, replicaMemberId: 'rsaaaaaa' }),
    r({ _id: 'g:rs02', host: 'demo.miduo.org', upstreamPort: 9300, weight: 0, replicaGroup: GROUP, replicaMemberId: 'rsbbbbbb' }),
  ];
}

describe('RouteResolver — 复制集组内选择', () => {
  it('无 replicaGroup 时行为不变:weight=0 仍是禁用', () => {
    const routes = [
      r({ _id: 'a', host: 'demo.miduo.org', weight: 0, upstreamPort: 9100 }),
      r({ _id: 'b', host: 'demo.miduo.org', weight: 100, upstreamPort: 9200 }),
    ];
    expect(resolveRoute(routes, 'demo.miduo.org', '/')?._id).toBe('b');
  });

  it('粘性 cookie 命中成员:即使 weight=0 也直达', () => {
    const hit = resolveRoute(replicaGroupRoutes(), 'demo.miduo.org', '/', { sticky: 'rsbbbbbb' });
    expect(hit?.upstreamPort).toBe(9300);
    expect(hit?.replicaMemberId).toBe('rsbbbbbb');
  });

  it('粘性失配（成员已移除）回落加权选择,不 404', () => {
    const hit = resolveRoute(replicaGroupRoutes(), 'demo.miduo.org', '/', {
      sticky: 'rs_gone',
      rand: () => 0,
    });
    expect(hit?.replicaMemberId).toBe('primary');
  });

  it('加权随机:rand 落在权重区间内选对应成员', () => {
    // 权重 [primary=90, rsaaaaaa=10],rand=0.95 → 累计 90 之后 → 成员
    const hit = resolveRoute(replicaGroupRoutes(), 'demo.miduo.org', '/', { rand: () => 0.95 });
    expect(hit?.replicaMemberId).toBe('rsaaaaaa');
    const hit2 = resolveRoute(replicaGroupRoutes(), 'demo.miduo.org', '/', { rand: () => 0.1 });
    expect(hit2?.replicaMemberId).toBe('primary');
  });

  it('总权重为 0 时回落主成员', () => {
    const routes = [
      r({ _id: 'g:p', host: 'demo.miduo.org', upstreamPort: 9100, weight: 0, replicaGroup: GROUP, replicaMemberId: 'primary' }),
      r({ _id: 'g:m', host: 'demo.miduo.org', upstreamPort: 9200, weight: 0, replicaGroup: GROUP, replicaMemberId: 'rsaaaaaa' }),
    ];
    expect(resolveRoute(routes, 'demo.miduo.org', '/')?.replicaMemberId).toBe('primary');
  });

  it('组内选择不跨 prefix:更具体 prefix 的普通路由优先于组', () => {
    const routes = [
      ...replicaGroupRoutes(),
      r({ _id: 'x', host: 'demo.miduo.org', pathPrefix: '/api/', upstreamPort: 9400 }),
    ];
    expect(resolveRoute(routes, 'demo.miduo.org', '/api/v1')?.upstreamPort).toBe(9400);
    expect(resolveRoute(routes, 'demo.miduo.org', '/', { rand: () => 0.1 })?.upstreamPort).toBe(9100);
  });

  it('pickReplica 分布粗检:1000 次 rand 均匀采样,成员占比接近其权重', () => {
    const group = replicaGroupRoutes();
    let memberHits = 0;
    for (let i = 0; i < 1000; i += 1) {
      const picked = pickReplica(group, { rand: () => (i + 0.5) / 1000 });
      if (picked.replicaMemberId === 'rsaaaaaa') memberHits += 1;
    }
    expect(memberHits).toBeGreaterThan(80);
    expect(memberHits).toBeLessThan(120);
  });
});
