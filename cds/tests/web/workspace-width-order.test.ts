import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Workspace 宽度秩序守卫。
 *
 * 2026-08-13 用户并排指着项目列表与分支列表说「我喜欢图2，不喜欢图1」。
 * 查下来不是审美分歧，是个 bug：**两个页面都写了 `wide`，两个都没拿到 wide**——
 * `.cds-workspace-project-list` 把它压回 1240、`.cds-branch-list-workspace`
 * 把它放开成无上限。TSX 上看不出任何异常，这正是 predicate-and-wiring-discipline
 * 「形状 6：判据读的值不是真正生效的那个值」。
 *
 * 所以这里钉两件事：档位只能由 Workspace 的 props 决定；档位只有三档。
 */

const WEB = path.resolve(process.cwd(), '../cds/web/src');
const read = (rel: string): string => fs.readFileSync(path.join(WEB, rel), 'utf8');

const CSS = read('index.css');
const SHELL = read('components/layout/AppShell.tsx');

/** 网格 / 台面类页面：内容是卡片阵列或多栏面板，必须吃满整列宽度。 */
const FLUID_PAGES = [
  'pages/ProjectListPage.tsx',
  'pages/BranchListPage.tsx',
  'pages/ReleaseCenterPage.tsx',
  'pages/ReleaseConsolePage.tsx',
  'pages/StatusPage.tsx',
  'pages/ReportsPage.tsx',
];

describe('Workspace 宽度秩序', () => {
  it('Workspace 支持三档，fluid 优先于 wide', () => {
    expect(SHELL).toContain('fluid?: boolean');
    expect(SHELL).toContain("fluid ? 'cds-workspace--fluid' : wide ? 'cds-workspace-wide' : null");
  });

  it('网格类页面一律 fluid，宽屏不再把内容压在中间一条', () => {
    for (const rel of FLUID_PAGES) {
      expect(read(rel), `${rel} 应当用 <Workspace fluid>`).toMatch(/<Workspace\s+fluid[\s>]/);
    }
  });

  /**
   * 最要紧的一条：CSS 不许再出现「按页面名覆盖 workspace 宽度」的类。
   * 那种类会让页面的声明失效，而且失效得完全没有痕迹。
   */
  it('CSS 里没有按页面名覆写 workspace 宽度的类', () => {
    expect(CSS).not.toContain('.cds-workspace-project-list');
    expect(CSS).not.toContain('.cds-branch-list-workspace');
    const overrides = [...CSS.matchAll(/\.cds-workspace[.\w-]*\s*\{[^}]*max-width[^}]*\}/g)]
      .map((m) => m[0].split('{')[0].trim())
      // 三档本体 + --fill（它只管高度）允许出现
      .filter((sel) => !['.cds-workspace', '.cds-workspace-wide', '.cds-workspace--fluid', '.cds-workspace-settings'].includes(sel));
    expect(overrides, `这些选择器在覆写 workspace 宽度: ${overrides.join(', ')}`).toEqual([]);
  });

  it('宽度只有三档，没有第四个魔数', () => {
    expect(CSS).toContain('--workspace-standard: 1240px');
    expect(CSS).toContain('--workspace-wide: 1440px');
    // 三档之外的硬编码上限（历史上出现过 1280 / 1360 / 1650 / 3000）
    const magic = [...CSS.matchAll(/max-width:\s*(\d{4})px/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n !== 1240 && n !== 1440);
    expect(magic, `发现三档之外的宽度魔数: ${magic.join(', ')}`).toEqual([]);
  });

  it('卡片网格由可用宽度算列数，不写死列数', () => {
    expect(CSS).toContain('.cds-card-grid');
    expect(CSS).toContain('repeat(auto-fill, minmax(min(100%, var(--cds-card-min, 380px)), 1fr))');
    // 项目卡曾写死 xl:grid-cols-3，宽屏下永远只有三列
    expect(read('pages/ProjectListPage.tsx')).not.toContain('xl:grid-cols-3');
  });

  /** 满铺不等于顶到边：窄屏 16 / 常规 32 / 超宽 48，两侧始终留呼吸位。 */
  it('横向留白按视口分档，超宽屏更宽松', () => {
    expect(CSS).toContain('px-8 pb-12 pt-6 2xl:px-12');
    expect(CSS).toMatch(/@media \(max-width: 767px\)[\s\S]{0,120}px-4/);
  });
});
