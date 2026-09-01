import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectGuardRedOnMutation, mutate } from '../helpers/guard-mutation.js';

/**
 * 2026-09-01 用户截图三连：
 *   1. 资源 chip 横条被上下裁掉（"Java" 只剩半行，右上角小圆钮也被切）；
 *   2. 从分支卡片点数据库 chip，要先落到抽屉、再点一次「打开工作台」；
 *   3. 面板整体偏暗、层次糊在一起（用户选定方案 B：底色不动，靠分层拆开）。
 *
 * 三条都是「看一眼就知道坏、但没有任何测试会红」的类型，所以钉成源码守卫。
 */
const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readDrawer(): string {
  return fs.readFileSync(path.join(CDS_ROOT, 'web/src/components/BranchDetailDrawer.tsx'), 'utf8');
}

function readBranchList(): string {
  return fs.readFileSync(path.join(CDS_ROOT, 'web/src/pages/BranchListPage.tsx'), 'utf8');
}

/**
 * 断言的是**行为形状**，不是某串 class 字面量。
 *
 * 第一版把 `overflow-x-auto px-1 pb-2 pt-2` 整串钉死，Codex 当场指出这正是仓库
 * predicate-and-wiring-discipline 形状 4a「反向锁死」：把 `pb-2 pt-2` 合并成
 * `py-2`、把 class 抽成常量、或改用 CSS 实现同一个最小高度——裁切这个 bug 明明
 * 还是修好的，CI 却会红。谁重构谁的 CI 红，于是没人敢重构。
 */
function chipScrollerClasses(source: string): string {
  const at = source.indexOf('ref={chipScrollerRef}');
  expect(at, '找不到 chip 滚动容器').toBeGreaterThan(-1);
  return source.slice(at, at + 320).match(/className="([^"]+)"/)?.[1] ?? '';
}

function chipButtonClasses(source: string): string {
  const at = source.indexOf('const active = selectedResource?.id === resource.id;');
  expect(at, '找不到 chip 按钮').toBeGreaterThan(-1);
  return source.slice(at, at + 2000).match(/className=\{`([^`]+)`/)?.[1] ?? '';
}

describe('资源 chip 横条不许再被裁', () => {
  it('横向滚动容器同时有纵向留白（overflow-x:auto 会把纵轴一并变成裁剪轴）', () => {
    const cls = chipScrollerClasses(readDrawer());
    expect(cls, '这条得能横滑').toMatch(/\boverflow-x-auto\b/);
    // py-N 或 pt-N + pb-N 都算数——留白多少、怎么写都行，有就行
    const hasVerticalPadding = /\bpy-\d/.test(cls) || (/\bpt-\d/.test(cls) && /\bpb-\d/.test(cls));
    expect(hasVerticalPadding, `滚动容器缺纵向留白，-top-1 的小圆钮和 chip 首行会被裁：${cls}`).toBe(true);
  });

  it('chip 高度随内容长，不钉死一行半', () => {
    const cls = chipButtonClasses(readDrawer());
    expect(/\bmin-h-/.test(cls), `chip 应给最小高而不是固定高：${cls}`).toBe(true);
    expect(/\bh-\d+\b/.test(cls), `chip 不该再用固定 h-N（两行内容塞不下）：${cls}`).toBe(false);
  });

  it('红用例：把 chip 改回固定高，守卫必须变红', () => {
    const real = readDrawer();
    const guard = (source: string) => {
      const cls = chipButtonClasses(source);
      expect(/\bmin-h-/.test(cls)).toBe(true);
      expect(/\bh-\d+\b/.test(cls)).toBe(false);
    };
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(real, 'inline-flex min-h-[2.75rem] min-w-[132px]', 'inline-flex h-10 min-w-[132px]'),
    );
  });

  it('红用例：拿掉滚动容器的纵向留白，守卫必须变红', () => {
    const real = readDrawer();
    const guard = (source: string) => {
      const cls = chipScrollerClasses(source);
      expect(/\bpy-\d/.test(cls) || (/\bpt-\d/.test(cls) && /\bpb-\d/.test(cls))).toBe(true);
    };
    expectGuardRedOnMutation(guard, real, mutate(real, 'overflow-x-auto px-1 pb-2 pt-2', 'overflow-x-auto px-1'));
  });
});

describe('滑动提示：右边还有东西才盖渐变', () => {
  it('渐变按实测滚动位置出现，不是常驻', () => {
    const source = readDrawer();
    expect(source).toContain('const updateChipScrollHint = useCallback(');
    expect(source).toContain('el.scrollWidth - el.clientWidth');
    expect(source).toContain('{chipScrollHint.right ? (');
    expect(source).toContain('bg-gradient-to-l from-[hsl(var(--surface-sunken))] to-transparent');
    // 常驻渐变会在资源不多、根本不用滑时平白糊掉最后一个 chip
    expect(source).toContain('{chipScrollHint.left ? (');
  });

  it('渐变不吃点击', () => {
    const source = readDrawer();
    const at = source.indexOf('{chipScrollHint.right ? (');
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 400)).toContain('pointer-events-none');
  });

  it('红用例：把渐变改成常驻，守卫必须变红', () => {
    const real = readDrawer();
    const guard = (source: string) => {
      expect(source).toContain('{chipScrollHint.right ? (');
    };
    expectGuardRedOnMutation(guard, real, mutate(real, '{chipScrollHint.right ? (', '{true ? ('));
  });
});

describe('数据库 chip 一步直达工作台', () => {
  it('分支卡片点数据库资源时带上直达标记', () => {
    const source = readBranchList();
    expect(source).toContain("directWorkbench: resource.kind === 'database',");
    expect(source).toContain('resourceWorkbenchDirect={detailDrawerResourceFocus?.directWorkbench || false}');
  });

  it('直达进来时，关掉工作台一路退回分支列表', () => {
    const source = readDrawer();
    expect(source).toContain('onWorkbenchDismiss={resourceWorkbenchDirect ? onClose : undefined}');
    // 两个工作台弹窗（SQL / Mongo）的关闭都要接上，漏一个就把人留在中间那层抽屉里
    expect(source.split('onClose={() => { setWorkbenchOpen(false); onWorkbenchDismiss?.(); }}').length - 1).toBe(2);
  });

  it('红用例：拆掉直达回退，守卫必须变红', () => {
    const real = readDrawer();
    const guard = (source: string) => {
      expect(source).toContain('onWorkbenchDismiss={resourceWorkbenchDirect ? onClose : undefined}');
    };
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(real, 'onWorkbenchDismiss={resourceWorkbenchDirect ? onClose : undefined}', 'onWorkbenchDismiss={undefined}'),
    );
  });
});

describe('方案 B 的分层落在 token 上，不是硬编码颜色', () => {
  it('chip 区走凹陷带、chip 走抬升层、分区标题带竖分隔', () => {
    const source = readDrawer();
    const chip = chipButtonClasses(source);
    // 断言「用了哪一层 token」，不锁具体写法：换个透明度、调个内阴影都不该让 CI 红
    expect(chip, 'chip 未选中态应抬到 raised 层').toMatch(/bg-\[hsl\(var\(--surface-raised\)\)\]/);
    const stripAt = source.indexOf('ref={chipScrollerRef}');
    const wrapper = source.slice(Math.max(0, stripAt - 700), stripAt);
    expect(wrapper, 'chip 区应自成一条凹陷带').toMatch(/bg-\[hsl\(var\(--surface-sunken\)\)\]/);
    expect(source, '分区标题应有竖分隔线').toMatch(/border-r border-\[hsl\(var\(--hairline-strong\)\)\]/);
  });

  /**
   * 第一版只扫 `#hex` 与 `rgb()`，于是 chip 的 `shadow-[inset_0_1px_0_hsl(0_0%_100%/.05)]`
   * 一路绿灯——Tailwind 的下划线写法把颜色藏在方括号里，那条白色内高光在白天主题的
   * 白 chip 上等于没有，双主题表现不一致（Codex P1，2026-09-01）。所以扫描要认
   * `hsl(` 本身：里面不是 `var(--…)` 就是字面量。
   */
  function themeLiteralsIn(block: string): string[] {
    return [
      ...block.match(/#[0-9a-fA-F]{3,8}\b/g) || [],
      ...block.match(/rgba?\([^)]*\)/g) || [],
      // hsl( 后面直接跟数字/其它 = 写死的颜色；hsl(var(--x)) 才是走 token
      ...block.match(/hsl\((?!var\()[^)]*\)?/g) || [],
    ];
  }

  it('这一块没有引入任何颜色字面量（cds-theme-tokens 规则）', () => {
    const source = readDrawer();
    const at = source.indexOf('方案 B（2026-09-01 用户选定）');
    expect(at).toBeGreaterThan(-1);
    expect(themeLiteralsIn(source.slice(at, at + 3000))).toEqual([]);
  });

  it('红用例：把 chip 高光写回颜色字面量，守卫必须变红', () => {
    const real = readDrawer();
    const guard = (source: string) => {
      const at = source.indexOf('方案 B（2026-09-01 用户选定）');
      expect(themeLiteralsIn(source.slice(at, at + 3000))).toEqual([]);
    };
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(real, 'shadow-[shadow:var(--shadow-chip)]', 'shadow-[inset_0_1px_0_hsl(0_0%_100%/.05)]'),
    );
  });

  /**
   * `shadow-[var(--x)]` 会被 Tailwind 解析成**阴影颜色**而不是阴影值：实际产出的是
   * `--tw-shadow-color: var(--x); --tw-shadow: var(--tw-shadow-colored)`，
   * 而 `--tw-shadow-colored` 此时是空的 —— 阴影整个消失，页面照常渲染、测试照常绿
   * （形状 2 的静默退化，本次真的踩了：token 加对了、类写上了、编译出来是个颜色）。
   * 必须写成带类型提示的 `shadow-[shadow:var(--x)]`。
   *
   * 只管这种「整个值就是一个裸 var()」的歧义写法。`shadow-[0_0_0_1px_hsl(var(--primary)/.35)]`
   * 以长度开头，Tailwind 判得出是阴影值，编译正确（已核对 dist 产物），不在此列。
   */
  it('引用 token 的阴影必须带 shadow: 类型提示，否则 Tailwind 当成颜色', () => {
    const bad = readDrawer().match(/shadow-\[var\(--[^\]]*\]/g) || [];
    expect(bad, `这些阴影会被编译成颜色、实际不产生阴影：${bad.join(' / ')}`).toEqual([]);
  });

  it('红用例：去掉 shadow: 类型提示，守卫必须变红', () => {
    const real = readDrawer();
    const guard = (source: string) => {
      expect(source.match(/shadow-\[var\(--[^\]]*\]/g) || []).toEqual([]);
    };
    expectGuardRedOnMutation(
      guard,
      real,
      mutate(real, 'shadow-[shadow:var(--shadow-chip)]', 'shadow-[var(--shadow-chip)]'),
    );
  });

  it('chip 抬升配方在两个主题都定义了', () => {
    const css = fs.readFileSync(path.join(CDS_ROOT, 'web/src/index.css'), 'utf8');
    const light = css.indexOf("[data-theme='light']");
    expect(light).toBeGreaterThan(-1);
    // 暗色块在前、白天块在后：两侧各要有一份定义，只加一半就是「白天没这档」
    expect(css.slice(0, light)).toContain('--shadow-chip:');
    expect(css.slice(light)).toContain('--shadow-chip:');
  });
});
