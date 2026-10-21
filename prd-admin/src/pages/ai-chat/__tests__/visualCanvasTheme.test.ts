import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

// 只用AST定位并执行真实JSX属性和事件回调，不复制主题选择逻辑。
// 这些是源码接线回归；真实浏览器双主题结果需另行取证。
function loadSource(relative: string) {
  const name = resolve(__dirname, relative);
  return ts.createSourceFile(name, readFileSync(name, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const fullscreen = loadSource('../../visual-agent/VisualAgentFullscreenPage.tsx');
const editor = loadSource('../AdvancedVisualAgentTab.tsx');

function openings(source: ts.SourceFile) {
  const found: ts.JsxOpeningElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
function attribute(node: ts.JsxOpeningElement, name: string) {
  return node.attributes.properties.filter(ts.isJsxAttribute).find(value => value.name.getText() === name)?.initializer;
}
function one(nodes: ts.JsxOpeningElement[], name: string) {
  if (nodes.length !== 1) throw new Error(`${name}必须唯一，实际为${nodes.length}`);
  return nodes[0]!;
}
function evaluate<T>(node: ts.JsxOpeningElement, name: string, scope: Record<string, unknown> = {}): T {
  const value = attribute(node, name);
  const expression = value && ts.isJsxExpression(value) ? value.expression : value;
  if (!expression) throw new Error(`缺少真实属性：${name}`);
  const code = ts.transpileModule(`(${expression.getText()})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(code, scope) as T;
}
const root = one(openings(fullscreen).filter(node =>
  attribute(node, 'className')?.getText().includes('w-full relative')), '全屏页面根节点');
const stage = one(openings(editor).filter(node =>
  attribute(node, 'data-tour-id')?.getText() === '"visual-editor-canvas"'), '真实主画布');
const back = one(openings(fullscreen).filter(node =>
  node.tagName.getText() === 'button' && attribute(node, 'onClick')?.getText() === '{onBack}'), '编辑器返回按钮');
const chat = one(openings(editor).filter(node =>
  attribute(node, 'ref')?.getText() === '{chatPanelRef}'), '浮动对话面板');

describe('视觉创作编辑器双主题接线', () => {
  it('编辑页不再继承固定暗岛，根背景使用现有主题底色', () => {
    const className = evaluate<string>(root, 'className', { isEditor: true });
    const style = evaluate<Record<string, string>>(root, 'style', { isEditor: true });
    expect(className.split(/\s+/)).not.toContain('surface-tone-dark');
    expect(style.background).toBe('var(--bg-base)');
  });

  it('列表页保留原有暗色视觉身份，不把修复外扩到列表', () => {
    const className = evaluate<string>(root, 'className', { isEditor: false });
    const style = evaluate<Record<string, string>>(root, 'style', { isEditor: false });
    expect(className.split(/\s+/)).toContain('surface-tone-dark');
    expect(style.background).toBe('#0a0a0c');
  });

  it('实际画布的底色和点阵跟随主题，不改变视口几何与手势', () => {
    const style = evaluate<Record<string, string>>(stage, 'style', { panning: false, effectiveTool: 'select' });
    expect(style.backgroundColor).toBe('var(--bg-base)');
    expect(style.backgroundImage).toBe('radial-gradient(circle, var(--border-subtle) 1px, transparent 1px)');
    expect(style.backgroundSize).toBe('48px 48px');
    expect(style.backgroundPosition).toBe('0px 0px');
    expect(style.touchAction).toBe('none');
    expect(style.cursor).toBe('default');
  });

  it('解除暗岛后，返回按钮及悬浮状态仍使用匹配的主题表面', () => {
    const style = evaluate<Record<string, string>>(back, 'style');
    expect(style.background).toBe('var(--bg-elevated)');
    expect(style.color).toBe('var(--text-primary)');
    const target = { style: {} as Record<string, string> };
    evaluate<(event: { currentTarget: typeof target }) => void>(back, 'onMouseEnter')({ currentTarget: target });
    expect(target.style.background).toBe('var(--bg-card-hover)');
    expect(target.style.borderColor).toBe('var(--border-default)');
    evaluate<(event: { currentTarget: typeof target }) => void>(back, 'onMouseLeave')({ currentTarget: target });
    expect(target.style.background).toBe('var(--bg-elevated)');
    expect(target.style.borderColor).toBe('var(--border-subtle)');
  });

  it('仅手机固定深色对话区保留局部暗岛，不让深色背景配上浅色主题深字', () => {
    expect(evaluate<string>(chat, 'className', { isMobile: true }).split(/\s+/)).toContain('surface-tone-dark');
    expect(evaluate<string>(chat, 'className', { isMobile: false }).split(/\s+/)).not.toContain('surface-tone-dark');
  });

  it('消费的底色、点阵和按钮token都有真实明暗定义，且随主题发生变化', () => {
    const css = readFileSync(resolve(__dirname, '../../../styles/tokens.css'), 'utf8');
    const block = (selector: string) => {
      const start = css.indexOf(selector);
      if (start < 0) throw new Error(`缺少主题定义：${selector}`);
      return css.slice(start, css.indexOf('\n}', start));
    };
    const value = (text: string, token: string) => {
      const match = text.match(new RegExp(`--${token}:\\s*([^;]+);`));
      if (!match) throw new Error(`缺少主题token：${token}`);
      return match[1]!.trim();
    };
    for (const token of ['bg-base', 'border-subtle', 'bg-elevated', 'bg-card-hover', 'border-default', 'text-primary']) {
      expect(value(block(':root {'), token)).not.toBe(value(block('[data-theme="light"] {'), token));
    }
  });
});
