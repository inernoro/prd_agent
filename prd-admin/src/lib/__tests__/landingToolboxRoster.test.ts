import { describe, expect, it } from 'vitest';
import { translations } from '@/pages/home/i18n/landing';
import { FALLBACK_ICON, toolboxIconPath } from '@/pages/home/scenes/ToolboxScene';
import { BUILTIN_TOOLS } from '@/stores/toolboxStore';

/**
 * 守卫：**首页百宝箱那一幕说自己「照着注册表来」，那就得真照着。**
 *
 * 这一幕的名单是手抄进 i18n 的快照，不是运行时从注册表算出来的。原来的文案更进一步，
 * 写的是「加一个新 Agent，这里自动多一个」——那是在宣称一个不存在的机制：注册表加了
 * 东西，这一屏不会变。文案已经改成「照着注册表来」这个较弱、但真实的说法。
 *
 * 弱一点的说法也得有人管，否则它照样会漂：注册表里改个名、把某个 Agent 从预览转正，
 * 首页还在用旧的说法，几个月后就变成另一种谎。所以这条守卫盯两件事：
 *
 * 1. 列出来的名字必须真在注册表里（改名即红），**一个例外都不许有**；
 * 2. 「预览」标记必须等于注册表的 `wip`（转正或退回预览，两边必须一起动）；
 * 3. 图标必须等于注册表那条的图标，**而且那一幕真的画得出来**——那一幕为了不给未登录页
 *    拉进整个图标库，自己维护了一小份路径表，查不到就退成一个通用方块。文案说的是
 *    「名字、一句话、图标都照着注册表来」，画成方块就没照着；而这条退化是静默的，
 *    页面照常渲染、类型照常通过，只有人真的看那一屏才发现。
 *
 * 第 3 条**跑的是那一幕真正用的那个函数**，不是扫它的源码。扫源码只能证明键在那儿：
 * 值是空串、值恰好就等于兜底方块，一样能扫出键来；反过来换个写法（加引号的键、
 * 展开一张共享表）明明画得出来却会判红。判据要读的是渲染时真正拿到的那个值。
 *
 * 第 1 条没有例外，是刻意的：只要留一个「这条不算」的口子，文案里那句「都照着注册表来」
 * 就又变成部分成立的话，而守卫照样绿——这正是要防的形状。原来的名单里「知识库」是导航
 * 路由、不在百宝箱内置表里，为此留过一个登记过的例外；这一版把它换成注册表里真有的
 * 「我的分享」，例外随之取消。知识库本身在这一页另有一整幕，没有被丢掉。
 *
 * 落地时还抓到一个：CDS Agent 在注册表里是 `wip: true`，首页却当成已验收的展示。
 *
 * 中英两份名单还要求 preview 标记逐位一致——两个语言各改各的，是这类名单最常见的漂法。
 */

const zh = translations.zh.tail.toolbox;
const en = translations.en.tail.toolbox;

const zhItems = zh.groups.flatMap((g) => g.items);
const enItems = en.groups.flatMap((g) => g.items);

const registry = new Map(BUILTIN_TOOLS.map((t) => [t.name, t]));

describe('首页百宝箱那一幕的名单', () => {
  it('确实有名单可查（否则下面几条恒真）', () => {
    expect(zhItems.length).toBeGreaterThanOrEqual(12);
    expect(registry.size).toBeGreaterThanOrEqual(20);
  });

  it('每个列出的名字都在注册表里，一个例外都没有', () => {
    const missing = zhItems.map((i) => i.name).filter((name) => !registry.has(name));
    expect(missing).toEqual([]);
  });

  it('「预览」标记必须等于注册表的 wip', () => {
    const mismatched = zhItems
      .filter((i) => registry.has(i.name))
      .filter((i) => Boolean(i.preview) !== Boolean(registry.get(i.name)?.wip))
      .map((i) => `${i.name}: 首页 preview=${Boolean(i.preview)} / 注册表 wip=${Boolean(registry.get(i.name)?.wip)}`);
    expect(mismatched).toEqual([]);
  });

  it('图标必须等于注册表那条的图标', () => {
    const mismatched = zhItems
      .filter((i) => registry.has(i.name))
      .filter((i) => i.icon !== registry.get(i.name)?.icon)
      .map((i) => `${i.name}: 首页 ${i.icon} / 注册表 ${registry.get(i.name)?.icon}`);
    expect(mismatched).toEqual([]);
  });

  it('这条判据分得清「画得出来」和「退成方块」（否则下面那条恒真）', () => {
    expect(toolboxIconPath('__不存在的图标__')).toBe(FALLBACK_ICON);
  });

  it('每个图标那一幕都画得出来，不会退成方块', () => {
    const unpaintable = zhItems
      .map((i) => ({ icon: i.icon, d: toolboxIconPath(i.icon) }))
      .filter(({ d }) => d === FALLBACK_ICON || d.trim().length === 0)
      .map(({ icon }) => icon);
    expect(unpaintable).toEqual([]);
  });

  it('中英两份名单的预览标记逐位一致', () => {
    expect(enItems.length).toBe(zhItems.length);
    expect(enItems.map((i) => Boolean(i.preview))).toEqual(zhItems.map((i) => Boolean(i.preview)));
  });
});
