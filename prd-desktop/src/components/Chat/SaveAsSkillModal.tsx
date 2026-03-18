import { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '../../lib/tauri';
import { useMessageStore } from '../../stores/messageStore';
import type { ApiResponse, Message } from '../../types';

/** A single conversation turn (user question + assistant answer) */
interface ConversationTurn {
  /** Index in the original messages array (for stable key) */
  index: number;
  userMessage: Message | null;
  assistantMessage: Message;
  /** Preview text (truncated) */
  userPreview: string;
  assistantPreview: string;
}

interface ExtractedSkillDraft {
  promptTemplate: string;
  title?: string;
  description?: string;
  category?: string;
  icon?: string;
}

interface Props {
  open: boolean;
  /** The assistant message that triggered "保存为技能" */
  triggerMessage: Message | null;
  onClose: () => void;
  /** Called after LLM extraction succeeds, passes the draft to SkillManagerModal */
  onExtracted: (draft: ExtractedSkillDraft) => void;
}

/** Max recent turns to show in the picker */
const MAX_TURNS = 10;
/** Truncate preview text */
const PREVIEW_LEN = 120;

function truncate(text: string, max: number): string {
  const s = (text || '').replace(/\n+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max) + '…';
}

export default function SaveAsSkillModal({ open, triggerMessage, onClose, onExtracted }: Props) {
  const messages = useMessageStore((s) => s.messages);

  // Build conversation turns from messages, up to the trigger message
  const turns = useMemo(() => {
    if (!triggerMessage) return [];
    const result: ConversationTurn[] = [];
    const triggerIdx = messages.findIndex((m) => m.id === triggerMessage.id);
    if (triggerIdx === -1) return [];

    // Walk backwards from triggerIdx, pairing user+assistant messages
    let i = triggerIdx;
    while (i >= 0 && result.length < MAX_TURNS) {
      const msg = messages[i];
      if (msg.role === 'Assistant' && (msg.content || '').trim()) {
        // Find the preceding user message
        let userMsg: Message | null = null;
        for (let j = i - 1; j >= 0; j--) {
          if (messages[j].role === 'User') {
            userMsg = messages[j];
            break;
          }
        }
        result.unshift({
          index: i,
          userMessage: userMsg,
          assistantMessage: msg,
          userPreview: truncate(userMsg?.content || '(无用户消息)', PREVIEW_LEN),
          assistantPreview: truncate(msg.content, PREVIEW_LEN),
        });
        // Skip past the user message we just consumed
        i = userMsg ? messages.indexOf(userMsg) - 1 : i - 1;
      } else {
        i--;
      }
    }
    return result;
  }, [messages, triggerMessage]);

  // Selected turn indices (the trigger message's turn is always pre-selected)
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset selection when modal opens
  useEffect(() => {
    if (open && turns.length > 0) {
      // Pre-select the last turn (the trigger message)
      const lastTurn = turns[turns.length - 1];
      setSelectedIndices(new Set([lastTurn.index]));
      setError(null);
      setIsExtracting(false);
    }
  }, [open, turns]);

  const toggleTurn = (turnIndex: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(turnIndex)) {
        // Don't allow deselecting the trigger message turn
        const lastTurn = turns[turns.length - 1];
        if (turnIndex === lastTurn?.index) return prev;
        next.delete(turnIndex);
      } else {
        next.add(turnIndex);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIndices(new Set(turns.map((t) => t.index)));
  };

  const selectOnlyLast = () => {
    const lastTurn = turns[turns.length - 1];
    if (lastTurn) setSelectedIndices(new Set([lastTurn.index]));
  };

  const handleExtract = async () => {
    setIsExtracting(true);
    setError(null);

    // Build the conversation context from selected turns, ordered chronologically
    const selectedTurns = turns.filter((t) => selectedIndices.has(t.index));
    const conversationMessages: Array<{ role: string; content: string }> = [];
    for (const turn of selectedTurns) {
      if (turn.userMessage?.content) {
        conversationMessages.push({ role: 'user', content: turn.userMessage.content });
      }
      conversationMessages.push({ role: 'assistant', content: turn.assistantMessage.content });
    }

    // Mark which turn is the "key" turn (the trigger)
    const lastTurn = selectedTurns[selectedTurns.length - 1];

    try {
      const resp = await invoke<ApiResponse<ExtractedSkillDraft>>('generate_skill_from_conversation', {
        conversationMessages,
        keyAssistantMessage: lastTurn?.assistantMessage.content || '',
      });

      if (resp?.success && resp.data?.promptTemplate) {
        onExtracted(resp.data);
        onClose();
      } else {
        setError((resp as any)?.error?.message || '提炼失败，请重试');
      }
    } catch (err: any) {
      setError(err?.message || '网络错误');
    } finally {
      setIsExtracting(false);
    }
  };

  if (!open || !triggerMessage) return null;

  const lastTurnIndex = turns[turns.length - 1]?.index;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="ui-glass-modal w-[560px] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/10 dark:border-white/10">
          <div>
            <h2 className="text-base font-medium">保存为技能</h2>
            <p className="text-xs text-text-secondary mt-0.5">
              选择要纳入提炼的对话轮次，AI 将从中提取可复用的提示词模板
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-2 px-5 py-2 border-b border-black/5 dark:border-white/5">
          <button
            onClick={selectAll}
            className="px-2.5 py-1 text-xs rounded-md hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary transition-colors"
          >
            全选 ({turns.length})
          </button>
          <button
            onClick={selectOnlyLast}
            className="px-2.5 py-1 text-xs rounded-md hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary transition-colors"
          >
            仅最后一轮
          </button>
          <div className="flex-1" />
          <span className="text-xs text-text-secondary/60">
            已选 {selectedIndices.size} / {turns.length} 轮
          </span>
        </div>

        {/* Conversation turns list */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {turns.length === 0 ? (
            <div className="text-center text-xs text-text-secondary/60 py-8">
              未找到可用的对话轮次
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {turns.map((turn, idx) => {
                const isSelected = selectedIndices.has(turn.index);
                const isKeyTurn = turn.index === lastTurnIndex;
                return (
                  <button
                    key={turn.index}
                    type="button"
                    onClick={() => toggleTurn(turn.index)}
                    className={`w-full text-left rounded-xl px-4 py-3 transition-all border ${
                      isSelected
                        ? isKeyTurn
                          ? 'border-amber-400/60 bg-amber-500/8 dark:border-amber-400/40 dark:bg-amber-500/10'
                          : 'border-primary-400/50 bg-primary-500/8 dark:border-primary-400/30 dark:bg-primary-500/10'
                        : 'border-black/8 dark:border-white/8 hover:border-black/15 dark:hover:border-white/15 hover:bg-black/3 dark:hover:bg-white/3'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {/* Checkbox */}
                      <div className={`mt-0.5 w-4.5 h-4.5 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                        isSelected
                          ? isKeyTurn
                            ? 'bg-amber-500 text-white'
                            : 'bg-primary-500 text-white'
                          : 'border border-black/20 dark:border-white/20'
                      }`}>
                        {isSelected && (
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        {/* Turn number + key badge */}
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span className="text-[10px] font-medium text-text-secondary/50">
                            第 {idx + 1} 轮
                          </span>
                          {isKeyTurn && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-300 font-medium">
                              触发轮次
                            </span>
                          )}
                        </div>

                        {/* User message preview */}
                        {turn.userMessage && (
                          <div className="flex items-start gap-1.5 mb-1">
                            <span className="text-[10px] font-medium text-blue-500 dark:text-blue-400 mt-px shrink-0">Q</span>
                            <p className="text-xs text-text-primary/80 leading-relaxed line-clamp-2">
                              {turn.userPreview}
                            </p>
                          </div>
                        )}

                        {/* Assistant message preview */}
                        <div className="flex items-start gap-1.5">
                          <span className="text-[10px] font-medium text-emerald-500 dark:text-emerald-400 mt-px shrink-0">A</span>
                          <p className="text-xs text-text-secondary leading-relaxed line-clamp-2">
                            {turn.assistantPreview}
                          </p>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-black/10 dark:border-white/10">
          {error && (
            <p className="text-xs text-red-500 mb-2">{error}</p>
          )}
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-text-secondary/50">
              多轮对话有助于 AI 理解你的意图和偏好
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-xs rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleExtract}
                disabled={selectedIndices.size === 0 || isExtracting}
                className="px-4 py-2 text-xs rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {isExtracting ? (
                  <>
                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    提炼中…
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    AI 提炼 ({selectedIndices.size} 轮)
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
