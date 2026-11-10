// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelImageGenRun } from '@/services';
import { ImageGenerationCancelActions } from './ImageGenerationCancelActions';
vi.mock('@/services', () => ({ cancelImageGenRun: vi.fn() }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const running = { status: 'running', runId: 'owned-run', prompt: '一张白桃图片' };
const render = async (items: Array<typeof running | { status: string; runId?: string }>) => {
  await act(async () => root.render(<ImageGenerationCancelActions items={items} />));
};
const button = () => host.querySelector('button')!;

describe('画布取消生成', () => {
  it('只展示已登记的运行任务，同一次多图生成只有一个取消入口', async () => {
    await render([running, { ...running }, { status: 'running' }, { status: 'done', runId: 'done-run' }]);
    expect(host.querySelectorAll('button')).toHaveLength(1);
  });
  it('发送正确任务ID，等待期间拒绝重复点击，成功后不自行宣称任务已取消', async () => {
    let finish!: (result: Awaited<ReturnType<typeof cancelImageGenRun>>) => void;
    vi.mocked(cancelImageGenRun).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render([running]);
    await act(async () => button().click());
    await act(async () => button().click());
    expect(cancelImageGenRun).toHaveBeenCalledTimes(1);
    expect(cancelImageGenRun).toHaveBeenCalledWith({ runId: 'owned-run' });
    expect(button().disabled).toBe(true);
    expect(host.textContent).toContain('正在取消…');
    await act(async () => { finish({ success: true, data: true, error: null }); });
    expect(host.textContent).not.toContain('已取消');
    expect(button().disabled).toBe(false);
  });
  it('以服务端回填的终态移除入口，已完成任务不会被乐观改成取消', async () => {
    await render([running]);
    await render([{ ...running, status: 'done' }]);
    expect(host.querySelector('button')).toBeNull();
    expect(host.textContent).not.toContain('已取消');
  });
  it('失败提示可恢复动作并隐藏原始诊断，任务仍保留取消入口', async () => {
    vi.mocked(cancelImageGenRun).mockResolvedValue({ success: false, data: null, error: { code: 'UNKNOWN', message: 'HTTP 500 secret=fixture https://private.invalid' } });
    await render([running]);
    await act(async () => button().click());
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('取消请求未完成');
    expect(alert?.textContent).toContain('请重试');
    expect(alert?.textContent).not.toContain('private.invalid');
    expect(button().disabled).toBe(false);
  });
});
