// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as Popover from '@radix-ui/react-popover';
import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectTierFromSize } from '@/lib/imageAspectOptions';

// 执行生产 JSX 与真实 Radix 交互；jsdom 不提供布局，像素边界与真触控仍需公开预览验收。
const source = ts.createSourceFile('AdvancedVisualAgentTab.tsx', readFileSync(
  resolve(__dirname, '../AdvancedVisualAgentTab.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function pickerScript() {
  const roots: ts.JsxElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'Popover.Root'
      && node.openingElement.attributes.getText().includes('sizeSelectorOpen')) roots.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (roots.length !== 1) throw new Error('聊天尺寸选择器必须接入唯一的碰撞定位 Popover');
  return ts.transpileModule(`(${roots[0].getText()})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
}
const options = new Map([['1:1', { size: '1024x1024' }], ['2:3', { size: '1024x1536' }]]);
let root: Root;
let host: HTMLDivElement;
let mobile = true;
let chatVisible = true;
let disabled = false;
const changed = vi.fn();
function Harness() {
  const [sizeSelectorOpen, setSizeSelectorOpen] = React.useState(false);
  const [composerSize, setComposerSize] = React.useState('1024x1024');
  const picker = runInNewContext(pickerScript(), {
    React, Popover, sizeSelectorOpen, setSizeSelectorOpen, isMobile: mobile, mobileShowChat: chatVisible,
    composerSize, autoSizeForSelectedImage: null, imageGenSize: '1024x1024',
    currentModelSizesNotApplicable: disabled, detectTierFromSize,
    sizeToAspectMap: new Map([['1024x1024', '1:1'], ['1024x1536', '2:3']]),
    detectAspectFromSize: () => { throw new Error('已有真实尺寸映射，不应走兜底'); },
    ratiosByResolution: { '1k': options, '2k': new Map(), '4k': new Map() },
    setComposerSizeManual: (size: string) => { changed(size); setComposerSize(size); },
  }) as React.ReactNode;
  return <div style={{ overflow: 'hidden' }}>{picker}</div>;
}
const trigger = () => document.querySelector<HTMLButtonElement>('[aria-label="尺寸比例"]')!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const click = async (element: HTMLElement) => { await React.act(async () => element.click()); };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  mobile = true;
  chatVisible = true;
  disabled = false;
  changed.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = async () => { await React.act(async () => root.render(<Harness />)); };

describe('聊天尺寸弹层定位与选择接线', () => {
  it('使用现有上方碰撞定位、视口留边与 inline 尺寸，不再依赖父容器 right-0', async () => {
    let tree: React.ReactElement | undefined;
    runInNewContext(pickerScript(), {
      React: { createElement: (type: unknown, props: Record<string, unknown>, ...children: unknown[]) => {
        const element = React.createElement(type as React.ElementType, props, ...children as React.ReactNode[]);
        if (type === Popover.Content) tree = element;
        return element;
      } }, Popover, sizeSelectorOpen: true, setSizeSelectorOpen: vi.fn(), isMobile: true, mobileShowChat: true,
      currentModelSizesNotApplicable: true, composerSize: '1024x1024', autoSizeForSelectedImage: null,
      imageGenSize: '1024x1024', detectTierFromSize, sizeToAspectMap: new Map(),
      detectAspectFromSize: () => '1:1', ratiosByResolution: { '1k': options, '2k': new Map(), '4k': new Map() },
    });
    expect(tree?.props).toMatchObject({ side: 'top', align: 'end', collisionPadding: 8,
      style: { width: 'min(260px, calc(100vw - 16px))',
        maxHeight: 'var(--radix-popover-content-available-height)', overflowY: 'auto', minHeight: 0 } });
    expect(tree?.props.avoidCollisions).not.toBe(false);
  });

  it.each([true, false])('手机=%s时脱离 overflow 父级，保留对应主题及尺寸回显/关闭', async (isMobile) => {
    mobile = isMobile;
    await render();
    await click(trigger());
    expect(dialog()).not.toBeNull();
    expect(host.contains(dialog())).toBe(false);
    expect(dialog()!.classList.contains('surface-tone-dark')).toBe(isMobile);
    const ratio = [...dialog()!.querySelectorAll('button')].find(button => button.textContent === '2:3')!;
    await click(ratio);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith('1024x1536');
    expect(dialog()).toBeNull();
    expect(trigger().textContent).toContain('2:3');
    await click(trigger());
    const selected = [...dialog()!.querySelectorAll('button')].find(button => button.textContent === '2:3')!;
    expect(selected.classList.contains('surface-action-accent')).toBe(true);
    expect(selected.style.color).toBe('var(--selection-text)');
    await React.act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(dialog()).toBeNull();
    await click(trigger());
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    await React.act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(dialog()).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('跨断点或手机聊天收起时隐藏 Portal，聊天重显保留原打开状态', async () => {
    mobile = false;
    chatVisible = false;
    await render();
    await click(trigger());
    expect(dialog()).not.toBeNull();
    mobile = true;
    await render();
    expect(dialog()).toBeNull();
    chatVisible = true;
    await render();
    expect(dialog()).not.toBeNull();
    chatVisible = false;
    await render();
    expect(dialog()).toBeNull();
    mobile = false;
    await render();
    expect(dialog()).not.toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it('尺寸不适用时保持禁用，不打开浮层或改动尺寸', async () => {
    disabled = true;
    await render();
    await click(trigger());
    expect(trigger().disabled).toBe(true);
    expect(dialog()).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });
});
