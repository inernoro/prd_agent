// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectSse, useSseStream, type UseSseStreamReturn } from './useSseStream';
import { useAiPreviewStream, type UseAiPreviewStreamReturn } from './useAiPreviewStream';

const mocks = vi.hoisted(() => ({
  authState: { token: 'test-token', isAuthenticated: true, logout: vi.fn() },
  refresh: vi.fn(),
}));
vi.mock('@/stores/authStore', () => ({ useAuthStore: { getState: () => mocks.authState } }));
vi.mock('@/services/real/apiClient', () => ({ tryRefreshAdminToken: mocks.refresh }));

function completedStream(text = '润色完成') {
  return new Response(`event: typing\ndata: ${JSON.stringify({ text })}\n\nevent: done\ndata: {}\n\n`);
}

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
    mocks.authState.token = 'test-token';
    mocks.refresh.mockReset();
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

  it('预览首次 HTTP 401 沿用会话刷新，保持请求正文并用新令牌完成和应用', async () => {
    mocks.refresh.mockImplementation(async () => {
      mocks.authState.token = 'renewed-token';
      return true;
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(completedStream());
    vi.stubGlobal('fetch', fetchMock);
    const body = { content: '原始缺陷', templateId: 'template-1' };
    await act(async () => preview.start(body));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer test-token' });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: 'POST', body: JSON.stringify(body), headers: { Authorization: 'Bearer renewed-token' },
    });
    expect(preview.phase).toBe('done');
    expect(preview.error).toBeNull();
    await act(async () => preview.apply());
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith('润色完成');
  });

  it('刷新后仍然 401 最多重发一次，保留失败和原文不应用', async () => {
    mocks.refresh.mockResolvedValue(true);
    const fetchMock = vi.fn().mockImplementation(async () => new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => preview.start({ content: '保留原始缺陷' }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(preview.phase).toBe('error');
    expect(preview.error).toBeTruthy();
    await act(async () => preview.apply());
    expect(onApply).not.toHaveBeenCalled();
  });

  it('刷新被拒绝时不重发润色', async () => {
    mocks.refresh.mockResolvedValue(false);
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => preview.start({ content: '原始缺陷' }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(preview.phase).toBe('error');
  });

  it.each([403, 503])('HTTP %s 不刷新也不重放请求', async status => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => preview.start({ content: '原始缺陷' }));
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(preview.phase).toBe('error');
  });

  it('刷新等待中取消再打开，旧刷新不得重发或污染新一轮预览', async () => {
    let finishRefresh!: (value: boolean) => void;
    mocks.refresh.mockImplementation(() => new Promise<boolean>(resolve => { finishRefresh = resolve; }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(completedStream('新一轮结果'));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => preview.start({ content: '旧正文' }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    await act(async () => preview.cancel());
    await act(async () => preview.start({ content: '新正文' }));
    await act(async () => finishRefresh(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(preview.text).toBe('新一轮结果');
    expect(preview.error).toBeNull();
    expect(preview.phase).toBe('done');
  });

  it('已消费 typing 后的 SSE 身份错误是业务终态，不刷新或重放生成', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      'event: typing\ndata: {"text":"部分结果"}\n\nevent: error\ndata: {"code":"UNAUTHORIZED"}\n\nevent: done\ndata: {}\n\n',
    ));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => preview.start({ content: '原文' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(preview.text).toBe('部分结果');
    expect(preview.phase).toBe('error');
    expect(preview.error).toBeTruthy();
    await act(async () => preview.apply());
    expect(onApply).not.toHaveBeenCalled();
  });


  it('刷新等待期间正文对象变动不改变已发出的传输快照', async () => {
    let finishRefresh!: (value: boolean) => void;
    mocks.refresh.mockImplementation(() => new Promise<boolean>(resolve => { finishRefresh = resolve; }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(completedStream());
    vi.stubGlobal('fetch', fetchMock);
    const body = { content: '发送时正文' };
    await act(async () => preview.start(body));
    body.content = '刷新期间修改';
    await act(async () => finishRefresh(true));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].body).toBe(fetchMock.mock.calls[0][1].body);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).content).toBe('发送时正文');
  });

  it('已消费错误终态后网络断连不得覆盖业务错误或重放流', async () => {
    let disconnect!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'event: error\ndata: {"code":"APPCALLER_POOL_UNBOUND"}\n\n',
        ));
        disconnect = () => controller.error(new Error('connection reset'));
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal('fetch', fetchMock);
    let started!: Promise<void>;
    await act(async () => { started = stream.start(); });
    const originalError = onError.mock.calls[0][0];
    await act(async () => { disconnect(); await started; });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(stream.phase).toBe('error');
    expect(stream.phaseMessage).toBe(originalError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('服务连接刷新等待中取消，不重发、不退出登录', async () => {
    let finishRefresh!: (value: boolean) => void;
    mocks.refresh.mockImplementation(() => new Promise<boolean>(resolve => { finishRefresh = resolve; }));
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const ac = new AbortController();
    const pending = connectSse({ url: '/events', onEvent: vi.fn(), signal: ac.signal });
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    ac.abort();
    finishRefresh(true);
    expect(await pending).toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.authState.logout).not.toHaveBeenCalled();
  });

});
