/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkflowCanvas } from './WorkflowCanvas';
import type { Workflow, WorkflowExecution } from '@/services/contracts/workflowAgent';

const api = vi.hoisted(() => ({ execution: null as WorkflowExecution | null, phase: '正在搭建页面', progress: 70,
  late: null as null | (() => void), defer: false, execute: vi.fn(), replay: vi.fn(), cancel: vi.fn(), get: vi.fn(), design: vi.fn() }));
const node = { nodeId: 'report', name: '已有报告', nodeType: 'webpage-generator', config: { instruction: '原要求' }, inputSlots: [], outputSlots: [] };
const workflow: Workflow = { id: 'workflow', name: '已有工作流', nodes: [node], edges: [], tags: [], variables: [], triggers: [],
  isEnabled: true, executionCount: 1, createdBy: 'owner', createdAt: '', updatedAt: '' };
const execution: WorkflowExecution = { id: 'existing-execution', workflowId: workflow.id, workflowName: workflow.name, status: 'running',
  nodeSnapshot: [node], edgeSnapshot: [], nodeExecutions: [{ nodeId: node.nodeId, nodeName: node.name, nodeType: node.nodeType,
    status: 'running', designRunId: 'same-design-run', attemptCount: 1, inputArtifactRefs: [], inputArtifacts: [], outputArtifacts: [] }],
  variables: {}, finalArtifacts: [], shareLinkIds: [], lastSeq: 0, triggerType: 'manual', triggeredBy: 'owner', createdAt: '' };
vi.mock('@/services', () => ({
  listCapsuleTypes: async () => ({ success: true, error: null, data: { items: [{ typeKey: 'webpage-generator', name: '网页报告',
    icon: 'globe', category: 'ai', accentHue: 200, testable: true, configSchema: [{ key: 'instruction', label: '要求', fieldType: 'textarea', required: false }],
    defaultInputSlots: [], defaultOutputSlots: [] }], categories: [] } }),
  getExecution: (...args: unknown[]) => api.get(...args), executeWorkflow: api.execute, cancelExecution: (...args: unknown[]) => api.cancel(...args),
  updateWorkflow: vi.fn(), testRunCapsule: vi.fn(),
}));
vi.mock('@/services/real/workflowAgent', () => ({ replayNode: api.replay }));
vi.mock('@/services/real/webPages', () => ({ getDesignArtifactRun: (...args: unknown[]) => api.design(...args) }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span aria-label="处理中" /> }));

let root: Root;
let container: HTMLDivElement;
const button = (text: string) => Array.from(container.querySelectorAll('button')).find(x => x.textContent?.trim().startsWith(text))!;
const click = async (element: Element) => { await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true }))); };
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(2500); }); };
const render = async () => { await act(async () => root.render(<MemoryRouter><WorkflowCanvas workflow={workflow} execution={execution} onBack={() => undefined} /></MemoryRouter>)); };
beforeEach(() => {
  vi.useFakeTimers(); Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1; m11 = 1; m41 = 0; m42 = 0; });
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON: () => ({}) });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1200 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
  api.execution = structuredClone(execution); api.phase = '正在搭建页面'; api.progress = 70; api.defer = false; api.late = null;
  api.execute.mockReset(); api.replay.mockReset(); api.get.mockReset(); api.design.mockReset(); api.cancel.mockReset();
  api.get.mockImplementation(async () => ({ success: true, error: null, data: { execution: api.execution } }));
  api.design.mockImplementation(async () => {
    if (api.defer) await new Promise<void>(resolve => { api.late = resolve; });
    return { success: true, error: null, data: { runId: 'same-design-run', status: 'Running', phase: api.phase, progress: api.progress } };
  });
  api.cancel.mockImplementation(async () => { api.execution = { ...api.execution!, status: 'cancelled' }; return { success: true, error: null, data: {} }; });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('真实Canvas打开日志保留配置草稿，只观察同一设计任务并隔离取消后的晚到进度', async () => {
  await render();
  await click(container.querySelector('.react-flow__node[data-id="report"]')!);
  const input = container.querySelector<HTMLTextAreaElement>('.workflow-node-panel textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '未保存的新要求');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(button('日志'));
  expect(container.querySelector('.workflow-log-panel')).not.toBeNull();
  await tick();
  expect(container.querySelector('.workflow-log-panel')?.textContent).toContain('正在搭建页面');
  expect(container.querySelector('.workflow-log-panel')?.textContent).toContain('70%');
  expect(api.design).toHaveBeenCalledWith('same-design-run');
  api.phase = '正在自查'; api.progress = 85; await tick();
  expect(container.querySelector('.workflow-log-panel')?.textContent).toContain('正在自查');
  expect(container.querySelector('.workflow-log-panel')?.textContent).toContain('85%');
  await click(container.querySelector('.react-flow__node[data-id="report"]')!);
  expect(container.querySelector<HTMLTextAreaElement>('.workflow-node-panel textarea')?.value).toBe('未保存的新要求');
  await act(async () => root.unmount()); root = createRoot(container); await render(); await click(button('日志')); await tick();
  expect(api.get).toHaveBeenLastCalledWith('existing-execution');
  api.defer = true; await tick(); await click(button('取消'));
  const reads = api.get.mock.calls.length;
  await act(async () => { api.late?.(); await Promise.resolve(); });
  await tick();
  expect(api.get).toHaveBeenCalledTimes(reads);
  expect(container.querySelector('.workflow-log-panel')?.textContent).not.toContain('正在自查');
  expect(api.execute).not.toHaveBeenCalled(); expect(api.replay).not.toHaveBeenCalled();
  expect(api.cancel).toHaveBeenCalledWith('existing-execution');
  expect(fetch).not.toHaveBeenCalled();
});
