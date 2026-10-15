// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 执行编辑器实际注册的 effect，而不是在测试里重写一份快捷键判断。
// AST 只负责定位；断言针对 DOM 键盘事件及随后真实 stage capture/bubble 的运行结果。
const source = ts.createSourceFile(
  'AdvancedVisualAgentTab.tsx',
  readFileSync(resolve(__dirname, '../AdvancedVisualAgentTab.tsx'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const effects: ts.ArrowFunction[] = [];
const pointerCallbacks: Record<string, ts.ArrowFunction> = {};
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
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'placeAtPointer'
    && node.initializer && ts.isCallExpression(node.initializer)
    && ts.isArrowFunction(node.initializer.arguments[0])) {
    pointerCallbacks.placeAtPointer = node.initializer.arguments[0];
  }
  if (ts.isJsxAttribute(node) && node.name.getText(source) === 'data-tour-id'
    && node.initializer && ts.isStringLiteral(node.initializer)
    && node.initializer.text === 'visual-editor-canvas') {
    for (const attribute of node.parent.properties) {
      if (!ts.isJsxAttribute(attribute) || !['onPointerDownCapture', 'onPointerDown'].includes(attribute.name.getText(source))) continue;
      const expression = attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression;
      if (expression && ts.isArrowFunction(expression)) pointerCallbacks[attribute.name.getText(source)] = expression;
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (effects.length !== 1) throw new Error('必须定位到唯一的画布快捷键 effect');
const transpile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const effectScript = transpile(`(${effects[0].getText(source)})()`);
const pointerScripts = Object.fromEntries(['placeAtPointer', 'onPointerDownCapture', 'onPointerDown'].map((name) => {
  if (!pointerCallbacks[name]) throw new Error(`未找到真实画布回调：${name}`);
  return [name, transpile(`(${pointerCallbacks[name].getText(source)})`)];
}));

let activeTool: string;
let placing: { kind: 'shape'; shapeType: 'rect' } | { kind: 'text' } | null;
const setActiveTool = vi.fn((tool: string) => { activeTool = tool; });
const setPlacing = vi.fn((next: typeof placing) => { placing = next; });
const setCanvas = vi.fn();
const setTextEdit = vi.fn();
const setMarquee = vi.fn();
const panRef = { current: { active: false } };
const stageRef = { current: null as HTMLElement | null };
const stageHoverRef = { current: false };
let cleanup: () => void;

function keydown(key: string, code: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...modifiers });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

function pointerdown() {
  // 离散键盘事件已结束；用下一次渲染的状态重新创建生产回调，不预先点击消耗 placing。
  const context = {
    placing, effectiveTool: activeTool, stageRef, panRef, isMobile: false,
    cameraRef: { current: { x: 0, y: 0 } }, zoomRef: { current: 1 }, worldRef: { current: null },
    pinchActiveRef: { current: false }, setCanvas, setPlacing, setTextEdit, setMarquee,
    setSelectionWithoutChip: vi.fn(), setPanning: vi.fn(),
  };
  const placeAtPointer = runInNewContext(pointerScripts.placeAtPointer, context);
  const capture = runInNewContext(pointerScripts.onPointerDownCapture, { ...context, placeAtPointer });
  const bubble = runInNewContext(pointerScripts.onPointerDown, context);
  const stage = stageRef.current!;
  stage.addEventListener('pointerdown', capture, true);
  stage.addEventListener('pointerdown', bubble);
  const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 80, clientY: 60 });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
  stage.dispatchEvent(event);
  stage.removeEventListener('pointerdown', capture, true);
  stage.removeEventListener('pointerdown', bubble);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="stage" tabindex="0"><button id="child">图层</button></div>'
    + '<button id="outside">其它区域</button><input id="input"><textarea id="textarea"></textarea>'
    + '<div id="editable" contenteditable="true" tabindex="0">提示词</div>';
  stageRef.current = document.getElementById('stage');
  stageRef.current!.setPointerCapture = vi.fn();
  stageHoverRef.current = false;
  activeTool = 'select';
  placing = { kind: 'shape', shapeType: 'rect' };
  panRef.current = { active: false };
  vi.clearAllMocks();
  cleanup = runInNewContext(effectScript, {
    document, window, stageRef, stageHoverRef, setActiveTool, setPlacing,
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
    ['shape', 'h', 'KeyH', 'hand'], ['text', 'h', 'KeyH', 'hand'],
    ['shape', 'v', 'KeyV', 'select'], ['text', 'v', 'KeyV', 'select'],
  ] as const)('%s 待放置时按 %s（%s）后，下一 pointerdown 使用 %s 而非插入对象', (kind, key, code, tool) => {
    placing = kind === 'shape' ? { kind, shapeType: 'rect' } : { kind };
    stageRef.current?.focus();
    keydown(key, code);
    expect(pointerdown().defaultPrevented).toBe(true);
    expect(setCanvas).not.toHaveBeenCalled();
    expect(setTextEdit).not.toHaveBeenCalled();
    expect(activeTool).toBe(tool);
    expect(placing).toBeNull();
    expect(panRef.current.active).toBe(tool === 'hand');
    if (tool === 'select') expect(setMarquee).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
    else expect(setMarquee).not.toHaveBeenCalled();
  });

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
    expect(setPlacing).not.toHaveBeenCalled();
  });

  it.each(
    ['input', 'textarea', 'editable'].flatMap((id) => (['shape', 'text'] as const).map((kind) => [id, kind] as const)),
  )('鼠标在画布内时也不抢占 %s 输入，并保留 %s 待放置', (id, kind) => {
    placing = kind === 'shape' ? { kind, shapeType: 'rect' } : { kind };
    document.getElementById(id)?.focus();
    stageHoverRef.current = true;
    expect(keydown('h', 'KeyH').defaultPrevented).toBe(false);
    expect(keydown('v', 'KeyV').defaultPrevented).toBe(false);
    expect(setActiveTool).not.toHaveBeenCalled();
    expect(setPlacing).not.toHaveBeenCalled();
    pointerdown();
    expect(setCanvas).toHaveBeenCalledTimes(1);
    expect(setCanvas.mock.calls[0][0]([])).toEqual([expect.objectContaining({ kind })]);
    expect(setTextEdit).toHaveBeenCalledTimes(kind === 'text' ? 1 : 0);
  });

  it.each([
    ['h', 'KeyH', { ctrlKey: true }], ['h', 'KeyH', { metaKey: true }], ['h', 'KeyH', { altKey: true }],
    ['v', 'KeyV', { ctrlKey: true }], ['v', 'KeyV', { metaKey: true }], ['v', 'KeyV', { altKey: true }],
  ])('不抢占 %s / %s 的组合键 %j', (key, code, modifiers) => {
    stageRef.current?.focus();
    expect(keydown(key, code, modifiers).defaultPrevented).toBe(false);
    expect(setActiveTool).not.toHaveBeenCalled();
    expect(setPlacing).not.toHaveBeenCalled();
  });

  it('卸载时移除监听器，避免重复切换或遗留页面快捷键', () => {
    stageRef.current?.focus();
    cleanup();
    expect(keydown('h', 'KeyH').defaultPrevented).toBe(false);
    expect(setActiveTool).not.toHaveBeenCalled();
  });
});
