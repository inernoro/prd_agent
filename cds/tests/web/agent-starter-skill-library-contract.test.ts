import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ALL_SKILL_GROUP,
  SkillLibrarySheet,
  SkillSourcePanel,
  normalizeSkillSource,
  summarizeSkillSelection,
} from '../../web/src/components/AgentStarterTab';
import { normalizeBundleViews } from '../../web/src/components/SkillDownloadDialog';
import { STARTER_SKILL_BUNDLES } from '../../src/services/skill-proxy.js';

const source = fs.readFileSync(
  path.join(process.cwd(), 'web/src/components/AgentStarterTab.tsx'),
  'utf8',
);
const styles = fs.readFileSync(path.join(process.cwd(), 'web/src/index.css'), 'utf8');

const SKILLS = [
  { key: 'plan-first', name: '先出方案', description: '动手前先说明路径、影响和取舍。', roles: [], recommendedRoles: [], groupKey: 'foundation', groupLabel: '基础方法' },
  { key: 'scope-check', name: '分支边界审计', description: '识别越界、共享与未知的改动范围。', roles: [], recommendedRoles: [], groupKey: 'delivery', groupLabel: '研发交付' },
] as const;

function renderSheet(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(SkillLibrarySheet, {
    groups: [{ key: ALL_SKILL_GROUP, label: '全部技能', count: 2 }],
    activeGroup: ALL_SKILL_GROUP,
    onActiveGroup: () => {},
    query: '',
    onQuery: () => {},
    visibleSkills: SKILLS as never,
    totalCount: 2,
    selectedKeys: ['plan-first'],
    openedWith: ['plan-first'],
    recommendedKeys: ['plan-first'],
    onToggle: () => {},
    onCancel: () => {},
    onDone: () => {},
    ...overrides,
  } as never));
}

describe('Agent 上手助手技能库契约', () => {
  it('默认只展示角色推荐，不把完整技能库一次铺满', () => {
    expect(source).toContain('skill.recommendedRoles.includes(roleId)');
    expect(source).toContain('.slice(0, 6)');
    expect(source).toContain('recommendedSkills');
  });

  /*
   * 这一条是本次事故的判据本身。
   *
   * 旧实现把技能库做成原地换模式，且主按钮写成 `{!showSkillLibrary && <PrimaryNext/>}`
   * —— 进了技能库那一屏就没有任何前进出口，用户只能在同一个位置、同一款样式的
   * 「返回角色推荐」上兜圈子。所以守卫要钉两件事：主按钮不许被任何「库开着」的
   * 条件挡住，技能库必须是浮层。
   */
  it('主按钮不受技能库开关影响，永远在推荐页上', () => {
    expect(source).toMatch(/<PrimaryNext onClick=\{\(\) => advance\(3\)\}>确认这些技能<\/PrimaryNext>/);
    // 任何形如 `{!libraryOpen && <PrimaryNext` / `{!showSkillLibrary && <PrimaryNext` 的写法都是旧病复发。
    expect(source).not.toMatch(/\{\s*!\s*\w*[lL]ibrary\w*\s*&&\s*<PrimaryNext/);
  });

  it('技能库是浮层，推荐页留在下面没被换掉', () => {
    expect(source).toContain('<SkillLibrarySheet');
    expect(source).toMatch(/step === 2 && libraryOpen/);
    // 浮层挂在面板自己身上，绝对定位才有参照系。
    expect(source).toMatch(/className=\{`relative flex max-h-/);
  });

  it('技能库给出三个出口：关闭、放弃这次改动、完成选择', () => {
    const markup = renderSheet();
    expect(markup).toContain('aria-label="关闭技能库"');
    expect(markup).toContain('放弃这次改动');
    expect(markup).toContain('完成选择');
  });

  it('搜不到东西时给的是出路，不是空白', () => {
    const markup = renderSheet({ visibleSkills: [], query: '不存在的技能' });
    expect(markup).toContain('没有匹配');
    expect(markup).toContain('清除搜索');
  });

  it('技能库只在助手内部滚动，不拉长整个页面', () => {
    expect(source).toContain('overflow-y-auto');
    expect(source).toContain('overflow-hidden');
  });

  it('步骤 03 的返回按钮走行内，不和底栏叠在一起', () => {
    // 面板底部那个绝对定位的返回固定在 bottom-5 left-8，而步骤 03 的底栏是最后一个
    // 流式子元素——两者会正好压在一起。步骤 02 用 pb-14 让位，步骤 03 没有，
    // 所以这一屏必须把返回收进底栏，并把绝对定位那个排除掉。
    expect(source).toMatch(/step > 0 && step < 4 && step !== 2/);
    expect(source).toMatch(/onClick=\{\(\) => advance\(1\)\}[\s\S]{0,400}返回/);
  });

  it('只有打开的上手助手弹窗才能隐藏全局入口和锁定页面滚动', () => {
    const openDialogSelector = "body:has([role='dialog'][data-state='open'] [data-agent-starter='true'])";
    expect(styles.match(new RegExp(openDialogSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length).toBe(3);
    expect(styles).not.toContain("body:has([data-agent-starter='true'])");
  });

  it('手机端隐藏总导航后让逐步选择内容填满弹窗', () => {
    expect(styles).toContain("[role='dialog']:has([data-agent-starter='true']) > div:first-child");
    expect(styles).toContain('flex: 1 1 auto !important;');
    expect(styles).toContain('min-height: 0 !important;');
  });
});

describe('技能库的改动摘要', () => {
  it('分得清保留、新加和去掉', () => {
    expect(summarizeSkillSelection({ selected: ['a', 'b', 'c'], openedWith: ['a', 'd'] }))
      .toEqual({ total: 3, kept: 1, added: 2, removed: 1 });
  });

  it('没动过就是没动过', () => {
    expect(summarizeSkillSelection({ selected: ['a'], openedWith: ['a'] }))
      .toEqual({ total: 1, kept: 1, added: 0, removed: 0 });
  });
});

describe('技能来源面板', () => {
  /*
   * 面板存在的理由：原来「查看技能来源」是一个直接指向 /api/skills/bundles 的外链，
   * 点一下把接口裸 JSON 甩给用户。以下用例钉的是「面板说的每句话都有来源」。
   */
  it('服务端没报出来源就返回 null，不许拿 0 兜底', () => {
    expect(normalizeSkillSource({ bundles: [] })).toBeNull();
    expect(normalizeSkillSource({ source: { kind: 'builtin' } })).toBeNull();
    expect(normalizeSkillSource({ source: { kind: 'builtin', bundleCount: 4, skillCount: 19, localSkillCount: 17, upstreamSkillCount: 2, upstreamConfigured: true } }))
      .toEqual({ kind: 'builtin', bundleCount: 4, skillCount: 19, localSkillCount: 17, upstreamSkillCount: 2, upstreamConfigured: true });
  });

  it('读不到清单时如实说「现在这份是兜底的」，并给重试', () => {
    const markup = renderToStaticMarkup(createElement(SkillSourcePanel, {
      state: 'fallback',
      source: null,
      fallbackCount: 19,
      rawUrl: 'https://cds.example.com/api/skills/bundles',
      onRetry: () => {},
    }));
    expect(markup).toContain('读不到来源');
    expect(markup).toContain('兜底清单');
    expect(markup).toContain('重新读一次');
  });

  it('读到来源就回答「还能不能装」，回源装不上时明确告警', () => {
    const markup = renderToStaticMarkup(createElement(SkillSourcePanel, {
      state: 'ok',
      source: { kind: 'builtin', bundleCount: 4, skillCount: 19, localSkillCount: 17, upstreamSkillCount: 2, upstreamConfigured: false },
      fallbackCount: 19,
      rawUrl: 'https://cds.example.com/api/skills/bundles',
      onRetry: () => {},
    }));
    expect(markup).toContain('4 类 · 19 个技能');
    expect(markup).toContain('17 个这台 CDS 自带');
    expect(markup).toContain('没有配置上游');
  });

  it('清单读到了但服务端没报来源时，说没报出来，不编一个', () => {
    const markup = renderToStaticMarkup(createElement(SkillSourcePanel, {
      state: 'ok',
      source: null,
      fallbackCount: 19,
      rawUrl: 'https://cds.example.com/api/skills/bundles',
      onRetry: () => {},
    }));
    expect(markup).toContain('没有报出来源信息');
  });

  it('没有市场入口时不渲染那个按钮，不给死链', () => {
    const withoutTab = renderToStaticMarkup(createElement(SkillSourcePanel, {
      state: 'ok', source: null, fallbackCount: 19, rawUrl: 'https://x/api', onRetry: () => {},
    }));
    expect(withoutTab).not.toContain('在技能市场里逐个看');
    const withTab = renderToStaticMarkup(createElement(SkillSourcePanel, {
      state: 'ok', source: null, fallbackCount: 19, rawUrl: 'https://x/api', onRetry: () => {}, onOpenMarketplace: () => {},
    }));
    expect(withTab).toContain('在技能市场里逐个看');
  });

  it('面板真的接进了完成页（删掉接线不会红就等于没接）', () => {
    expect(source).toContain('<SkillSourcePanel');
    expect(source).toMatch(/onClick=\{toggleSkillSource\}/);
    // 主入口不许再是一个指向接口的裸链接。
    expect(source).not.toMatch(/<a href=\{`\$\{serviceOrigin\}\/api\/skills\/bundles`\}[\s\S]{0,200}查看技能来源/);
  });
});

describe('技能清单的响应形状', () => {
  /*
   * 事故：两处调用方都写着 `data?.data?.items`，而这个端点返回的是
   * `{ bundles: [...] }`——技能市场 tab 与项目初始化的技能明细双双恒定为空，
   * 全程无报错。判据直接拿服务端的真实常量喂，形状一变就红。
   */
  it('能把服务端真实返回读成界面要的形状', () => {
    const views = normalizeBundleViews(STARTER_SKILL_BUNDLES);
    expect(views.length).toBe(STARTER_SKILL_BUNDLES.bundles.length);
    expect(views.every((view) => view.skillCount > 0)).toBe(true);
    expect(views[0].title).toBe(STARTER_SKILL_BUNDLES.bundles[0].label);
    expect(views[0].skills[0].key).toBe(STARTER_SKILL_BUNDLES.bundles[0].skills[0].key);
    // 角色 id 要翻成中文，别把 pm / owner 直接摆给用户看。
    expect(views[0].roleLabels).toContain('产品经理');
  });

  it('形状不认识时返回空数组，不抛异常', () => {
    expect(normalizeBundleViews({ data: { items: [{ key: 'x' }] } })).toEqual([]);
    expect(normalizeBundleViews(null)).toEqual([]);
  });
});
