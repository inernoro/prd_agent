import { useEffect, useState } from 'react';
import {
  RefreshCw,
  Trash2,
  ExternalLink,
  Loader2,
  GitPullRequest,
  GitPullRequestClosed,
  GitMerge,
  AlertTriangle,
  FileText,
} from 'lucide-react';
import { usePrReviewStore } from './usePrReviewStore';
import { AlignmentPanel } from './AlignmentPanel';
import { SummaryPanel } from './SummaryPanel';
import { PrRawContentModal } from './PrRawContentModal';
import type { PrReviewItemDto, PrReviewState } from '@/services/real/prReview';

interface Props {
  item: PrReviewItemDto;
}

function stateVisual(state: PrReviewState | string) {
  switch (state) {
    case 'merged':
      return { label: '已合并', color: 'text-purple-300 border-purple-400/30 bg-purple-400/10', Icon: GitMerge };
    case 'closed':
      return { label: '已关闭', color: 'text-red-300 border-red-400/30 bg-red-400/10', Icon: GitPullRequestClosed };
    case 'open':
    default:
      return { label: '进行中', color: 'text-emerald-300 border-emerald-400/30 bg-emerald-400/10', Icon: GitPullRequest };
  }
}

function formatDateTime(iso?: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

/**
 * 单条 PR 卡片：
 * - 默认折叠展示基本信息
 * - 点击卡片展开详情 + 笔记编辑
 * - 刷新/删除按钮
 * - 笔记失焦自动保存（乐观更新）
 */
export function PrItemCard({ item }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [noteDraft, setNoteDraft] = useState(item.note ?? '');
  const [rawOpen, setRawOpen] = useState(false);

  const refreshItem = usePrReviewStore((s) => s.refreshItem);
  const updateNote = usePrReviewStore((s) => s.updateNote);
  const deleteItem = usePrReviewStore((s) => s.deleteItem);
  const refreshing = usePrReviewStore((s) => s.refreshingIds.has(item.id));
  const savingNote = usePrReviewStore((s) => s.savingNoteIds.has(item.id));

  // 外部 item.note 变化时同步到本地 draft（刷新/回滚场景）
  useEffect(() => {
    setNoteDraft(item.note ?? '');
  }, [item.note]);

  const snapshot = item.snapshot;
  const visual = stateVisual(snapshot?.state ?? 'open');
  const Icon = visual.Icon;
  const hasError = !!item.lastRefreshError;

  const handleNoteBlur = () => {
    const next = noteDraft.trim() === '' ? null : noteDraft;
    if (next === (item.note ?? null)) return;
    void updateNote(item.id, next);
  };

  return (
    <div
      className={`rounded-xl border ${hasError ? 'border-red-500/30 bg-red-500/5' : 'border-white/10 bg-white/[0.03]'} transition overflow-hidden`}
    >
      {/* Header: 折叠态 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-5 py-4 text-left hover:bg-white/5 transition"
      >
        <div className="flex items-start gap-3">
          <Icon size={18} className={visual.color.split(' ')[0] + ' mt-1 shrink-0'} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-xs text-white/50">
              <span className="font-mono">
                {item.owner}/{item.repo}#{item.number}
              </span>
              <span className={`px-2 py-0.5 rounded-md border text-[11px] ${visual.color}`}>
                {visual.label}
              </span>
              {hasError && (
                <span className="flex items-center gap-1 text-red-300">
                  <AlertTriangle size={12} />
                  刷新异常
                </span>
              )}
            </div>
            <div className="mt-1 text-sm font-semibold text-white truncate">
              {snapshot?.title ?? '（尚未拉取到标题）'}
            </div>
            <div className="mt-1 flex items-center gap-3 text-xs text-white/40">
              {snapshot?.authorLogin && <span>作者 {snapshot.authorLogin}</span>}
              {snapshot && (
                <span>
                  +{snapshot.additions} / -{snapshot.deletions} · {snapshot.changedFiles} files
                </span>
              )}
              <span>更新 {formatDateTime(item.updatedAt)}</span>
            </div>
          </div>
        </div>
      </button>

      {/* Expanded: 详情 + 笔记 */}
      {expanded && (
        <div className="px-5 pb-5 border-t border-white/5">
          {/* 元数据网格 */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4 text-xs">
            <div>
              <div className="text-white/40">PR 创建</div>
              <div className="text-white/80">{formatDateTime(snapshot?.createdAt)}</div>
            </div>
            <div>
              <div className="text-white/40">合并时间</div>
              <div className="text-white/80">{formatDateTime(snapshot?.mergedAt)}</div>
            </div>
            <div>
              <div className="text-white/40">最近刷新</div>
              <div className="text-white/80">{formatDateTime(item.lastRefreshedAt)}</div>
            </div>
            {snapshot?.labels && snapshot.labels.length > 0 && (
              <div className="col-span-full">
                <div className="text-white/40 mb-1">标签</div>
                <div className="flex flex-wrap gap-1">
                  {snapshot.labels.map((l) => (
                    <span key={l} className="px-2 py-0.5 rounded-md bg-white/10 text-white/80 text-[11px]">
                      {l}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* 错误提示 */}
          {hasError && (
            <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
              <div className="font-semibold mb-1">最近刷新错误</div>
              <div className="text-red-200/80">{item.lastRefreshError}</div>
            </div>
          )}

          {/* 笔记 */}
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-white/40 mb-1.5">
              <span>我的笔记（Markdown，失焦自动保存）</span>
              {savingNote && (
                <span className="flex items-center gap-1">
                  <Loader2 size={10} className="animate-spin" />
                  保存中
                </span>
              )}
            </div>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              onBlur={handleNoteBlur}
              placeholder="写下你的审查想法..."
              rows={4}
              className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white placeholder-white/30 text-sm focus:border-white/30 focus:outline-none resize-none"
            />
          </div>

          {/* AI 变更摘要（档 1）*/}
          <div className="mt-4">
            <SummaryPanel itemId={item.id} cached={item.summaryReport} />
          </div>

          {/* AI 对齐度检查（档 3）*/}
          <div className="mt-3">
            <AlignmentPanel itemId={item.id} cached={item.alignmentReport} />
          </div>

          {/* 操作 */}
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRawOpen(true)}
              disabled={!snapshot}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-sky-500/15 text-sky-200 text-xs hover:bg-sky-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition"
              title={snapshot ? '查看 PR 描述和变更文件' : '尚未拉取到 PR 内容'}
            >
              <FileText size={14} />
              查看原文
            </button>
            <button
              type="button"
              onClick={() => void refreshItem(item.id)}
              disabled={refreshing}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50 transition"
            >
              {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              刷新
            </button>
            <a
              href={item.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 transition"
            >
              <ExternalLink size={14} />
              在 GitHub 打开
            </a>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => {
                if (window.confirm('删除这条 PR 记录？')) {
                  void deleteItem(item.id);
                }
              }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-red-300 text-xs hover:bg-red-500/10 transition"
            >
              <Trash2 size={14} />
              删除
            </button>
          </div>
        </div>
      )}

      {rawOpen && <PrRawContentModal itemId={item.id} onClose={() => setRawOpen(false)} />}
    </div>
  );
}
