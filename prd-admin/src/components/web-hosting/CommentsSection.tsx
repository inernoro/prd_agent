import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageSquare, Send, Trash2, Lock, MousePointer2, Link2, X, Check, RotateCcw, CornerDownRight, History } from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '../ui/VideoLoader';
import { getUserAvatarUrl } from '../../lib/avatar';
import { useAuthStore } from '../../stores/authStore';
import { listShareComments, addShareComment, listSiteComments, addSiteComment, deleteSiteComment,
  setSiteCommentResolved, type HostedSiteCommentDto } from '../../services/real/webPages';
import type { HostedAnnotations } from './useHostedAnnotations';
import type { HostedReview } from './useHostedReview';

const ELEMENT_LABELS: Record<string, string> = { button: '按钮', a: '链接', img: '图片', p: '段落',
  h1: '标题', h2: '标题', h3: '标题', h4: '标题', section: '区块', div: '区块', li: '列表项', svg: '图标' };
const elementLabel = (tag: string) => ELEMENT_LABELS[tag] ?? '页面元素';

type Props = (
  | { mode: 'share'; token: string; password?: string; siteId?: never }
  | { mode: 'site'; siteId: string; token?: never; password?: never }
) & {
  onStateLoaded?: (commentsEnabled: boolean) => void;
  onCountChange?: (count: number) => void;
  annotations?: HostedAnnotations;
  review?: HostedReview;
  onPickElement?: () => void;
};

export default function CommentsSection(props: Props) {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated);
  const authToken = useAuthStore(s => s.token);
  const [loading, setLoading] = useState(true);
  const [comments, setComments] = useState<HostedSiteCommentDto[]>([]);
  const [commentsEnabled, setCommentsEnabled] = useState(true);
  const [canComment, setCanComment] = useState(false);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [otherVersions, setOtherVersions] = useState(false);
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fetchId = useRef(0);
  const mounted = useRef(true);
  const callbacks = useRef(props); callbacks.current = props;
  const { mode, token, password, siteId, annotations, review } = props;
  const versionKey = review?.selected?.contentVersionKey;
  const canWrite = canComment && (!review || (!!review.selected && !review.loading));
  const identity = `${mode}:${token ?? siteId}:${password ?? ''}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const allRoots = comments.filter(c => !c.parentId);
  const versionRoots = review ? allRoots.filter(c => c.contentVersion === versionKey && !!versionKey) : allRoots;
  const outsideRoots = review ? allRoots.filter(c => c.contentVersion !== versionKey || !versionKey) : [];
  const roots = otherVersions ? outsideRoots : versionRoots;
  const openCount = roots.filter(c => !c.isResolved).length;
  const resolvedCount = roots.length - openCount;
  useEffect(() => { callbacks.current.onCountChange?.(versionRoots.length); }, [versionRoots.length]);
  useEffect(() => {
    const activeRoots = comments.filter(c => !c.parentId && (!callbacks.current.review || (!!versionKey && c.contentVersion === versionKey)));
    callbacks.current.annotations?.setThreads(activeRoots);
  }, [comments, versionKey]);
  useEffect(() => { setOtherVersions(false); setReplyTo(null); setDraft(''); setFilter('open'); }, [versionKey]);

  const load = useCallback(async (silent = false) => {
    const request = ++fetchId.current;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = mode === 'share' ? await listShareComments(token!, password) : await listSiteComments(siteId!);
      if (!mounted.current || request !== fetchId.current) return;
      if (res.success && res.data) {
        setComments(res.data.comments); setCommentsEnabled(res.data.commentsEnabled); setCanComment(res.data.canComment);
        callbacks.current.onStateLoaded?.(res.data.commentsEnabled);
      } else if (!silent) setError(res.error?.message || '加载讨论失败');
    } catch { if (mounted.current && request === fetchId.current && !silent) setError('网络错误，无法加载讨论'); }
    finally { if (mounted.current && request === fetchId.current && !silent) setLoading(false); }
  }, [mode, token, password, siteId]);
  useEffect(() => { void load(); }, [load, isAuthenticated, authToken]);
  useEffect(() => {
    if (annotations?.draftAnchor) { setReplyTo(null); textareaRef.current?.focus(); }
  }, [annotations?.draftAnchor]);
  useEffect(() => {
    const id = annotations?.activeId;
    if (!id) return;
    const selected = comments.find(c => c.id === id);
    if (selected) setFilter(selected.isResolved ? 'resolved' : 'open');
    const timer = window.setTimeout(() => document.getElementById(`hosted-thread-${id}`)?.scrollIntoView({ block: 'nearest' }), 50);
    return () => window.clearTimeout(timer);
  }, [annotations?.activeId, comments]);

  const submit = async () => {
    if (!draft.trim() || submitting || !canWrite) return;
    const operationIdentity = identity;
    const options = replyTo ? { parentId: replyTo } : { anchor: annotations?.draftAnchor ?? undefined,
      revisionId: review?.selected?.id, expectedContentVersion: versionKey };
    setSubmitting(true); setError(null);
    try {
      const res = mode === 'share' ? await addShareComment(token!, draft.trim(), password, options)
        : await addSiteComment(siteId!, draft.trim(), options);
      if (!mounted.current || operationIdentity !== identityRef.current) return;
      if (res.success && res.data) {
        const created = res.data;
        setComments(prev => prev.some(c => c.id === created.id) ? prev : [created, ...prev]);
        setDraft(''); setReplyTo(null); annotations?.clearDraft(); if (!replyTo) setFilter('open');
        await load(true);
      } else setError(res.error?.message || '发表失败，草稿已保留');
    } catch { if (mounted.current && operationIdentity === identityRef.current) setError('网络错误，发表失败，草稿已保留'); }
    finally { if (mounted.current && operationIdentity === identityRef.current) setSubmitting(false); }
  };
  const remove = async (id: string) => {
    if (confirmDelete !== id) { setConfirmDelete(id); return; }
    const operationIdentity = identity;
    setBusyId(id); setError(null);
    try {
      const res = await deleteSiteComment(id);
      if (!mounted.current || operationIdentity !== identityRef.current) return;
      if (res.success) { setComments(prev => prev.filter(c => c.id !== id && c.parentId !== id)); if (replyTo === id) setReplyTo(null); }
      else setError(res.error?.message || '删除失败');
    } catch { if (mounted.current && operationIdentity === identityRef.current) setError('网络错误，删除失败'); }
    finally { if (mounted.current && operationIdentity === identityRef.current) { setBusyId(null); setConfirmDelete(null); } }
  };
  const resolve = async (comment: HostedSiteCommentDto) => {
    const operationIdentity = identity;
    setBusyId(comment.id); setError(null);
    try {
      const source = mode === 'share' ? { token: token!, password } : { siteId: siteId! };
      const res = await setSiteCommentResolved(source, comment.id, !comment.isResolved);
      if (!mounted.current || operationIdentity !== identityRef.current) return;
      if (res.success && res.data) {
        setComments(prev => prev.map(c => c.id === comment.id ? res.data! : c));
        if (res.data.isResolved) annotations?.setActiveId(null);
      }
      else setError(res.error?.message || '更新讨论状态失败');
    } catch { if (mounted.current && operationIdentity === identityRef.current) setError('网络错误，更新失败'); }
    finally { if (mounted.current && operationIdentity === identityRef.current) setBusyId(null); }
  };
  const visible = roots.filter(c => filter === 'all' || (filter === 'resolved' ? c.isResolved : !c.isResolved));
  const startPicking = () => { setReplyTo(null); annotations?.select(); props.onPickElement?.(); };
  const replyTarget = roots.find(c => c.id === replyTo);
  return (
    <section aria-label="批注与讨论" className="space-y-4 text-sm text-token-primary">
      {annotations && (
        <div className="space-y-2">
          <button type="button" onClick={startPicking} disabled={!canWrite || !annotations.ready || submitting || review?.uploading}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[var(--accent-fg-amber)] transition-colors hover:bg-amber-500/15 disabled:opacity-40 disabled:cursor-not-allowed">
            <MousePointer2 size={15} />绑定页面元素 / 选中文字
          </button>
          <p className="text-xs leading-relaxed text-token-muted">
            {annotations.ready ? '先在网页上选择位置，意见就会留在那里。' : annotations.connectionChecked
              ? '此页面暂未连接批注层，仍可发表整页评论。' : '正在连接页面批注层…'}
          </p>
        </div>
      )}
      {loading ? <MapSectionLoader text="正在加载讨论…" /> : (
        <>
          {review && <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs text-token-muted">
              <span>{review.selected ? `${review.selected.versionLabel} 的批注` : '正在读取版本归属…'}</span>
              <span>批注随版本保留</span>
            </div>
            <div className="flex gap-1 rounded-lg bg-token-nested p-1" role="tablist" aria-label="批注版本范围">
              <button type="button" role="tab" aria-selected={!otherVersions} onClick={() => setOtherVersions(false)} className={`flex-1 rounded-md px-2 py-1.5 text-xs ${!otherVersions ? 'bg-token-card font-medium text-token-primary' : 'text-token-muted'}`}>本版 {versionRoots.length}</button>
              <button type="button" role="tab" aria-selected={otherVersions} onClick={() => setOtherVersions(true)} className={`flex-1 rounded-md px-2 py-1.5 text-xs ${otherVersions ? 'bg-token-card font-medium text-token-primary' : 'text-token-muted'}`}>其他版本 {outsideRoots.length}</button>
            </div>
            {otherVersions && <p className="text-xs leading-relaxed text-token-muted">旧版意见不会叠到本版页面。选择所属版本，回到原内容查看。</p>}
          </div>}
          {!commentsEnabled ? <p className="flex gap-2 text-token-muted"><Lock size={15} />该站点已关闭评论与批注</p>
            : !isAuthenticated ? <p className="flex gap-2 text-token-muted"><Lock size={15} />登录后即可批注和回复</p>
              : canWrite && !otherVersions ? (
                <div className="rounded-xl border border-token-subtle bg-token-nested p-3 space-y-3">
                  {annotations?.draftAnchor ? (
                    <div className="flex gap-2 rounded-md bg-amber-500/10 p-2 text-xs text-token-secondary">
                      <Link2 size={14} className="shrink-0 text-amber-500" />
                      <div className="min-w-0 flex-1"><div className="font-medium text-token-primary">已绑定{annotations.draftAnchor.kind === 'text' ? '选中文字' : elementLabel(annotations.draftAnchor.tagName)}</div>
                        <p className="mt-1 line-clamp-3 break-words">{annotations.draftAnchor.text || '无文字元素'}</p></div>
                      <button type="button" aria-label="取消位置绑定" disabled={submitting} onClick={annotations.clearDraft} className="self-start p-1"><X size={13} /></button>
                    </div>
                  ) : replyTarget ? (
                    <div className="flex gap-2 text-xs text-token-secondary"><CornerDownRight size={14} />
                      <span className="flex-1 truncate">回复 {replyTarget.authorName}：{replyTarget.content}</span>
                      <button type="button" aria-label="取消回复" disabled={submitting} onClick={() => setReplyTo(null)}><X size={14} /></button>
                    </div>
                  ) : <p className="text-xs text-token-muted">整页评论</p>}
                  <textarea ref={textareaRef} aria-label={replyTo ? '回复内容' : '批注内容'} value={draft} disabled={submitting}
                    onChange={e => setDraft(e.target.value)} maxLength={2000} rows={3}
                    onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit(); } }}
                    placeholder={replyTo ? '补充你的想法…' : annotations?.draftAnchor ? '这个位置需要怎样修改？' : '写下对整个页面的意见…'}
                    className="w-full resize-y bg-transparent text-sm leading-relaxed placeholder-token-muted outline-none focus-visible:ring-1 focus-visible:ring-amber-500/50 rounded" />
                  <div className="flex items-center justify-between gap-2"><span className="text-[11px] text-token-muted">{draft.length}/2000</span>
                    <button type="button" onClick={() => void submit()} disabled={!draft.trim() || submitting}
                      className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed">
                      {submitting ? <MapSpinner size={13} /> : <Send size={13} />}{replyTo ? '回复' : '发表'}
                    </button></div>
                </div>
              ) : null}
          <div role="tablist" aria-label="讨论状态" className="flex gap-1 border-b border-token-subtle pb-2">
            {([{ value: 'open', label: '未解决', count: openCount }, { value: 'resolved', label: '已解决', count: resolvedCount },
              { value: 'all', label: '全部', count: roots.length }] as const).map(tab => (
              <button key={tab.value} type="button" role="tab" aria-selected={filter === tab.value} onClick={() => setFilter(tab.value)}
                className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${filter === tab.value ? 'bg-token-nested font-semibold text-token-primary' : 'text-token-muted hover:text-token-primary'}`}>{tab.label} {tab.count}</button>
            ))}
          </div>
          {visible.length === 0 && !error && <div className="py-7 text-center text-token-muted">
            <MessageSquare size={22} className="mx-auto mb-3 opacity-50" />
            <p>{filter === 'resolved' ? '还没有已解决的讨论' : filter === 'open' && resolvedCount ? '当前讨论都已解决' : '从网页上的一个位置开始批注'}</p>
          </div>}
          <div className="space-y-3">{visible.map((comment) => {
            const replies = comments.filter(c => c.parentId === comment.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            const number = versionRoots.filter(c => c.anchor).findIndex(c => c.id === comment.id) + 1;
            const missing = !otherVersions && annotations?.missingIds.includes(comment.id);
            const originVersion = review?.versions.find(v => v.id === comment.revisionId || v.contentVersionKey === comment.contentVersion);
            const canOpenOrigin = !!originVersion?.canPreview;
            const locate = () => {
              if (otherVersions && originVersion) void review?.selectVersion(originVersion.id, comment.id);
              else annotations?.focus(comment.id);
            };
            return <article key={comment.id} id={`hosted-thread-${comment.id}`} className={`rounded-xl border p-3 space-y-3 transition-colors ${annotations?.activeId === comment.id ? 'border-amber-500/60 bg-amber-500/5' : 'border-token-subtle'}`}>
              {comment.anchor && <button type="button" onClick={locate} disabled={otherVersions ? !canOpenOrigin : !annotations?.ready}
                className="flex w-full items-start gap-2 rounded-md bg-token-nested p-2 text-left text-xs hover:bg-amber-500/10 disabled:cursor-default">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-[var(--accent-fg-amber)]">{otherVersions ? <History size={12} /> : number}</span>
                <span className="min-w-0 flex-1"><span className="flex items-center gap-1 font-medium text-token-primary"><Link2 size={11} />{comment.anchor.kind === 'text' ? '文字批注' : elementLabel(comment.anchor.tagName)}</span>
                  <span className="mt-1 block line-clamp-2 break-words text-token-secondary">{comment.anchor.text || '无文字元素'}</span>
                  {missing && <span className="mt-1 block text-[var(--accent-fg-amber)]">原位置已变更，批注内容已保留</span>}</span>
              </button>}
              {otherVersions && <div className="flex items-center justify-between gap-2 text-xs text-token-muted">
                <span>来自 {originVersion?.versionLabel ?? (comment.contentVersion ? '未收录的旧版本' : '未标版本的历史评论')}</span>
                {canOpenOrigin && <button type="button" onClick={locate} className="text-token-primary underline">切换到 {originVersion!.versionLabel}</button>}
              </div>}
              <CommentMessage comment={comment} busy={busyId === comment.id} confirming={confirmDelete === comment.id} onDelete={() => void remove(comment.id)} />
              {replies.length > 0 && <div className="ml-3 space-y-3 border-l border-token-subtle pl-3">{replies.map(reply =>
                <CommentMessage key={reply.id} comment={reply} busy={busyId === reply.id} confirming={confirmDelete === reply.id} onDelete={() => void remove(reply.id)} />)}</div>}
              <div className="flex items-center justify-between gap-2 text-xs text-token-muted">
                {canWrite && !otherVersions ? <button type="button" disabled={submitting} onClick={() => { annotations?.clearDraft(); setReplyTo(comment.id); textareaRef.current?.focus(); textareaRef.current?.scrollIntoView({ block: 'nearest' }); }}
                  className="flex items-center gap-1 hover:text-token-primary"><CornerDownRight size={13} />回复{replies.length ? ` ${replies.length}` : ''}</button> : <span />}
                {comment.canResolve && commentsEnabled ? <button type="button" disabled={busyId !== null} onClick={() => void resolve(comment)} className="flex items-center gap-1 hover:text-token-primary disabled:opacity-40">
                  {comment.isResolved ? <RotateCcw size={13} /> : <Check size={13} />}{comment.isResolved ? '重新打开' : '标记解决'}</button>
                  : comment.isResolved ? <span className="flex items-center gap-1 text-emerald-600"><Check size={13} />已解决</span> : null}
              </div>
            </article>;
          })}</div>
        </>
      )}
      {error && <p role="alert" className="text-xs leading-relaxed text-red-500">{error}<button type="button" onClick={() => void load()} className="ml-2 underline">重新加载</button></p>}
    </section>
  );
}

function CommentMessage({ comment, busy, confirming, onDelete }: { comment: HostedSiteCommentDto; busy: boolean; confirming: boolean; onDelete: () => void }) {
  return <div className="flex items-start gap-2">
    <img src={getUserAvatarUrl({ avatarFileName: comment.authorAvatarFileName, displayName: comment.authorName })} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover bg-token-nested" />
    <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-xs font-medium text-token-primary">{comment.authorName}</span><time className="text-[10px] text-token-muted" dateTime={comment.createdAt}>{formatTime(comment.createdAt)}</time></div>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-token-secondary">{comment.content}</p></div>
    {comment.canDelete && <button type="button" disabled={busy} onClick={onDelete} aria-label={confirming ? '确认删除讨论及回复' : '删除评论'} title={confirming ? '再次点击确认删除' : '删除评论'} className="shrink-0 p-1 text-token-muted hover:text-red-500 disabled:opacity-40">
      {busy ? <MapSpinner size={13} /> : confirming ? <span className="text-xs text-red-500">确认删除</span> : <Trash2 size={13} />}</button>}
  </div>;
}

function formatTime(iso: string): string {
  const diff = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}
