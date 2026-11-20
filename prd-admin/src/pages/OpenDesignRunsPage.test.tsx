// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getDesignRuntimeCapabilities, listOpenDesignRuns, readInformationDeliveryFiles, readOpenDesignRunEvents, type OpenDesignRun } from '@/services/real/webPages';
import OpenDesignRunsPage from './OpenDesignRunsPage';

vi.mock('@/services/real/webPages', () => ({
  getDesignRuntimeCapabilities: vi.fn(), listOpenDesignRuns: vi.fn(), readOpenDesignRunEvents: vi.fn(), readInformationDeliveryFiles: vi.fn(),
}));

const date = '2026-11-20T01:50:00+08:00';
const run: OpenDesignRun = {
  runId: 'run-a', title: '流程教程', sourceSurface: 'knowledge-base', operation: 'generate',
  status: 'Running', phase: '课程还有待确认的问题，等待作者补答', phaseCode: 'preparing-workspace',
  createdAt: date, firstPreviewAt: date, resolvedModel: 'gpt-5.6-sol', resolvedPlatform: 'OpenAI',
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.resetAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(getDesignRuntimeCapabilities).mockResolvedValue({ success: true, data: { defaultRuntime: 'open-design', runtimes: [] }, error: null });
  vi.mocked(readInformationDeliveryFiles).mockResolvedValue({ success: false, error: { code: 'NOT_FOUND', message: '无文件' }, data: null });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('沿原任务深链显示作者等待和实际模型，随后追加服务端事件与完成状态', async () => {
  vi.mocked(listOpenDesignRuns)
    .mockResolvedValueOnce({ success: true, data: { items: [run] }, error: null })
    .mockResolvedValue({ success: true, data: { items: [{ ...run, status: 'Done', phase: '设计产物已完成', deliveryStoreId: 'store-a' }] }, error: null });
  vi.mocked(readOpenDesignRunEvents)
    .mockResolvedValueOnce({ success: true, data: { items: [{ sequence: 1, type: 'phase', phase: run.phase, occurredAt: date }], nextSeq: 1, lastAvailableSeq: 1 }, error: null })
    .mockResolvedValue({ success: true, data: { items: [], nextSeq: 1, lastAvailableSeq: 1 }, error: null });

  await act(async () => root.render(<MemoryRouter initialEntries={['/web-pages/opendesign?run=run-a&store=store-a']}><OpenDesignRunsPage /></MemoryRouter>));
  expect(container.textContent).toContain('等待作者补答');
  expect(container.textContent).toContain('gpt-5.6-sol · OpenAI');
  expect(container.querySelector('a[href="/document-store/store-a/delivery?run=run-a"]')).not.toBeNull();

  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(readOpenDesignRunEvents).toHaveBeenCalledWith('run-a', 1, expect.any(AbortSignal));
  expect(container.textContent).toContain('设计产物已完成');
  expect(container.textContent).toContain('等待作者补答');
  expect(container.querySelector('a[href="/document-store/store-a/delivery/run-a/read"]')).not.toBeNull();
});

it('当前列表没有指定任务时不请求该任务的事件', async () => {
  vi.mocked(listOpenDesignRuns).mockResolvedValue({ success: true, data: { items: [run] }, error: null });
  await act(async () => root.render(<MemoryRouter initialEntries={['/web-pages/opendesign?run=other']}><OpenDesignRunsPage /></MemoryRouter>));
  expect(container.textContent).toContain('当前账号或环境无法访问这条任务');
  expect(readOpenDesignRunEvents).not.toHaveBeenCalled();
});

it('回放已完成的任务时，显示各轮执行的实际镜像和当时的 MAP 版本', async () => {
  const firstCommit = '1'.repeat(40);
  const currentCommit = '2'.repeat(40);
  const firstDigest = 'sha256:' + 'a'.repeat(64);
  const secondDigest = 'sha256:' + 'b'.repeat(64);
  const finished = {
    ...run, status: 'Done', hasDeliveryWorkspace: true,
    deploymentScope: `prd-agent::feature::revision::${currentCommit}`,
    deliveryRuntimeExecutions: [
      { cdsSessionId: 'cds-first', imageDigest: firstDigest, deploymentScope: `prd-agent::feature::revision::${firstCommit}` },
      { cdsSessionId: 'cds-second', imageDigest: secondDigest, deploymentScope: `prd-agent::feature::revision::${currentCommit}` },
    ],
  };
  vi.mocked(listOpenDesignRuns).mockResolvedValue({ success: true, data: { items: [finished] }, error: null });
  vi.mocked(readOpenDesignRunEvents).mockResolvedValue({ success: true, data: { items: [], nextSeq: 0, lastAvailableSeq: 0 }, error: null });

  await act(async () => root.render(<MemoryRouter initialEntries={['/web-pages/opendesign?run=run-a']}><OpenDesignRunsPage /></MemoryRouter>));
  const versions = container.querySelector('[aria-label="工作区执行版本"]');
  const executions = versions?.querySelectorAll('li');
  expect(executions).toHaveLength(2);
  expect(executions?.[0]?.textContent).toContain(firstDigest);
  expect(executions?.[0]?.textContent).toContain('cds-first');
  expect(executions?.[0]?.querySelector(`[title="${firstCommit}"]`)).not.toBeNull();
  expect(executions?.[1]?.textContent).toContain(secondDigest);
  expect(executions?.[1]?.querySelector(`[title="${currentCommit}"]`)).not.toBeNull();
});

it('从网页托管打开旧任务时能回到原作者入口，分页心跳保留早期阶段', async () => {
  vi.mocked(listOpenDesignRuns).mockResolvedValue({ success: true, data: { items: [], selected: { ...run, deliveryOriginStoreId: 'store-a' } }, error: null });
  const progressEvents = Array.from({ length: 100 }, (_, index) => ({
    sequence: index + 2, type: 'phase', phase: `正在应用作者裁定 · 已运行 ${index} 秒`, occurredAt: date,
  }));
  vi.mocked(readOpenDesignRunEvents)
    .mockResolvedValueOnce({ success: true, data: { items: [{ sequence: 1, type: 'phase', phase: '等待作者补答', occurredAt: date }, ...progressEvents.slice(0, -1)], nextSeq: 100, lastAvailableSeq: 101 }, error: null })
    .mockResolvedValueOnce({ success: true, data: { items: progressEvents.slice(-1), nextSeq: 101, lastAvailableSeq: 101 }, error: null });
  await act(async () => root.render(<MemoryRouter initialEntries={['/web-pages/opendesign?run=run-a']}><OpenDesignRunsPage /></MemoryRouter>));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(readOpenDesignRunEvents).toHaveBeenCalledWith('run-a', 100, expect.any(AbortSignal));
  expect(container.querySelector('a[href="/document-store/store-a/delivery?run=run-a"]')).not.toBeNull();
  expect(container.querySelector('ol')?.textContent).toContain('等待作者补答');
  expect(container.querySelectorAll('ol li')).toHaveLength(2);
});
