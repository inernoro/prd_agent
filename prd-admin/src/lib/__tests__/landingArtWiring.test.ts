import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LANDING_PREVIEW_SLOTS } from '@/lib/landingPreviewSlots';

/**
 * 守卫：注册表里的每个产物图槽位，首页上都真的有地方会用它。
 *
 * 这些槽位不是「多一张装饰图」，而是**替换掉幕里那张手绘假图**。所以两种漂移都要防：
 *   · 注册表登记了、页面上没人引用 → 管理员生成完，图永远不显示；
 *   · 页面上引用了、注册表没登记 → 那个位置永远是手绘图，管理员在设置里找不到它。
 *
 * 两头都断言才拦得住（`predicate-and-wiring-discipline` 形状 2：链路只建了一半，
 * 编译过、测试绿、通读也挑不出）。
 */

const HOME_DIR = path.resolve(__dirname, '../../pages/home');

function readHomeSources(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) out.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(HOME_DIR);
  return out.join('\n');
}

describe('首页产物图接线', () => {
  const source = readHomeSources();
  /** 页面源码里出现过的所有 landing.* 槽位字面量 */
  const used = new Set(
    Array.from(source.matchAll(/'(landing\.[a-z0-9.-]+)'/g), (m) => m[1]),
  );

  it('注册表里的每个槽位，首页源码里都有人引用', () => {
    const orphan = LANDING_PREVIEW_SLOTS.map((s) => s.slot).filter((slot) => !used.has(slot));
    expect(
      orphan,
      `这些槽位在 landingPreviewSlots 里登记了，但 pages/home 下没有任何地方引用 —— `
        + `管理员生成出来的图永远不会显示：${orphan.join(', ')}`,
    ).toEqual([]);
  });

  it('首页引用的每个槽位，注册表里都登记了', () => {
    const known = new Set(LANDING_PREVIEW_SLOTS.map((s) => s.slot));
    const unregistered = [...used].filter((slot) => !known.has(slot));
    expect(
      unregistered,
      `这些槽位在首页被引用，但 landingPreviewSlots 里没有对应条目，管理员在设置页里 `
        + `根本看不到它、也就没法给它生成图：${unregistered.join(', ')}`,
    ).toEqual([]);
  });

  it('每个槽位都有非空的画面描述（提示词不能是空壳）', () => {
    const empty = LANDING_PREVIEW_SLOTS.filter((s) => s.subject.trim().length < 40).map((s) => s.id);
    expect(empty, `这些槽位的 subject 太短，生不出可用的图：${empty.join(', ')}`).toEqual([]);
  });
});
