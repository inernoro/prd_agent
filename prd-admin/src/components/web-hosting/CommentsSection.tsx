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
  /** 评论数变化时回传（含首次加载、发表、删除），供父级在顶栏按钮等处展示「评论 N」 */
  onCountChange?: (count: number) => void;
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
  // 组件卸载后所有在途请求都作废（避免卸载后 setState / onStateLoaded 拿 stale 值回写父组件，Cursor high）
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    // 卸载只翻 mountedRef：所有在途 handler（load/submit/delete）都已用 !mountedRef.current 兜底丢弃，
    // 无需再动 fetchIdRef（动它会触发 react-hooks/exhaustive-deps 的 ref-in-cleanup 告警）。
    return () => { mountedRef.current = false; };
  }, []);

  const mode = props.mode;
  const token = (props as { token?: string }).token;
  const password = (props as { password?: string }).password;
  const siteId = (props as { siteId?: string }).siteId;
  // onStateLoaded 走 ref：父级每次 render 传新内联函数也不污染 load 的依赖，
  // 避免 iframe onLoad 等无关 modal 重渲染触发评论列表重新拉取 + loading 闪烁（Cursor medium）
  const onStateLoadedRef = useRef(props.onStateLoaded);
  onStateLoadedRef.current = props.onStateLoaded;
  // 走 ref 同理：父级内联函数每次 render 都换新引用，不该污染下面 effect 的依赖
  const onCountChangeRef = useRef(props.onCountChange);
  onCountChangeRef.current = props.onCountChange;
  // 评论数变化（首次加载 / 乐观插入 / 删除 / 对账）回传父级，顶栏「评论 N」实时同步
  useEffect(() => {
    onCountChangeRef.current?.(comments.length);
  }, [comments.length]);

  // silent=true：后台对账刷新，不翻 loading（否则全屏 section loader 会盖掉刚乐观插入的评论，
  // 让发表后的新评论"闪没"，慢/失败的刷新更像没发成功，Cursor medium）。
  const load = useCallback(async (silent = false) => {
    const myId = ++fetchIdRef.current;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = mode === 'share'
        ? await listShareComments(token!, password)
        : await listSiteComments(siteId!);
      if (myId !== fetchIdRef.current || !mountedRef.current) return; // 过期/已卸载，丢弃
      if (res.success && res.data) {
        setComments(res.data.comments);
        setCommentsEnabled(res.data.commentsEnabled);
        setCanComment(res.data.canComment);
        onStateLoadedRef.current?.(res.data.commentsEnabled);
      } else if (!silent) {
        // 后台刷新失败保持静默：乐观插入的评论仍在屏上，不该用错误提示打断（发表已成功）
        setError(res.error?.message || '加载评论失败');
      }
    } catch {
      if (myId !== fetchIdRef.current || !mountedRef.current) return;
      if (!silent) setError('网络错误，无法加载评论');
    } finally {
      if (myId === fetchIdRef.current && mountedRef.current && !silent) setLoading(false);
    }
  }, [mode, token, password, siteId]);

  // isAuthenticated / authToken 纳入依赖：登录态就绪（含 persist rehydration）后重新拉取，
  // 让已登录用户拿到 canComment=true 的发表 UI，不必手动刷新。
  useEffect(() => {
    void load();
  }, [load, isAuthenticated, authToken]);

  const handleSubmit = async () => {
    const content = draft.trim();
    if (!content || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = mode === 'share'
        ? await addShareComment(token!, content, password)
        : await addSiteComment(siteId!, content);
      if (!mountedRef.current) return;
      if (res.success && res.data) {
        const created = res.data;
        setDraft('');
        // 1) 乐观插入（按 id 去重）：服务端已落库，立即上屏 —— 即使下面 load() 失败，评论也已可见，
        //    用户不会以为没发出去而重复提交导致重复评论（Cursor medium: refresh fail → duplicate）。
        setComments((prev) => (prev.some((c) => c.id === created.id) ? prev : [created, ...prev]));
        // 2) 再静默 load() 对账拿服务端真相（含他人新评论 / 准确时间戳）。silent=不翻 loading，
        //    乐观插入的评论全程留在屏上；best-effort：失败也无妨，乐观插入已兜底。
        await load(true);
      } else {
        setError(res.error?.message || '发表失败');
      }
    } catch {
      if (mountedRef.current) setError('网络错误，发表失败');
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const handleDelete = async (commentId: string) => {
    const res = await deleteSiteComment(commentId);
    if (!mountedRef.current) return;
    if (res.success) {
      // 按 commentId 精确过滤：id 全局唯一，无论期间是否有并发 load 切了线程，
      // "从当前列表移除这一条"永远是正确操作。不能用 fetchIdRef 守卫——那会在并发 load
      // 撞号时把已成功的服务端删除丢掉、评论残留到下次刷新（Cursor medium）。
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
          // 仅在"加载成功但确实没有评论"时显示空状态；加载失败已由上方 error 提示，
          // 不能再叠一句"还没有评论"让用户误以为是成功的空列表（Cursor low）。
          !error && (
            <div className="text-center py-8 text-sm text-white/30">
              还没有评论，来发表第一条吧
            </div>
          )
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
