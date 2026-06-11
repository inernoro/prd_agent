/**
 * 工作台「快捷操作」注册表护栏测试。
 *
 * 保证三件事：
 * 1. 注册表元数据完整（id 唯一、label 非空、默认项可解析）
 * 2. goto 类操作的目标 tab 必须真实存在于 SingleProductView 的 Section 联合类型（防 phantom tab）
 * 3. create 类操作的跳转路径必须命中 App.tsx 里真实注册的 /product-agent/p/:productId/:kind/new 路由
 */
import { describe, expect, it, vi } from 'vitest';
import {
  QUICK_ACTION_REGISTRY,
  DEFAULT_QUICK_ACTION_IDS,
  resolveQuickActions,
  type QuickActionContext,
} from '../quickActionRegistry';
import singleProductViewRaw from '../SingleProductView.tsx?raw';
import navRegistryRaw from '../../../app/navRegistry.tsx?raw';
import objectDetailPageRaw from '../ProductObjectDetailPage.tsx?raw';

/** 执行一个 action，记录它到底是切 tab 还是跳路由 */
function runAction(id: string): { tabs: string[]; paths: string[] } {
  const action = QUICK_ACTION_REGISTRY.find((a) => a.id === id)!;
  const tabs: string[] = [];
  const paths: string[] = [];
  const ctx: QuickActionContext = {
    productId: 'PID',
    navigate: vi.fn((to: unknown) => { paths.push(String(to)); }) as unknown as QuickActionContext['navigate'],
    gotoTab: (t) => tabs.push(t),
  };
  action.run(ctx);
  return { tabs, paths };
}

/** 从 SingleProductView.tsx 源码提取 Section 联合类型的合法 key 集合 */
function parseSectionKeys(): Set<string> {
  const m = singleProductViewRaw.match(/type Section = ([^;]+);/);
  expect(m, 'SingleProductView.tsx 应有 type Section 联合类型').toBeTruthy();
  return new Set([...m![1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]));
}

describe('quickActionRegistry', () => {
  it('id 唯一且 label 非空', () => {
    const ids = QUICK_ACTION_REGISTRY.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of QUICK_ACTION_REGISTRY) expect(a.label.trim().length).toBeGreaterThan(0);
  });

  it('默认快捷操作全部可解析', () => {
    const defs = resolveQuickActions(DEFAULT_QUICK_ACTION_IDS);
    expect(defs.map((d) => d.label)).toEqual(['创建需求', '创建缺陷']);
  });

  it('resolveQuickActions 忽略未知 id（向前兼容）', () => {
    const defs = resolveQuickActions(['create-requirement', 'removed-action', 'create-defect']);
    expect(defs.map((d) => d.id)).toEqual(['create-requirement', 'create-defect']);
  });

  it('每个操作恰好触发一种效果（切 tab 或跳路由）', () => {
    for (const a of QUICK_ACTION_REGISTRY) {
      const { tabs, paths } = runAction(a.id);
      expect(tabs.length + paths.length, `操作 ${a.id} 应恰好触发一次效果`).toBe(1);
      if (a.group === 'goto') expect(tabs.length, `goto 操作 ${a.id} 应切 tab`).toBe(1);
      if (a.group === 'create') expect(paths.length, `create 操作 ${a.id} 应跳路由`).toBe(1);
    }
  });

  it('goto 操作的目标 tab 必须存在于 SingleProductView 的 Section（防 phantom tab）', () => {
    const sections = parseSectionKeys();
    for (const a of QUICK_ACTION_REGISTRY.filter((x) => x.group === 'goto')) {
      const { tabs } = runAction(a.id);
      expect(sections.has(tabs[0]), `操作 ${a.id} 指向不存在的 tab「${tabs[0]}」`).toBe(true);
    }
  });

  it('create 操作的路径必须命中真实注册的新建路由（防 phantom route）', () => {
    // 路由在 navRegistry 以参数化形式注册：/product-agent/p/:productId/:kind/:id（id=new 走新建）
    expect(
      navRegistryRaw.includes('/product-agent/p/:productId/:kind/:id'),
      'navRegistry 应注册 /product-agent/p/:productId/:kind/:id 路由',
    ).toBe(true);
    for (const a of QUICK_ACTION_REGISTRY.filter((x) => x.group === 'create')) {
      const { paths } = runAction(a.id);
      const m = paths[0].match(/^\/product-agent\/p\/PID\/([a-z-]+)\/new$/);
      expect(m, `操作 ${a.id} 路径 ${paths[0]} 不符合新建路由格式`).toBeTruthy();
      // kind 必须被 ProductObjectDetailPage 实际处理（kind === 'xxx' 分支存在）
      expect(
        objectDetailPageRaw.includes(`kind === '${m![1]}'`),
        `操作 ${a.id} 的对象类型「${m![1]}」在 ProductObjectDetailPage 没有处理分支`,
      ).toBe(true);
    }
  });
});
