import { memo } from 'react';
import { MessageCircle, FileText, Wrench, ChevronRight } from 'lucide-react';
import type { AiChatSuggestedQuestion } from '@/services/contracts/aiChat';

const ICON_MAP: Record<string, React.ComponentType<{ size?: number | string; className?: string }>> = {
  chat: MessageCircle,
  doc: FileText,
  tool: Wrench,
};

interface SuggestedQuestionsProps {
  questions: AiChatSuggestedQuestion[];
  onSelect: (text: string) => void;
  /** 流式输出中或正在等待响应时隐藏 */
  disabled?: boolean;
}

export const SuggestedQuestions = memo(function SuggestedQuestions({
  questions,
  onSelect,
  disabled,
}: SuggestedQuestionsProps) {
  if (!questions.length || disabled) return null;

  return (
    <div
      className="flex flex-col gap-1.5 mt-3 mb-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
      style={{ maxWidth: '85%' }}
    >
      <div
        className="text-[11px] font-medium pl-1 select-none"
        style={{ color: 'var(--text-muted)' }}
      >
        推荐追问
      </div>
      {questions.map((q, idx) => {
        const IconComp = ICON_MAP[q.icon ?? ''] ?? MessageCircle;
        return (
          <button
            key={`${q.text}-${idx}`}
            type="button"
            className="group flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-left transition-all duration-150 hover:brightness-110"
            style={{
              background: 'rgba(30, 41, 59, 0.60)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              color: 'var(--text-secondary)',
            }}
            onClick={() => onSelect(q.text)}
            title={q.text}
          >
            <IconComp
              size={14}
              className="shrink-0 opacity-50 group-hover:opacity-80 transition-opacity"
            />
            <span className="flex-1 text-[12px] leading-[18px] line-clamp-2">
              {q.text}
            </span>
            <ChevronRight
              size={14}
              className="shrink-0 opacity-0 group-hover:opacity-50 transition-opacity -mr-0.5"
            />
          </button>
        );
      })}
    </div>
  );
});
