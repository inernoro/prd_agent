import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { resolveImageRefs } from '../imageRefResolver';
import { serializeImageReferenceMessage } from '../chipTokenText';
import { parseVisualMessageDisplay } from '../visualMessageDisplay';

// AST 只定位实际队列/消费入口，模型、存储和重试均执行生产表达式。
const source = ts.createSourceFile('AdvancedVisualAgentTab.tsx',
  readFileSync(resolve(__dirname, '../../pages/ai-chat/AdvancedVisualAgentTab.tsx'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function unique(predicate: (node: ts.Node) => boolean): ts.Node {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) nodes.push(node); ts.forEachChild(node, visit); };
  visit(source);
  if (nodes.length !== 1) throw new Error(`生产入口必须唯一，实际 ${nodes.length}`);
  return nodes[0]!;
}
function variable(name: string) {
  const node = unique(n => ts.isVariableDeclaration(n) && n.name.getText(source) === name) as ts.VariableDeclaration;
  if (!node.initializer) throw new Error(`缺少生产表达式 ${name}`);
  return node.initializer;
}
function evaluate<T>(node: ts.Node, scope: Record<string, unknown>): T {
  return runInNewContext(ts.transpileModule('(' + node.getText(source) + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, scope) as T;
}
function queuedTexts() {
  const resolveResult = resolveImageRefs({ rawText: '@img7 保持构图',
    canvas: [{ key: 'original', refId: 7, src: 'https://example.com/original.png', label: '原参考图' }] });
  const jobNode = unique(n => ts.isVariableDeclaration(n) && n.name.getText(source) === 'job'
    && n.type?.getText(source) === 'GenJob') as ts.VariableDeclaration;
  if (!jobNode.initializer) throw new Error('缺少真实队列构造');
  return evaluate<{ displayText: string; messageText?: string; requestText: string }>(jobNode.initializer, {
    resolveResult, serializeImageReferenceMessage, requestText: '模型专用请求', imageRefs: [],
    seedSelectedKey: '', sizeOverride: null,
  });
}

describe('队列消息快照与模型及重试输入分离', () => {
  it('直连澄清读取普通引用，持久消息仍保留稳定图片身份', () => {
    const job = queuedTexts();
    const forced = evaluate<{ clean: string }>(variable('forcedPick'), {
      directPrompt: true, displayText: job.displayText, requestText: job.requestText,
      extractForcedImageModel: (clean: string) => ({ clean }),
    });
    expect(forced.clean).toBe('@img7 保持构图');
    const runFromText = vi.fn(async () => {});
    const drain = evaluate<() => void>(variable('drainGenQueue'), {
      runningCountRef: { current: 0 }, pendingJobsRef: { current: [job] }, MAX_GEN_CONCURRENCY: 3,
      setPendingCount: vi.fn(), setRunningCount: vi.fn(), setBusy: vi.fn(),
      runFromText, drainGenQueue: vi.fn(),
    });
    drain();
    expect(runFromText).toHaveBeenCalledWith(job.displayText, job.requestText, [], '', null, job.messageText);
    const stored = evaluate<string>(variable('displayForMsg'), {
      messageText: job.messageText, display: job.displayText, imageRefs: [], reqText: forced.clean,
      parseVisualMessageDisplay,
    });
    expect(stored).toContain('[@image:#7:original:');
    expect(stored).not.toContain('模型专用请求');
  });

  it('实际重试以 SHA 找到新画板身份，不被旧消息快照键拦截', () => {
    const job = queuedTexts();
    const prompt = evaluate<string>(variable('displayPrompt'), {
      display: job.displayText, reqText: job.requestText, stripModelMention: (text: string) => text,
      parseVisualMessageDisplay,
    });
    const sha = 'a'.repeat(64);
    const canvas = [{ key: 'reuploaded', refId: 12, src: 'https://example.com/original.png', label: '重传参考图', sha256: sha }];
    const sendText = vi.fn((rawText: string, opts: { chipRefs: { refId: number; canvasKey: string }[] }) =>
      resolveImageRefs({ rawText, chipRefs: opts.chipRefs, canvas }));
    const assignment = unique(n => ts.isBinaryExpression(n) && n.left.getText(source) === 'retryRef.current') as ts.BinaryExpression;
    const retry = evaluate<(p: string, shas: string[], items: typeof canvas) => void>(assignment.right,
      { sendText, toast: { error: vi.fn() } });
    retry(prompt, [sha], canvas);
    expect(sendText).toHaveBeenCalledOnce();
    const result = sendText.mock.results[0]!.value as ReturnType<typeof resolveImageRefs>;
    expect(result.ok).toBe(true);
    expect(result.cleanText).toBe('@img12 保持构图');
    expect(result.refs.map(ref => ref.canvasKey)).toEqual(['reuploaded']);
  });
});

describe('图片复制占位符的发送契约', () => {
  const canvas = [{ key: 'original', refId: 7, src: 'https://example.com/original.png', label: '蓝色参考' }];
  it('编辑器中的旧编号按稳定身份更新，不与模型收到的编号分裂', () => {
    const result = resolveImageRefs({ rawText: '@img1 保持构图', chipRefs: [{ canvasKey: 'original', refId: 1 }], canvas });
    expect(result.ok).toBe(true);
    expect(result.cleanText).toBe('@img7 保持构图');
    expect(result.refs.map(ref => ref.refId)).toEqual([7]);
  });

  it('按图片身份恢复引用，并使用当前编号构造模型请求', () => {
    const result = resolveImageRefs({ rawText: '让 [@image:#1:original:https://example.com/original.png] 变为水彩', canvas });
    expect(result.ok).toBe(true);
    expect(result.refs).toHaveLength(1);
    expect(result.refs[0].canvasKey).toBe('original');
    expect(result.cleanText).toBe('让 @img7 变为水彩');
  });

  it('便携占位符与编号已变化的卡片混用时不会二次改绑图片', () => {
    const result = resolveImageRefs({
      rawText: '[@image:#2:second:https://example.com/second.png] 与 @img1 保持构图',
      chipRefs: [{ canvasKey: 'original', refId: 1 }],
      canvas: [...canvas, { key: 'second', refId: 1, src: 'https://example.com/second.png', label: '第二张参考' }],
    });
    expect(result.ok).toBe(true);
    expect(result.cleanText).toBe('@img1 与 @img7 保持构图');
    expect(result.refs.map(ref => ref.canvasKey)).toEqual(['original', 'second']);
  });

  it('失效复制引用阻止生成，保留输入并明确恢复动作', () => {
    const result = resolveImageRefs({ rawText: '[@image:#1:removed:https://example.com/removed.png] 保持构图', canvas });
    expect(result.ok).toBe(false);
    expect(result.errors.join('')).toMatch(/重新选择/);
    expect(result.refs).toHaveLength(0);
  });

  it('失效编辑器卡片不会被当前选中图片偷偷替换', () => {
    const result = resolveImageRefs({ rawText: '@img1 保持构图', chipRefs: [{ canvasKey: 'removed', refId: 1 }], selectedKeys: ['original'], canvas });
    expect(result.ok).toBe(false);
    expect(result.refs).toHaveLength(0);
  });
});
