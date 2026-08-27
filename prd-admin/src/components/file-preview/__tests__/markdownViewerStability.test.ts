import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * MarkdownViewer 的渲染器身份必须跨 render 稳定。
 *
 * 这些 renderer 曾经是写在 JSX 里的内联箭头函数，每次 render 都是新函数，
 * ReactMarkdown 于是**每次重渲染都重挂整棵正文 DOM**。静态阅读时被 memo 挡住了，
 * 一旦 content 高频变化（流式改写逐 token 追加）就每帧重挂：
 * 动画无限重启、原生选区被清空、Mermaid/KaTeX 反复初始化。
 * 用户 2026-08-25 的原话是「一闪一闪，就像是老电脑一样，一点都不丝滑」。
 *
 * 这条守卫盯的是「删掉不会红」的那种退化（predicate-and-wiring-discipline.md 形状 2）：
 * 把依赖数组从 [] 改回带变量，全量单测照样全绿，只有在浏览器里数 DOM 变更才看得出来
 * ——实测一次流式改写，空依赖时元素重建 10 次，依赖写成 [body] 时 108 次。
 */
describe('MarkdownViewer：渲染器身份稳定', () => {
  const SRC = readFileSync(resolve(__dirname, '../MarkdownViewer.tsx'), 'utf-8');

  it('components 走 useMemo 且依赖数组为空', () => {
    const m = /const components = useMemo<[\s\S]*?\n {2}\}, \[([^\]]*)\]\);/.exec(SRC);
    expect(m, '找不到 components 这个 useMemo').toBeTruthy();
    expect(m![1].trim(), 'components 的依赖必须为空，否则正文每次重渲染都会整棵重挂').toBe('');
  });

  it('随实例变化的东西走 ref 包，不进闭包依赖', () => {
    // slugger / 图片索引 / 主题这三样每次 render 都可能变；
    // renderer 必须读 ctx.current，而不是把它们捕进闭包（捕了依赖数组就没法是空的）。
    expect(SRC).toContain('const ctx = useRef({ slugger, imageIndexBySrc, theme })');
    expect(SRC).toContain('ctx.current.slugger');
    expect(SRC).toContain('ctx.current.imageIndexBySrc');
    expect(SRC).toContain('ctx.current.theme');
  });

  it('JSX 里不再直接写 components={{…}} 内联对象', () => {
    expect(SRC).toContain('components={components}');
    expect(SRC).not.toMatch(/components=\{\{/);
  });
});
