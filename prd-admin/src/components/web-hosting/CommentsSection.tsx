import { useState, useEffect, useRef, useCallback } from 'react';
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
 * 走 prd-admin 暗色面板配色（与 ShareViewPage / SitePreviewModal 一致）。
 */
type Props = (
  | { mode: 'share'; token: string; password?: string; siteId?: never }
  | { mode: 'site'; siteId: string; token?: never; password?: never }
) & {
  /** 服务端权威 commentsEnabled 拉到后回传，供父级（预览弹窗开关）与 stale site 快照对齐 */
  onStateLoaded?: (commentsEnabled: boolean) => void;
};

export default function CommentsSection(props: Props) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  // 鉴权 token：persist rehydration 后才有值；纳入 load 依赖，避免首帧匿名拉取后 canComment 卡 false
  const authToken = useAuthStore((s) => s.token);
  const [loading, setLoading] = useState(true);
  const [comments, setComments] = useState<HostedSiteCommentDto[]>([]);
  const [commentsEnabled, setCommentsEnabled] = useState(true);
  const [canComment, setCanComment] = useState(false);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 防竞态：token/password/siteId/登录态变化时旧请求回来不得覆盖新结果（Cursor learned rule）
  const fetchIdRef = useRef(0);

  const mode = props.mode;
  const token = (props as { token?: string }).token;
  const password = (props as { password?: string }).password;
  const siteId = (props as { siteId?: string }).siteId;
  const onStateLoaded = props.onStateLoaded;

  const load = useCallback(async () => {
    const myId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = mode === 'share'
        ? await listShareComments(token!, password)
        : await listSiteComments(siteId!);
      if (myId !== fetchIdRef.current) return; // 过期响应，丢弃
      if (res.success && res.data) {
        setComments(res.data.comments);
        setCommentsEnabled(res.data.commentsEnabled);
        setCanComment(res.data.canComment);
        onStateLoaded?.(res.data.commentsEnabled);
      } else {
        setError(res.error?.message || '加载评论失败');
      }
    } catch {
      if (myId !== fetchIdRef.current) return;
      setError('网络错误，无法加载评论');
    } finally {
      if (myId === fetchIdRef.current) setLoading(false);
    }
  }, [mode, token, password, siteId, onStateLoaded]);

  // isAuthenticated / authToken 纳入依赖：登录态就绪（含 persist rehydration）后重新拉取，
  // 让已登录用户拿到 canComment=true 的发表 UI，不必手动刷新。
  useEffect(() => {
    void load();
  }, [load, isAuthenticated, authToken]);

  const handleSubmit = async () => {
    const content = draft.trim();
    if (!content || submitting) return;
    const reqId = fetchIdRef.current; // 锁定当前线程，回来后变了就丢弃（防串线程，Cursor learned rule）
    setSubmitting(true);
    setError(null);
    try {
      const res = mode === 'share'
        ? await addShareComment(token!, content, password)
        : await addSiteComment(siteId!, content);
      if (reqId !== fetchIdRef.current) return; // token/siteId/password/登录态已变，结果作废
      if (res.success && res.data) {
        setComments((prev) => [res.data!, ...prev]);
        setDraft('');
      } else {
        setError(res.error?.message || '发表失败');
      }
    } catch {
      if (reqId !== fetchIdRef.current) return;
      setError('网络错误，发表失败');
    } finally {
      if (reqId === fetchIdRef.current) setSubmitting(false);
    }
  };

  const handleDelete = async (commentId: string) => {
    const reqId = fetchIdRef.current;
    const res = await deleteSiteComment(commentId);
    if (reqId !== fetchIdRef.current) return; // 删除在途时线程已切换，late 响应不动新线程的列表
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
