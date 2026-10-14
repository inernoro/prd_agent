// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 执行编辑器实际注册的 effect，而不是在测试里重写一份快捷键判断。
// AST 只负责定位；断言针对 DOM 键盘事件、工具切换与 preventDefault 的运行结果。
const source = ts.createSourceFile(
  'AdvancedVisualAgentTab.tsx',
  readFileSync(resolve(__dirname, '../AdvancedVisualAgentTab.tsx'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const effects: ts.ArrowFunction[] = [];
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') {
    const callback = node.arguments[0];
    if (callback && ts.isArrowFunction(callback)) {
      const text = callback.getText(source);
      if (text.includes('stageHoverRef.current') && text.includes('layerBringToFront()')) {
        effects.push(callback);
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (effects.length !== 1) throw new Error('必须定位到唯一的画布快捷键 effect');
const effectScript = ts.transpileModule(`(${effects[0].getText(source)})()`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

const setActiveTool = vi.fn();
const stageRef = { current: null as HTMLElement | null };
const stageHoverRef = { current: false };
let cleanup: () => void;

function keydown(key: string, code: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...modifiers });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="stage" tabindex="0"><button id="child">图层</button></div>'
    + '<button id="outside">其它区域</button><input id="input"><textarea id="textarea"></textarea>'
    + '<div id="editable" contenteditable="true" tabindex="0">提示词</div>';
  stageRef.current = document.getElementById('stage');
  stageHoverRef.current = false;
  setActiveTool.mockClear();
  cleanup = runInNewContext(effectScript, {
    document, window, stageRef, stageHoverRef, setActiveTool,
    fitToAll: vi.fn(), fitToSelection: vi.fn(), zoomTo100: vi.fn(),
    layerMoveUp: vi.fn(), layerMoveDown: vi.fn(), layerBringToFront: vi.fn(), layerSendToBack: vi.fn(),
    groupSelection: vi.fn(), ungroupSelection: vi.fn(), selectAllOnCanvas: vi.fn(),
  }) as () => void;
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('画布工具快捷键的真实监听器', () => {
  it.each([
    ['h', 'KeyH', 'hand'], ['H', 'KeyH', 'hand'], ['非拉丁键', 'KeyH', 'hand'],
    ['v', 'KeyV', 'select'], ['V', 'KeyV', 'select'], ['非拉丁键', 'KeyV', 'select'],
  ])('画布获得焦点时 %s / %s 切换为 %s', (key, code, tool) => {
    stageRef.current?.focus();
    const event = keydown(key, code);
    expect(setActiveTool).toHaveBeenCalledTimes(1);
    expect(setActiveTool).toHaveBeenCalledWith(tool);
    expect(event.defaultPrevented).toBe(true);
  });

  it('画布内部控件获得焦点时仍可切换工具', () => {
    document.getElementById('child')?.focus();
    expect(keydown('h', 'KeyH').defaultPrevented).toBe(true);
    expect(setActiveTool).toHaveBeenCalledTimes(1);
    expect(setActiveTool).toHaveBeenCalledWith('hand');
  });

  it('鼠标仍在画布内、焦点为非输入控件时可切换工具', () => {
    document.getElementById('outside')?.focus();
    stageHoverRef.current = true;
    keydown('v', 'KeyV');
    expect(setActiveTool).toHaveBeenCalledTimes(1);
    expect(setActiveTool).toHaveBeenCalledWith('select');
  });

  it('焦点和鼠标都不在画布内时不抢占按键', () => {
    document.getElementById('outside')?.focus();
    expect(keydown('h', 'KeyH').defaultPrevented).toBe(false);
    expect(keydown('v', 'KeyV').defaultPrevented).toBe(false);
    expect(setActiveTool).not.toHaveBeenCalled();
  });

  it.each(['input', 'textarea', 'editable'])('鼠标在画布内时也不抢占 %s 输入', (id) => {
    document.getElementById(id)?.focus();
    stageHoverRef.current = true;
    expect(keydown('h', 'KeyH').defaultPrevented).toBe(false);
    expect(keydown('v', 'KeyV').defaultPrevented).toBe(false);
    expect(setActiveTool).not.toHaveBeenCalled();
  });

  it.each([
    ['h', 'KeyH', { ctrlKey: true }], ['h', 'KeyH', { metaKey: true }], ['h', 'KeyH', { altKey: true }],
    ['v', 'KeyV', { ctrlKey: true }], ['v', 'KeyV', { metaKey: true }], ['v', 'KeyV', { altKey: true }],
  ])('不抢占 %s / %s 的组合键 %j', (key, code, modifiers) => {
    stageRef.current?.focus();
    expect(keydown(key, code, modifiers).defaultPrevented).toBe(false);
    expect(setActiveTool).not.toHaveBeenCalled();
  });

  it('卸载时移除监听器，避免重复切换或遗留页面快捷键', () => {
    stageRef.current?.focus();
    cleanup();
    expect(keydown('h', 'KeyH').defaultPrevented).toBe(false);
    expect(setActiveTool).not.toHaveBeenCalled();
  });
});
