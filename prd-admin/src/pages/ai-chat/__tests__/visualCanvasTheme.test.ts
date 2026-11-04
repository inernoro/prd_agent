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
const message = loadSource('../components/ChatMessageItem.tsx');

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
const messageBubble = one(openings(message).filter(node =>
  attribute(node, 'className')?.getText().includes('leading-[16px]')), '普通消息气泡');
const sizeNotice = one(openings(editor).filter(node =>
  attribute(node, 'title')?.getText().includes('比例已微调：')), '尺寸调整提示');
function containingExpression(node: ts.Node): ts.Expression {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxExpression(parent) && parent.expression) return parent.expression;
  }
  throw new Error('尺寸调整提示必须由真实JSX表达式控制');
}
const sizeNoticeCondition = containingExpression(sizeNotice);
function renderSizeNotice(it: Record<string, unknown>) {
  const code = ts.transpileModule(`(${sizeNoticeCondition.getText()})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return runInNewContext(code, {
    it,
    React: { createElement: (_tag: string, props: Record<string, unknown>, text: string) => ({ props, text }) },
  }) as { props: { title: string; style: Record<string, string> }; text: string } | null;
}

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

  it.each([false, true])('普通消息用户=%s时背景与正文使用同一主题层，不留下深底深字', (isUser) => {
    const style = evaluate<Record<string, string>>(messageBubble, 'style', { isUser });
    expect(style.background).toBe('var(--nested-block-bg)');
    expect(style.color).toBe('var(--text-primary)');
  });

  it.each(['tier', 'ratio'])('尺寸弹层%s选项的真实选中/未选中样式均使用配套主题表面', (key) => {
    const options = openings(editor).filter(node => node.tagName.getText() === 'button'
      && attribute(node, 'key')?.getText() === `{${key}}`
      && attribute(node, 'onClick')?.getText().includes('setComposerSizeManual'));
    expect(options).toHaveLength(2);
    for (const option of options) for (const isSelected of [false, true]) {
      const className = evaluate<string>(option, 'className', { isSelected });
      expect(className.split(/\s+/)).toContain(isSelected ? 'surface-action-accent' : 'surface-action');
      expect(evaluate<Record<string, string>>(option, 'style', { isSelected }).color).toBe(isSelected ? 'var(--selection-text)' : 'var(--text-primary)');
    }
  });

  it.each([
    [true, '比例已微调'],
    [false, '尺寸已替换'],
  ])('尺寸提示比例微调=%s时保留文案与tooltip，使用成对紫色主题token', (ratioAdjusted, text) => {
    const notice = renderSizeNotice({ status: 'done', sizeAdjusted: true, ratioAdjusted, requestedSize: '1024x1024', effectiveSize: '1024x1536' });
    expect(notice?.text).toBe(text);
    expect(notice?.props.title).toBe(`${text}：1024x1024 → 1024x1536`);
    expect(notice?.props.style).toEqual({
      background: 'color-mix(in srgb, var(--semantic-purple-text) 12%, var(--bg-elevated))',
      border: '1px solid var(--semantic-purple-border)',
      color: 'var(--semantic-purple-text)',
    });
  });

  it.each([
    ['done', false], ['done', undefined], ['running', true], ['error', true], ['queued', true],
  ])('状态=%s、尺寸调整=%s时不显示尺寸提示', (status, sizeAdjusted) => {
    expect(renderSizeNotice({ status, sizeAdjusted })).toBeNull();
  });

  it('尺寸提示缺失尺寸字段时保留原有tooltip空值兜底', () => {
    expect(renderSizeNotice({ status: 'done', sizeAdjusted: true, ratioAdjusted: false })?.props.title).toBe('尺寸已替换： → ');
  });

  it('消费的底色、点阵、按钮和尺寸提示token都有真实明暗定义，且随主题发生变化', () => {
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
    for (const token of ['bg-base', 'border-subtle', 'bg-elevated', 'bg-card-hover', 'border-default', 'text-primary', 'semantic-purple-border', 'semantic-purple-text']) {
      expect(value(block(':root {'), token)).not.toBe(value(block('[data-theme="light"] {'), token));
    }
    for (const token of ['semantic-purple-border', 'semantic-purple-text']) {
      expect(value(block('.surface-tone-dark {'), token)).toBe(value(block(':root {'), token));
    }
  });
});
