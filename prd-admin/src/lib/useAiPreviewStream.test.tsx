// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSseStream, type UseSseStreamReturn } from './useSseStream';
import { useAiPreviewStream, type UseAiPreviewStreamReturn } from './useAiPreviewStream';

vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => ({ token: 'test-token' }) } }));
vi.mock('@/services/real/apiClient', () => ({ tryRefreshAdminToken: vi.fn() }));

describe('润色流式失败与请求保护', () => {
  let root: Root;
  let container: HTMLDivElement;
  const onError = vi.fn();
  const onApply = vi.fn();
  let stream: UseSseStreamReturn;
  let preview: UseAiPreviewStreamReturn;

  function Harness() {
    stream = useSseStream({ url: '/stream', onError });
    preview = useAiPreviewStream({ url: '/polish', onApply });
    return null;
  }

  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('配置失败保留错误终态，结束连接不会把它覆盖成成功', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'event: error\ndata: {"code":"APPCALLER_POOL_UNBOUND","message":"AppCallerCode=private.polish::chat"}\n\n',
    )));
    await act(async () => stream.start());
    expect(stream.phase).toBe('error');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain('联系管理员');
    expect(onError.mock.calls[0][0]).not.toMatch(/AppCallerCode|private|::chat/);
  });

  it('HTTP 失败按契约分类，不把整个响应或内部异常放进界面', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: false, error: { code: 'MODEL_POOL_EMPTY', message: 'HTTP 503 secret upstream' },
    }), { status: 503 })));
    await act(async () => stream.start());
    expect(stream.phase).toBe('error');
    expect(onError.mock.calls[0][0]).toContain('联系管理员');
    expect(onError.mock.calls[0][0]).not.toMatch(/HTTP|secret|success|upstream/);
  });

  it('同一轮连续打开只发一次请求，失败和取消都保留原文', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      'event: typing\ndata: {"text":"部分生成"}\n\nevent: error\ndata: {"code":"APPCALLER_POOL_UNBOUND"}\n\n',
    ));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      preview.start({ content: '原始缺陷' });
      preview.start({ content: '原始缺陷' });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(preview.error).toContain('联系管理员');
    await act(async () => preview.apply());
    expect(onApply).not.toHaveBeenCalled();
    await act(async () => preview.cancel());
    expect(preview.open).toBe(false);
    expect(onApply).not.toHaveBeenCalled();
  });
});
