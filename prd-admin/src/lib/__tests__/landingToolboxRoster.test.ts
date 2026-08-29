import { describe, expect, it } from 'vitest';
import { translations } from '@/pages/home/i18n/landing';
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
 * 1. 列出来的名字必须真在注册表里（改名即红）；
 * 2. 「预览」标记必须等于注册表的 `wip`（转正或退回预览，两边必须一起动）。
 *
 * 落地时确实抓到一个：CDS Agent 在注册表里是 `wip: true`，首页却当成已验收的展示。
 *
 * 中英两份名单还要求 preview 标记逐位一致——两个语言各改各的，是这类名单最常见的漂法。
 */

const zh = translations.zh.tail.toolbox;
const en = translations.en.tail.toolbox;

const zhItems = zh.groups.flatMap((g) => g.items);
const enItems = en.groups.flatMap((g) => g.items);

const registry = new Map(BUILTIN_TOOLS.map((t) => [t.name, t]));

/**
 * 列在首页、却不在**前端**内置表里的名字。
 *
 * 「知识库」是导航路由，不是百宝箱的内置工具条目；它到底会不会出现在真实的百宝箱页，
 * 取决于后端下发的 `toolbox_items`，静态守卫判不了——所以显式登记在这里，而不是假装它通过了。
 * 要再往这个集合里加第二个，先说清它为什么不在注册表里；这里越长，「照着注册表来」这句话越虚。
 */
const NOT_IN_FRONTEND_REGISTRY = new Set(['知识库']);

describe('首页百宝箱那一幕的名单', () => {
  it('确实有名单可查（否则下面几条恒真）', () => {
    expect(zhItems.length).toBeGreaterThanOrEqual(12);
    expect(registry.size).toBeGreaterThanOrEqual(20);
  });

  it('每个列出的名字都在注册表里（登记过的例外除外）', () => {
    const missing = zhItems
      .map((i) => i.name)
      .filter((name) => !registry.has(name) && !NOT_IN_FRONTEND_REGISTRY.has(name));
    expect(missing).toEqual([]);
  });

  it('例外集合不许悄悄变大', () => {
    expect(NOT_IN_FRONTEND_REGISTRY.size).toBeLessThanOrEqual(1);
  });

  it('「预览」标记必须等于注册表的 wip', () => {
    const mismatched = zhItems
      .filter((i) => registry.has(i.name))
      .filter((i) => Boolean(i.preview) !== Boolean(registry.get(i.name)?.wip))
      .map((i) => `${i.name}: 首页 preview=${Boolean(i.preview)} / 注册表 wip=${Boolean(registry.get(i.name)?.wip)}`);
    expect(mismatched).toEqual([]);
  });

  it('中英两份名单的预览标记逐位一致', () => {
    expect(enItems.length).toBe(zhItems.length);
    expect(enItems.map((i) => Boolean(i.preview))).toEqual(zhItems.map((i) => Boolean(i.preview)));
  });
});
