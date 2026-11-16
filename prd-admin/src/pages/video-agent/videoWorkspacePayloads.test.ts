import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as pageExports from './VideoAgentPage';
import { calculateVideoRunSpentCost } from './VideoStoryboardEditor';

// 执行真实异步读取回调；只替代 HTTP 与 React setter，不复制读取/归一算法。
function callback(file: string, name: string, scope: Record<string, unknown>) {
  const source = ts.createSourceFile(file, readFileSync(resolve(__dirname, file), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found.push(node); ts.forEachChild(node, visit); };
  visit(source);
  const expression = found[0]?.initializer;
  if (found.length !== 1 || !expression || !ts.isCallExpression(expression) || !expression.arguments[0]) throw new Error('读取入口不唯一 '+name);
  return runInNewContext(ts.transpileModule('(' + expression.arguments[0].getText(source) + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, scope) as () => Promise<void>;
}

describe('视频工作台成功响应的缺省集合', () => {
  it('项目、任务和模型省略列表时实际读取入口保持空集合可渲染', async () => {
    const setProjects = vi.fn(), setRuns = vi.fn(), setModels = vi.fn(), error = vi.fn();
    const load = callback('VideoAgentPage.tsx', 'loadWorkspace', { ...pageExports,
      listVideoProjectsReal: async () => ({ success: true, data: undefined }),
      listVideoGenRunsReal: async () => ({ success: true, data: null }),
      listVideoModelsReal: async () => ({ success: true, data: {} }),
      setProjects, setRuns, setModels, setSelectedProjectId: (update: (id: null) => unknown) => update(null),
      toast: { error }, setLoading: vi.fn(),
    });
    await load();
    expect(setProjects).toHaveBeenLastCalledWith([]);
    expect(setRuns).toHaveBeenLastCalledWith([]);
    expect(setModels).toHaveBeenLastCalledWith([]);
    expect(error).not.toHaveBeenCalled();
  });

  async function loadedRun(scenes: unknown) {
    const setRun = vi.fn(), setError = vi.fn();
    const load = callback('VideoStoryboardEditor.tsx', 'loadRun', {
      runId: 'existing-synthetic', getVideoGenRunReal: async () => ({ success: true, data: { id: 'existing-synthetic', status: 'Editing', scenes } }),
      setRun, setError, markServerSignal: vi.fn(),
      setSelectedSceneIndex: (update: (current: number) => unknown) => update(3),
      shouldKeepVideoRunPolling: () => false, keepPollingUntilRef: { current: 0 },
      startPolling: vi.fn(), stopPolling: vi.fn(), autoSelectedExportRef: { current: false }, setPreviewMode: vi.fn(),
    });
    await load();
    return { run: setRun.mock.calls[0]?.[0], setError };
  }
  it('读取已有任务缺少分镜时不因长度计算中断恢复', async () => {
    const { run, setError } = await loadedRun(null);
    expect(run.scenes).toEqual([]);
    expect(setError).toHaveBeenLastCalledWith(null);
  });
  it('旧分镜省略版本列表时原成本消费者仍能读取当前成本', async () => {
    const { run, setError } = await loadedRun([{ index: 0, status: 'Done', cost: 0.25 }]);
    expect(run.scenes[0].versions).toEqual([]);
    expect(calculateVideoRunSpentCost(run.scenes)).toBe(0.25);
    expect(setError).toHaveBeenLastCalledWith(null);
  });
});
