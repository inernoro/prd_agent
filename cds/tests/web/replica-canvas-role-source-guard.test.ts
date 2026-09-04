/**
 * 源码守卫：运行画布的 WEB / API 角色只能来自服务端（service-graph inferServiceRole），
 * 前端不得再自己按服务名正则猜（predicate-and-wiring-discipline 形状 3：判据分裂后各自漂移）。
 * 2026-09-02 之前画布里有一条 /web|admin|front|console|ui/ 正则，和 forwarder 的按名约定、
 * 后端角色判定三处各写各的；本守卫防止它被抄回来。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PANEL = path.resolve(__dirname, '../../web/src/components/branch/ReplicaSetPanel.tsx');

describe('运行画布角色判定不在前端按名字猜', () => {
  const src = fs.readFileSync(PANEL, 'utf8');
  it('没有按服务名判 web / api 的正则', () => {
    expect(src).not.toMatch(/\/(?:[a-z]+\|)+[a-z]+\/i?\.test\(\s*(?:id|pid|profileId)\s*\)/);
    expect(src).not.toContain('isWebLike');
  });
  it('徽标读的是服务端给的 role，并把非声明来源标成推断', () => {
    expect(src).toContain('node?.role');
    expect(src).toContain("roleSource !== 'declared'");
    expect(src).toContain('data-role-source');
  });
  it('入口只连站点的壳，前缀成员由壳下面的前缀线承接', () => {
    expect(src).toContain('prefixEdges');
    expect(src).toContain('graph.sites');
  });
});
