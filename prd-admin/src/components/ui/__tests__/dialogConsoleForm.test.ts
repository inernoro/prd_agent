import { readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 系统弹窗「控制台形态」的守卫（2026-09-01 用户选定方向 A）。
 *
 * 为什么需要它：这次改动的每一处，删掉之后全量测试都照样全绿——
 * 容器圆角改回 22、遮罩重新挂上 blur、Button 的尺寸钩子被顺手删掉，
 * 编译、类型、lint 一个都不会红，只有人打开一个弹窗才看得见
 * （.claude/rules/predicate-and-wiring-discipline.md 形状 2）。
 *
 * 断言的是形态成立的几个前提，不是某一行长什么样：
 * 尺寸档位、钩子接着线、遮罩不模糊、token 双写、没人在容器上再叠一层内边距。
 */

const ROOT = resolve(__dirname, '../../../..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');

/** 注释里出现的字面量不算数——这批断言此前已经被自己的说明文字喂绿过四次。 */
const stripTs = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/[^\n]*/g, '');
const stripCss = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '');

const DIALOG = 'src/components/ui/Dialog.tsx';
const BUTTON = 'src/components/design/Button.tsx';
const LEGACY = 'src/styles/legacy.css';
const TOKENS = 'src/styles/tokens.css';

describe('弹窗容器落在控制台那一档', () => {
  const dialog = stripTs(read(DIALOG));

  it('容器 8px 圆角，不是圆润饱满的 22px', () => {
    expect(dialog).toContain('rounded-[8px]');
    expect(dialog).not.toContain('rounded-[22px]');
    // 剥完注释还剩真代码，否则上面两条是在对空字符串断言。
    expect(dialog).toContain('DialogPrimitive.Content');
  });

  it('容器自身不留内边距——动作条要贴着底边铺满，叠一层 padding 就贴不住', () => {
    const content = dialog.slice(dialog.indexOf('DialogPrimitive.Content'), dialog.indexOf('prd-dialog-body'));
    expect(content).not.toMatch(/\bp-\d/);
  });

  it('动作条是独立分区，带上分隔线的那一条', () => {
    expect(dialog).toContain('prd-dialog-actions');
    expect(stripCss(read(LEGACY))).toMatch(/\.prd-dialog-actions\s*\{[^}]*border-top/);
  });
});

describe('弹窗内的按钮压到控制台尺寸', () => {
  it('Button 输出尺寸钩子（CSS 靠它区分 md 与已经是 28px 的 xs/sm）', () => {
    expect(stripTs(read(BUTTON))).toContain('map-btn-size-${size}');
  });

  it('CSS 只压 md 这一档，且圆角跟着降到 6px', () => {
    const css = stripCss(read(LEGACY));
    const rule = css.match(/\.prd-dialog-content \.map-btn-size-md\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/height:\s*32px/);
    expect(css).toMatch(/\.prd-dialog-content \.map-btn\s*\{[^}]*border-radius:\s*6px/);
  });

  it('主操作与危险操作填色、次操作只描边——三个都填色就分不出主次', () => {
    const css = stripCss(read(LEGACY));
    expect(css).toMatch(/\.prd-dialog-content \.map-btn-primary\s*\{[^}]*background:\s*var\(--dialog-primary-bg\)/);
    expect(css).toMatch(/\.prd-dialog-content \.map-btn-danger\s*\{[^}]*background:\s*var\(--dialog-danger-bg\)/);
    expect(css).toMatch(/\.prd-dialog-content \.map-btn-secondary\s*\{[^}]*background:\s*transparent/);
  });
});

describe('实底面板不再配模糊遮罩', () => {
  it('面板颜色全部走 token，没有留下一堆 !important 的玻璃补丁', () => {
    const css = stripCss(read(LEGACY));
    const rule = css.match(/\.prd-dialog-content\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain('var(--dialog-surface)');
    expect(rule![1]).not.toContain('!important');
    expect(rule![1]).not.toContain('backdrop-filter');
  });

  it('遮罩只压暗——模糊是给半透明面板映照用的，实底没有可映照的东西', () => {
    const css = stripCss(read(LEGACY));
    const rule = css.match(/\.prd-dialog-overlay\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).not.toContain('backdrop-filter');
  });
});

describe('--dialog-* token 双写', () => {
  const tokens = read(TOKENS);
  const lightAt = tokens.indexOf('[data-theme="light"]');
  const dark = tokens.slice(0, lightAt);
  const light = tokens.slice(lightAt);

  /**
   * 唯一允许只写一次的：填色红上的白字两个主题都成立
   * （admin-dual-theme.md 里写明的合法例外）。浅色块不重写，直接继承暗色的定义。
   */
  const SHARED = new Set(['--dialog-danger-fg']);

  it('暗色块定义的每个 --dialog-* 都在浅色块有对应值', () => {
    const names = [...dark.matchAll(/(--dialog-[a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(8);
    const missing = names.filter((n) => !SHARED.has(n) && !light.includes(`${n}:`));
    expect(missing).toEqual([]);
  });
});

describe('没有调用方在容器上再叠内边距', () => {
  it('contentClassName 里不出现整体 padding（会和分区内边距叠起来）', () => {
    // 自己走一遍目录，不用 fs.globSync：那是 Node 22 才有的 API，
    // 本地跑 22、CI 跑 20，于是本地全绿、CI 直接 TypeError（不是断言失败，是测试崩了）。
    // 「本地过了就以为过了」在这条上栽过一次——判据依赖的 API 也要看运行环境。
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = resolve(dir, e.name);
        if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full);
        return e.name.endsWith('.tsx') ? [full] : [];
      });
    const SRC = resolve(ROOT, 'src');
    const files = walk(SRC).map((f) => `src/${f.slice(SRC.length + 1).split(sep).join('/')}`);
    // companion：扫描得能扫到东西，否则下面那条会对着空数组判绿。
    expect(files.length, '应扫到 .tsx 文件').toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const rel of files) {
      if (rel.endsWith('Dialog.tsx')) continue;
      const src = stripTs(read(rel));
      for (const m of src.matchAll(/contentClassName=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        const cls = m[1] ?? m[2] ?? '';
        if (/(^|[\s:!])!?p-\d/.test(cls)) offenders.push(`${rel}: ${cls}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
