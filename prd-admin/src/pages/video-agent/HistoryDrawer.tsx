/**
 * 历史任务抽屉：右侧 drawer，createPortal 到 body
 * 遵循 frontend-modal.md 的 3 条硬约束（inline style 高度 / createPortal / flex min-h:0）
 */
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Clock, Video, AlertCircle, CheckCircle2, Wand2, FileType2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { VideoGenRunListItem } from '@/services/contracts/videoAgent';

export interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  runs: VideoGenRunListItem[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}

const STATUS_BADGES: Record<string, { label: string; bg: string; color: string; Icon: typeof CheckCircle2 }> = {
  Queued: { label: '排队中', bg: 'rgba(148,163,184,0.12)', color: '#94a3b8', Icon: Clock },
  Scripting: { label: '拆分镜', bg: 'rgba(59,130,246,0.14)', color: '#60a5fa', Icon: FileType2 },
  Editing: { label: '编辑中', bg: 'rgba(236,72,153,0.14)', color: '#f472b6', Icon: FileType2 },
  Rendering: { label: '渲染中', bg: 'rgba(167,139,250,0.14)', color: '#a78bfa', Icon: Video },
  Completed: { label: '已完成', bg: 'rgba(34,197,94,0.14)', color: '#4ade80', Icon: CheckCircle2 },
  Failed: { label: '失败', bg: 'rgba(239,68,68,0.14)', color: '#f87171', Icon: AlertCircle },
  Cancelled: { label: '已取消', bg: 'rgba(148,163,184,0.12)', color: '#94a3b8', Icon: X },
};

function formatRelativeTime(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export const HistoryDrawer: React.FC<HistoryDrawerProps> = ({
  open,
  onClose,
  runs,
  selectedRunId,
  onSelect,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const node = (
    <div className="fixed inset-0 z-[120]">
      {/* 遮罩 */}
      <div
        className="absolute inset-0"
        style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
      />

      {/* 抽屉面板 */}
      <div
        className="absolute top-0 right-0 flex flex-col"
        style={{
          width: 'min(420px, 92vw)',
          height: '100vh',
          background: 'var(--panel)',
          borderLeft: '1px solid var(--border-default)',
          boxShadow: '-10px 0 40px rgba(0,0,0,0.35)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="shrink-0 flex items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid var(--border-default)' }}
        >
          <div className="flex items-center gap-2">
            <Clock size={14} style={{ color: 'var(--text-muted)' }} />
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              历史任务
            </span>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {runs.length} 个
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:opacity-80 opacity-60"
            title="关闭（Esc）"
          >
            <X size={14} style={{ color: 'var(--text-muted)' }} />
          </button>
        </div>

        {/* List */}
        <div
          className="flex-1"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 px-6 text-center">
              <Clock size={28} style={{ color: 'var(--text-muted)', opacity: 0.4 }} />
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                还没有历史任务
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                提交一次生成后，会自动出现在这里
              </div>
            </div>
          ) : (
            <div className="py-2">
              {runs.map((run) => {
                const badge = STATUS_BADGES[run.status] ?? STATUS_BADGES.Queued;
                const isSelected = selectedRunId === run.id;
                const isVideogen = !!run.videoAssetUrl && run.scenesCount === 0;
                const Icon = badge.Icon;
                const modeIcon = isVideogen ? Wand2 : FileType2;
                const ModeIcon = modeIcon;
                return (
                  <button
                    key={run.id}
                    onClick={() => onSelect(run.id)}
                    className={cn('w-full text-left px-4 py-3 transition-colors flex flex-col gap-1')}
                    style={{
                      background: isSelected ? 'rgba(236,72,153,0.08)' : 'transparent',
                      borderLeft: '2px solid ' + (isSelected ? '#f472b6' : 'transparent'),
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <ModeIcon
                        size={11}
                        style={{ color: isVideogen ? '#a78bfa' : '#f472b6', flexShrink: 0 }}
                      />
                      <span
                        className="text-xs font-medium truncate flex-1"
                        style={{ color: 'var(--text-primary)' }}
                        title={run.articleTitle || run.id}
                      >
                        {run.articleTitle || '（未命名）'}
                      </span>
                      <span
                        className="shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded"
                        style={{ background: badge.bg, color: badge.color }}
                      >
                        <Icon size={9} />
                        {badge.label}
                      </span>
                    </div>
                    <div
                      className="flex items-center gap-2 text-[10px]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <span>{formatRelativeTime(run.createdAt)}</span>
                      {run.scenesCount > 0 && (
                        <>
                          <span>·</span>
                          <span>
                            {run.scenesReady}/{run.scenesCount} 镜头
                          </span>
                        </>
                      )}
                      {run.totalDurationSeconds > 0 && (
                        <>
                          <span>·</span>
                          <span>{run.totalDurationSeconds.toFixed(1)}s</span>
                        </>
                      )}
                    </div>
                    {run.errorMessage && (
                      <div
                        className="text-[10px] truncate"
                        style={{ color: '#f87171' }}
                        title={run.errorMessage}
                      >
                        {run.errorMessage}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
};

export default HistoryDrawer;
