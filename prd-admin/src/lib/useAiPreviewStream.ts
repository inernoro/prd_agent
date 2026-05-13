import { useState, useRef } from 'react';
import { useSseStream, type SseStartOverrides } from '@/lib/useSseStream';

export interface UseAiPreviewStreamOptions {
  /** SSE 端点 URL (POST) */
  url: string;
  /** 默认请求体工厂 (start() 可覆盖) */
  buildBody?: () => unknown;
  /** 用户确认应用流式结果时的回调 */
  onApply: (finalText: string) => void;
  /** 是否在 typing 累积外再做客户端清洗 (默认不做) */
  transform?: (raw: string) => string;
}

export interface AiPreviewModel {
  model?: string;
  platform?: string;
  modelGroupName?: string;
}

export interface UseAiPreviewStreamReturn {
  open: boolean;
  text: string;
  thinking: string;
  streaming: boolean;
  phase: string;
  phaseMessage: string;
  error: string | null;
  model: AiPreviewModel | null;
  /** 开启 modal 并立即开始流 (可覆盖 body) */
  start: (override?: unknown) => void;
  /** 应用 (调用 onApply + 关闭) */
  apply: () => void;
  /** 不应用直接关闭 (会先 abort) */
  cancel: () => void;
  /** 重新生成 (abort + reset + 重新 start) */
  regenerate: (override?: unknown) => void;
}

/**
 * 通用 AI 预览流 hook —— 任意一次性 AI 端点升级流式 + 预览弹窗的统一接入。
 *
 * 对端协议 (与 AiStreamingHelpers 配对): phase / model / thinking / typing / done / error
 *
 * 用法:
 * ```tsx
 * const polish = useAiPreviewStream({
 *   url: '/api/defect-agent/defects/polish/stream',
 *   buildBody: () => ({ content, templateId, imageDescriptions }),
 *   onApply: (final) => setContent(final),
 * });
 *
 * <button onClick={() => polish.start()}>AI 润色</button>
 * <AiPreviewModal {...polish} title="AI 润色预览" markdown />
 * ```
 */
export function useAiPreviewStream(opts: UseAiPreviewStreamOptions): UseAiPreviewStreamReturn {
  const [open, setOpen] = useState(false);
  const [thinking, setThinking] = useState('');
  const [model, setModel] = useState<AiPreviewModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastBodyRef = useRef<unknown>(undefined);

  const sse = useSseStream({
    url: opts.url,
    method: 'POST',
    onEvent: {
      thinking: (data) => {
        const t = (data as { text?: string })?.text ?? '';
        if (t) setThinking((prev) => prev + t);
      },
      model: (data) => {
        const m = data as AiPreviewModel;
        setModel({
          model: m.model,
          platform: m.platform,
          modelGroupName: m.modelGroupName,
        });
      },
    },
    onError: (msg) => setError(msg),
  });

  const start = (override?: unknown) => {
    setOpen(true);
    setThinking('');
    setModel(null);
    setError(null);
    sse.reset();
    const body = override ?? opts.buildBody?.();
    lastBodyRef.current = body;
    const overrides: SseStartOverrides = body !== undefined ? { body } : {};
    void sse.start(overrides);
  };

  const cancel = () => {
    sse.abort();
    sse.reset();
    setThinking('');
    setModel(null);
    setError(null);
    setOpen(false);
  };

  const apply = () => {
    const raw = sse.typing;
    const final = opts.transform ? opts.transform(raw) : raw;
    opts.onApply(final);
    cancel();
  };

  const regenerate = (override?: unknown) => {
    sse.abort();
    sse.reset();
    setThinking('');
    setModel(null);
    setError(null);
    const body = override ?? lastBodyRef.current ?? opts.buildBody?.();
    const overrides: SseStartOverrides = body !== undefined ? { body } : {};
    void sse.start(overrides);
  };

  return {
    open,
    text: sse.typing,
    thinking,
    streaming: sse.isStreaming,
    phase: sse.phase,
    phaseMessage: sse.phaseMessage,
    error,
    model,
    start,
    apply,
    cancel,
    regenerate,
  };
}
