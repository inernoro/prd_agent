import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, X, Check } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { Button } from '@/components/design/Button';
import { useSseStream } from '@/lib/useSseStream';
import { api } from '@/services/api';

interface Props {
  open: boolean;
  text: string;
  onClose: () => void;
  onApply: (polished: string) => void;
}

interface ModelInfo {
  model?: string;
  platform?: string;
  modelGroupName?: string;
}

export function DailyLogPolishPopover({ open, text, onClose, onApply }: Props) {
  const [polished, setPolished] = useState('');
  const [model, setModel] = useState<ModelInfo>({});
  const [thinking, setThinking] = useState('');
  const [showThinking, setShowThinking] = useState(false);
  const startedRef = useRef(false);

  const { phase, phaseMessage, abort, start, reset } = useSseStream({
    url: api.reportAgent.dailyLogs.polish(),
    method: 'POST',
    onTyping: (chunk) => setPolished((prev) => prev + chunk),
    onEvent: {
      model: (data) => setModel(data as ModelInfo),
      thinking: (data) => {
        const t = (data as { text?: string }).text ?? '';
        setThinking((prev) => prev + t);
      },
      done: (data) => {
        const finalText = (data as { text?: string }).text;
        if (finalText) setPolished(finalText);
      },
    },
  });

  useEffect(() => {
    if (open && !startedRef.current) {
      startedRef.current = true;
      setPolished('');
      setThinking('');
      setShowThinking(false);
      setModel({});
      reset();
      void start({ body: { text } });
    }
    if (!open) {
      startedRef.current = false;
      abort();
    }
  }, [open, text, start, abort, reset]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const handleApply = () => {
    const finalText = polished.trim();
    if (!finalText) return;
    onApply(finalText);
    onClose();
  };

  const handleAbort = () => {
    abort();
    onClose();
  };

  const isStreaming = phase === 'connecting' || phase === 'streaming';
  const isError = phase === 'error';
  const canApply = polished.trim().length > 0 && !isStreaming;

  const overlay = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
      onClick={handleAbort}
    >
      <div
        className="rounded-2xl border border-white/10 bg-[#0f1014] shadow-2xl flex flex-col"
        style={{ width: 'min(640px, 92vw)', maxHeight: '78vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles size={15} style={{ color: 'rgba(168, 85, 247, 0.9)' }} />
            <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              AI 润色
            </span>
            {model.model && (
              <span className="text-[11px] font-mono" style={{ color: 'rgba(255,255,255,0.4)' }}>
                ● {model.model}
                {model.platform ? ` · ${model.platform}` : ''}
              </span>
            )}
          </div>
          <button
            onClick={handleAbort}
            className="p-1 rounded hover:bg-white/5 transition-colors"
            title="关闭"
          >
            <X size={14} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        {/* Body */}
        <div
          className="flex-1 px-5 py-4 flex flex-col gap-3"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {/* Original */}
          <div>
            <div className="text-[11px] mb-1.5" style={{ color: 'var(--text-muted)' }}>原文</div>
            <div
              className="text-[13px] px-3 py-2 rounded-lg whitespace-pre-wrap"
              style={{ background: 'rgba(255,255,255,0.03)', color: 'var(--text-secondary)', border: '1px solid var(--border-primary)' }}
            >
              {text}
            </div>
          </div>

          {/* Phase / status */}
          {(isStreaming || isError) && (
            <div
              className="flex items-center gap-2 text-[12px] px-3 py-2 rounded-lg"
              style={{
                background: isError ? 'rgba(239,68,68,0.08)' : 'rgba(56,189,248,0.08)',
                color: isError ? 'rgba(248,113,113,0.95)' : 'rgba(125,211,252,0.95)',
                border: `1px solid ${isError ? 'rgba(239,68,68,0.2)' : 'rgba(56,189,248,0.2)'}`,
              }}
            >
              {isStreaming && <MapSpinner size={12} />}
              <span>{phaseMessage || (isError ? '润色失败' : 'AI 准备中…')}</span>
            </div>
          )}

          {/* Thinking (collapsible) */}
          {thinking && (
            <div>
              <button
                onClick={() => setShowThinking((v) => !v)}
                className="text-[11px] mb-1.5 transition-colors hover:text-white"
                style={{ color: 'var(--text-muted)' }}
              >
                {showThinking ? '▾' : '▸'} 思考过程（{thinking.length} 字）
              </button>
              {showThinking && (
                <div
                  className="text-[11px] px-3 py-2 rounded-lg whitespace-pre-wrap font-mono leading-relaxed"
                  style={{ background: 'rgba(168,85,247,0.04)', color: 'rgba(196,138,255,0.75)', border: '1px solid rgba(168,85,247,0.15)' }}
                >
                  {thinking}
                </div>
              )}
            </div>
          )}

          {/* Polished result */}
          <div>
            <div className="text-[11px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
              润色后{isStreaming ? '（生成中…）' : ''}
            </div>
            <div
              className="text-[13px] px-3 py-2 rounded-lg whitespace-pre-wrap"
              style={{
                background: 'rgba(34,197,94,0.04)',
                color: 'var(--text-primary)',
                border: '1px solid rgba(34,197,94,0.18)',
                minHeight: 64,
              }}
            >
              {polished || (isStreaming ? <span style={{ color: 'var(--text-muted)' }}>等待 AI 输出…</span> : null)}
              {isStreaming && polished && (
                <span className="inline-block w-1.5 h-3 ml-0.5 animate-pulse" style={{ background: 'rgba(34,197,94,0.8)', verticalAlign: 'middle' }} />
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/10 shrink-0">
          <Button variant="ghost" size="sm" onClick={handleAbort}>
            <X size={13} /> {isStreaming ? '取消' : '放弃'}
          </Button>
          <Button variant="primary" size="sm" onClick={handleApply} disabled={!canApply}>
            <Check size={13} /> 替换原文
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
