/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionDetailPanel } from './ExecutionDetailPanel';
import { ArtifactPreviewModal } from './ArtifactPreviewModal';
import type { ExecutionArtifact } from '@/services/contracts/workflowAgent';

const state = vi.hoisted(() => ({
  selectedExecution: { id: 'existing-execution', workflowId: 'workflow', workflowName: '已有报告', status: 'running',
    nodeExecutions: [], nodeSnapshot: [], edgeSnapshot: [], finalArtifacts: [], variables: {},
    createdAt: '2026-11-05T00:00:00Z', triggerType: 'manual', triggeredBy: 'owner' },
  setViewMode: vi.fn(), setSelectedExecution: vi.fn(), loadExecution: vi.fn(),
}));
const calls = vi.hoisted(() => ({ urls: [] as string[], business: vi.fn(), download: vi.fn(async () => ({ blob: new Blob(['zip']), fileName: '报告.zip' })), emit: undefined as undefined | ((event: { id: string; event: string; data: string }) => void) }));
vi.mock('@/stores/workflowStore', () => ({ useWorkflowStore: Object.assign(() => state, { getState: () => state }) }));
vi.mock('@/services', () => ({
  getExecution: vi.fn(async () => ({ success: true, data: { execution: state.selectedExecution } })),
  getNodeLogs: vi.fn(async () => ({ success: true, data: { logs: '', artifacts: [] } })),
  resumeFromNode: calls.business, cancelExecution: calls.business, continueExecution: calls.business,
  rejectApproval: calls.business, createShareLink: calls.business,
}));
vi.mock('@/lib/useSseStream', () => ({ connectSse: vi.fn(async (options: {
  url: string; signal: AbortSignal; onEvent: (event: { id: string; event: string; data: string }) => void;
}) => {
  calls.urls.push(options.url); calls.emit = options.onEvent;
  options.onEvent({ id: calls.urls.length === 1 ? '5' : '6', event: 'node-design-progress', data: JSON.stringify({
    nodeId: 'report', nodeName: '已有报告', designRunId: 'same-design-run', phase: calls.urls.length === 1 ? '正在搭建页面' : '正在自查',
    progress: 70, elapsedSeconds: 12, status: 'Running', model: 'observed-model', platform: 'observed-platform',
  }) });
  if (calls.urls.length === 1) return { success: false, errorCode: 'NETWORK_ERROR' };
  await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
  return { success: true };
}) }));
vi.mock('@/services/real/apiClient', () => ({ apiDownload: calls.download }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span aria-label="处理中" /> }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  calls.urls.length = 0; calls.business.mockClear(); calls.download.mockClear(); calls.emit = undefined;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test-download') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe('工作流设计进度与完整版本预览', () => {
  it('只重连带序号的同一观察流，显示真实设计阶段而不重发业务', async () => {
    await act(async () => root.render(<ExecutionDetailPanel />));
    expect(container.textContent).toContain('已有报告 · OpenDesign');
    expect(container.textContent).toContain('正在搭建页面 · 70%');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    expect(calls.urls).toHaveLength(2);
    expect(calls.urls[1]).toContain('existing-execution/stream?afterSeq=5');
    expect(container.textContent).toContain('正在自查 · 70%');
    expect(container.textContent).toContain('observed-model · observed-platform');
    expect(container.textContent).not.toContain('chars');
    const designPanel = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('已有报告 · OpenDesign'))!.parentElement!;
    expect(designPanel.querySelector('.animate-pulse')).not.toBeNull();
    await act(async () => calls.emit?.({ id: '7', event: 'node-design-progress', data: JSON.stringify({
      nodeId: 'report', nodeName: '已有报告', phase: '设计完成', progress: 100, elapsedSeconds: 13, status: 'Done',
    }) }));
    expect(designPanel.querySelector('.animate-pulse')).toBeNull();
    await act(async () => calls.emit?.({ id: '8', event: 'execution-completed', data: JSON.stringify({
      status: 'completed', completedNodes: 1, failedNodes: 0, skippedNodes: 0,
    }) }));
    expect(Array.from(container.querySelectorAll('span')).some(span => span.textContent === '执行完成')).toBe(true);
    const elapsed = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('已有报告 · OpenDesign'))!;
    expect(elapsed.textContent).toContain('13.0s');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
    expect(elapsed.textContent).toContain('13.0s');
    expect(calls.urls).toHaveLength(2);
    expect(calls.business).not.toHaveBeenCalled();
  });

  it('整包使用准确版本URL保留相对资源基址，旧内联报告和sandbox不变', async () => {
    const artifact: ExecutionArtifact = { artifactId: 'output', name: '报告.html', mimeType: 'text/html', sizeBytes: 80,
      inlineContent: '<!doctype html><html><body>已有报告</body></html>',
      designDelivery: { runId: 'same-design-run', siteId: 'site', revisionId: 'revision',
        url: 'https://assets.example.test/site/.versions/version/index.html?v=1', packageHash: 'a'.repeat(64), fileCount: 4 } };
    Object.assign(artifact.designDelivery!, { downloadPath: '/api/workflow-agent/artifacts/same-design-run/package' });
    await act(async () => root.render(<ArtifactPreviewModal artifact={artifact} onClose={() => undefined} />));
    const frame = container.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe(artifact.designDelivery?.url);
    expect(frame?.hasAttribute('srcdoc')).toBe(false);
    expect(frame?.getAttribute('sandbox')).toBe('');
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="下载文件"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(calls.download).toHaveBeenCalledWith('/api/workflow-agent/artifacts/same-design-run/package', '报告.zip');
    await act(async () => root.render(<ArtifactPreviewModal artifact={{ ...artifact, designDelivery: undefined }} onClose={() => undefined} />));
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toBe(artifact.inlineContent);
    expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('');
  });
});
