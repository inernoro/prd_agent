import { useState, useEffect, useCallback } from 'react';
import { MessageSquare, Send, Trash2, Lock } from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '../ui/VideoLoader';
import { getUserAvatarUrl } from '../../lib/avatar';
import { useAuthStore } from '../../stores/authStore';
import {
  listShareComments, addShareComment,
  listSiteComments, addSiteComment,
  deleteSiteComment,
  type HostedSiteCommentDto,
} from '../../services/real/webPages';

/**
 * 托管站点评论区 —— 在分享页 / 站点预览下展示评论列表 + 发表入口。
 *
 * 两种数据来源（discriminated by mode）：
 * - mode='share'：经分享 token 读写（公开访问路径，读不需登录、写需登录）
 * - mode='site' ：经 siteId 读写（owner / 团队成员视角，恒需登录）
 *
 * 走 prd-admin 暗色面板配色（与 SharedSitePage / SitePreviewModal 一致）。
 */
type Props =
  | { mode: 'share'; token: string; password?: string; siteId?: never }
  | { mode: 'site'; siteId: string; token?: never; password?: never };

export default function CommentsSection(props: Props) {
  const { isAuthenticated } = useAuthStore();
  const [loading, setLoading] = useState(true);
  const [comments, setComments] = useState<HostedSiteCommentDto[]>([]);
  const [commentsEnabled, setCommentsEnabled] = useState(true);
  const [canComment, setCanComment] = useState(false);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = props.mode === 'share'
        ? await listShareComments(props.token, props.password)
        : await listSiteComments(props.siteId);
      if (res.success && res.data) {
        setComments(res.data.comments);
        setCommentsEnabled(res.data.commentsEnabled);
        setCanComment(res.data.canComment);
      } else {
        setError(res.error?.message || '加载评论失败');
      }
    } catch {
      setError('网络错误，无法加载评论');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mode, (props as { token?: string }).token, (props as { password?: string }).password, (props as { siteId?: string }).siteId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSubmit = async () => {
    const content = draft.trim();
    if (!content || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = props.mode === 'share'
        ? await addShareComment(props.token, content, props.password)
        : await addSiteComment(props.siteId, content);
      if (res.success && res.data) {
        setComments((prev) => [res.data!, ...prev]);
        setDraft('');
      } else {
        setError(res.error?.message || '发表失败');
      }
    } catch {
      setError('网络错误，发表失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (commentId: string) => {
    const res = await deleteSiteComment(commentId);
    if (res.success) {
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } else {
      setError(res.error?.message || '删除失败');
    }
  };

  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03]">
      <header className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
        <MessageSquare className="w-4 h-4 text-white/50" />
        <h2 className="text-sm font-semibold text-white">评论</h2>
        <span className="text-xs text-white/40">{comments.length}</span>
      </header>

      <div className="p-4 space-y-4">
        {/* 发表区 */}
        {!commentsEnabled ? (
          <div className="flex items-center gap-2 text-sm text-white/40 py-1">
            <Lock className="w-4 h-4" />
            该站点已关闭评论
          </div>
        ) : !isAuthenticated ? (
          <div className="flex items-center gap-2 text-sm text-white/40 py-1">
            <Lock className="w-4 h-4" />
            登录后即可发表评论
          </div>
        ) : canComment ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="写下你的评论…"
              rows={3}
              maxLength={2000}
              className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder-white/30 resize-none focus:outline-none focus:border-blue-500/50"
            />
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-white/30">{draft.length}/2000</span>
              <button
                onClick={handleSubmit}
                disabled={!draft.trim() || submitting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {submitting ? <MapSpinner size={14} /> : <Send className="w-3.5 h-3.5" />}
                发表
              </button>
            </div>
          </div>
        ) : null}

        {error && <p className="text-sm text-red-400">{error}</p>}

        {/* 列表区 */}
        {loading ? (
          <MapSectionLoader text="正在加载评论…" />
        ) : comments.length === 0 ? (
          <div className="text-center py-8 text-sm text-white/30">
            还没有评论，来发表第一条吧
          </div>
        ) : (
          <ul className="space-y-3">
            {comments.map((c) => (
              <li key={c.id} className="flex gap-3">
                <Avatar name={c.authorName} fileName={c.authorAvatarFileName} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white/90 truncate">{c.authorName}</span>
                    <span className="text-[11px] text-white/30">{formatTime(c.createdAt)}</span>
                    {c.canDelete && (
                      <button
                        onClick={() => handleDelete(c.id)}
                        title="删除评论"
                        className="ml-auto text-white/30 hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <p className="text-sm text-white/70 mt-0.5 whitespace-pre-wrap break-words">{c.content}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Avatar({ name, fileName }: { name: string; fileName?: string }) {
  // getUserAvatarUrl 永远返回有效 URL（缺头像时回退内置 data-uri），无需额外兜底分支
  const url = getUserAvatarUrl({ avatarFileName: fileName, displayName: name });
  return (
    <img
      src={url}
      alt={name}
      className="w-8 h-8 rounded-full object-cover shrink-0 bg-white/10"
    />
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = Math.floor((now - d.getTime()) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return d.toLocaleDateString('zh-CN');
}
