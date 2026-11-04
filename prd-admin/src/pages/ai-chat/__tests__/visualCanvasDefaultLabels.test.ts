// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  canvasToPersistedV1, persistedV1ToCanvas,
  type CanvasImageItem, type PersistedCanvasStateV1,
} from '@/lib/visualAgentCanvasPersist';
import { chipToken, inlineMarksToTokens, parseChipTokenText } from '@/lib/chipTokenText';

// 与已有键盘回归一致：AST只定位，执行的是实际创建、标题和复制回调。
// 不复制生产命名算法，不用源码是否含中文代替运行结果，也不声称覆盖真实系统剪贴板。
const source = ts.createSourceFile('AdvancedVisualAgentTab.tsx',
  readFileSync(resolve(__dirname, '../AdvancedVisualAgentTab.tsx'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
type Scope = Record<string, unknown>;
function one<T>(values: T[], name: string): T {
  if (values.length !== 1) throw new Error(name + '必须唯一，实际为' + values.length);
  return values[0]!;
}
function find<T extends ts.Node>(predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source); return found;
}
function attribute(node: ts.JsxOpeningElement, name: string) {
  return node.attributes.properties.filter(ts.isJsxAttribute).find(value => value.name.getText(source) === name);
}
function expression(node: ts.JsxOpeningElement, name: string): ts.Expression {
  const value = attribute(node, name)?.initializer;
  if (!value || !ts.isJsxExpression(value) || !value.expression) throw new Error('缺少实际JSX表达式：' + name);
  return value.expression;
}
const transpile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;

// 旧源没有该import，就不加载尚未新增的模块；因此旧源RED只能来自行为断言。
// 新源若实际接入该模块，则执行真实导出并按import别名装配；缺文件/导出不兜底、不跳过。
const labelBindings: Scope = {};
for (const declaration of source.statements.filter(ts.isImportDeclaration)) {
  if (!ts.isStringLiteral(declaration.moduleSpecifier)
    || declaration.moduleSpecifier.text !== '@/lib/canvasElementLabels' || declaration.importClause?.isTypeOnly) continue;
  const names = declaration.importClause?.namedBindings;
  if (!names || !ts.isNamedImports(names)) throw new Error('默认名称模块必须使用显式命名导入');
  const actual = { exports: {} as Scope };
  runInNewContext(transpile(readFileSync(resolve(__dirname, '../../../lib/canvasElementLabels.ts'), 'utf8')),
    { module: actual, exports: actual.exports });
  for (const name of names.elements.filter(value => !value.isTypeOnly)) {
    const exported = name.propertyName?.text ?? name.name.text;
    if (!(exported in actual.exports)) throw new Error('默认名称导出缺失：' + exported);
    labelBindings[name.name.text] = actual.exports[exported];
  }
}
function evaluate<T>(node: ts.Node, scope: Scope = {}): T {
  return runInNewContext(transpile('(' + node.getText(source) + ')'), { ...labelBindings, ...scope }) as T;
}
const place = one(find((node): node is ts.VariableDeclaration =>
  ts.isVariableDeclaration(node) && node.name.getText(source) === 'placeAtPointer'), '形状创建入口');
if (!place.initializer || !ts.isCallExpression(place.initializer) || !place.initializer.arguments[0]) {
  throw new Error('未找到真实placeAtPointer回调');
}
const placeCallback = place.initializer.arguments[0];
const generatorButton = one(find((node): node is ts.JsxOpeningElement => {
  if (!ts.isJsxOpeningElement(node) || node.tagName.getText(source) !== 'button') return false;
  const label = attribute(node, 'aria-label')?.initializer;
  return !!label && ts.isStringLiteral(label) && label.text === '图像生成器';
}), '生成器按钮');
const itemElement = one(find((node): node is ts.JsxOpeningElement =>
  ts.isJsxOpeningElement(node) && !!attribute(node, 'data-canvas-key')), '画布对象节点');
const copyButton = one(find((node): node is ts.JsxOpeningElement => {
  if (!ts.isJsxOpeningElement(node) || node.tagName.getText(source) !== 'button' || !attribute(node, 'onClick')) return false;
  const text = expression(node, 'onClick').getText(source);
  return text.includes('copyToClipboard(') && text.includes('setImgContextMenu(');
}), '右键复制按钮');
const generatorRenderer = one(find((node): node is ts.ArrowFunction => ts.isArrowFunction(node)
  && node.parameters.length === 1 && node.parameters[0]!.name.getText(source) === 'g'
  && node.getText(source).includes('ui_' + '$' + '{g.key}')), '生成器实际标题渲染');
const textRenderer = one(find((node): node is ts.ConditionalExpression => ts.isConditionalExpression(node)
  && ts.isBinaryExpression(node.condition) && node.condition.left.getText(source) === 'kind'
  && node.condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
  && ts.isStringLiteral(node.condition.right) && node.condition.right.text === 'text'), '文字实际渲染分支');
const textConfirmButton = one(find((node): node is ts.JsxOpeningElement => {
  if (!ts.isJsxOpeningElement(node) || node.tagName.getText(source) !== 'Button' || !attribute(node, 'onClick')) return false;
  const text = expression(node, 'onClick').getText(source);
  return text.includes('textEdit.key') && text.includes('setCanvas(');
}), '编辑文字确认按钮');

let creationTime = 1_792_000_000_000;
function create(kind: 'shape' | 'generator' | 'text',
  shapeType: NonNullable<CanvasImageItem['shapeType']> = 'rect', setTextEdit = vi.fn()) {
  let items: CanvasImageItem[] = [];
  const selected = vi.fn();
  const scope: Scope = {
    Date: { now: () => ++creationTime }, canEditCanvas: () => true,
    stageRef: { current: { focus: vi.fn() } }, cameraRef: { current: { x: 0, y: 0 } }, zoomRef: { current: 1 },
    placing: kind === 'text' ? { kind } : { kind: 'shape', shapeType }, setPlacing: vi.fn(), setTextEdit,
    setCanvas: (update: (before: CanvasImageItem[]) => CanvasImageItem[]) => { items = update(items); },
    setSelectionWithoutChip: selected, stageCenterWorld: () => ({ x: 0, y: 0 }),
    // 命名测试不重写/验证空位规划；只固定无重叠的合法放置结果。
    occupiedRects: () => [], findNearestFreeTopLeft: () => ({ x: 10, y: 20 }),
    focusKeyRef: { current: null }, requestAnimationFrame: () => 0, focusQuickComposer: vi.fn(),
  };
  if (kind !== 'generator') {
    evaluate<(event: Scope) => boolean>(placeCallback, scope)({
      currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) }, clientX: 80, clientY: 60,
    });
  } else evaluate<() => void>(expression(generatorButton, 'onClick'), scope)();
  const item = one(items, '实际新建对象');
  expect(selected).toHaveBeenCalledWith([item.key]);
  return item;
}
const title = (item: CanvasImageItem) => evaluate<string>(expression(itemElement, 'title'), { it: item });
function renderedText(item: CanvasImageItem) {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(evaluate<React.ReactElement>(textRenderer.whenTrue, { React, it: item, active: false }));
  return container.textContent;
}
function copied(items: CanvasImageItem[], selectedKeys: string[]) {
  const clicked = items.find(item => item.key === selectedKeys[0]);
  if (!clicked) throw new Error('复制目标缺失');
  let menu: Scope | undefined;
  evaluate<(event: Scope) => void>(expression(itemElement, 'onContextMenu'), {
    it: clicked, kind: clicked.kind, selectedKeys,
    setImgContextMenu: (value: Scope) => { menu = value; },
    setSelection: vi.fn(), setSelectionWithoutChip: vi.fn(),
  })({ clientX: 10, clientY: 10, preventDefault: vi.fn(), stopPropagation: vi.fn() });
  const copyToClipboard = vi.fn();
  evaluate<() => void>(expression(copyButton, 'onClick'), {
    canvas: items, selectedKeys, imgContextMenu: menu, copyToClipboard, setImgContextMenu: vi.fn(),
  })();
  expect(copyToClipboard).toHaveBeenCalledTimes(1);
  return copyToClipboard.mock.calls[0]![0] as string;
}
function roundTrip(item: CanvasImageItem) {
  const saved = JSON.parse(JSON.stringify(canvasToPersistedV1([item]).state)) as PersistedCanvasStateV1;
  const before = JSON.stringify(saved);
  const restored = one(persistedV1ToCanvas(saved, []).canvas, '恢复对象');
  expect(JSON.stringify(saved)).toBe(before);
  // 原codec会给generator/图片补齐已有缺省字段；先要求每个原字段不丢，
  // 再要求规范化后的下一次完整JSON稳定，不将既有补齐误判为命名回归。
  const savedAgain = JSON.parse(JSON.stringify(canvasToPersistedV1([restored]).state)) as PersistedCanvasStateV1;
  expect(savedAgain).toMatchObject(saved);
  const restoredAgain = persistedV1ToCanvas(savedAgain, []).canvas;
  expect(JSON.parse(JSON.stringify(canvasToPersistedV1(restoredAgain).state))).toEqual(savedAgain);
  expect(restored.key).toBe(item.key);
  return restored;
}
function fixture(kind: 'shape' | 'generator', prompt: string): CanvasImageItem {
  return { key: 'custom-' + kind, kind, prompt, createdAt: 1, src: '', status: 'done',
    x: 10, y: 20, w: 240, h: 160, ...(kind === 'shape' ? { shapeType: 'rect' as const } : {}) };
}
const textFixture = (prompt: string, text?: string): CanvasImageItem => ({
  key: 'custom-text', kind: 'text', prompt, createdAt: 1, src: '', status: 'done',
  x: 10, y: 20, w: 320, h: 88, ...(text === undefined ? {} : { text }),
});
function confirmText(item: CanvasImageItem, value: string) {
  const untouched = fixture('shape', '其它元素不得改变'), before = JSON.stringify([item, untouched]);
  let items = [item, untouched];
  const setTextEdit = vi.fn();
  evaluate<() => void>(expression(textConfirmButton, 'onClick'), {
    canEditCanvas: () => true, textEdit: { open: true, key: item.key, value }, setTextEdit,
    setCanvas: (update: (previous: CanvasImageItem[]) => CanvasImageItem[]) => { items = update(items); },
  })();
  expect(setTextEdit).toHaveBeenCalledWith({ open: false, key: '', value: '' });
  expect(JSON.stringify([item, untouched])).toBe(before);
  expect(items[1]).toBe(untouched);
  return one(items.filter(next => next.key === item.key), '确认后的原文字对象');
}

describe('系统新建画布对象的人类默认名称', () => {
  it.each([
    ['rect', '矩形'], ['circle', '圆形'], ['triangle', '三角形'], ['star', '星形'],
  ] as const)('实际创建%s后，名称、title、复制和V1往返均为%s', (shapeType, expected) => {
    const item = create('shape', shapeType);
    expect(item).toMatchObject({ kind: 'shape', shapeType, status: 'done', prompt: expected, src: '' });
    expect(item.key).toMatch(/^shape_\d+$/);
    expect([item.x, item.y, item.w, item.h].every(Number.isFinite)).toBe(true);
    expect(title(item)).toBe(expected);
    expect(copied([item], [item.key])).toBe(expected);
    const restored = roundTrip(item);
    expect(restored).toMatchObject({ kind: item.kind, shapeType, prompt: expected,
      x: item.x, y: item.y, w: item.w, h: item.h });
    expect(title(restored)).toBe(expected);
    expect(copied([restored], [restored.key])).toBe(expected);
  });

  it('真实按钮创建空生成器，默认名称和复制内容为图像生成器', () => {
    const item = create('generator');
    expect(item).toMatchObject({ kind: 'generator', prompt: '图像生成器', src: '', w: 1024, h: 1024 });
    expect(title(item)).toBe('图像生成器');
    const restored = roundTrip(item);
    expect(copied([restored], [restored.key])).toBe('图像生成器');
  });

  it('实际生成器JSX显示人类类型标题，不将用户提示词当类型名或改写它', () => {
    const item = fixture('generator', '保留用户自定义的长提示词');
    const before = JSON.stringify(item);
    const render = evaluate<(value: CanvasImageItem) => React.ReactElement>(generatorRenderer, { React });
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(render(item));
    expect(container.firstElementChild?.firstElementChild?.textContent?.trim()).toBe('图像生成器');
    expect(JSON.stringify(item)).toBe(before);
    expect(copied([item], [item.key])).toBe(item.prompt);
  });

  it('generator真正缺prompt/name时采用同一人类默认，不修改输入存档', () => {
    const state: PersistedCanvasStateV1 = { schemaVersion: 1,
      elements: [{ id: 'legacy-generator', kind: 'generator', x: 10, y: 20, w: 1024, h: 1024 }] };
    const before = JSON.stringify(state);
    const item = one(persistedV1ToCanvas(state, []).canvas, '缺省生成器');
    expect(item.prompt).toBe('图像生成器');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('真实多选复制保持canvas顺序，系统默认不再带出内部类型码', () => {
    const shape = create('shape', 'rect'), generator = create('generator');
    const items = [generator, shape].map(roundTrip);
    expect(copied(items, [shape.key, generator.key])).toBe('图像生成器\n矩形');
  });
});

describe('既有文字类型的系统默认来源，不迁移显式正文', () => {
  it('实际文字创建回调为画布、编辑初值、title及复制使用文字', () => {
    const setTextEdit = vi.fn(), item = create('text', 'rect', setTextEdit);
    expect(item).toMatchObject({ kind: 'text', prompt: '文字', text: '文字', src: '', w: 320, h: 88, fontSize: 26 });
    expect(item.key).toMatch(/^text_\d+$/);
    expect(setTextEdit).toHaveBeenCalledWith({ open: true, key: item.key, value: '文字' });
    expect(renderedText(item)).toBe('文字');
    expect(title(item)).toBe('文字');
    const restored = roundTrip(item);
    expect(restored).toMatchObject({ key: item.key, kind: 'text', prompt: '文字', text: '文字' });
    expect(copied([restored], [restored.key])).toBe('文字');
  });

  it('原确认回调的空输入fallback为文字，不新增清洗规则或改动旁项', () => {
    const item = textFixture('原名称', '原正文'), confirmed = confirmText(item, '');
    expect(confirmed).toMatchObject({ key: item.key, kind: 'text', prompt: '文字', text: '文字',
      x: item.x, y: item.y, w: item.w, h: item.h });
    expect(renderedText(confirmed)).toBe('文字');
    expect(title(confirmed)).toBe('文字');
    const restored = roundTrip(confirmed);
    expect(copied([restored], [restored.key])).toBe('文字');
  });

  it('实际renderer只在正文缺省时显示文字，不回写名称、正文或存档', () => {
    const item = textFixture('保留缺正文对象的显式名称'), before = JSON.stringify(item);
    expect(renderedText(item)).toBe('文字');
    expect(JSON.stringify(item)).toBe(before);
    expect(item).not.toHaveProperty('text');
    const restored = roundTrip(item);
    expect(restored.prompt).toBe(item.prompt);
    expect(restored.text).toBeUndefined();
    expect(JSON.parse(JSON.stringify(canvasToPersistedV1([restored]).state.elements[0]))).not.toHaveProperty('text');
  });

  it.each(['用户自己的正文', 'Text', 'Shape:rect', ''])('显式保存的名称和文字%s保持原样，包括空串', value => {
    const item = textFixture(value, value), before = JSON.stringify(item), restored = roundTrip(item);
    expect(restored).toMatchObject({ prompt: value, text: value });
    expect(title(restored)).toBe(value);
    expect(renderedText(restored)).toBe(value);
    if (value) expect(copied([restored], [restored.key])).toBe(value);
    expect(JSON.stringify(item)).toBe(before);
  });

  it.each(['用户输入的正文', 'Text', 'Shape:rect'])('实际确认不把显式输入%s识别成系统默认', value => {
    const confirmed = confirmText(textFixture('原名称', '原正文'), value);
    expect(confirmed).toMatchObject({ prompt: value, text: value });
    expect(renderedText(confirmed)).toBe(value);
    expect(copied([confirmed], [confirmed.key])).toBe(value);
  });
});

describe('显式用户数据与图片引用身份不迁移', () => {
  it.each(['用户自己的名字', 'Shape:rect', 'Image Generator'])('显式名称%s逐项往返保留', prompt => {
    for (const kind of ['shape', 'generator'] as const) {
      const item = fixture(kind, prompt), before = JSON.stringify(item), restored = roundTrip(item);
      expect(restored.prompt).toBe(prompt);
      expect(title(restored)).toBe(prompt);
      if (prompt) expect(copied([restored], [restored.key])).toBe(prompt);
      expect(JSON.stringify(item)).toBe(before);
    }
  });

  it('shape显式空名称仍可往返，不被系统默认补写', () => {
    const item = fixture('shape', ''), before = JSON.stringify(item), restored = roundTrip(item);
    expect(restored.prompt).toBe('');
    expect(title(restored)).toBe('');
    expect(JSON.stringify(item)).toBe(before);
  });

  it('generator原序列化省略空name和prompt，但不改写原输入', () => {
    const item = fixture('generator', ''), before = JSON.stringify(item);
    const saved = JSON.parse(JSON.stringify(canvasToPersistedV1([item]).state.elements[0]));
    expect(saved).toMatchObject({ id: item.key, kind: 'generator' });
    expect(saved).not.toHaveProperty('name');
    expect(saved).not.toHaveProperty('prompt');
    expect(item.prompt).toBe('');
    expect(title(item)).toBe('');
    expect(JSON.stringify(item)).toBe(before);
  });

  it.each(['shape', 'text'] as const)('旧%s缺name仍不虚构标签或改正文', kind => {
    const element = kind === 'shape'
      ? { id: 'legacy-shape', kind, shapeType: 'rect' as const, x: 10, y: 20, w: 240, h: 160 }
      : { id: 'legacy-text', kind, text: '用户正文不得改名', fontSize: 26, x: 10, y: 20, w: 320, h: 88 };
    const state: PersistedCanvasStateV1 = { schemaVersion: 1, elements: [element] };
    const before = JSON.stringify(state), item = one(persistedV1ToCanvas(state, []).canvas, '旧无名称对象');
    expect(item.prompt).toBe('');
    const saved = JSON.parse(JSON.stringify(canvasToPersistedV1([item]).state.elements[0]));
    expect(saved).not.toHaveProperty('name');
    if (kind === 'text') expect(item.text).toBe('用户正文不得改名');
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([
    [{ name: '用户名称' }, '用户名称'],
    [{ prompt: '用户提示词', name: '不得覆盖的名称' }, '用户提示词'],
    [{ prompt: '', name: '空提示词不得fallback' }, ''],
    [{ name: '' }, ''],
  ] as const)('generator显式prompt/name优先级及空串保持：%j', (fields, expected) => {
    const state: PersistedCanvasStateV1 = { schemaVersion: 1,
      elements: [{ id: 'explicit-generator', kind: 'generator', ...fields }] };
    const before = JSON.stringify(state);
    expect(persistedV1ToCanvas(state, []).canvas[0]?.prompt).toBe(expected);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('图片key/refId/src及原结构化复制token不被默认名称处理删除或改号', () => {
    const item: CanvasImageItem = { key: 'owned-image', kind: 'image', createdAt: 1, status: 'done',
      src: 'https://example.invalid/owned.png', assetId: 'owned-asset', refId: 7,
      prompt: '用户图片名称包含@img7但不是系统默认', x: 0, y: 0, w: 320, h: 220 };
    const restored = roundTrip(item);
    expect(restored).toMatchObject({ key: item.key, refId: 7, src: item.src, prompt: item.prompt });
    const token = chipToken(7, item.key, item.src);
    const text = inlineMarksToTokens('调整@img7的位置', new Map([[7, { canvasKey: item.key, src: item.src }]]));
    expect(text).toBe('调整' + token + '的位置');
    expect(parseChipTokenText(text)).toContainEqual({
      type: 'chip', refId: 7, canvasKey: item.key, src: item.src, raw: token,
    });
  });
});
