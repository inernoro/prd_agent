import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  AlertTriangle,
  History,
  GitCommit,
  MessageSquare,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Clock,
  ExternalLink,
  FileText,
  Tag,
  UserPlus,
  UserMinus,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequest,
  Eye,
  Pencil,
  Play,
  AlertCircle,
  Zap,
  Plus,
} from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import {
  getPrReviewItemHistorySlice,
  type PrHistoryCommit,
  type PrHistoryReview,
  type PrHistoryReviewComment,
  type PrHistoryIssueComment,
  type PrHistoryTimelineEvent,
  type PrHistoryCheckRun,
  type PrHistorySliceType,
} from '@/services/real/prReview';
import { PrMarkdown } from './PrMarkdown';

interface Props {
  itemId: string;
  htmlUrl: string;
  onClose: () => void;
}

/**
 * PR 历史记录弹窗 —— 按 tab 懒加载版本。
 *
 * 改进点（相对第一版）：
 * 1. 改用 createPortal 挂到 document.body，避开 PrItemCard 的 overflow-hidden 裁剪
 * 2. 用 `flex-1 min-h-0 overflow-y-auto` 修复经典的 flexbox 滚动 bug
 *    （flex 子元素默认 min-height:auto 会阻止 overflow 生效，必须显式 min-h-0）
 * 3. 按 tab 懒加载：默认只拉 timeline，其他 tab 点击时才拉对应 endpoint
 * 4. 分页：每页 30 条，items.length >= 30 时展示"加载更多"按钮
 * 5. 每个 tab 的 state 独立缓存，切 tab 不重复拉取
 *
 * 性能对比：
 *   第一版：打开即并行拉 6 个 endpoint，实测 2-3s
 *   新版：打开只拉 timeline 1 个 endpoint，实测 300-600ms
 */

type TabKey = PrHistorySliceType;

interface TabState<T> {
  items: T[];
  page: number;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

function initState<T>(): TabState<T> {
  return { items: [], page: 0, hasMore: true, loading: false, loaded: false, error: null };
}

const TAB_ORDER: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'timeline', label: '时间线', icon: <History size={13} /> },
  { key: 'commits', label: '提交', icon: <GitCommit size={13} /> },
  { key: 'reviews', label: '评审', icon: <Eye size={13} /> },
  { key: 'issueComments', label: '对话评论', icon: <MessageSquare size={13} /> },
  { key: 'reviewComments', label: '行内评论', icon: <FileText size={13} /> },
  { key: 'checkRuns', label: 'CI 检查', icon: <Zap size={13} /> },
];

export function PrHistoryModal({ itemId, htmlUrl, onClose }: Props) {
  const [tab, setTab] = useState<TabKey>('timeline');

  // 每个 tab 独立的状态。用一个 map 存比用 6 个 useState 干净
  const [states, setStates] = useState<{
    timeline: TabState<PrHistoryTimelineEvent>;
    commits: TabState<PrHistoryCommit>;
    reviews: TabState<PrHistoryReview>;
    reviewComments: TabState<PrHistoryReviewComment>;
    issueComments: TabState<PrHistoryIssueComment>;
    checkRuns: TabState<PrHistoryCheckRun>;
  }>({
    timeline: initState(),
    commits: initState(),
    reviews: initState(),
    reviewComments: initState(),
    issueComments: initState(),
    checkRuns: initState(),
  });

  const loadTab = useCallback(async (key: TabKey, append: boolean) => {
    const current = (states as Record<TabKey, TabState<unknown>>)[key];
    if (current.loading) return;
    const nextPage = append ? current.page + 1 : 1;

    setStates((prev) => ({
      ...prev,
      [key]: { ...prev[key], loading: true, error: null },
    }));

    const res = await getPrReviewItemHistorySlice(itemId, key, nextPage, 30);

    setStates((prev) => {
      if (!res.success || !res.data) {
        return {
          ...prev,
          [key]: {
            ...prev[key],
            loading: false,
            error: res.error?.message ?? '加载失败',
            loaded: true,
          },
        };
      }
      const d = res.data;
      const existing = append ? prev[key].items : [];
      return {
        ...prev,
        [key]: {
          items: [...existing, ...(d.items as unknown[])],
          page: d.page,
          hasMore: d.hasMore,
          loading: false,
          loaded: true,
          error: null,
        },
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  // 打开弹窗时自动加载当前 tab；切 tab 时如果没加载过也触发一次
  useEffect(() => {
    const current = (states as Record<TabKey, TabState<unknown>>)[tab];
    if (!current.loaded && !current.loading) {
      void loadTab(tab, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      style={{
        // 显式 inset 避免任何 Tailwind v4 处理 `inset-0` 的边缘情况
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        padding: '16px',
      }}
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-5xl rounded-xl border border-white/10 bg-[#0f1014] shadow-2xl flex flex-col overflow-hidden"
        style={{
          // 关键：用 inline style 强制高度 = 视口 90%，绕过 Tailwind JIT
          // 可能遇到的任何 arbitrary value 问题（用户反馈过两次 modal 超出
          // 屏幕 —— 说明 `h-[90vh]` 类在 v4 Oxide 上行为和预期不一致）
          height: '90vh',
          maxHeight: '90vh',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10 shrink-0">
          <History size={18} className="text-violet-300" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-white">GitHub 审查历史</div>
            <div className="text-[11px] text-white/50 mt-0.5">按 tab 懒加载，单次请求 300-600ms</div>
          </div>
          <a
            href={htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/70 hover:text-white text-xs transition"
          >
            <ExternalLink size={12} />
            GitHub
          </a>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex items-center gap-1 px-4 border-b border-white/10 shrink-0 overflow-x-auto">
          {TAB_ORDER.map((t) => {
            const s = (states as Record<TabKey, TabState<unknown>>)[t.key];
            return (
              <TabButton
                key={t.key}
                active={tab === t.key}
                onClick={() => setTab(t.key)}
                icon={t.icon}
                label={t.label}
                count={s.loaded ? s.items.length : undefined}
                loading={s.loading && !s.loaded}
              />
            );
          })}
        </div>

        {/* Body —— flex-1 + min-h-0 是 flex 子元素 overflow 的必要组合，
            但同样用 inline style 兜底避免 Tailwind 变种问题 */}
        <div
          className="flex-1 px-5 py-4"
          style={{
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain', // 防止滚动链穿透到 body
          }}
        >
          {tab === 'timeline' && (
            <TabWrapper
              state={states.timeline}
              onLoadMore={() => void loadTab('timeline', true)}
              emptyText="没有时间线事件"
            >
              <TimelineTab events={states.timeline.items} />
            </TabWrapper>
          )}
          {tab === 'commits' && (
            <TabWrapper
              state={states.commits}
              onLoadMore={() => void loadTab('commits', true)}
              emptyText="没有提交"
            >
              <CommitsTab commits={states.commits.items} />
            </TabWrapper>
          )}
          {tab === 'reviews' && (
            <TabWrapper
              state={states.reviews}
              onLoadMore={() => void loadTab('reviews', true)}
              emptyText="没有评审"
            >
              <ReviewsTab reviews={states.reviews.items} />
            </TabWrapper>
          )}
          {tab === 'issueComments' && (
            <TabWrapper
              state={states.issueComments}
              onLoadMore={() => void loadTab('issueComments', true)}
              emptyText="没有对话评论"
            >
              <IssueCommentsTab comments={states.issueComments.items} />
            </TabWrapper>
          )}
          {tab === 'reviewComments' && (
            <TabWrapper
              state={states.reviewComments}
              onLoadMore={() => void loadTab('reviewComments', true)}
              emptyText="没有行内评论"
            >
              <ReviewCommentsTab comments={states.reviewComments.items} />
            </TabWrapper>
          )}
          {tab === 'checkRuns' && (
            <TabWrapper
              state={states.checkRuns}
              onLoadMore={() => void loadTab('checkRuns', true)}
              emptyText="没有 CI 检查（head commit 可能无 check runs）"
            >
              <ChecksTab runs={states.checkRuns.items} />
            </TabWrapper>
          )}
        </div>
      </div>
    </div>
  );

  // createPortal 是必须的 —— 否则会被 PrItemCard 外层的 overflow-hidden 裁剪，
  // 导致内容超出卡片边界就看不到也滚动不了
  return createPortal(modal, document.body);
}

// ============================================================
// 通用 tab 容器：loading / error / empty / 内容 / 加载更多
// ============================================================

function TabWrapper<T>({
  state,
  onLoadMore,
  emptyText,
  children,
}: {
  state: TabState<T>;
  onLoadMore: () => void;
  emptyText: string;
  children: React.ReactNode;
}) {
  // 首次加载占位
  if (!state.loaded && state.loading) {
    return <MapSectionLoader text="从 GitHub 加载..." />;
  }

  if (state.error) {
    return (
      <div className="flex items-start gap-2 p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-200">
        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
        <div>
          <div className="font-semibold">加载失败</div>
          <div className="text-red-200/80 mt-1">{state.error}</div>
        </div>
      </div>
    );
  }

  if (state.items.length === 0) {
    return <div className="text-center text-xs text-white/40 py-16">{emptyText}</div>;
  }

  return (
    <>
      {children}
      {state.hasMore && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={state.loading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-50 text-xs text-white/80 transition border border-white/10"
          >
            {state.loading ? (
              <MapSpinner size={14} />
            ) : (
              <Plus size={14} />
            )}
            加载更多（当前 {state.items.length} 条 · 第 {state.page} 页）
          </button>
        </div>
      )}
      {!state.hasMore && state.items.length > 30 && (
        <div className="mt-4 text-center text-[10px] text-white/30">
          已加载全部 {state.items.length} 条
        </div>
      )}
    </>
  );
}

// ============================================================
// Tab button
// ============================================================

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
  loading,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-2 text-xs transition relative shrink-0 ${
        active ? 'text-white' : 'text-white/50 hover:text-white/80'
      }`}
    >
      {icon}
      <span>{label}</span>
      {loading ? (
        <MapSpinner size={10} style={{ opacity: 0.6 }} />
      ) : count != null ? (
        <span
          className={`text-[10px] px-1.5 rounded-full ${
            active ? 'bg-violet-500/30 text-violet-200' : 'bg-white/5 text-white/40'
          }`}
        >
          {count}
        </span>
      ) : null}
      {active && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-violet-400 rounded-t" />
      )}
    </button>
  );
}

// ============================================================
// Timeline Tab —— 统一事件流
// ============================================================

function TimelineTab({ events }: { events: PrHistoryTimelineEvent[] }) {
  return (
    <ol className="relative border-l-2 border-white/10 ml-3 space-y-3">
      {events.map((ev, i) => {
        const meta = timelineEventMeta(ev.event);
        return (
          <li key={i} className="pl-4 relative">
            <div
              className={`absolute w-4 h-4 rounded-full -left-[9px] flex items-center justify-center ${meta.dotBg}`}
            >
              <div className="w-1.5 h-1.5 rounded-full bg-white/80" />
            </div>
            <div className={`rounded-lg border px-3 py-2 ${meta.color}`}>
              <div className="flex items-start gap-2">
                <div className="shrink-0 mt-0.5">{meta.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs leading-relaxed">
                    {ev.actorLogin && <span className="font-semibold text-white">{ev.actorLogin}</span>}{' '}
                    <span className="text-white/75">{buildTimelineDescription(ev)}</span>
                  </div>
                  {ev.commitMessage && (
                    <div className="mt-1 text-[11px] text-white/60 font-mono break-words">
                      {ev.commitMessage}
                      {ev.commitSha && <span className="ml-2 text-white/40">{ev.commitSha.slice(0, 7)}</span>}
                    </div>
                  )}
                  {ev.body && (
                    <div className="mt-1.5 text-[12px] text-white/75">
                      <PrMarkdown variant="inline">{ev.body}</PrMarkdown>
                    </div>
                  )}
                  {ev.createdAt && (
                    <div className="mt-1 text-[10px] text-white/35 font-mono flex items-center gap-1">
                      <Clock size={10} />
                      {formatDateTime(ev.createdAt)}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

interface TimelineMeta {
  icon: React.ReactNode;
  color: string;
  dotBg: string;
}

function timelineEventMeta(event: string): TimelineMeta {
  switch (event) {
    case 'committed':
      return { icon: <GitCommit size={12} className="text-sky-300" />, color: 'border-sky-500/20 bg-sky-500/[0.04]', dotBg: 'bg-sky-500/40' };
    case 'reviewed':
      return { icon: <Eye size={12} className="text-violet-300" />, color: 'border-violet-500/20 bg-violet-500/[0.04]', dotBg: 'bg-violet-500/40' };
    case 'commented':
      return { icon: <MessageSquare size={12} className="text-white/60" />, color: 'border-white/10 bg-white/[0.02]', dotBg: 'bg-white/30' };
    case 'labeled':
    case 'unlabeled':
      return { icon: <Tag size={12} className="text-amber-300" />, color: 'border-amber-500/20 bg-amber-500/[0.04]', dotBg: 'bg-amber-500/40' };
    case 'assigned':
    case 'unassigned':
      return { icon: <UserPlus size={12} className="text-teal-300" />, color: 'border-teal-500/20 bg-teal-500/[0.04]', dotBg: 'bg-teal-500/40' };
    case 'review_requested':
    case 'review_request_removed':
      return { icon: <UserMinus size={12} className="text-indigo-300" />, color: 'border-indigo-500/20 bg-indigo-500/[0.04]', dotBg: 'bg-indigo-500/40' };
    case 'merged':
      return { icon: <GitMerge size={12} className="text-purple-300" />, color: 'border-purple-500/20 bg-purple-500/[0.04]', dotBg: 'bg-purple-500/40' };
    case 'closed':
      return { icon: <GitPullRequestClosed size={12} className="text-red-300" />, color: 'border-red-500/20 bg-red-500/[0.04]', dotBg: 'bg-red-500/40' };
    case 'reopened':
      return { icon: <GitPullRequest size={12} className="text-emerald-300" />, color: 'border-emerald-500/20 bg-emerald-500/[0.04]', dotBg: 'bg-emerald-500/40' };
    case 'head_ref_force_pushed':
      return { icon: <AlertCircle size={12} className="text-orange-300" />, color: 'border-orange-500/20 bg-orange-500/[0.04]', dotBg: 'bg-orange-500/40' };
    case 'head_ref_deleted':
      return { icon: <MinusCircle size={12} className="text-white/40" />, color: 'border-white/10 bg-white/[0.02]', dotBg: 'bg-white/20' };
    case 'renamed':
      return { icon: <Pencil size={12} className="text-cyan-300" />, color: 'border-cyan-500/20 bg-cyan-500/[0.04]', dotBg: 'bg-cyan-500/40' };
    case 'ready_for_review':
      return { icon: <Play size={12} className="text-emerald-300" />, color: 'border-emerald-500/20 bg-emerald-500/[0.04]', dotBg: 'bg-emerald-500/40' };
    case 'convert_to_draft':
    case 'converted_to_draft':
      return { icon: <FileText size={12} className="text-white/60" />, color: 'border-white/10 bg-white/[0.02]', dotBg: 'bg-white/30' };
    default:
      return { icon: <History size={12} className="text-white/40" />, color: 'border-white/10 bg-white/[0.02]', dotBg: 'bg-white/25' };
  }
}

function buildTimelineDescription(ev: PrHistoryTimelineEvent): string {
  switch (ev.event) {
    case 'committed':
      return '推送了提交';
    case 'reviewed':
      if (ev.state === 'APPROVED') return '提交了评审：✅ 批准';
      if (ev.state === 'CHANGES_REQUESTED') return '提交了评审：❌ 需要修改';
      if (ev.state === 'COMMENTED') return '提交了评审：💬 评论';
      return '提交了评审';
    case 'commented':
      return '发表了评论';
    case 'labeled':
      return `添加了标签 ${ev.label ?? ''}`.trim();
    case 'unlabeled':
      return `移除了标签 ${ev.label ?? ''}`.trim();
    case 'assigned':
      return `指派给 ${ev.assigneeLogin ?? ''}`.trim();
    case 'unassigned':
      return `取消指派 ${ev.assigneeLogin ?? ''}`.trim();
    case 'review_requested':
      return `请求 ${ev.requestedReviewerLogin ?? ''} 评审`.trim();
    case 'review_request_removed':
      return `取消了 ${ev.requestedReviewerLogin ?? ''} 的评审请求`.trim();
    case 'merged':
      return '合并了 PR';
    case 'closed':
      return '关闭了 PR';
    case 'reopened':
      return '重新打开了 PR';
    case 'head_ref_force_pushed':
      return '强制推送了 head 分支（历史被覆盖）';
    case 'head_ref_deleted':
      return '删除了 head 分支';
    case 'renamed':
      return `重命名了标题 ${ev.rename ?? ''}`.trim();
    case 'ready_for_review':
      return '标记为可评审（从草稿恢复）';
    case 'converted_to_draft':
    case 'convert_to_draft':
      return '转为草稿';
    case 'mentioned':
      return '被提及';
    case 'cross-referenced':
      return '被其他 issue/PR 交叉引用';
    default:
      return ev.event;
  }
}

// ============================================================
// Commits Tab
// ============================================================

function CommitsTab({ commits }: { commits: PrHistoryCommit[] }) {
  return (
    <div className="space-y-2">
      {commits.map((c) => (
        <a
          key={c.sha}
          href={c.htmlUrl ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="block rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/20 transition p-3"
        >
          <div className="flex items-start gap-3">
            <GitCommit size={14} className="text-sky-300 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-white leading-snug break-words">
                {c.message.split('\n')[0]}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-white/50 font-mono flex-wrap">
                <span className="text-sky-300">{c.sha.slice(0, 7)}</span>
                <span>·</span>
                <span>{c.authorLogin ?? c.authorName}</span>
                {c.authoredAt && (
                  <>
                    <span>·</span>
                    <span>{formatDateTime(c.authoredAt)}</span>
                  </>
                )}
              </div>
            </div>
            <ExternalLink size={12} className="text-white/30 mt-1" />
          </div>
        </a>
      ))}
    </div>
  );
}

// ============================================================
// Reviews Tab
// ============================================================

function ReviewsTab({ reviews }: { reviews: PrHistoryReview[] }) {
  return (
    <div className="space-y-3">
      {reviews.map((r) => {
        const meta = reviewStateMeta(r.state);
        return (
          <div key={r.id} className={`rounded-lg border p-3 ${meta.color}`}>
            <div className="flex items-start gap-2">
              <div className="shrink-0 mt-0.5">{meta.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="text-xs">
                  <span className="font-semibold text-white">{r.authorLogin}</span>{' '}
                  <span className="text-white/70">{meta.label}</span>
                </div>
                {r.body && r.body.trim() && (
                  <div className="mt-2 text-[13px] text-white/85">
                    <PrMarkdown>{r.body}</PrMarkdown>
                  </div>
                )}
                {r.submittedAt && (
                  <div className="mt-1.5 text-[10px] text-white/35 font-mono flex items-center gap-1">
                    <Clock size={10} />
                    {formatDateTime(r.submittedAt)}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function reviewStateMeta(state: string) {
  switch (state) {
    case 'APPROVED':
      return { icon: <CheckCircle2 size={14} className="text-emerald-300" />, label: '批准', color: 'border-emerald-500/20 bg-emerald-500/[0.04]' };
    case 'CHANGES_REQUESTED':
      return { icon: <XCircle size={14} className="text-red-300" />, label: '要求修改', color: 'border-red-500/20 bg-red-500/[0.04]' };
    case 'COMMENTED':
      return { icon: <MessageSquare size={14} className="text-sky-300" />, label: '评论', color: 'border-sky-500/20 bg-sky-500/[0.04]' };
    case 'DISMISSED':
      return { icon: <MinusCircle size={14} className="text-white/50" />, label: '已废弃', color: 'border-white/10 bg-white/[0.02]' };
    case 'PENDING':
      return { icon: <Clock size={14} className="text-amber-300" />, label: '草稿中', color: 'border-amber-500/20 bg-amber-500/[0.04]' };
    default:
      return { icon: <Eye size={14} className="text-white/50" />, label: state, color: 'border-white/10 bg-white/[0.02]' };
  }
}

// ============================================================
// Issue Comments Tab（主对话评论）
// ============================================================

function IssueCommentsTab({ comments }: { comments: PrHistoryIssueComment[] }) {
  return (
    <div className="space-y-3">
      {comments.map((c) => (
        <div key={c.id} className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <div className="flex items-start gap-2">
            <MessageSquare size={14} className="text-white/50 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-[11px] text-white/50">
                <span className="font-semibold text-white">{c.authorLogin}</span>
                {c.createdAt && <span className="font-mono">{formatDateTime(c.createdAt)}</span>}
              </div>
              {c.body && (
                <div className="mt-2 text-[13px] text-white/85">
                  <PrMarkdown>{c.body}</PrMarkdown>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// Review Comments Tab（行内评论 + diff 上下文）
// ============================================================

function ReviewCommentsTab({ comments }: { comments: PrHistoryReviewComment[] }) {
  return (
    <div className="space-y-3">
      {comments.map((c) => (
        <div key={c.id} className="rounded-lg border border-sky-500/20 bg-sky-500/[0.04] p-3">
          <div className="flex items-start gap-2">
            <MessageSquare size={14} className="text-sky-300 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-[11px] text-white/50 flex-wrap">
                <span className="font-semibold text-white">{c.authorLogin}</span>
                {c.createdAt && <span className="font-mono">{formatDateTime(c.createdAt)}</span>}
              </div>
              {c.path && (
                <div className="mt-1 text-[11px] text-white/50 font-mono">
                  <FileText size={10} className="inline mr-1" />
                  {c.path}
                  {c.line != null && <span className="text-white/40">:L{c.line}</span>}
                </div>
              )}
              {c.diffHunk && (
                <pre className="mt-1.5 text-[10px] leading-relaxed font-mono whitespace-pre overflow-x-auto bg-black/40 rounded p-2 max-h-32 border border-white/5">
                  {c.diffHunk.split('\n').map((line, i) => {
                    let cls = 'text-white/60';
                    if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-300';
                    else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-300';
                    else if (line.startsWith('@@')) cls = 'text-sky-300';
                    return (
                      <div key={i} className={cls}>
                        {line || ' '}
                      </div>
                    );
                  })}
                </pre>
              )}
              {c.body && (
                <div className="mt-2 text-[13px] text-white/85">
                  <PrMarkdown>{c.body}</PrMarkdown>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// Checks Tab —— CI 状态
// ============================================================

function ChecksTab({ runs }: { runs: PrHistoryCheckRun[] }) {
  return (
    <div className="space-y-2">
      {runs.map((r) => {
        const meta = checkRunMeta(r);
        return (
          <a
            key={r.id}
            href={r.htmlUrl ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            className={`block rounded-lg border p-3 transition hover:bg-white/[0.04] ${meta.color}`}
          >
            <div className="flex items-start gap-3">
              <div className="shrink-0 mt-0.5">{meta.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-white leading-snug truncate">{r.name}</div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-white/50 font-mono flex-wrap">
                  <span>{meta.label}</span>
                  {r.appName && (
                    <>
                      <span>·</span>
                      <span>{r.appName}</span>
                    </>
                  )}
                  {r.completedAt && r.startedAt && (
                    <>
                      <span>·</span>
                      <span>
                        {Math.max(
                          0,
                          Math.round(
                            (new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 1000,
                          ),
                        )}
                        s
                      </span>
                    </>
                  )}
                  {r.startedAt && !r.completedAt && (
                    <>
                      <span>·</span>
                      <span>{formatDateTime(r.startedAt)}</span>
                    </>
                  )}
                </div>
              </div>
              <ExternalLink size={12} className="text-white/30 mt-1" />
            </div>
          </a>
        );
      })}
    </div>
  );
}

function checkRunMeta(r: PrHistoryCheckRun) {
  if (r.status === 'completed') {
    switch (r.conclusion) {
      case 'success':
        return { icon: <CheckCircle2 size={14} className="text-emerald-300" />, label: '成功', color: 'border-emerald-500/20 bg-emerald-500/[0.04]' };
      case 'failure':
        return { icon: <XCircle size={14} className="text-red-300" />, label: '失败', color: 'border-red-500/20 bg-red-500/[0.04]' };
      case 'cancelled':
        return { icon: <MinusCircle size={14} className="text-white/50" />, label: '已取消', color: 'border-white/10 bg-white/[0.02]' };
      case 'skipped':
        return { icon: <MinusCircle size={14} className="text-white/40" />, label: '已跳过', color: 'border-white/10 bg-white/[0.02]' };
      case 'timed_out':
        return { icon: <Clock size={14} className="text-amber-300" />, label: '超时', color: 'border-amber-500/20 bg-amber-500/[0.04]' };
      case 'action_required':
        return { icon: <AlertCircle size={14} className="text-orange-300" />, label: '需要操作', color: 'border-orange-500/20 bg-orange-500/[0.04]' };
      case 'neutral':
      default:
        return { icon: <MinusCircle size={14} className="text-white/50" />, label: r.conclusion ?? '完成', color: 'border-white/10 bg-white/[0.02]' };
    }
  }
  if (r.status === 'in_progress') {
    return { icon: <MapSpinner size={14} color="#7dd3fc" />, label: '运行中', color: 'border-sky-500/20 bg-sky-500/[0.04]' };
  }
  return { icon: <Clock size={14} className="text-white/50" />, label: r.status, color: 'border-white/10 bg-white/[0.02]' };
}

// ============================================================
// Shared helpers
// ============================================================

function formatDateTime(iso?: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}
