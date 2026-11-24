// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiterarySettingSave } from './useLiterarySettingSave';
import { toast } from '@/lib/toast';

vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// 执行页面中实际传给保存 hook 的参数，避免只测辅助函数却漏掉真实 API 接线。
const source = ts.createSourceFile('ArticleIllustrationEditorPage.tsx',
  readFileSync(path.resolve(__dirname, 'ArticleIllustrationEditorPage.tsx'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function actualOptions(name: string, scope: Record<string, unknown>) {
  const found: ts.Expression[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name
      && node.initializer && ts.isCallExpression(node.initializer)) found.push(node.initializer.arguments[0]!);
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(found).toHaveLength(1);
  return runInNewContext(ts.transpileModule(`(${found[0].getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, scope);
}

describe('文学创作设置保存及恢复', () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useLiterarySettingSave<unknown>>;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  function Harness(props: Parameters<typeof useLiterarySettingSave<unknown>>[0]) {
    current = useLiterarySettingSave(props);
    return <div>{current.saving ? '保存中' : current.error ?? '就绪'}</div>;
  }
  const render = async (props: Parameters<typeof Harness>[0]) => {
    await act(async () => root.render(<Harness {...props} />));
  };

  it('服务端确认之前保持原值，成功之后才提交新设置', async () => {
    const response = deferred<{ success: boolean }>();
    const saved = vi.fn(), save = vi.fn(() => response.promise);
    await render({ scopeKey: 'workspace-a', save, onSaved: saved, errorMessage: '保存失败' });
    expect(save).not.toHaveBeenCalled();
    let pending!: Promise<boolean>;
    await act(async () => { pending = current.run('new-id'); });
    expect(current.saving).toBe(true);
    expect(saved).not.toHaveBeenCalled();
    await act(async () => { response.resolve({ success: true }); expect(await pending).toBe(true); });
    expect(saved).toHaveBeenCalledWith('new-id');
    expect(current.saving).toBe(false);
    expect(current.error).toBeNull();
  });

  it.each(['business', 'network'])('%s失败可见、保留原值，重试仍使用同一选择且可恢复', async kind => {
    const save = vi.fn().mockResolvedValueOnce({ success: false }).mockResolvedValue({ success: true });
    if (kind === 'network') save.mockReset().mockRejectedValueOnce(new Error('private upstream detail')).mockResolvedValue({ success: true });
    const saved = vi.fn();
    await render({ scopeKey: 'workspace-a', save, onSaved: saved, errorMessage: '提示词风格保存失败' });
    await act(async () => { expect(await current.run(null)).toBe(false); });
    expect(saved).not.toHaveBeenCalled();
    expect(current.error).toBe('提示词风格保存失败');
    expect(toast.error).toHaveBeenCalledWith('提示词风格保存失败', '当前设置保持不变，请重试');
    await act(async () => { expect(await current.retry()).toBe(true); });
    expect(save.mock.calls).toEqual([[null], [null]]);
    expect(saved).toHaveBeenCalledOnce();
    expect(saved).toHaveBeenCalledWith(null);
    expect(current.error).toBeNull();
  });

  it('同一次保存未完成时不发送第二次选择，避免请求乱序覆盖', async () => {
    const response = deferred<{ success: boolean }>(), save = vi.fn(() => response.promise);
    await render({ scopeKey: 'user-a', save, onSaved: vi.fn(), errorMessage: '模型设置保存失败' });
    let pending!: Promise<boolean>;
    await act(async () => { pending = current.run('pool-a'); expect(await current.run('pool-b')).toBe(false); });
    expect(save).toHaveBeenCalledOnce();
    await act(async () => { response.resolve({ success: true }); await pending; });
  });

  it.each([true, false])('切换工作区后忽略旧保存响应（success=%s），新工作区仍可保存', async success => {
    const oldResponse = deferred<{ success: boolean }>(), oldSaved = vi.fn(), newSaved = vi.fn();
    await render({ scopeKey: 'workspace-a', save: () => oldResponse.promise, onSaved: oldSaved, errorMessage: '保存失败' });
    let oldPending!: Promise<boolean>;
    await act(async () => { oldPending = current.run('old-selection'); });
    await render({ scopeKey: 'workspace-b', save: async () => ({ success: true }), onSaved: newSaved, errorMessage: '保存失败' });
    await act(async () => { expect(await current.run('new-selection')).toBe(true); });
    await act(async () => { oldResponse.resolve({ success }); expect(await oldPending).toBe(false); });
    expect(oldSaved).not.toHaveBeenCalled();
    expect(newSaved).toHaveBeenCalledWith('new-selection');
    expect(toast.error).not.toHaveBeenCalled();
    expect(current.error).toBeNull();
  });

  it('离开页面后不再提交迟到的保存结果或提示错误', async () => {
    const response = deferred<{ success: boolean }>(), saved = vi.fn();
    await render({ scopeKey: 'workspace-a', save: () => response.promise, onSaved: saved, errorMessage: '保存失败' });
    let pending!: Promise<boolean>;
    await act(async () => { pending = current.run('id'); });
    await act(async () => root.render(null));
    await act(async () => { response.reject(new Error('timeout')); expect(await pending).toBe(false); });
    expect(saved).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('页面模型保存发送原始两个选项 ID，确认成功后更新两处选择', async () => {
    const save = vi.fn(async () => ({ success: true })), image = vi.fn(), chat = vi.fn();
    await render(actualOptions('modelSettingSave', {
      userId: 'user-a', updateLiteraryAgentPreferences: save, setImageModelPrefId: image, setChatModelPrefId: chat,
      literaryPreferencesRef: { current: { anchorTutorialSeen: true } },
    }));
    await act(async () => { await current.run({ imageModelId: 'pool-image-logical', chatModelId: 'pool-chat-logical' }); });
    expect(save).toHaveBeenCalledWith({ imageModelId: 'pool-image-logical', chatModelId: 'pool-chat-logical', anchorTutorialSeen: true });
    expect(image).toHaveBeenCalledWith('pool-image-logical');
    expect(chat).toHaveBeenCalledWith('pool-chat-logical');
  });

  it.each([{ id: 'private-prompt' }, null])('页面提示词保存使用工作区 ID，自动推断以空 ID 清除原选择：%s', async prompt => {
    const save = vi.fn(async () => ({ success: true })), saved = vi.fn();
    await render(actualOptions('promptSettingSave', {
      workspaceId: 'workspace-a', updateVisualAgentWorkspace: save, setSelectedPromptRaw: saved,
    }));
    await act(async () => { await current.run(prompt); });
    expect(save).toHaveBeenCalledWith({ id: 'workspace-a', selectedPromptId: prompt?.id ?? '' });
    expect(saved).toHaveBeenCalledWith(prompt);
  });
});
