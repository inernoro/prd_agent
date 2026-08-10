import { useCallback, useRef, useState } from 'react';
import { readSseStream, type SseEvent } from '@/lib/sse';
import { api } from '@/services/api';
import { buildApiUrl } from '@/services/real/webPages';
import { useAuthStore } from '@/stores/authStore';
import type { AskMessage, AskSource, AskStatus } from './askTypes';

/**
 * 「向我提问」的流式 hook。
 *
 * 没有复用通用的 useSseStream，是因为这里有两件它办不到的事：
 *  1. 门禁失败要拿到**真实 HTTP 状态码 + 错误码**（401 引导登录、429 显示等多久），
 *     通用 hook 只把响应体当纯文本塞进错误消息。
 *  2. 需要 model / session 两个自定义事件，且 typing 要落到"当前这条助手消息"上，
 *     而不是一个全局 typing 字符串。
 *
 * 鉴权是可选的：有 token 就带，没有也发（匿名分享页）——服务端据站点的
 * AllowAnonymous 决定放不放行。
 */
export function useAskStream(source: AskSource) {
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [status, setStatus] = useState<AskStatus>('idle');
  const [phaseMessage, setPhaseMessage] = useState('');
  const [model, setModel] = useState<{ model: string; platform?: string } | null>(null);
  /** 门禁类失败：不是"答错了"，而是"没资格问"，UI 要给引导而不是重试按钮 */
  const [gateError, setGateError] = useState<{ code: string; message: string } | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const reset = useCallback(() => {
    abort();
    setMessages([]);
    setStatus('idle');
    setPhaseMessage('');
    setGateError(null);
    sessionIdRef.current = null;
  }, [abort]);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || status === 'connecting' || status === 'answering') return;

      abort();
      const ac = new AbortController();
      abortRef.current = ac;

      const userMsg: AskMessage = { id: `u-${Date.now()}`, role: 'user', content: q };
      const assistantId = `a-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantId, role: 'assistant', content: '', streaming: true },
      ]);
      setStatus('connecting');
      setPhaseMessage('正在读取页面内容…');
      setGateError(null);

      // 历史只带纯文本，且不含正在生成的这条
      const history = messages
        .filter((m) => m.content.trim().length > 0 && !m.error)
        .map((m) => ({ role: m.role, content: m.content }));

      // 必须过 buildApiUrl：这是裸 fetch（SSE 绕开了 apiRequest），前后端分开部署时
      // 相对路径会打到前端自己身上，拿回 404 或一坨 HTML 而不是事件流。
      const url = buildApiUrl(
        source.mode === 'share'
          ? api.webPages.askStreamByShare(encodeURIComponent(source.token))
          : api.webPages.askStream(encodeURIComponent(source.siteId)),
      );

      const body: Record<string, unknown> = {
        question: q,
        sessionId: sessionIdRef.current,
        history,
      };
      if (source.mode === 'share') {
        if (source.siteId) body.siteId = source.siteId;
        if (source.password) body.password = source.password;
      }

      // 是否真的收到了 done。EOF 不等于答完——代理截断 / 空闲超时都会让流静默结束，
      // 把半截答案当成功呈现出去，用户完全看不出来。
      let sawDone = false;

      const failAssistant = (message: string) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, streaming: false, error: message } : m)),
        );
      };

      try {
        const authToken = useAuthStore.getState().token;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });

        if (!res.ok) {
          // 门禁失败走 JSON + 真实状态码（服务端刻意在写第一个 SSE 字节前判完）
          const payload = await res.json().catch(() => null);
          const code = payload?.error?.code ?? `HTTP_${res.status}`;
          const message = payload?.error?.message ?? `请求失败（${res.status}）`;
          setGateError({ code, message });
          setStatus('error');
          failAssistant(message);
          return;
        }

        setStatus('answering');

        await readSseStream(
          res,
          (evt: SseEvent) => {
            if (!evt.data) return;
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(evt.data) as Record<string, unknown>;
            } catch {
              return;
            }

            switch (evt.event) {
              case 'session':
                if (typeof data.sessionId === 'string') sessionIdRef.current = data.sessionId;
                break;
              case 'phase':
                setPhaseMessage(String(data.message ?? ''));
                break;
              case 'model':
                setModel({
                  model: String(data.model ?? ''),
                  platform: data.platform ? String(data.platform) : undefined,
                });
                break;
              case 'typing': {
                const text = String(data.text ?? '');
                if (!text) break;
                setMessages((prev) =>
                  prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + text } : m)),
                );
                break;
              }
              case 'done':
                sawDone = true;
                setMessages((prev) =>
                  prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
                );
                setStatus('done');
                setPhaseMessage('');
                break;
              case 'error':
                failAssistant(String(data.message ?? '回答失败'));
                setStatus('error');
                break;
              default:
                break;
            }
          },
          ac.signal,
        );

        // 流结束但没收到 done：这是被截断，不是答完。必须如实标成中断——
        // 之前这里无条件把 answering 改成 done，半截答案会被当成功呈现，
        // 用户既看不出少了什么，也不知道可以重试。
        if (!sawDone) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId && m.streaming
                ? {
                    ...m,
                    streaming: false,
                    error: m.content ? '回答被中断，内容可能不完整，可以再问一次。' : '连接中断，没有收到回答。',
                  }
                : m,
            ),
          );
          setStatus((s) => (s === 'answering' || s === 'connecting' ? 'error' : s));
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        const message = e instanceof Error ? e.message : '网络请求失败';
        failAssistant(message);
        setStatus('error');
      }
    },
    [abort, messages, source, status],
  );

  return {
    messages,
    status,
    phaseMessage,
    model,
    gateError,
    isBusy: status === 'connecting' || status === 'answering',
    ask,
    abort,
    reset,
  };
}
