import { useState, useEffect, useRef, useCallback, useId, type ReactNode } from 'react';
import { MessageSquare, Send, Trash2, Lock, LogIn, MousePointer2, Link2, X, Check, RotateCcw, CornerDownRight, History } from 'lucide-react';
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
  | { mode: 'share'; token: string; password?: string; siteId?: string }
  | { mode: 'site'; siteId: string; token?: never; password?: never }
) & {
  onStateLoaded?: (commentsEnabled: boolean) => void;
  onCountChange?: (count: number) => void;
  annotations?: HostedAnnotations;
  review?: HostedReview;
  onPickElement?: () => void;
  onLogin?: () => void;
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
  const versionPending = !!review?.loading;
  const canWrite = isAuthenticated && commentsEnabled && canComment && (!review || (!!review.selected && !review.loading));
  const pickingHintId = useId();
  const loginToAnnotate = !loading && !error && commentsEnabled && (!isAuthenticated || !canComment) && !!props.onLogin;
  const pickingHint = (() => {
    if (loading) return '正在加载讨论权限…';
    if (error && !canComment) return '无法加载讨论权限，请重新加载后再试。';
    if (!commentsEnabled) return '该站点已关闭评论与批注。';
    if (!isAuthenticated) return '登录后可选择网页元素或文字留下批注，并参与回复。';
    if (!canComment) return '当前登录状态无法批注，请重新登录后再试。';
    if (review?.uploading) return '新版本正在上传，完成后即可批注。';
    if (versionPending) return review?.historical ? '正在切换网页版本，请稍候…' : '正在确认网页版本，请稍候…';
    if (review && !review.selected) return '无法确认网页版本，请在顶部重新加载版本。';
    if (submitting) return '正在发表批注，请稍候…';
    if (!annotations?.ready) return annotations?.connectionChecked
      ? '此页面暂未连接批注层，仍可发表整页评论。' : '正在连接页面批注层…';
    return '先在网页上选择位置，意见就会留在那里。';
  })();
  const identity = `${mode}:${token ?? ''}:${siteId ?? ''}:${password ?? ''}`;
  const confirmedDraftVersion = useRef({ identity, versionKey });
  const identityRef = useRef(identity); identityRef.current = identity;
  const draftScope = `${identity}:${review?.selected?.id ?? ''}:${versionKey ?? ''}`;
  const draftScopeRef = useRef({ key: draftScope, draft, replyTo, anchor: annotations?.draftAnchor });
  const previousDraftScope = draftScopeRef.current;
  if (previousDraftScope.key !== draftScope || previousDraftScope.draft !== draft
    || previousDraftScope.replyTo !== replyTo || previousDraftScope.anchor !== annotations?.draftAnchor)
    draftScopeRef.current = { key: draftScope, draft, replyTo, anchor: annotations?.draftAnchor };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const allRoots = comments.filter(c => !c.parentId);
  const versionRoots = review ? allRoots.filter(c => c.contentVersion === versionKey && !!versionKey) : allRoots;
  const outsideRoots = review ? allRoots.filter(c => c.contentVersion !== versionKey || !versionKey) : [];
  const roots = otherVersions ? outsideRoots : versionRoots;
  const openCount = roots.filter(c => !c.isResolved).length;
  const resolvedCount = roots.length - openCount;
  useEffect(() => { callbacks.current.onCountChange?.(allRoots.length); }, [allRoots.length]);
  useEffect(() => {
    const activeRoots = comments.filter(c => !c.parentId && (!callbacks.current.review || (!!versionKey && c.contentVersion === versionKey)));
    callbacks.current.annotations?.setThreads(activeRoots);
  }, [comments, versionKey]);
  useEffect(() => {
    const previous = confirmedDraftVersion.current;
    if (previous.identity !== identity || (versionKey && previous.versionKey && versionKey !== previous.versionKey)) {
      setOtherVersions(false); setReplyTo(null); setDraft(''); setFilter('open');
    }
    // An unresolved metadata response does not change which publication owns the draft.
    if (previous.identity !== identity || versionKey) confirmedDraftVersion.current = { identity, versionKey };
  }, [identity, versionKey]);

  const load = useCallback(async (silent = false) => {
    const request = ++fetchId.current;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = mode === 'share' ? await listShareComments(token!, password, siteId) : await listSiteComments(siteId!);
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
    const operationDraftScope = draftScopeRef.current;
    const options = replyTo ? { parentId: replyTo } : { anchor: annotations?.draftAnchor ?? undefined,
      revisionId: review?.historical ? review.selected?.id : undefined, expectedContentVersion: versionKey };
    setSubmitting(true); setError(null);
    try {
      const res = mode === 'share' ? await addShareComment(token!, draft.trim(), password, { ...options, siteId })
        : await addSiteComment(siteId!, draft.trim(), options);
      if (!mounted.current || operationIdentity !== identityRef.current) return;
      if (res.success && res.data) {
        const created = res.data;
        window.dispatchEvent(new Event('hosted-comments-changed'));
        setComments(prev => prev.some(c => c.id === created.id) ? prev : [created, ...prev]);
        if (operationDraftScope === draftScopeRef.current) {
          setDraft(''); setReplyTo(null); annotations?.clearDraft(); if (!replyTo) setFilter('open');
        }
        await load(true);
      } else if (operationDraftScope === draftScopeRef.current) setError(res.error?.message || '发表失败，草稿已保留');
    } catch { if (mounted.current && operationIdentity === identityRef.current && operationDraftScope === draftScopeRef.current) setError('网络错误，发表失败，草稿已保留'); }
    finally { if (mounted.current && operationIdentity === identityRef.current) setSubmitting(false); }
  };
  const remove = async (id: string) => {
    if (confirmDelete !== id) { setConfirmDelete(id); return; }
    const operationIdentity = identity;
    setBusyId(id); setError(null);
    try {
      const res = await deleteSiteComment(id);
      if (!mounted.current || operationIdentity !== identityRef.current) return;
      if (res.success) { window.dispatchEvent(new Event('hosted-comments-changed')); setComments(prev => prev.filter(c => c.id !== id && c.parentId !== id)); if (replyTo === id) setReplyTo(null); }
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
  const pickEntry = annotations ? <button type="button" onClick={loginToAnnotate ? props.onLogin : startPicking}
    aria-label={loginToAnnotate ? (isAuthenticated ? '重新登录后批注' : '登录后批注') : '绑定页面元素 / 选中文字'}
    disabled={!loginToAnnotate && (loading || !canWrite || !annotations.ready || submitting || review?.uploading)}
    title={pickingHint} aria-describedby={pickingHintId} className={loginToAnnotate ? 'review-login-action' : 'review-pick-action'}>
    {loginToAnnotate ? <><LogIn size={15} />{isAuthenticated ? '重新登录后批注' : '登录后批注'}</> : <><MousePointer2 size={14} />选取位置</>}
  </button> : null;
  return (
    <section aria-label="批注与讨论" className="review-discussion">
      <div className="review-scope">
        {review && <>
          <div className="review-scope-tabs" role="tablist" aria-label="批注版本范围">
            <button type="button" role="tab" disabled={versionPending} aria-selected={!otherVersions} onClick={() => setOtherVersions(false)}>本版 <span>{versionPending ? '—' : versionRoots.length}</span></button>
            <button type="button" role="tab" disabled={versionPending} aria-selected={otherVersions} onClick={() => setOtherVersions(true)}>其他版本 <span>{versionPending ? '—' : outsideRoots.length}</span></button>
          </div>
          <div className="review-scope-caption"><span>{review.selected ? `${review.selected.versionLabel} · ${review.historical ? '历史版本' : '当前发布'}` : '正在读取版本归属…'}</span><span>{otherVersions ? '选择版本，回到原内容' : '批注随版本保留'}</span></div>
        </>}
        <div role="tablist" aria-label="讨论状态" className="review-status-tabs">
          {([{ value: 'open', label: '未解决', count: openCount }, { value: 'resolved', label: '已解决', count: resolvedCount },
            { value: 'all', label: '全部', count: roots.length }] as const).map(tab => (
            <button key={tab.value} type="button" role="tab" disabled={versionPending} aria-selected={filter === tab.value} onClick={() => setFilter(tab.value)}>{tab.label} <span>{versionPending ? '—' : tab.count}</span></button>
          ))}
        </div>
      </div>
      <div className="review-thread-scroll">
        {loading || versionPending ? <MapSectionLoader text={versionPending ? '正在确认网页版本…' : '正在加载讨论…'} /> : <>
          {visible.length === 0 && !error && <div className="review-empty">
            <MessageSquare size={23} /><strong>{filter === 'resolved' ? '还没有已解决的讨论' : filter === 'open' && resolvedCount ? '本版意见已全部处理' : '让意见留在对应的位置'}</strong>
            <p>{otherVersions ? '其他版本的讨论会保留在这里。' : '选取一个元素或一段文字，开始第一条批注。'}</p>
          </div>}
          {visible.map((comment) => {
            const replies = comments.filter(c => c.parentId === comment.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            const number = versionRoots.filter(c => c.anchor).findIndex(c => c.id === comment.id) + 1;
            const missing = !otherVersions && annotations?.missingIds.includes(comment.id);
            const originVersion = review?.versions.find(v => v.id === comment.revisionId || v.contentVersionKey === comment.contentVersion);
            const canOpenOrigin = !!originVersion?.canPreview;
            const locate = () => {
              if (otherVersions && originVersion) void review?.selectVersion(originVersion.id, comment.id);
              else annotations?.focus(comment.id);
            };
            return <article key={comment.id} id={`hosted-thread-${comment.id}`} className={`review-thread${annotations?.activeId === comment.id ? ' is-active' : ''}`}>
              <CommentMessage comment={comment} busy={busyId === comment.id} confirming={confirmDelete === comment.id} onDelete={() => void remove(comment.id)}>
                {comment.anchor && <button type="button" onClick={locate} disabled={otherVersions ? !canOpenOrigin : !annotations?.ready} className="review-anchor-quote">
                  <span className="review-anchor-number">{otherVersions ? <History size={13} /> : number}</span>
                  <span><strong>{comment.anchor.kind === 'text' ? '选中文字' : elementLabel(comment.anchor.tagName)}</strong><span>{comment.anchor.text || '无文字元素'}</span>
                    {missing && <small>原位置已变更，批注内容已保留</small>}</span>
                </button>}
                {otherVersions && <div className="review-origin-version"><span>来自 {originVersion?.versionLabel ?? (comment.contentVersion ? '未收录的旧版本' : '未标版本的历史评论')}</span>
                  {canOpenOrigin && <button type="button" onClick={locate}>切换到 {originVersion!.versionLabel}</button>}</div>}
              </CommentMessage>
              {replies.length > 0 && <div className="review-replies">{replies.map(reply =>
                <CommentMessage key={reply.id} comment={reply} busy={busyId === reply.id} confirming={confirmDelete === reply.id} onDelete={() => void remove(reply.id)} />)}</div>}
              <div className="review-thread-actions">
                {canWrite && !otherVersions ? <button type="button" disabled={submitting} onClick={() => { annotations?.clearDraft(); setReplyTo(comment.id); textareaRef.current?.focus(); }}><CornerDownRight size={13} />回复{replies.length ? ` ${replies.length}` : ''}</button> : <span />}
                {comment.canResolve && commentsEnabled && <button type="button" disabled={busyId !== null} onClick={() => void resolve(comment)}>
                  {comment.isResolved ? <RotateCcw size={13} /> : <Check size={13} />}{comment.isResolved ? '重新打开' : '标记解决'}</button>}
              </div>
            </article>;
          })}
        </>}
        {error && <p role="alert" className="review-discussion-error">{error}<button type="button" onClick={() => void load()}>重新加载</button></p>}
      </div>
      <div className="review-composer">
        {!commentsEnabled || !canWrite ? <div className="review-composer-unavailable">
          {versionPending ? <MapSpinner size={19} /> : <Lock size={19} />}<strong>{!commentsEnabled ? '评论与批注已关闭' : !isAuthenticated ? '加入这份网页的讨论' : versionPending ? '正在确认网页版本' : '暂时无法开始批注'}</strong>
          <p id={pickingHintId}>{pickingHint}</p>{pickEntry}
          {!annotations && !isAuthenticated && props.onLogin && <button type="button" className="review-login-action" onClick={props.onLogin}><LogIn size={15} />登录后评论</button>}
        </div> : otherVersions ? <div className="review-composer-unavailable"><History size={19} /><p>回到对应版本，继续那里的讨论。</p><button type="button" className="review-pick-action" onClick={() => setOtherVersions(false)}>返回本版发表评论</button></div> : <>
          {annotations?.draftAnchor ? <div className="review-composer-anchor"><Link2 size={14} /><span><strong>已选中{annotations.draftAnchor.kind === 'text' ? '文字' : elementLabel(annotations.draftAnchor.tagName)}</strong><span>{annotations.draftAnchor.text || '无文字元素'}</span></span>
            <button type="button" aria-label="取消位置绑定" disabled={submitting} onClick={annotations.clearDraft}><X size={14} /></button></div>
            : replyTarget ? <div className="review-composer-anchor"><CornerDownRight size={14} /><span><strong>回复 {replyTarget.authorName}</strong><span>{replyTarget.content}</span></span><button type="button" aria-label="取消回复" disabled={submitting} onClick={() => setReplyTo(null)}><X size={14} /></button></div>
            : <div className="review-composer-label"><span>整页评论</span>{pickEntry}</div>}
          <textarea ref={textareaRef} aria-label={replyTo ? '回复内容' : '批注内容'} value={draft} disabled={submitting}
            onChange={e => setDraft(e.target.value)} maxLength={2000} rows={3}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit(); } }}
            placeholder={replyTo ? '补充你的想法…' : annotations?.draftAnchor ? '这个位置需要怎样修改？' : '写下意见，或先选取网页上的位置…'} />
          <div className="review-composer-footer"><span>{draft.length ? `${draft.length}/2000` : 'Ctrl / ⌘ + Enter 发送'}</span><button type="button" onClick={() => void submit()} disabled={!draft.trim() || submitting} className="review-send-action">
            {submitting ? <MapSpinner size={14} /> : <Send size={14} />}{replyTo ? '发送回复' : '发送批注'}</button></div>
          {annotations && !annotations.draftAnchor && <p id={pickingHintId} className="review-composer-hint">{pickingHint}</p>}
        </>}
      </div>
    </section>
  );
}

function CommentMessage({ comment, busy, confirming, onDelete, children }: { comment: HostedSiteCommentDto; busy: boolean; confirming: boolean; onDelete: () => void; children?: ReactNode }) {
  return <div className="review-message">
    <div className="review-message-author"><img src={getUserAvatarUrl({ avatarFileName: comment.authorAvatarFileName, displayName: comment.authorName })} alt="" />
      <strong>{comment.authorName}</strong><span>·</span><time dateTime={comment.createdAt}>{formatTime(comment.createdAt)}</time>
      {comment.canDelete && <button type="button" disabled={busy} onClick={onDelete} aria-label={confirming ? '确认删除讨论及回复' : '删除评论'} title={confirming ? '再次点击确认删除' : '删除评论'}>
        {busy ? <MapSpinner size={13} /> : confirming ? <span>确认删除</span> : <Trash2 size={13} />}</button>}
    </div>
    {children}
    <p className="review-message-body">{comment.content}</p>
  </div>;
}

function formatTime(iso: string): string {
  const diff = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}
