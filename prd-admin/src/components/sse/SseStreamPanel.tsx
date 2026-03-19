import { Loader2 } from 'lucide-react';
import { SsePhaseBar } from './SsePhaseBar';
import { SseTypingBlock } from './SseTypingBlock';
import type { SsePhase } from '@/lib/useSseStream';

interface SseStreamPanelProps {
  /** 当前阶段 */
  phase: SsePhase;
  /** 阶段描述文本 */
  phaseMessage: string;
  /** LLM 流式打字文本 */
  typing: string;
  /** 是否已完成 */
  isDone: boolean;
  /** 阶段栏右侧附加信息 */
  phaseExtra?: React.ReactNode;
  /** 主体内容（评分表、结果列表等） */
  children?: React.ReactNode;
  /** 无数据时的空状态提示（默认"暂无数据"） */
  emptyText?: string;
  /** 是否有数据 */
  hasData?: boolean;
  /** 打字区块标题 */
  typingLabel?: string;
  /** 打字区块最大高度 */
  typingMaxHeight?: number;
  /** 等待中的占位内容（loading spinner） */
  waitingContent?: React.ReactNode;
}

/**
 * SSE 流式面板 — 组合 PhaseBar + TypingBlock + 主体内容
 *
 * 符合「LLM 交互过程可视化」原则的标准面板布局：
 * 1. 顶部：阶段状态栏（实时反馈当前步骤）
 * 2. 中部：LLM 打字效果（AI 正在输出时展示原始文本流）
 * 3. 下部：业务内容（评分表、分析结果等逐步出现）
 *
 * 使用方式：
 * ```tsx
 * <SseStreamPanel phase={phase} phaseMessage={msg} typing={typing} isDone={done} hasData={items.length > 0}>
 *   <MyResultTable items={items} />
 * </SseStreamPanel>
 * ```
 */
export function SseStreamPanel({
  phase,
  phaseMessage,
  typing,
  isDone,
  phaseExtra,
  children,
  emptyText = '暂无数据',
  hasData = false,
  typingLabel,
  typingMaxHeight,
  waitingContent,
}: SseStreamPanelProps) {
  const isStreaming = phase === 'connecting' || phase === 'streaming';

  return (
    <div className="space-y-3">
      {/* 阶段状态栏 */}
      <SsePhaseBar phase={phase} message={phaseMessage} extra={phaseExtra} />

      {/* LLM 打字效果（仅流式传输中且有内容时展示） */}
      {isStreaming && typing && (
        <SseTypingBlock text={typing} label={typingLabel} maxHeight={typingMaxHeight} />
      )}

      {/* 主体内容 */}
      {hasData ? (
        children
      ) : isStreaming && !hasData ? (
        waitingContent ?? (
          <div className="flex flex-col items-center gap-2 py-8" style={{ color: 'var(--text-muted)' }}>
            <Loader2 size={24} className="animate-spin" style={{ color: 'rgba(120,180,255,0.5)' }} />
            <span className="text-xs">AI 正在分析数据…</span>
          </div>
        )
      ) : isDone && !hasData ? (
        <p className="text-sm text-center py-4" style={{ color: 'var(--text-muted)' }}>{emptyText}</p>
      ) : null}
    </div>
  );
}
