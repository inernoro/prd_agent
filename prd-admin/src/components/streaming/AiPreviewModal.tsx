import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, RotateCw, Check, Brain, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText, MapCursor } from '@/components/streaming';
import type { AiPreviewModel } from '@/lib/useAiPreviewStream';

export interface AiPreviewModalProps {
  /** 是否打开 */
  open: boolean;
  /** 流式累积主文本 */
  text: string;
  /** 思考过程 (推理模型) */
  thinking?: string;
  /** 是否仍在流式 */
  streaming: boolean;
  /** 阶段文案 (心跳/等待时给出) */
  phaseMessage?: string;
  /** 错误信息 */
  error?: string | null;
  /** 模型徽标 */
  model?: AiPreviewModel | null;
  /** 弹窗标题 (如 "AI 润色预览") */
  title?: string;
  /** 副标题 (可选) */
  subtitle?: string;
  /** 是否按 markdown 渲染最终结果 (流式期间仍走纯文本动画) */
  markdown?: boolean;
  /** 自定义 markdown 渲染器 */
  renderMarkdown?: (content: string) => ReactNode;
  /** 应用结果 */
  onApply: () => void;
  /** 重新生成 */
  onRegenerate: () => void;
  /** 取消 */
  onCancel: () => void;
  /** 应用按钮文案, 默认 "应用" */
  applyLabel?: string;
}

/**
 * 通用 AI 预览弹窗 —— 一次性 AI 端点升级流式 + 预览的统一 UI。
 *
 * 与 <see cref="useAiPreviewStream"/> 配对使用。
 *
 * 设计约束 (遵守 .claude/rules/frontend-modal.md):
 * - createPortal 到 document.body
 * - 关键尺寸用 inline style (height: 80vh / maxHeight: 80vh)
 * - 滚动区 min-h-0 + overflow-y-auto + overscroll-behavior: contain
 * - ESC + 点蒙版关闭
 *
 * 动效约束 (遵守 doc/rule.frontend.streaming-text.md):
 * - 流式主体用 <StreamingText> Blur focus
 * - 思考块用 <StreamingText> + 折叠面板, 禁裸文本
 * - 流式期间纯文本词级动画, 完成后切 markdown (markdown=true)
 */
export function AiPreviewModal({
  open,
  text,
  thinking,
  streaming,
  phaseMessage,
  error,
  model,
  title = 'AI 预览',
  subtitle,
  markdown = false,
  renderMarkdown,
  onApply,
  onRegenerate,
  onCancel,
  applyLabel = '应用',
}: AiPreviewModalProps) {
  const [thinkingOpen, setThinkingOpen] = useState(true);
  useEffect(() => {
    if (text && streaming) setThinkingOpen(false);
  }, [text, streaming]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const canApply = !streaming && !!text && !error;

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)' }}
      onClick={onCancel}
    >
      <div
        className="flex flex-col rounded-xl border"
        onClick={(e) => e.stopPropagation()}
        style={{
          height: '80vh',
          maxHeight: '80vh',
          width: 'min(720px, 92vw)',
          background: 'var(--bg-card, #1E1F20)',
          borderColor: 'var(--border-subtle, rgba(255,255,255,0.1))',
          color: 'var(--text-primary, #fff)',
        }}
      >
        {/* Header */}
        <div className="shrink-0 flex items-start gap-3 px-5 py-4 border-b" style={{ borderColor: 'var(--border-subtle, rgba(255,255,255,0.1))' }}>
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold flex items-center gap-2">
              {title}
              {streaming && (
                <span className="text-[11px] font-normal opacity-60 flex items-center gap-1">
                  <MapSpinner size={12} />
                  {phaseMessage || '正在生成…'}
                </span>
              )}
            </div>
            {subtitle && (
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{subtitle}</div>
            )}
            {model?.model && (
              <div className="flex items-center gap-1.5 text-[10px] mt-1 font-mono opacity-60">
                <span>● {model.model}</span>
                {model.platform && <span>· {model.platform}</span>}
                {model.modelGroupName && <span>· pool: {model.modelGroupName}</span>}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 p-1 rounded hover:bg-white/5"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div
          className="flex-1 px-5 py-4 flex flex-col gap-3"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {/* Thinking block */}
          {thinking && (
            <div className="rounded-lg border" style={{ borderColor: 'rgba(168,85,247,0.25)', background: 'rgba(168,85,247,0.04)' }}>
              <button
                type="button"
                onClick={() => setThinkingOpen((v) => !v)}
                className="w-full flex items-center gap-2 px-3 py-2 text-[11px] hover:bg-white/[0.03] transition"
                style={{ color: 'rgba(196,138,255,0.85)' }}
              >
                {thinkingOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <Brain size={12} />
                <span className="font-semibold">AI 思考过程</span>
                <span className="opacity-60">· {thinking.length} 字符</span>
                {streaming && !text && <MapSpinner size={10} className="ml-auto" />}
              </button>
              {thinkingOpen && (
                <pre
                  className="px-3 pb-3 text-[11px] font-mono whitespace-pre-wrap break-words max-h-48 overflow-auto"
                  style={{ color: 'rgba(196,138,255,0.7)' }}
                >
                  <StreamingText
                    text={thinking}
                    streaming={streaming && !text}
                    cursorContent={<MapCursor size={11} />}
                  />
                </pre>
              )}
            </div>
          )}

          {/* Main output */}
          <div className="text-[13px] leading-[1.7] break-words">
            {text ? (
              <StreamingText
                text={text}
                streaming={streaming}
                markdown={markdown}
                renderMarkdown={renderMarkdown}
                cursorContent={<MapCursor size={12} />}
              />
            ) : streaming ? (
              <div className="flex items-center gap-2 text-[12px] opacity-60">
                <MapSpinner size={14} />
                <span>{phaseMessage || '等待 AI 输出…'}</span>
              </div>
            ) : error ? null : (
              <div className="text-[12px] opacity-50">暂无内容</div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-lg border p-3 text-[12px] flex items-start gap-2" style={{ borderColor: 'rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.06)', color: 'rgba(239,68,68,0.95)' }}>
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <div>{error}</div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--border-subtle, rgba(255,255,255,0.1))' }}>
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="ghost" size="sm" onClick={onRegenerate} disabled={streaming}>
            <RotateCw size={13} className="mr-1" />重新生成
          </Button>
          <Button size="sm" onClick={onApply} disabled={!canApply}>
            <Check size={13} className="mr-1" />{applyLabel}
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
