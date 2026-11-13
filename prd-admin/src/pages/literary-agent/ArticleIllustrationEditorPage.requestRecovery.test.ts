import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { buildLiteraryModelOptions, selectFreshLiteraryModel } from './literaryModelOptions';
import { ok, fail, type ApiResponse } from '@/types/api';
import { fitLiteraryImageSize, imageRunFailure } from './literaryImageRunContract';

const source = ts.createSourceFile('page.tsx', readFileSync(path.resolve(__dirname, 'ArticleIllustrationEditorPage.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function actual(name: string) {
  let result: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) result = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!result) throw new Error(name);
  return ts.transpileModule('(' + result.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
function harness(found: boolean) {
  const pool = { id: 'role', code: 'image-quality', isDefault: true, models: [{ modelId: 'image-quality', actualModelId: 'new-image', platformId: 'logical-model', healthStatus: 'Healthy' }] };
  const items = { current: [{ markerIndex: 0, markerText: '合成描述', draftText: '合成描述', status: 'error', planItem: { prompt: '合成描述', count: 1, size: '1024x1024' }, url: 'https://example.test/old.png', assetUrl: 'https://example.test/old.png' }] as Array<Record<string, unknown>> };
  const create = vi.fn(async (input: unknown): Promise<ApiResponse<{runId: string}>> => { void input; return fail('NETWORK_ERROR', '应答丢失'); });
  const lookup = vi.fn(async (): Promise<ApiResponse<{runId: string}>> => found ? ok({ runId: 'original-run' }) : fail('UNKNOWN', '原请求未确认'));
  const patch = vi.fn(async (input: unknown) => { void input; return { success: true }; });
  const stream = vi.fn(async ({ onEvent }: { onEvent: (event: unknown) => void }) => {
    onEvent({ data: JSON.stringify({ type: 'imageDone', runId: 'original-run', url: 'https://example.test/new.png' }) });
    return { success: true };
  });
  const scope: Record<string, unknown> = {
    imageGenModel: { modelName: 'image-quality' }, imageCapabilitiesModel: 'image-quality',
    effectiveModel: { modelName: 'image-quality' }, workspaceId: 'synthetic-workspace',
    markerRunItemsRef: items, genAbortRef: { current: new AbortController() }, modelMigrationNoticeRef: { current: null },
    setMarkerRunItems: (change: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>) => { items.current = change(items.current); },
    updateMarkerStatus: patch, updateArticleMarker: patch,
    getLiteraryAgentModels: vi.fn(async () => ({ success: true, data: [pool] })),
    getLiteraryAgentAdapterInfo: vi.fn(async () => ({ success: true, data: { matched: true, sizesByResolution: { '1k': [{ size: '1024x1024', aspectRatio: '1:1' }] } } })),
    setImageGenPools: vi.fn(), setImageModelPrefId: vi.fn(), buildLiteraryModelOptions, selectFreshLiteraryModel,
    fitLiteraryImageSize, imageRunFailure, parseSizeFromText: () => null,
    createLiteraryAgentImageGenRun: create, getLiteraryAgentRunByRequest: lookup,
    streamLiteraryAgentImageGenRunWithRetry: stream, safeJsonParse: JSON.parse,
    toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() }, AbortController,
  };
  scope.observeMarkerRun = runInNewContext(actual('observeMarkerRun'), scope);
  const run = runInNewContext(actual('runSingleMarker'), scope) as (index: number) => Promise<string>;
  return { items, run, create, lookup, stream, patch };
}

describe('文学创建任务应答丢失的真实页面路径', () => {
  it('用户恢复尚未入库的请求时复用原幂等标识，首轮不会自行重发', async () => {
    const h = harness(false);
    h.lookup.mockResolvedValue(fail('IMAGE_GEN_REQUEST_PENDING', '尚未入库'));
    expect(await h.run(0)).toBe('pending');
    expect(h.create).toHaveBeenCalledOnce();
    const firstKey = (h.create.mock.calls[0][0] as { idempotencyKey: string }).idempotencyKey;
    h.create.mockResolvedValueOnce(ok({ runId: 'original-run' }));
    expect(await h.run(0)).toBe('completed');
    expect(h.create).toHaveBeenCalledTimes(2);
    expect((h.create.mock.calls[1][0] as { idempotencyKey: string }).idempotencyKey).toBe(firstKey);
  });

  it('只提交一次；按原请求查回 runId 后观察原任务并回填图片', async () => {
    const h = harness(true);
    expect(await h.run(0)).toBe('completed');
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.lookup).toHaveBeenCalledOnce();
    expect(h.stream.mock.calls[0][0]).toMatchObject({ runId: 'original-run' });
    expect(h.items.current[0]).toMatchObject({ status: 'done', url: 'https://example.test/new.png' });
    const intentIndex = h.patch.mock.calls.findIndex(call => (call[0] as Record<string, unknown>)?.generationRequestId);
    expect(intentIndex).toBeGreaterThanOrEqual(0);
    expect(h.patch.mock.invocationCallOrder[intentIndex]).toBeLessThan(h.create.mock.invocationCallOrder[0]!);
  });

  it('查不到原任务时保持待确认、保留旧图；再次检查只读查询而不重新创建', async () => {
    const h = harness(false);
    expect(await h.run(0)).toBe('pending');
    expect(h.items.current[0]).toMatchObject({ status: 'running', url: 'https://example.test/old.png' });
    expect(h.items.current[0].generationRequestId).toBeTruthy();
    expect(await h.run(0)).toBe('pending');
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.lookup).toHaveBeenCalledTimes(2);
    expect(h.stream).not.toHaveBeenCalled();
  });
});
