/**
 * 守卫：主题切换的水波纹（View Transition API）两半都必须在。
 *
 * 历史（2026-08-05 用户反馈「波浪方式的切换我很喜欢……现在变成直接切换了」）：
 * 这套效果原本活在 legacy 栈 `cds/web-legacy/app.js` + `style.css`，dashboard 迁到
 * React 新栈时**只搬了「关掉默认淡入淡出」那一半**（`::view-transition-*(root)
 * { animation: none }`），扩散动画那一半没搬，于是主题切换退化成瞬间硬切——
 * 而且只留前半条比两条都不留更糟：它把浏览器默认的交叉淡入也一并干掉了。
 *
 * 这类「迁移只搬了一半」靠读代码发现不了（两边文件各自都自洽），所以钉两条：
 *   1. CSS 侧：clip-path 扩散动画与 keyframes 必须存在
 *   2. JS 侧：切换必须真的走 startViewTransition，且 DOM 变更同步发生在回调内
 *
 * 相关规则：`.claude/rules/predicate-and-wiring-discipline.md` 形状 2（链路只建一半）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CSS_PATH = path.resolve(__dirname, '../../web/src/index.css');
const THEME_TS_PATH = path.resolve(__dirname, '../../web/src/lib/theme.ts');

describe('主题水波纹 · CSS 侧', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');

  it('扩散动画与 keyframes 都在（不能只留「关掉默认过渡」那一半）', () => {
    expect(css).toMatch(/::view-transition-new\(root\)\s*\{[^}]*clip-path:\s*circle\(0%/);
    expect(css).toMatch(/animation:\s*cds-theme-ripple-in/);
    expect(css).toMatch(/@keyframes\s+cds-theme-ripple-in/);
    // 旧主题必须静止且在下层，新主题圆形扩散覆盖上去
    expect(css).toMatch(/::view-transition-old\(root\)\s*\{[^}]*animation:\s*none/);
  });

  it('快照期间冻结全局 micro-motion，避免捕到过渡中途的颜色', () => {
    expect(css).toContain('.vt-snapshotting');
    expect(css).toMatch(/\.vt-snapshotting[^{]*\{[^}]*transition-duration:\s*0s\s*!important/);
  });

  it('reduced-motion 下退化为瞬时切换', () => {
    const reducedBlocks = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/g) || [];
    expect(reducedBlocks.some((b) => b.includes('view-transition-new(root)'))).toBe(true);
  });
});

describe('主题水波纹 · JS 侧', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** 最小可用的 document/window 替身：只覆盖 runThemeTransition 实际会碰的面。 */
  function stubDom(withViewTransition: boolean, reducedMotion = false) {
    const props = new Map<string, string>();
    const classes = new Set<string>();
    let readyResolve: () => void = () => {};
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    const doc = {
      documentElement: {
        style: { setProperty: (k: string, v: string) => props.set(k, v) },
        classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
        dataset: {} as Record<string, string>,
      },
      startViewTransition: withViewTransition
        ? (cb: () => void) => { cb(); return { ready }; }
        : undefined,
    };
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', {
      innerWidth: 1200,
      innerHeight: 800,
      matchMedia: () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} }),
    });
    return { props, classes, flushReady: () => { readyResolve(); return ready; } };
  }

  it('走 startViewTransition，并把波纹原点与半径写进 CSS 变量', async () => {
    const dom = stubDom(true);
    const { runThemeTransition } = await import('../../web/src/lib/theme');
    const apply = vi.fn();

    runThemeTransition({ x: 44, y: 730 }, apply);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(dom.props.get('--ripple-x')).toBe('44px');
    expect(dom.props.get('--ripple-y')).toBe('730px');
    // 半径必须够覆盖最远角：从 (44,730) 到 (1200,0) 约 1367px
    const radius = Number((dom.props.get('--ripple-radius') || '0').replace('px', ''));
    expect(radius).toBeGreaterThanOrEqual(Math.hypot(1200 - 44, 730));
  });

  it('DOM 变更同步发生在回调内（异步改会让新快照捕到旧画面）', async () => {
    stubDom(true);
    const { runThemeTransition } = await import('../../web/src/lib/theme');
    let appliedDuringCall = false;
    runThemeTransition(null, () => { appliedDuringCall = true; });
    // startViewTransition 的替身同步调回调；真实浏览器同样要求同步改 DOM
    expect(appliedDuringCall).toBe(true);
  });

  it('快照捕完后解冻 micro-motion', async () => {
    const dom = stubDom(true);
    const { runThemeTransition } = await import('../../web/src/lib/theme');
    runThemeTransition(null, () => {});
    expect(dom.classes.has('vt-snapshotting')).toBe(true);
    await dom.flushReady();
    await Promise.resolve();
    expect(dom.classes.has('vt-snapshotting')).toBe(false);
  });

  it('浏览器不支持 View Transition 时降级为瞬时切换，不抛错', async () => {
    const dom = stubDom(false);
    const { runThemeTransition } = await import('../../web/src/lib/theme');
    const apply = vi.fn();
    runThemeTransition({ x: 10, y: 10 }, apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(dom.classes.has('vt-snapshotting')).toBe(false);
  });

  it('prefers-reduced-motion 下不启动 View Transition', async () => {
    const dom = stubDom(true, true);
    const { runThemeTransition } = await import('../../web/src/lib/theme');
    const apply = vi.fn();
    runThemeTransition({ x: 10, y: 10 }, apply);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(dom.classes.has('vt-snapshotting')).toBe(false);
  });
});

describe('主题切换入口', () => {
  it('rail 有一级入口，不只藏在头像浮层里', () => {
    const shell = fs.readFileSync(
      path.resolve(__dirname, '../../web/src/components/layout/AppShell.tsx'),
      'utf8',
    );
    expect(shell).toContain('cds-rail-theme-toggle');
    expect(shell).toContain('data-shell-action="theme-toggle"');
    // 入口必须真的接上水波纹，否则等于又退回瞬时切换
    expect(shell).toContain('toggleWithRipple');
  });

  it('切主题不关移动端抽屉——它是设置不是导航（review P3-2）', () => {
    const shell = fs.readFileSync(
      path.resolve(__dirname, '../../web/src/components/layout/AppShell.tsx'),
      'utf8',
    );
    const toggle = shell.slice(
      shell.indexOf('function RailThemeToggle'),
      shell.indexOf('function userDisplayName'),
    );
    expect(toggle).toContain('toggleWithRipple');
    // 断「有没有真的调用」，不是「源码里出没出现这个词」——解释为什么不调的注释
    // 本身就含这个词，按字面扫会把正确实现判红（形状 4a：断言实现字面而非行为）。
    expect(toggle).not.toMatch(/onNavigate\s*\?\.\s*\(/);
    expect(toggle).not.toMatch(/onNavigate\s*\(/);
    // 也不该再从 props 收这个回调
    expect(toggle).not.toMatch(/function RailThemeToggle\([^)]*onNavigate/);
  });

  it('useTheme 暴露 toggleWithRipple（删了这条接线本文件会红）', () => {
    const theme = fs.readFileSync(THEME_TS_PATH, 'utf8');
    expect(theme).toContain('toggleWithRipple');
    expect(theme).toContain('startViewTransition');
  });
});

describe('同页多个 useTheme 实例的同步', () => {
  it('applyThemeMode 会广播给同页其它实例（storage 事件只跨标签页，管不到同页）', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../web/src/lib/theme.ts'),
      'utf8',
    );
    // 模块级订阅表 + 在 applyThemeMode 里广播 + hook 里订阅，三处缺一不可
    expect(src).toContain('themeListeners');
    expect(src).toMatch(/applyThemeMode[\s\S]*themeListeners\.forEach/);
    expect(src).toMatch(/themeListeners\.add\(/);
    expect(src).toMatch(/themeListeners\.delete\(/);
  });

  it('shell 里确实有两个以上消费者——这正是需要广播的原因', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const shell = fs.readFileSync(
      path.resolve(__dirname, '../../web/src/components/layout/AppShell.tsx'),
      'utf8',
    );
    const consumers = (shell.match(/useTheme\(\)/g) || []).length;
    expect(consumers).toBeGreaterThanOrEqual(2);
  });
});
