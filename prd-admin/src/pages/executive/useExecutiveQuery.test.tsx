// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, ok, type ApiResponse } from '@/types/api';
import { useExecutiveQuery } from './useExecutiveQuery';

describe('统计按需加载', () => {
  let root: Root;
  let container: HTMLDivElement;
  let query: ReturnType<typeof useExecutiveQuery<string>>;
  const fetcher = vi.fn<(days: number) => Promise<ApiResponse<string>>>();
  function Harness({ days = 0, enabled = true, revision = 0 }) {
    query = useExecutiveQuery(fetcher, days, enabled, revision);
    return <div>{query.data ?? query.error ?? (query.loading ? 'loading' : 'idle')}</div>;
  }
  async function render(props: { days?: number; enabled?: boolean; revision?: number } = {}) {
    await act(async () => root.render(<StrictMode><Harness {...props} /></StrictMode>));
  }
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    fetcher.mockReset().mockImplementation(async days => ok(`days:${days}`));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  it('未打开的标签不查询；StrictMode 和来回切换复用请求及结果', async () => {
    await render({ enabled: false });
    expect(fetcher).not.toHaveBeenCalled();
    await render();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(query.data).toBe('days:0');
    await render({ enabled: false });
    await render();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('较早时间范围的慢响应不会覆盖新范围', async () => {
    let resolveOld!: (value: ReturnType<typeof ok<string>>) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    await render();
    await render({ days: 7 });
    expect(query.data).toBe('days:7');
    await act(async () => resolveOld(ok('old')));
    expect(query.data).toBe('days:7');
    await render();
    expect(query.data).toBe('old');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('手动刷新绕过缓存；一分钟后重新打开会更新', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    await render();
    await render({ revision: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await render({ enabled: false, revision: 1 });
    now.mockReturnValue(62_000);
    await render({ revision: 1 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('失败结束等待且重试不复用失败结果', async () => {
    fetcher.mockResolvedValueOnce(fail('UNKNOWN', '查询超时'));
    await render();
    expect(query.error).toBe('查询超时');
    expect(query.loading).toBe(false);
    await render({ revision: 1 });
    expect(query.data).toBe('days:0');
    expect(query.error).toBeUndefined();
  });
  it('切换范围与刷新期间保留原始窗口，失败不清空已有结果', async () => {
    await render();
    let resolveNew!: (value: ApiResponse<string>) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
    await render({ days: 7 });
    expect(query.data).toBe('days:0');
    expect(query.dataDays).toBe(0);
    expect(query.loading).toBe(true);
    expect(query.stale).toBe(true);
    await act(async () => resolveNew(fail('UNKNOWN', '统计超时')));
    expect(query.data).toBe('days:0');
    expect(query.dataDays).toBe(0);
    expect(query.loading).toBe(false);
    expect(query.error).toBe('统计超时');
    expect(query.stale).toBe(true);
    await render({ days: 7, revision: 1 });
    expect(query.data).toBe('days:7');
    expect(query.dataDays).toBe(7);
    expect(query.stale).toBe(false);
    expect(query.updatedAt).toBeTypeOf('number');
  });

});
