import { StreamingText } from '@/components/streaming';

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
 * SSE 打字效果区块 — 展示 LLM 原始流式输出（调试/监控场景）
 *
 * 滚动显示最新文本内容 + Blur focus 动效，让用户知道 AI 正在工作。
 * 用于替代所有"加载中..."的空白等待。
 *
 * 内部委托给统一的 StreamingText (mode='blur') 渲染, 保留 tailChars 截断
 * 行为 (此区块定位是"监控/调试", 不显示历史上文)。
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
        {/* maxTailChars 走 StreamingText 内置尾窗 + 绝对 offset key, 避免预先 slice 导致的 key 漂移闪烁 */}
        <StreamingText text={text} streaming={showCursor} mode="blur" maxTailChars={tailChars} />
      </div>
    </div>
  );
}
