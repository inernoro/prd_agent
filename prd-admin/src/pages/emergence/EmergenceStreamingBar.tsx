import { useEffect, useMemo, useRef } from 'react';
import { CheckCircle2, AlertCircle, Sparkle, Brain } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import type { SsePhase } from '@/lib/useSseStream';

interface Props {
  phase: SsePhase;
  message: string;
  /** LLM 流式累积的原始文本（useSseStream.typing） */
  typing?: string;
  /** LLM 推理过程文本（reasoning_content / thinking） */
  thinking?: string;
  /** 当前维度：决定颜色（1=蓝/探索 2=紫/涌现 3=黄/幻想） */
  dimension?: 1 | 2 | 3;
  /** 右侧附加信息（如"已涌现 3 个"） */
  extra?: React.ReactNode;
}

const phaseColor: Record<SsePhase, { color: string; bg: string; border: string }> = {
  idle: { color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.06)' },
  connecting: { color: 'rgba(120,180,255,0.9)', bg: 'rgba(120,180,255,0.08)', border: 'rgba(120,180,255,0.2)' },
  streaming: { color: 'rgba(120,180,255,0.9)', bg: 'rgba(120,180,255,0.08)', border: 'rgba(120,180,255,0.2)' },
  done: { color: 'rgba(120,220,180,0.9)', bg: 'rgba(120,220,180,0.08)', border: 'rgba(120,220,180,0.2)' },
  error: { color: 'rgba(255,100,100,0.9)', bg: 'rgba(255,100,100,0.08)', border: 'rgba(255,100,100,0.2)' },
};

const dimColor: Record<1 | 2 | 3, { main: string; soft: string; border: string }> = {
  1: { main: 'rgba(96,165,250,0.95)', soft: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.22)' },
  2: { main: 'rgba(192,132,252,0.95)', soft: 'rgba(147,51,234,0.08)', border: 'rgba(147,51,234,0.22)' },
  3: { main: 'rgba(250,204,21,0.95)', soft: 'rgba(234,179,8,0.08)', border: 'rgba(234,179,8,0.22)' },
};

/**
 * 去掉 LLM 输出里的 JSON 结构化噪音，只保留阅读感强的 title/description/groundingContent 片段。
 * 采用极轻量的正则抽取，不做完整 JSON 解析（那样流式场景下容易抛异常）。
 */
function extractReadableText(raw: string): string {
  if (!raw) return '';
  const keys = ['title', 'description', 'groundingContent', 'techPlan'];
  const parts: string[] = [];
  for (const key of keys) {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)(?:"|$)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      try {
        const decoded = JSON.parse(`"${m[1]}"`);
        if (typeof decoded === 'string' && decoded.trim()) parts.push(decoded);
      } catch {
        if (m[1] && m[1].trim()) parts.push(m[1]);
      }
    }
  }
  if (parts.length === 0) {
    // 没抽到任何字段就直接回退为原始文本（去代码块包围符）
    return raw.replace(/```json|```/g, '').trim();
  }
  return parts.join(' · ');
}

export function EmergenceStreamingBar({ phase, message, typing = '', thinking = '', dimension = 1, extra }: Props) {
  const pc = phaseColor[phase];
  const dc = dimColor[dimension];

  const readable = useMemo(() => extractReadableText(typing), [typing]);
  // 只显示最新 260 字符，避免长文本挤碎布局
  const tail = readable.length > 260 ? '…' + readable.slice(-260) : readable;

  // 思考模式：还没收到正式 typing，但已经有 reasoning_content 流入
  const showThinking = !tail && thinking && thinking.trim().length > 0;
  const thinkingText = thinking.replace(/\s+/g, ' ').trim();
  const thinkingTail = thinkingText.length > 260 ? '…' + thinkingText.slice(-260) : thinkingText;

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [tail, thinkingTail]);

  const isBusy = phase === 'connecting' || phase === 'streaming';

  return (
    <div
      className="flex items-stretch gap-0 overflow-hidden"
      style={{
        background: `linear-gradient(90deg, ${dc.soft} 0%, rgba(255,255,255,0.02) 100%)`,
        border: `1px solid ${dc.border}`,
        borderRadius: 12,
        boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.05), 0 4px 12px -4px rgba(0,0,0,0.35)',
      }}
    >
      {/* 左侧：状态徽章 */}
      <div
        className="flex items-center gap-2 px-3 py-2 flex-shrink-0"
        style={{ borderRight: `1px solid ${dc.border}` }}
      >
        {isBusy ? (
          showThinking ? (
            <Brain size={14} className="flex-shrink-0 emergence-think-pulse" style={{ color: dc.main }} />
          ) : (
            <MapSpinner size={14} color={dc.main} className="flex-shrink-0" />
          )
        ) : phase === 'done' ? (
          <CheckCircle2 size={14} className="flex-shrink-0" style={{ color: pc.color }} />
        ) : phase === 'error' ? (
          <AlertCircle size={14} className="flex-shrink-0" style={{ color: pc.color }} />
        ) : (
          <Sparkle size={14} className="flex-shrink-0" style={{ color: dc.main }} />
        )}
        <span className="text-[12px] font-medium whitespace-nowrap" style={{ color: dc.main }}>
          {showThinking ? 'AI 思考中' : (message || (phase === 'idle' ? '就绪' : 'AI 生长中'))}
        </span>
      </div>

      {/* 中间：流式文字预览（横向滚动到最新） */}
      <div
        ref={scrollRef}
        className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden emergence-typing-scroll"
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          whiteSpace: 'nowrap',
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace',
        }}
      >
        {tail ? (
          <>
            <span
              className="text-[11.5px] leading-none"
              style={{
                color: 'rgba(255,255,255,0.82)',
                textShadow: `0 0 12px ${dc.main.replace('0.95', '0.35')}`,
              }}
            >
              {tail}
            </span>
            {isBusy && (
              <span
                className="inline-block ml-1 emergence-typing-cursor"
                style={{
                  width: 6,
                  height: 12,
                  background: dc.main,
                  borderRadius: 1,
                  boxShadow: `0 0 8px ${dc.main}`,
                }}
              />
            )}
          </>
        ) : showThinking ? (
          <>
            <span
              className="text-[11.5px] leading-none italic"
              style={{
                color: 'rgba(255,255,255,0.55)',
                textShadow: `0 0 12px ${dc.main.replace('0.95', '0.25')}`,
              }}
            >
              {thinkingTail}
            </span>
            {isBusy && (
              <span
                className="inline-block ml-1 emergence-typing-cursor"
                style={{
                  width: 6,
                  height: 12,
                  background: dc.main,
                  opacity: 0.55,
                  borderRadius: 1,
                  boxShadow: `0 0 6px ${dc.main}`,
                }}
              />
            )}
          </>
        ) : (
          <span className="text-[11px] italic" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
            {isBusy ? '正在连接模型，首字到达后这里会实时流式显示…' : ''}
          </span>
        )}
      </div>

      {/* 右侧：附加信息 */}
      {extra && (
        <div
          className="flex items-center px-3 py-2 flex-shrink-0 text-[11px]"
          style={{
            color: 'var(--text-muted)',
            borderLeft: `1px solid ${dc.border}`,
          }}
        >
          {extra}
        </div>
      )}
    </div>
  );
}
