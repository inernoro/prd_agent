// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getKnowledgeIndexStatus } from '@/services/real/documentStore';
import { ok, fail } from '@/types/api';
import type { KnowledgeIndexStatus as Status } from '@/services/contracts/documentStore';
import { KnowledgeIndexStatus } from './KnowledgeIndexStatus';

vi.mock('@/services/real/documentStore', () => ({ getKnowledgeIndexStatus: vi.fn() }));

const status = (overrides: Partial<Status> = {}): Status => ({
  status: 'pending', displayMessage: '已保存，问答内容正在刷新', pollingRecommended: true,
  targetSeconds: 120, delayed: false, ...overrides,
});

describe('知识库问答刷新状态', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.mocked(getKnowledgeIndexStatus).mockReset();
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('只观察后台状态，到达当前版本ready后停止轮询', async () => {
    vi.mocked(getKnowledgeIndexStatus)
      .mockResolvedValueOnce(ok(status()))
      .mockResolvedValueOnce(ok(status({ status: 'ready', displayMessage: '问答已使用最新正文', pollingRecommended: false })));
    await act(async () => root.render(<KnowledgeIndexStatus entryId="entry" revision="one" />));
    expect(container.textContent).toContain('问答内容正在刷新');
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(container.textContent).toContain('问答已使用最新正文');
    expect(container.querySelector('.animate-spin')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(getKnowledgeIndexStatus).toHaveBeenCalledTimes(2);
  });

  it('切换文档时旧请求的迟到响应不覆盖当前文章，保存版本变化会重查', async () => {
    let resolveOld!: (value: ReturnType<typeof ok<Status>>) => void;
    vi.mocked(getKnowledgeIndexStatus)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(ok(status({ status: 'ready', displayMessage: 'B的当前正文', pollingRecommended: false })))
      .mockResolvedValueOnce(ok(status({ delayed: true, displayMessage: 'B的刷新超过时间目标，仍在处理' })));
    await act(async () => root.render(<KnowledgeIndexStatus entryId="a" revision="one" />));
    await act(async () => root.render(<KnowledgeIndexStatus entryId="b" revision="one" />));
    await act(async () => resolveOld(ok(status({ status: 'ready', displayMessage: 'A的旧正文', pollingRecommended: false }))));
    expect(container.textContent).toContain('B的当前正文');
    expect(container.textContent).not.toContain('A的旧正文');
    await act(async () => root.render(<KnowledgeIndexStatus entryId="b" revision="two" />));
    expect(container.textContent).toContain('超过时间目标，仍在处理');
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('状态读取失败后不自动重发任务，人工重新查看只读状态', async () => {
    vi.mocked(getKnowledgeIndexStatus)
      .mockResolvedValueOnce(fail('SERVER_UNAVAILABLE', '状态服务暂时不可用'))
      .mockResolvedValueOnce(ok(status({ status: 'failed', displayMessage: '问答刷新失败', pollingRecommended: false, errorMessage: '模型暂时不可用' })));
    await act(async () => root.render(<KnowledgeIndexStatus entryId="entry" />));
    expect(container.textContent).toContain('状态服务暂时不可用');
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(getKnowledgeIndexStatus).toHaveBeenCalledTimes(1);
    await act(async () => container.querySelector('button')!.click());
    expect(container.textContent).toContain('问答刷新失败');
    expect(container.textContent).toContain('模型暂时不可用');
    expect(getKnowledgeIndexStatus).toHaveBeenCalledTimes(2);
  });
});
