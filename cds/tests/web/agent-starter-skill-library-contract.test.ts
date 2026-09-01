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

  /*
   * 卡片必须有个「下沉的底」可以浮在上面。
   *
   * 事故值：卡片填充和它背后的底原来都是 surface-raised，对比度 1.000——
   * 完全同色，只有 1px 发丝线在区分。深色下靠近黑底把白字和琥珀色顶出来，
   * 看不出这个洞；白天没这个红利，整片纯白（用户原话「有点光光的」）。
   * 修法是给浮层一个下沉的内容区，两个主题都变成 1.21。
   *
   * 判据钉的是不变量本身——**内容区的表面不许和卡片同色**，而不是数某个
   * token 出现几次（数数会被关闭按钮、hover 底色这些小控件带偏）。
   * 任何一方改成和另一方同层，这条即红。
   */
  it('技能卡浮在下沉的内容区上，不是同色贴同色', () => {
    const markup = renderSheet();
    // 内容区 = 装着搜索框和网格的那一列，用 `p-4 lg:p-5` 这个唯一后缀锚定
    const well = markup.match(/bg-\[hsl\(var\(--surface-(\w+)\)\)\] p-4 lg:p-5/)?.[1];
    // 卡片认 data-skill-card="default"（未选中态才有填充色；选中态走 warn-soft）。
    // 不许按「第几个 aria-pressed 按钮」去猜——分组筛选也是 aria-pressed，
    // 猜出来的是没有表面 token 的分组按钮，判据会静默读到 undefined。
    const cardTag = markup.match(/<button[^>]*data-skill-card="default"[^>]*>/)?.[0] ?? '';
    const card = cardTag.match(/--surface-(\w+)/)?.[1];
    // 任一侧读不出来就直接失败，不许因为「没匹配到」而静默通过
    expect(well).toBeTruthy();
    expect(card).toBeTruthy();
    expect(well).not.toBe(card);
  });

  /*
   * Codex 第三轮 P2：键盘用户能 Tab 到被浮层盖住的「确认这些技能」并按下去——
   * 浮层还开着，向导却前进了。那是本 PR 声明的三个出口之外的第四个、看不见的
   * 出口，正好推翻这次要修的东西，所以按 A 类缺陷处理。
   *
   * 判据钉三件事：被盖住的那一屏要整块 inert、浮层有对话框语义、焦点收进来。
   * inert 走 DOM 属性而不是 JSX prop——React 18 不认识它。
   */
  it('技能库开着时，被盖住的那一屏不可聚焦', () => {
    expect(source).toMatch(/stepContentRef\.current[\s\S]{0,80}?\.inert = skillLibraryOpen/);
    expect(source).toMatch(/<div ref=\{stepContentRef\}/);
    const markup = renderSheet();
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    // 焦点收进浮层，不留在被盖住的「打开技能库」上
    expect(source).toMatch(/searchRef\.current\?\.focus\(\)/);
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

  /*
   * Codex review P2（本 PR）：完成页新增的「去技能市场」会把 active 切成
   * marketplace，而弹窗当时写的是 `active === 'starter' ? <AgentStarterTab/> : null`
   * —— 一切走就卸载，回来直接退到步骤 01，用户选好的技能和交付方式全丢，
   * 而这个入口恰恰开在「配置已完成、结果还没抄走」的那一屏。
   *
   * 判据钉的是「切走时不许卸载」这个不变量：三元卸载的写法一旦回来即红。
   */
  it('切到技能市场时上手助手只藏不卸，向导状态不丢', () => {
    const dialog = fs.readFileSync(
      path.join(process.cwd(), 'web/src/components/SkillDownloadDialog.tsx'),
      'utf8',
    );
    // 不许再出现「三元把 AgentStarterTab 整个渲染掉」的卸载写法。
    // 判据盯的是这个三元和组件之间的直接关系，不是文件里有没有 `: null`
    // ——别的 tab 用三元卸载是合理的，只有向导不行。
    expect(dialog).not.toMatch(/active === 'starter'[\s\S]{0,80}?\?\s*\(?\s*<AgentStarterTab/);
    // 必须是「常驻挂载 + 用 hidden 切显隐」
    expect(dialog).toMatch(/active === 'starter' \? undefined : 'hidden'/);
  });

  /*
   * Codex 第二轮 P2：重试读清单会把用户改过的技能选择冲掉。
   *
   * 铺推荐的那个 effect 原来只依赖 recommendedSkills，而它在两种情况下都会变：
   * 换角色（该重铺）和清单重新加载（不该重铺）。后者包含「读不到清单 → 用兜底
   * 清单配好 → 点重新读一次 → 成功」这条路，而重试按钮就开在完成页。
   *
   * 判据钉的是「清单变化不许无条件重铺」：effect 里必须有定制标记的早退，
   * 且用户动手的入口要把标记立起来。
   */
  it('清单重新加载不冲掉用户改过的技能选择', () => {
    // 铺推荐的 effect 必须先看定制标记再决定要不要覆盖
    expect(source).toMatch(/if \(skillsCustomizedRef\.current\) return[\s\S]{0,120}?setSelectedSkills\(recommendedSkills/);
    // 换角色是用户自己的动作，标记归零后重铺推荐才合理
    expect(source).toMatch(/skillsCustomizedRef\.current = false[\s\S]{0,60}?\}, \[roleId\]\)/);
    // 勾选/取消技能要把标记立起来，否则早退永远不生效
    expect(source).toMatch(/toggleSkill[\s\S]{0,160}?skillsCustomizedRef\.current = true/);
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
    expect(normalizeSkillSource({ source: { kind: 'builtin', bundleCount: 4, skillCount: 19, localSkillCount: 17, cachedSkillCount: 0, upstreamSkillCount: 2, upstreamConfigured: true } }))
      .toEqual({ kind: 'builtin', bundleCount: 4, skillCount: 19, localSkillCount: 17, cachedSkillCount: 0, upstreamSkillCount: 2, upstreamConfigured: true });
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
      source: { kind: 'builtin', bundleCount: 4, skillCount: 19, localSkillCount: 17, cachedSkillCount: 0, upstreamSkillCount: 2, upstreamConfigured: false },
      fallbackCount: 19,
      rawUrl: 'https://cds.example.com/api/skills/bundles',
      onRetry: () => {},
    }));
    expect(markup).toContain('4 类 · 19 个技能');
    expect(markup).toContain('17 个这台 CDS 上有现成的');
    expect(markup).toContain('没有配置上游');
  });

  /*
   * Codex review P2（本 PR）：缓存包被算进了「必须回源」。
   *
   * 面板原来的话是「这 N 个技能需要回源，但没配上游，装到它们会失败」——
   * 对一个缓存里躺着现成 zip 的技能，这句是假的（fetchSkill 命中缓存直接返回，
   * 上游失败还会回退陈旧缓存）。判据钉两件事：缓存要算进「断网也装得上」，
   * 且全都装得上时不许再出那条告警。
   */
  it('缓存包算进「断网也装得上」，不触发回源告警', () => {
    const markup = renderToStaticMarkup(createElement(SkillSourcePanel, {
      state: 'ok',
      // 19 个里 12 个本机自带、7 个只有缓存包，一个都不需要回源
      source: { kind: 'builtin', bundleCount: 4, skillCount: 19, localSkillCount: 12, cachedSkillCount: 7, upstreamSkillCount: 0, upstreamConfigured: false },
      fallbackCount: 19,
      rawUrl: 'https://cds.example.com/api/skills/bundles',
      onRetry: () => {},
    }));
    expect(markup).toContain('19 个这台 CDS 上都有现成的');
    // 上游没配，但一个都不缺——不许再说「装到它们会失败」
    expect(markup).not.toContain('装到它们会失败');
  });

  it('确实缺包时照旧告警，并说清缺在哪一档', () => {
    const markup = renderToStaticMarkup(createElement(SkillSourcePanel, {
      state: 'ok',
      source: { kind: 'builtin', bundleCount: 4, skillCount: 19, localSkillCount: 10, cachedSkillCount: 4, upstreamSkillCount: 5, upstreamConfigured: false },
      fallbackCount: 19,
      rawUrl: 'https://cds.example.com/api/skills/bundles',
      onRetry: () => {},
    }));
    expect(markup).toContain('14 个这台 CDS 上有现成的');
    expect(markup).toContain('含 4 个缓存包');
    expect(markup).toContain('装到它们会失败');
  });

  /*
   * 分类明细只有在加起来等于总数时才准露面。
   * 技能库按角色筛（产品经理 18 个），来源面板报的是整份清单（22 个）——
   * 两个口径摆在同一块面板里对不上，用户只会以为哪个数错了。
   */
  it('分类条数加得起来才显示', () => {
    const source = { kind: 'builtin', bundleCount: 2, skillCount: 22, localSkillCount: 22, cachedSkillCount: 0, upstreamSkillCount: 0, upstreamConfigured: true };
    const base = { state: 'ok' as const, source, fallbackCount: 19, rawUrl: 'https://x/api', onRetry: () => {} };
    const good = renderToStaticMarkup(createElement(SkillSourcePanel, {
      ...base, groups: [{ key: 'a', label: '基础方法', count: 14 }, { key: 'b', label: '研发交付', count: 8 }],
    }));
    expect(good).toContain('分成');
    expect(good).toContain('基础方法');

    // 口径不一致（按角色筛过的 18）：宁可不显示，也不摆一组对不上的数字
    const mismatched = renderToStaticMarkup(createElement(SkillSourcePanel, {
      ...base, groups: [{ key: 'a', label: '基础方法', count: 10 }, { key: 'b', label: '研发交付', count: 8 }],
    }));
    expect(mismatched).not.toContain('研发交付');
  });

  it('角色筛掉一部分时说清楚为什么技能库比总数少', () => {
    const markup = renderToStaticMarkup(createElement(SkillSourcePanel, {
      state: 'ok',
      source: { kind: 'builtin', bundleCount: 4, skillCount: 22, localSkillCount: 22, cachedSkillCount: 0, upstreamSkillCount: 0, upstreamConfigured: true },
      roleLabel: '产品经理',
      roleSkillCount: 18,
      fallbackCount: 19,
      rawUrl: 'https://x/api',
      onRetry: () => {},
    }));
    expect(markup).toContain('按「产品经理」筛出 18 个');
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
