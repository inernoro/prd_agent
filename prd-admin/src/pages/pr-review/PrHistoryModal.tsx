import { useEffect, useMemo, useState } from 'react';
import {
  X,
  Loader2,
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
  TriangleAlert,
} from 'lucide-react';
import {
  getPrReviewItemHistory,
  type PrHistoryDto,
  type PrHistoryCommit,
  type PrHistoryReview,
  type PrHistoryReviewComment,
  type PrHistoryIssueComment,
  type PrHistoryTimelineEvent,
  type PrHistoryCheckRun,
} from '@/services/real/prReview';
import { PrMarkdown } from './PrMarkdown';

interface Props {
  itemId: string;
  htmlUrl: string;
  onClose: () => void;
}

type TabKey = 'timeline' | 'commits' | 'reviews' | 'comments' | 'checks';

/**
 * PR 历史记录弹窗。
 *
 * 数据来源：GET /api/pr-review/items/{id}/history
 * 后端并行拉取 6 个 GitHub REST API（commits / reviews / review comments /
 * issue comments / timeline events / check runs），实时拉取不缓存。
 *
 * 5 个 tab：
 *   时间线 —— 统一事件流（committed / reviewed / commented / labeled / merged 等 20+）
 *   提交   —— 提交列表（作者、SHA、消息、时间）
 *   评审   —— 代码审查（APPROVED / CHANGES_REQUESTED / COMMENTED）
 *   评论   —— 行内评论 + 主对话评论合并按时间排序
 *   CI 检查 —— GitHub Actions / 其他 check runs 的状态
 */
export function PrHistoryModal({ itemId, htmlUrl, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PrHistoryDto | null>(null);
  const [tab, setTab] = useState<TabKey>('timeline');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const res = await getPrReviewItemHistory(itemId);
      if (cancelled) return;
      if (res.success && res.data) {
        setData(res.data);
      } else {
        setError(res.error?.message ?? '加载失败');
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const counts = useMemo(() => {
    if (!data) return { timeline: 0, commits: 0, reviews: 0, comments: 0, checks: 0 };
    return {
      timeline: data.timeline.length,
      commits: data.commits.length,
      reviews: data.reviews.length,
      comments: data.reviewComments.length + data.issueComments.length,
      checks: data.checkRuns.length,
    };
  }, [data]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-5xl max-h-[92vh] mx-4 rounded-xl border border-white/10 bg-[#0f1014] shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10 shrink-0">
          <History size={18} className="text-violet-300" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-white">GitHub 审查历史</div>
            <div className="text-[11px] text-white/50 mt-0.5">实时从 GitHub 拉取，不走缓存</div>
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
          <TabButton active={tab === 'timeline'} onClick={() => setTab('timeline')} icon={<History size={13} />} label="时间线" count={counts.timeline} />
          <TabButton active={tab === 'commits'} onClick={() => setTab('commits')} icon={<GitCommit size={13} />} label="提交" count={counts.commits} />
          <TabButton active={tab === 'reviews'} onClick={() => setTab('reviews')} icon={<Eye size={13} />} label="评审" count={counts.reviews} />
          <TabButton active={tab === 'comments'} onClick={() => setTab('comments')} icon={<MessageSquare size={13} />} label="评论" count={counts.comments} />
          <TabButton active={tab === 'checks'} onClick={() => setTab('checks')} icon={<Zap size={13} />} label="CI 检查" count={counts.checks} />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 text-sm text-white/50 py-16">
              <Loader2 size={16} className="animate-spin" />
              从 GitHub 加载历史...
            </div>
          )}

          {error && !loading && (
            <div className="flex items-start gap-2 p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-200">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">加载失败</div>
                <div className="text-red-200/80 mt-1">{error}</div>
              </div>
            </div>
          )}

          {data && !loading && !error && (
            <>
              {data.errors.length > 0 && (
                <div className="mb-4 flex items-start gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-200">
                  <TriangleAlert size={14} className="shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">部分数据拉取失败（可能是权限或 API 限流）</div>
                    <ul className="mt-1 space-y-0.5 text-amber-200/80">
                      {data.errors.map((e, i) => <li key={i}>· {e}</li>)}
                    </ul>
                  </div>
                </div>
              )}

              {tab === 'timeline' && <TimelineTab events={data.timeline} />}
              {tab === 'commits' && <CommitsTab commits={data.commits} />}
              {tab === 'reviews' && <ReviewsTab reviews={data.reviews} />}
              {tab === 'comments' && <CommentsTab reviewComments={data.reviewComments} issueComments={data.issueComments} />}
              {tab === 'checks' && <ChecksTab runs={data.checkRuns} />}
            </>
          )}
        </div>
      </div>
    </div>
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
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-2 text-xs transition relative ${
        active ? 'text-white' : 'text-white/50 hover:text-white/80'
      }`}
    >
      {icon}
      <span>{label}</span>
      <span className={`text-[10px] px-1.5 rounded-full ${active ? 'bg-violet-500/30 text-violet-200' : 'bg-white/5 text-white/40'}`}>
        {count}
      </span>
      {active && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-violet-400 rounded-t" />}
    </button>
  );
}

// ============================================================
// Timeline Tab —— 统一事件流
// ============================================================

function TimelineTab({ events }: { events: PrHistoryTimelineEvent[] }) {
  if (events.length === 0) {
    return <EmptyHint text="没有时间线事件" />;
  }

  return (
    <ol className="relative border-l-2 border-white/10 ml-3 space-y-3">
      {events.map((ev, i) => {
        const meta = timelineEventMeta(ev.event);
        return (
          <li key={i} className="pl-4 relative">
            {/* dot */}
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
                    {ev.actorLogin && <span className="font-semibold text-white">{ev.actorLogin}</span>}
                    {' '}
                    <span className="text-white/75">{buildTimelineDescription(ev)}</span>
                  </div>
                  {ev.commitMessage && (
                    <div className="mt-1 text-[11px] text-white/60 font-mono truncate">
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
  if (commits.length === 0) return <EmptyHint text="没有提交" />;
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
              <div className="mt-1 flex items-center gap-2 text-[11px] text-white/50 font-mono">
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
  if (reviews.length === 0) return <EmptyHint text="没有评审" />;
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
                  <span className="font-semibold text-white">{r.authorLogin}</span>
                  {' '}
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
// Comments Tab —— 合并行内评论 + 对话评论
// ============================================================

interface MergedComment {
  kind: 'review' | 'issue';
  id: number;
  authorLogin: string;
  body?: string | null;
  createdAt?: string | null;
  htmlUrl?: string | null;
  path?: string | null;
  line?: number | null;
  diffHunk?: string | null;
}

function CommentsTab({
  reviewComments,
  issueComments,
}: {
  reviewComments: PrHistoryReviewComment[];
  issueComments: PrHistoryIssueComment[];
}) {
  const merged = useMemo<MergedComment[]>(() => {
    const rc: MergedComment[] = reviewComments.map((c) => ({
      kind: 'review',
      id: c.id,
      authorLogin: c.authorLogin,
      body: c.body,
      createdAt: c.createdAt,
      htmlUrl: c.htmlUrl,
      path: c.path,
      line: c.line,
      diffHunk: c.diffHunk,
    }));
    const ic: MergedComment[] = issueComments.map((c) => ({
      kind: 'issue',
      id: c.id,
      authorLogin: c.authorLogin,
      body: c.body,
      createdAt: c.createdAt,
      htmlUrl: c.htmlUrl,
    }));
    return [...rc, ...ic].sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return ta - tb;
    });
  }, [reviewComments, issueComments]);

  if (merged.length === 0) return <EmptyHint text="没有评论" />;

  return (
    <div className="space-y-3">
      {merged.map((c) => (
        <div
          key={`${c.kind}-${c.id}`}
          className="rounded-lg border border-white/10 bg-white/[0.02] p-3"
        >
          <div className="flex items-start gap-2">
            <MessageSquare
              size={14}
              className={c.kind === 'review' ? 'text-sky-300 mt-0.5' : 'text-white/50 mt-0.5'}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-[11px] text-white/50">
                <span className="font-semibold text-white">{c.authorLogin}</span>
                <span className={`px-1.5 py-0.5 rounded ${c.kind === 'review' ? 'bg-sky-500/15 text-sky-200' : 'bg-white/5 text-white/60'}`}>
                  {c.kind === 'review' ? '行内评论' : '对话评论'}
                </span>
                {c.createdAt && (
                  <span className="font-mono">{formatDateTime(c.createdAt)}</span>
                )}
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
                    return <div key={i} className={cls}>{line || ' '}</div>;
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
  if (runs.length === 0) return <EmptyHint text="没有 CI 检查（head commit 可能无 check runs）" />;
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
                <div className="mt-1 flex items-center gap-2 text-[11px] text-white/50 font-mono">
                  <span>{meta.label}</span>
                  {r.appName && <><span>·</span><span>{r.appName}</span></>}
                  {r.completedAt && r.startedAt && (
                    <>
                      <span>·</span>
                      <span>{Math.max(0, Math.round((new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 1000))}s</span>
                    </>
                  )}
                  {r.startedAt && !r.completedAt && (
                    <><span>·</span><span>{formatDateTime(r.startedAt)}</span></>
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
  // 完成态看 conclusion
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
    return { icon: <Loader2 size={14} className="text-sky-300 animate-spin" />, label: '运行中', color: 'border-sky-500/20 bg-sky-500/[0.04]' };
  }
  // queued or other
  return { icon: <Clock size={14} className="text-white/50" />, label: r.status, color: 'border-white/10 bg-white/[0.02]' };
}

// ============================================================
// Shared helpers
// ============================================================

function EmptyHint({ text }: { text: string }) {
  return <div className="text-center text-xs text-white/40 py-16">{text}</div>;
}

function formatDateTime(iso?: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}
