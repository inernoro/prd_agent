interface SseTypingBlockProps {
  /** 累积的流式文本 */
  text: string;
  /** 显示最后 N 个字符（默认 400） */
  tailChars?: number;
  /** 最大高度（默认 100px） */
  maxHeight?: number;
  /** 是否显示闪烁光标（默认 true） */
  showCursor?: boolean;
  /** 标题（如"AI 思考过程"） */
  label?: string;
}

/**
 * SSE 打字效果区块 — 展示 LLM 原始流式输出
 *
 * 滚动显示最新文本内容 + 闪烁光标，让用户知道 AI 正在工作。
 * 用于替代所有"加载中..."的空白等待。
 */
export function SseTypingBlock({
  text,
  tailChars = 400,
  maxHeight = 100,
  showCursor = true,
  label,
}: SseTypingBlockProps) {
  if (!text) return null;

  return (
    <div>
      {label && (
        <span className="text-xs mb-1 block" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
      )}
      <div
        className="px-3 py-2 rounded-lg text-xs font-mono overflow-x-auto"
        style={{
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.06)',
          color: 'var(--text-muted)',
          maxHeight,
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {text.length > tailChars ? `…${text.slice(-tailChars)}` : text}
        {showCursor && <span className="animate-pulse">|</span>}
      </div>
    </div>
  );
}
