import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as persistence from '../../../lib/visualAgentCanvasPersist';
import * as scheduling from '../../../lib/canvasSaveSchedule';

// 执行 TSX 内真正的 boot、放置、提交和自动保存回调；只替换 React/DOM/API 边界。
// 这不是复制一份简化业务实现，也不代替公网真实鼠标、保存和刷新验收。
const path = new URL('../AdvancedVisualAgentTab.tsx', import.meta.url);
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map<string, ts.VariableDeclaration>();
const effects: ts.Expression[] = [];
const elements: ts.JsxElement[] = [];
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect') effects.push(node.arguments[0]);
  if (ts.isJsxElement(node)) elements.push(node);
  ts.forEachChild(node, visit);
}
visit(ast);

function callback(name: string) {
  const initializer = declarations.get(name)?.initializer;
  if (!initializer) throw new Error(`未找到真实回调：${name}`);
  return ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer;
}
function effect(...markers: string[]) {
  const found = effects.filter(node => markers.every(marker => node.getText(ast).includes(marker)));
  expect(found).toHaveLength(1);
  return found[0];
}
function button(name: string, requireCallback = true) {
  const found = elements.filter(node => node.openingElement.attributes.properties.some(attribute =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'aria-label'
      && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === name));
  expect(found).toHaveLength(1);
  const attributes = found[0].openingElement.attributes.properties;
  const click = attributes.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'onClick');
  if (!click || !ts.isJsxAttribute(click) || !click.initializer || !ts.isJsxExpression(click.initializer) || !click.initializer.expression) {
    if (requireCallback) throw new Error(`按钮没有真实回调：${name}`);
    return { node: found[0], callback: undefined };
  }
  return { node: found[0], callback: click.initializer.expression };
}
function run(node: ts.Node, context: vm.Context, ...args: unknown[]) {
  const code = ts.transpileModule(`module.exports = (${node.getText()});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInContext(code, context);
  return context.module.exports(...args);
}
const boot = effect('getVisualAgentWorkspaceDetail', 'initWorkspaceRef.current.started', 'applyCanvasFocus');
const save = effect('const runSave = ()', 'canvasSaveCooldownRemaining');
const ready = declarations.get('workspaceReady')?.initializer;
if (!ready) throw new Error('缺少真实 workspaceReady 谓词');

function setup() {
  const changes = vi.fn();
  const saves: { elements: unknown[] }[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let resolveDetail!: (value: unknown) => void;
  const detail = new Promise(resolve => { resolveDetail = resolve; });
  const context = vm.createContext({
    module: { exports: null }, ...persistence, ...scheduling,
    workspaceId: 'stsmk-local-readiness', workspaceIdRef: { current: 'stsmk-local-readiness' },
    workspace: null, booting: true, workspaceReady: false, workspaceReadyRef: { current: false },
    canvas: [], canvasRef: { current: [] }, canvasBootedRef: { current: null },
    canvasDirtyRef: { current: false }, canvasSaveTimerRef: { current: null }, lastSavedJsonRef: { current: '' },
    lastSaveAtRef: { current: 0 }, pendingLocalOnlyWarnRef: { current: 0 },
    initWorkspaceRef: { current: { workspaceId: '', started: false } },
    viewportHydratedRef: { current: false }, lastViewportSavedRef: { current: null },
    cameraRef: { current: { x: 0, y: 0 } }, zoomRef: { current: 0.5 },
    isMobileRef: { current: true }, INITIAL_MSG_LIMIT: 80,
    stageRef: { current: { focus: vi.fn() } }, focusKeyRef: { current: null },
    placing: { kind: 'shape', shapeType: 'rect' },
    selectedKeys: [], selectedKeysRef: { current: [] },
    getVisualAgentWorkspaceDetail: () => detail,
    setCanvas: (next: unknown[] | ((prev: unknown[]) => unknown[])) => {
      changes();
      context.canvas = typeof next === 'function' ? next(context.canvas) : next;
      context.canvasRef.current = context.canvas;
    },
    setWorkspace: (next: unknown) => { context.workspace = next; refreshReady(); },
    setBooting: (next: boolean) => { context.booting = next; refreshReady(); },
    setHasMoreMessages: vi.fn(), setStylePrompt: vi.fn(), setStylePromptDraft: vi.fn(), setMessages: vi.fn(),
    setNextRefId: vi.fn(), clearSelectionWithChips: vi.fn(), setSelectionWithoutChip: vi.fn(),
    focusStage: vi.fn(), focusComposer: vi.fn(), pushMsg: vi.fn(), setError: vi.fn(),
    setViewport: vi.fn(), clampZoom: (value: number) => value,
    safeJsonParse: (text: string) => JSON.parse(text),
    reconcileVisualAgentWorkspaceCanvas: vi.fn(),
    saveVisualAgentWorkspaceCanvas: async (input: { payloadJson: string }) => {
      saves.push(JSON.parse(input.payloadJson)); return { success: true };
    },
    setPlacing: (value: unknown) => { context.placing = value; }, setTextEdit: vi.fn(),
    setActiveTool: vi.fn(), setShapeMenuOpen: vi.fn(), setInput: vi.fn(), setQuickInput: vi.fn(),
    setDrawingBoardOpen: vi.fn(),
    quickInput: '保留快捷草稿', richComposerRef: { current: {
      getStructuredContent: () => ({ text: '保留富文本草稿', imageRefs: [] }), clear: vi.fn(),
    } },
    composerSizeAutoRef: { current: true }, selectedSingleImageForComposer: null,
    extractSizeToken: (text: string) => ({ cleanText: text }), sendText: vi.fn(),
    pendingJobsRef: { current: [] }, drainGenQueue: vi.fn(),
    sendGuardRef: { current: null }, composerSize: null, autoSizeForSelectedImage: null,
    mergeSendCanvas: (items: unknown[]) => items,
    resolveImageRefs: ({ rawText }: { rawText: string }) => ({ cleanText: rawText, refs: [] }),
    buildRequestText: (text: string) => ({ requestText: text }), setPendingCount: vi.fn(),
    titleGenTriggeredRef: { current: true }, focusQuickComposer: vi.fn(),
    toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn() }, showUploadToast: vi.fn(),
    requestAnimationFrame: vi.fn(), document: { activeElement: null },
    window: { setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id: number) => timers.delete(id) },
    stageCenterWorld: () => ({ x: 0, y: 0 }), occupiedRects: () => [],
    findNearestFreeTopLeft: () => ({ x: 0, y: 0 }),
    systemDialog: { confirm: vi.fn(async () => true), prompt: vi.fn() },
  });
  function refreshReady() {
    vm.runInContext(`module.exports = () => (${ready!.getText(ast)});`, context);
    context.workspaceReady = context.module.exports();
    context.workspaceReadyRef.current = context.workspaceReady;
  }
  // 新守卫也是执行真实回调，不在测试里另造一套权限逻辑。
  if (declarations.has('canEditCanvas')) context.canEditCanvas = () => run(callback('canEditCanvas'), context);
  const restore = async (mode: 'stored' | 'fallback' = 'stored') => {
    resolveDetail({ success: true, data: { workspace: { id: context.workspaceId }, messages: [], assets: [],
      canvas: mode === 'stored' ? { payloadJson: JSON.stringify({ schemaVersion: 1, elements: [] }) } : null } });
    await new Promise(resolve => setImmediate(resolve));
    refreshReady();
  };
  const place = (kind: 'shape' | 'text') => {
    context.placing = kind === 'shape' ? { kind, shapeType: 'rect' } : { kind };
    return run(callback('placeAtPointer'), context, { clientX: 350, clientY: 320,
      currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) } });
  };
  return { context, changes, saves, timers, resolveDetail, refreshReady, restore, place };
}

describe('当前工作区快照成功应用之后才接受持久化编辑', () => {
  for (const kind of ['shape', 'text'] as const) for (const mode of ['stored', 'fallback'] as const) {
    it(`${kind}/${mode}：延迟恢复前拒绝放置，恢复后立即编辑、保存并可回放`, async () => {
      const h = setup();
      const cleanup = run(boot, h.context);
      expect(h.place(kind)).toBe(false);
      expect(h.context.canvas).toHaveLength(0);
      run(save, h.context);
      expect(h.timers.size).toBe(0);
      await h.restore(mode);
      expect(h.context.workspaceReady).toBe(true);
      expect(h.place(kind)).toBe(true);
      run(save, h.context);
      for (const timer of h.timers.values()) timer();
      await new Promise(resolve => setImmediate(resolve));
      expect(h.saves.some(snapshot => snapshot.elements.length === 1)).toBe(true);
      const latest = h.saves[h.saves.length - 1];
      const restored = persistence.persistedV1ToCanvas(latest as Parameters<typeof persistence.persistedV1ToCanvas>[0], []);
      expect(restored.canvas).toHaveLength(1);
      expect(restored.canvas[0].kind).toBe(kind);
      cleanup();
    });
  }
  it('boot 开始即撤销旧工作区的应用资格，错误详情不能变可写', async () => {
    const h = setup();
    h.context.canvasBootedRef.current = 'stsmk-old-workspace';
    run(boot, h.context);
    expect(h.context.canvasBootedRef.current).toBeNull();
    h.resolveDetail({ success: false, error: { message: '详情暂不可用' } });
    await new Promise(resolve => setImmediate(resolve));
    expect(h.context.booting).toBe(false);
    expect(h.context.workspaceReady).toBe(false);
    expect(h.place('shape')).toBe(false);
    expect(h.saves).toHaveLength(0);
  });
  it('快照应用前抛错，finally 不能因已拿到 workspace 而错误开放', async () => {
    const h = setup();
    h.context.safeJsonParse = () => { throw new Error('损坏快照'); };
    run(boot, h.context);
    await h.restore();
    expect(h.context.booting).toBe(false);
    expect(h.context.workspaceReady).toBe(false);
    expect(h.place('text')).toBe(false);
  });
  it('切换工作区后的旧详情响应不应用、不开放、不保存', async () => {
    const h = setup();
    const cleanup = run(boot, h.context);
    cleanup();
    h.context.workspaceIdRef.current = 'stsmk-new-workspace';
    await h.restore();
    expect(h.changes).not.toHaveBeenCalled();
    expect(h.context.workspaceReady).toBe(false);
    expect(h.saves).toHaveLength(0);
  });
  it('当前 owner 已切换，即使捕获旧 ready=true 也拒绝回调', () => {
    const h = setup();
    h.context.workspaceReady = true;
    h.context.workspaceReadyRef.current = true;
    h.context.workspaceIdRef.current = 'stsmk-new-workspace';
    expect(h.place('shape')).toBe(false);
    expect(h.changes).not.toHaveBeenCalled();
  });
});

describe('草图控件与宿主 readiness 接线', () => {
  const childPath = new URL('../../../components/visual-agent/DrawingBoardDialog.tsx', import.meta.url);
  const childSource = fs.readFileSync(childPath, 'utf8');
  const childAst = ts.createSourceFile(childPath.pathname, childSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(node: ts.Node, predicate: (candidate: ts.Node) => boolean): ts.Node[] {
    const found: ts.Node[] = [];
    const walk = (candidate: ts.Node) => {
      if (predicate(candidate)) found.push(candidate);
      ts.forEachChild(candidate, walk);
    };
    walk(node);
    return found;
  }
  const host = find(ast, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === 'DrawingBoardDialog')[0] as ts.JsxSelfClosingElement;
  function attribute(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) {
    const found = node.attributes.properties.find(candidate => ts.isJsxAttribute(candidate) && candidate.name.getText() === name);
    if (!found || !ts.isJsxAttribute(found) || !found.initializer || !ts.isJsxExpression(found.initializer) || !found.initializer.expression) {
      throw new Error(`缺少实际属性接线：${name}`);
    }
    return found.initializer.expression;
  }
  const hostConfirm = attribute(host, 'onConfirm');
  const handler = find(childAst, node => ts.isVariableDeclaration(node) && node.name.getText() === 'handleConfirm')[0] as ts.VariableDeclaration;
  const childConfirm = (handler.initializer as ts.CallExpression).arguments[0];
  const confirmButton = find(childAst, node => ts.isJsxOpeningElement(node) && node.tagName.getText() === 'button'
    && node.attributes.properties.some(candidate => ts.isJsxAttribute(candidate) && candidate.name.getText() === 'onClick'
      && candidate.initializer?.getText() === '{handleConfirm}'))[0] as ts.JsxOpeningElement;
  it('宿主恢复前拒绝确认，不关闭草图、不弹描述、不入画布', async () => {
    const h = setup();
    await run(hostConfirm, h.context, 'data:image/png;base64,local', [], '640x480');
    expect(h.context.setDrawingBoardOpen).not.toHaveBeenCalled();
    expect(h.context.systemDialog.prompt).not.toHaveBeenCalled();
    expect(h.changes).not.toHaveBeenCalled();
  });
  it('等待草图描述期间切换工作区，二次检查拒绝且保留草图', async () => {
    const h = setup();
    h.context.workspaceReadyRef.current = true;
    let resolvePrompt!: (value: string) => void;
    h.context.systemDialog.prompt = () => new Promise(resolve => { resolvePrompt = resolve; });
    const pending = run(hostConfirm, h.context, 'data:image/png;base64,local', [], '640x480');
    h.context.workspaceIdRef.current = 'stsmk-new-workspace';
    resolvePrompt('保留草图描述');
    await pending;
    expect(h.context.setDrawingBoardOpen).not.toHaveBeenCalled();
    expect(h.changes).not.toHaveBeenCalled();
  });
  it.each([false, true])('宿主传参、按钮 disabled 和真实 handler 保持一致：ready=%s', (value) => {
    const h = setup();
    h.context.workspaceReady = value;
    const evaluate = (node: ts.Node) => vm.runInContext(`(${node.getText()})`, h.context);
    h.context.canSubmit = evaluate(attribute(host, 'canSubmit'));
    expect(h.context.canSubmit).toBe(value);
    expect(evaluate(attribute(confirmButton, 'disabled'))).toBe(!value);
    const exportImage = vi.fn(() => 'data:image/png;base64,local');
    h.context.canvasRef.current = { toDataURL: exportImage };
    h.context.messages = [];
    h.context.canvasDims = { w: 640, h: 480 };
    h.context.onConfirm = vi.fn();
    run(childConfirm, h.context);
    if (value) {
      expect(exportImage).toHaveBeenCalledOnce();
      expect(h.context.onConfirm).toHaveBeenCalledWith('data:image/png;base64,local', [], '640x480');
    } else {
      expect(exportImage).not.toHaveBeenCalled();
      expect(h.context.onConfirm).not.toHaveBeenCalled();
    }
  });
});

describe('提交、草稿与既有上传保护', () => {
  for (const name of ['onSendRich', 'onSendQuick'] as const) {
    it(`${name}：恢复前拒绝，不清空草稿，不发送或入队`, async () => {
      const h = setup();
      await run(callback(name), h.context);
      expect(h.context.richComposerRef.current.clear).not.toHaveBeenCalled();
      expect(h.context.setInput).not.toHaveBeenCalled();
      expect(h.context.setQuickInput).not.toHaveBeenCalled();
      expect(h.context.sendText).not.toHaveBeenCalled();
      expect(h.context.pendingJobsRef.current).toHaveLength(0);
    });
  }
  it('统一发送入口恢复前不解析参考图、不入队、不消费模型', async () => {
    const h = setup();
    await run(callback('sendText'), h.context, '正常生成请求');
    expect(h.context.pendingJobsRef.current).toHaveLength(0);
    expect(h.context.drainGenQueue).not.toHaveBeenCalled();
  });
  it('生成器区域恢复前不创建，恢复后可创建并经真实序列化回放', async () => {
    const h = setup();
    const generate = button('图像生成器').callback!;
    run(generate, h.context);
    expect(h.changes).not.toHaveBeenCalled();
    run(boot, h.context);
    await h.restore();
    run(generate, h.context);
    expect(h.context.canvas).toHaveLength(1);
    const snapshot = persistence.canvasToPersistedV1(h.context.canvas).state;
    expect(persistence.persistedV1ToCanvas(snapshot, []).canvas[0].kind).toBe('generator');
    expect(h.context.pendingJobsRef.current).toHaveLength(0);
  });
  it('上传、拖放和图片粘贴共同入口仍在恢复前拒绝，且未消费文件', async () => {
    const h = setup();
    await run(callback('onUploadImages'), h.context, [{ type: 'image/png' }]);
    expect(h.context.showUploadToast).toHaveBeenCalled();
    expect(h.changes).not.toHaveBeenCalled();
  });
  it('删除确认期间切换 owner，不删除新画板或清空选区', async () => {
    const h = setup();
    h.context.workspaceReadyRef.current = true;
    h.context.workspaceReady = true;
    let confirm!: (value: boolean) => void;
    h.context.systemDialog.confirm = () => new Promise(resolve => { confirm = resolve; });
    const pending = run(callback('confirmAndDeleteSelectedKeys'), h.context, ['old-shape']);
    h.context.workspaceIdRef.current = 'stsmk-new-workspace';
    confirm(true);
    await pending;
    expect(h.changes).not.toHaveBeenCalled();
    expect(h.context.clearSelectionWithChips).not.toHaveBeenCalled();
  });
  it.each(['形状', '文字', '图像生成器', '发送'])('%s 的 UI 禁用条件绑定同一 workspaceReady', (name) => {
    const attributes = button(name, false).node.openingElement.attributes.properties;
    const disabled = attributes.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'disabled');
    expect(disabled?.getText(ast)).toContain('!workspaceReady');
  });
});
