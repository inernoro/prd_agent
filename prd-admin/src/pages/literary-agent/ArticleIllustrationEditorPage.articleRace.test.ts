import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// 从页面源码执行实际回调和状态推导，避免在测试中复制页面逻辑。
const source = ts.createSourceFile('ArticleIllustrationEditorPage.tsx',
  readFileSync(path.resolve(__dirname, 'ArticleIllustrationEditorPage.tsx'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function actual(name: string) {
  const found: ts.Node[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node);
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
      found.push(ts.isCallExpression(node.initializer) ? node.initializer.arguments[0]! : node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(source); expect(found).toHaveLength(1);
  return ts.transpileModule('(' + found[0]!.getText(source) + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function harness() {
  const state = { article: '', phase: 0, uploaded: '', markers: [] as unknown[], withMarkers: '', withImages: '', restored: false };
  const response = deferred<unknown>();
  const getDetail = vi.fn(() => response.promise), save = vi.fn(async () => ({ success: true }));
  const prompts = vi.fn(async () => {}), choice = vi.fn();
  const pendingPrompt = { current: null as string | null };
  const scope = {
    workspaceId: 'synthetic-workspace', articleMutationVersionRef: { current: 0 },
    getVisualAgentWorkspaceDetail: getDetail, updateVisualAgentWorkspace: save,
    setArticleContent: (value: string) => { state.article = value; },
    setArticleWithMarkers: (value: string) => { state.withMarkers = value; },
    setArticleWithImages: (value: string) => { state.withImages = value; },
    setPhase: (value: number) => { state.phase = value; },
    setUploadedFileName: (value: string) => { state.uploaded = value; },
    setMarkers: (value: unknown[]) => { state.markers = value; },
    setArticleChoice: choice, autoSubmitSuppressedRef: { current: false },
    setAutoSubmitSuppressed: vi.fn(), setAutoSubmitEnabled: vi.fn(),
    extractMarkers: () => [{ index: 0, text: '旧位置' }],
    setMarkerRunItems: vi.fn(), setMarkerRunItemsRestored: (value: boolean) => { state.restored = value; },
    restoredRunningRef: { current: new Set() }, getImageGenRun: vi.fn(),
    pendingSelectedPromptIdRef: pendingPrompt, loadLiteraryPrompts: prompts,
    toast: { error: vi.fn(), warning: vi.fn() }, setIsDragging: vi.fn(), fileInputRef: { current: { value: 'old' } },
  };
  const load = runInNewContext(actual('loadWorkspace'), scope) as () => Promise<void>;
  const fileUpload = runInNewContext(actual('handleFileUpload'), scope) as (event: unknown) => Promise<void>;
  const drop = runInNewContext(actual('handleDrop'), scope) as (event: unknown) => Promise<void>;
  const detail = (article = '旧文章') => ({ success: true, data: { workspace: {
    articleContent: article, articleContentWithMarkers: '旧配图文本', selectedPromptId: 'existing-prompt',
    articleWorkflow: { phase: 2, markers: [] },
  }, illustrationChoice: 'server-choice' } });
  const upload = (kind: 'file' | 'drop', text: () => Promise<string> = async () => '新上传文章') => {
    const file = { name: '合成文章.md', text };
    return kind === 'file' ? fileUpload({ target: { files: [file] } })
      : drop({ dataTransfer: { files: [file] }, preventDefault: vi.fn(), stopPropagation: vi.fn() });
  };
  return { state, response, load, upload, detail, getDetail, save, prompts, choice, pendingPrompt, scope };
}

describe('文章上传与迟到工作区响应', () => {
  it.each(['file', 'drop'] as const)('%s上传成功后，旧详情不能覆盖正文和工作流阶段，提示词配置仍恢复', async kind => {
    const h = harness(), loading = h.load();
    await h.upload(kind);
    expect(h.state.article).toBe('新上传文章');
    h.response.resolve(h.detail()); await loading;
    expect(h.state.article).toBe('新上传文章');
    expect(h.state.phase).toBe(1);
    expect(h.state.uploaded).toBe('合成文章.md');
    expect(h.state.withMarkers).toBe('');
    expect(h.state.markers).toEqual([]);
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.prompts).toHaveBeenCalledOnce();
    expect(h.pendingPrompt.current).toBe('existing-prompt');
    expect(h.choice).toHaveBeenCalledWith('server-choice');
    expect(h.scope.getImageGenRun).not.toHaveBeenCalled();
  });

  it('没有新上传时正常恢复服务端正文和工作流', async () => {
    const h = harness(), loading = h.load(); h.response.resolve(h.detail()); await loading;
    expect(h.state.article).toBe('旧文章'); expect(h.state.phase).toBe(2);
    expect(h.state.withMarkers).toBe('旧配图文本');
    expect(h.prompts).toHaveBeenCalledOnce(); expect(h.save).not.toHaveBeenCalled();
  });

  it('上传之后主动再次读取可以恢复选中的历史版本，不永久冻结文章', async () => {
    const h = harness(), loading = h.load(); await h.upload('file');
    h.response.resolve(h.detail()); await loading;
    h.getDetail.mockResolvedValueOnce(h.detail('主动恢复文章')); await h.load();
    expect(h.state.article).toBe('主动恢复文章'); expect(h.state.phase).toBe(2);
  });

  it('读取文件失败不阻止正常详情恢复，也不提交文章保存', async () => {
    const h = harness(), loading = h.load();
    await h.upload('file', async () => { throw new Error('合成读取失败'); });
    h.response.resolve(h.detail()); await loading;
    expect(h.state.article).toBe('旧文章'); expect(h.save).not.toHaveBeenCalled();
    expect(h.scope.toast.error).toHaveBeenCalledWith('文件读取失败');
  });
});

describe('打开存量文章时恢复插图位置', () => {
  it.each([
    ['auto', '原文一\r\n [IMG]\r\n\r\n原文二\r\n【插图位置】', 'user-anchor'],
    ['auto', '正文提到 [IMG]，但没有独立一行的锚点。', 'auto'],
    ['per-h1', '# 标题\n\n[IMG]', 'per-h1'],
    ['per-h2', '## 小标题\n\n[配图]', 'per-h2'],
  ])('%s 策略打开「%s」时恢复为 %s', async (selectedPositionStrategy, article, expected) => {
    const h = harness();
    const loading = h.load();
    h.response.resolve(h.detail(article));
    await loading;
    const USER_ANCHOR_LINE_REGEX = runInNewContext(actual('USER_ANCHOR_LINE_REGEX'));
    const isAnchorParagraph = runInNewContext(actual('isAnchorParagraph'), { USER_ANCHOR_LINE_REGEX });
    const paragraphRanges = runInNewContext(actual('paragraphRanges'), { isAnchorParagraph });
    const splitParagraphs = runInNewContext(actual('splitParagraphs'), { paragraphRanges });
    const previewParagraphs = splitParagraphs(h.state.article);
    const userAnchorCount = runInNewContext(actual('userAnchorCount'), { previewParagraphs, isAnchorParagraph });

    expect(runInNewContext(actual('positionStrategy'), { selectedPositionStrategy, userAnchorCount })).toBe(expected);
  });
});
