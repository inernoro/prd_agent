import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 视觉创作首页的锚点与本页教程必须一一对应。
 *
 * onboarding-tips 规则第二节写着「改动带教程的页面时，同一个 PR 内必须做锚点对账」，
 * 但那是一条**靠人记**的规则——所以它没被执行：这个 PR 给首页加了「模型选择器」
 * 这个核心控件，教程却照旧从参考图直接跳到尺寸，新用户走完全套「完整教程」
 * 都不知道有个决定出图效果的选择要做（Codex PR #1476 P1）。
 *
 * 于是把那条自查变成机器判据。两个方向都要判：
 * - 页面多出锚点、教程没讲 → 教程漏了新功能（这次就是）；
 * - 教程指着页面上没有的锚点 → 那一步会卡在「正在定位」直到超时，
 *   新用户对着一个转圈的气泡等 10 秒。
 */
const TEST_DIR = __dirname;
const PAGE = resolve(TEST_DIR, '../VisualAgentWorkspaceListPage.tsx');
const SEED = resolve(TEST_DIR, '../../../../../prd-api/src/PrdAgent.Api/Controllers/Api/DailyTipsController.cs');

/** 页面上的锚点。两种写法都要认：静态 data-tour-id="x" 与三元 data-tour-id={c ? 'x' : undefined}。 */
function pageAnchors(): Set<string> {
  const src = readFileSync(PAGE, 'utf8');
  const found = new Set<string>();
  for (const m of src.matchAll(/data-tour-id="([^"]+)"/g)) found.add(m[1]!);
  for (const m of src.matchAll(/data-tour-id=\{[^}]*?'([a-z0-9-]+)'[^}]*\}/g)) found.add(m[1]!);
  return found;
}

/** visual-page-guide 那一段 seed 引用到的锚点。 */
function seedAnchors(): { anchors: Set<string>; block: string } {
  const src = readFileSync(SEED, 'utf8');
  const at = src.indexOf('T("visual-page-guide"');
  if (at < 0) throw new Error('没找到 visual-page-guide seed');
  // 到下一条 seed 为止。C# 里每条都以 T(" 开头。
  const next = src.indexOf('T("', at + 10);
  const block = src.slice(at, next < 0 ? undefined : next);
  const anchors = new Set<string>();
  for (const m of block.matchAll(/\[data-tour-id=([a-z0-9-]+)\]/g)) anchors.add(m[1]!);
  return { anchors, block };
}

describe('视觉创作首页：锚点与本页教程对账', () => {
  it('companion：两边都解析出了东西，下面几条不是对着空集合判绿', () => {
    expect(pageAnchors().size).toBeGreaterThan(5);
    expect(seedAnchors().anchors.size).toBeGreaterThan(5);
  });

  it('【关键】页面上的每个锚点都有对应的教程步骤（加了核心控件就得讲）', () => {
    const missing = [...pageAnchors()].filter((a) => !seedAnchors().anchors.has(a)).sort();
    expect(missing, `这些锚点页面上有、教程没讲：${missing.join(', ')}`).toEqual([]);
  });

  it('【关键】教程指到的锚点页面上都存在（否则那一步会卡在「正在定位」）', () => {
    const orphan = [...seedAnchors().anchors].filter((a) => !pageAnchors().has(a)).sort();
    expect(orphan, `这些锚点教程在讲、页面上却没有：${orphan.join(', ')}`).toEqual([]);
  });

  it('标题里写的步数与真实步数一致', () => {
    // 标题是「本页 N 步上手教程」，用户按它预期要走多久。加了步不改这个数就是骗人。
    const { block } = seedAnchors();
    const declared = Number(block.match(/本页 (\d+) 步上手教程/)?.[1]);
    expect(declared, '标题应声明步数').toBeGreaterThan(0);
    const steps = [...block.matchAll(/Selector = "\[data-tour-id=/g)].length;
    expect(steps, '真实步数应与标题一致').toBe(declared);
  });

  it('模型选择这一步真的在讲模型，不是占个位', () => {
    const { block } = seedAnchors();
    const at = block.indexOf('[data-tour-id=visual-model-btn]');
    expect(at, '教程里应有模型选择这一步').toBeGreaterThan(0);
    const step = block.slice(at, at + 400);
    expect(step).toContain('模型');
  });
});
