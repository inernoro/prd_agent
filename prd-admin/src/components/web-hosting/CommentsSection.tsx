import { annotationPreviewText } from './annotationPreviewText';
import { Fragment, useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useId, type CSSProperties, type ReactNode } from 'react';
import { MessageSquare, ArrowUp, Trash2, Lock, LogIn, MousePointer2, Link2, X, Check, RotateCcw, CornerDownRight, History, Eye, EyeOff, PanelRightClose, ChevronUp, ChevronDown, CircleAlert } from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '../ui/VideoLoader';
import { getUserAvatarUrl } from '../../lib/avatar';
import { useAuthStore } from '../../stores/authStore';
import { listShareComments, addShareComment, listSiteComments, addSiteComment, deleteSiteComment,
  setSiteCommentResolved, type HostedSiteCommentDto, type HostedSiteCommentOptions } from '../../services/real/webPages';
import type { HostedAnnotations } from './useHostedAnnotations';
import type { HostedReview } from './useHostedReview';
import { useDiscussionDraft } from './useDiscussionDraft';
import { useDiscussionPolling } from './useDiscussionPolling';
import { groupDiscussionThreads } from './discussionPresentation';
import '../../styles/hosted-review-discussion.css';

const ELEMENT_LABELS: Record<string, string> = { button: '按钮', a: '链接', img: '图片', p: '段落',
  h1: '标题', h2: '标题', h3: '标题', h4: '标题', section: '区块', div: '区块', li: '列表项', svg: '图标' };
const elementLabel = (tag: string) => ELEMENT_LABELS[tag] ?? '页面元素';
const emptyRecoveries: readonly string[] = [];

function readRecoveries(key?: string): readonly string[] {
  if (!key) return emptyRecoveries;
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (Array.isArray(saved)) return saved.filter((id): id is string => typeof id === 'string');
  } catch { /* The composer also tracks recoveries in memory. */ }
  return emptyRecoveries;
}

export interface CommentThreadCounts { annotations: number; discussions: number }
type DiscussionActions = {
  canReply: boolean;
  canResolve: (threadId: string) => boolean;
  reply: (threadId: string, content: string, clientId: string) => Promise<string | null>;
  resolve: (threadId: string) => Promise<string | null>;
  getReplies: (threadId: string) => readonly HostedSiteCommentDto[];
};
type DiscussionAnnotationHost = HostedAnnotations & {
  readingId?: string | null;
  anchorLocations?: Readonly<Record<string, { group: string; paragraph: number }>>;
  bindDiscussionActions?: (actions: DiscussionActions) => () => void;
};

type Props = (
  | { mode: 'share'; token: string; password?: string; siteId?: string }
  | { mode: 'site'; siteId: string; token?: never; password?: never }
) & {
  onStateLoaded?: (commentsEnabled: boolean) => void;
  onCountChange?: (count: number) => void;
  annotations?: DiscussionAnnotationHost;
  review?: HostedReview;
  onPickElement?: () => void;
  onLogin?: () => void;
  threadKind?: 'annotation' | 'discussion';
  onThreadCountsChange?: (counts: CommentThreadCounts) => void;
  versionOnly?: boolean;
  splitLayout?: boolean;
  visible?: boolean;
  readerLayout?: boolean;
  onLocateAnchor?: (focus: () => void) => void;
  onClose?: () => void;
  headerActions?: ReactNode;
  onHistoryHint?: (hint: { id: string; label: string; count: number } | null) => void;
};

export default function CommentsSection(props: Props) {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated);
  const authToken = useAuthStore(s => s.token);
  const userId = useAuthStore(s => s.user?.userId);
  const [loading, setLoading] = useState(true);
  const [comments, setComments] = useState<HostedSiteCommentDto[]>([]);
  const [commentsEnabled, setCommentsEnabled] = useState(true);
  const [canComment, setCanComment] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [pendingPageDraft, setPendingPageDraft] = useState<{ scope: string; id: string; text: string } | null>(null);
  const [recoveriesByScope, setRecoveriesByScope] = useState<Record<string, readonly string[]>>({});
  const [openedRecovery, setOpenedRecovery] = useState<{ scope: string; id: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [otherVersions, setOtherVersions] = useState(false);
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>(props.readerLayout ? 'open' : 'all');
  const [error, setError] = useState<string | null>(null);
  const [syncFailed, setSyncFailed] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [newThreads, setNewThreads] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map());
  const [showOlderReplies, setShowOlderReplies] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ text: string; undo?: () => void } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const keptScroll = useRef<number | null>(null);
  const threadElements = useRef(new Map<string, HTMLElement>());
  const fetchId = useRef(0);
  const seen = useRef<{ identity: string; ids: Set<string> }>();
  const submittingDraft = useRef<object | null>(null);
  const actionRef = useRef<DiscussionActions>();
  const changeSource = useRef({});
  const notifyChanged = () => window.dispatchEvent(new CustomEvent('hosted-comments-changed', { detail: changeSource.current }));
  const mounted = useRef(true);
  const callbacks = useRef(props); callbacks.current = props;
  const { mode, token, password, siteId, annotations, review } = props;
  const draftAnchor = props.threadKind === 'discussion' ? null : annotations?.draftAnchor;
  const versionKey = review?.selected?.contentVersionKey;
  const versionPending = !!review?.loading && !review.error;
  const canWrite = isAuthenticated && commentsEnabled && canComment && (!review || (!!review.selected && !review.loading));
  const pickingHintId = useId();
  const loginToAnnotate = !loading && !error && commentsEnabled && (!isAuthenticated || !canComment) && !!props.onLogin;
  const pickingHint = (() => {
    if (loading) return '正在加载讨论权限…';
    if (error && !canComment) return '无法加载讨论权限，请重新加载后再试。';
    if (!commentsEnabled) return '该站点已关闭评论与批注。';
    if (!isAuthenticated) return props.threadKind === 'discussion' ? '登录后参与这份网页的讨论。' : '登录后可选择网页元素或文字留下批注，并参与回复。';
    if (!canComment) return '当前登录状态无法批注，请重新登录后再试。';
    if (review?.uploading) return '新版本正在上传，完成后即可批注。';
    if (versionPending) return review?.historical ? '正在切换网页版本，请稍候…' : '正在确认网页版本，请稍候…';
    if (review && !review.selected) return '无法确认网页版本，请在顶部重新加载版本。';
    if (submitting) return '正在发表批注，请稍候…';
    if (props.threadKind === 'discussion') return '填写讨论内容，与其他读者交流。';
    if (!annotations?.ready) return annotations?.connectionChecked
      ? '此页面暂未连接批注层，仍可发表整页评论。' : '正在连接页面批注层…';
    return '先在网页上选择位置，意见就会留在那里。';
  })();
  const identity = `${mode}:${token ?? ''}:${siteId ?? ''}:${password ?? ''}:${isAuthenticated ? userId ?? 'member' : 'guest'}`;
  const manualVersionScope = `${identity}:${props.threadKind ?? 'all'}`;
  const defaultVersionScope = `${manualVersionScope}:${versionKey ?? ''}`;
  const initialVersionScope = useRef('');
  const confirmedDraftVersion = useRef({ identity, versionKey });
  const identityRef = useRef(identity); identityRef.current = identity;
  const draftScope = `${identity}:${review?.selected?.id ?? ''}:${versionKey ?? ''}:${props.threadKind ?? 'all'}`;
  const draftStorage = props.readerLayout && userId && siteId && (!review || versionKey)
    ? `hosted-review-draft:${userId}:${siteId}:${versionKey ?? 'live'}` : undefined;
  const recoveryStorage = draftStorage ? `${draftStorage}:recoveries:${props.threadKind ?? 'all'}` : undefined;
  const storedRecoveries = useMemo(() => readRecoveries(recoveryStorage), [recoveryStorage]);
  const recoverableReplies = recoveriesByScope[draftScope] ?? storedRecoveries;
  const recoveredReply = !replyTo && !draftAnchor && openedRecovery?.scope === draftScope ? openedRecovery.id : null;
  const draftSource = replyTo ?? recoveredReply;
  const draftMode = draftSource ? `reply:${draftSource}` : draftAnchor ? 'anchor' : 'page';
  const { draft: savedDraft, update: setDraft } = useDiscussionDraft(`${draftScope}:${draftMode}`,
    draftStorage ? `${draftStorage}:${draftMode}` : undefined);
  const draft = savedDraft.text;
  const storeRecoveries = useCallback((next: readonly string[]) => {
    setRecoveriesByScope(previous => ({ ...previous, [draftScope]: next }));
    if (!recoveryStorage) return;
    try {
      if (next.length) sessionStorage.setItem(recoveryStorage, JSON.stringify(next));
      else sessionStorage.removeItem(recoveryStorage);
    } catch { /* The drafts and their recovery entry remain available in memory. */ }
  }, [draftScope, recoveryStorage]);
  useEffect(() => {
    if (pendingPageDraft === null) return;
    if (pendingPageDraft.scope !== draftScope) {
      if (!versionPending) setPendingPageDraft(null);
      return;
    }
    if (draftMode !== 'page') return;
    setPendingPageDraft(null);
    const combined = [draft, pendingPageDraft.text].filter(Boolean).join('\n\n');
    if (combined.length > 2000) {
      if (!recoverableReplies.includes(pendingPageDraft.id)) storeRecoveries([...recoverableReplies, pendingPageDraft.id]);
    } else if (combined !== draft) setDraft({ text: combined });
    textareaRef.current?.focus({ preventScroll: true });
  }, [draft, draftMode, draftScope, pendingPageDraft, recoverableReplies, setDraft, storeRecoveries, versionPending]);
  const draftScopeRef = useRef({ key: draftScope, draft, draftMode, replyTo, anchor: draftAnchor });
  const previousDraftScope = draftScopeRef.current;
  if (previousDraftScope.key !== draftScope || previousDraftScope.draft !== draft
    || previousDraftScope.draftMode !== draftMode || previousDraftScope.replyTo !== replyTo || previousDraftScope.anchor !== draftAnchor)
    draftScopeRef.current = { key: draftScope, draft, draftMode, replyTo, anchor: draftAnchor };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setReplyTo(null); }, [props.threadKind]);
  useEffect(() => {
    submittingDraft.current = null;
    setSubmitting(false);
    setPendingPageDraft(null);
    setOpenedRecovery(null);
    setNewThreads(new Map());
    setShowOlderReplies(new Set());
    setNotice(null);
  }, [identity]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const allRoots = useMemo(() => comments.filter(c => !c.parentId), [comments]);
  const isVersionScoped = !!review;
  const versionRoots = useMemo(() => isVersionScoped ? allRoots.filter(c => c.contentVersion === versionKey && !!versionKey) : allRoots,
    [allRoots, isVersionScoped, versionKey]);
  const outsideRoots = useMemo(() => isVersionScoped ? allRoots.filter(c => c.contentVersion !== versionKey || !versionKey) : [],
    [allRoots, isVersionScoped, versionKey]);
  const scopedRoots = otherVersions ? outsideRoots : versionRoots;
  const roots = useMemo(() => scopedRoots.filter(comment => !props.threadKind || (props.threadKind === 'annotation' ? !!comment.anchor : !comment.anchor)),
    [scopedRoots, props.threadKind]);
  const openCount = roots.filter(c => !c.isResolved).length;
  const resolvedCount = roots.length - openCount;
  const reportedCount = allRoots.filter(comment => !props.threadKind || (props.threadKind === 'annotation' ? !!comment.anchor : !comment.anchor)).length;
  const currentCount = versionRoots.filter(comment => !props.threadKind || (props.threadKind === 'annotation' ? !!comment.anchor : !comment.anchor)).length;
  const versionReady = !versionPending;
  useEffect(() => { if (!loading && versionReady && !error) callbacks.current.onCountChange?.(reportedCount); }, [reportedCount, loading, versionReady, error]);
  const annotationCount = versionRoots.filter(comment => !!comment.anchor).length;
  const discussionCount = versionRoots.length - annotationCount;
  useEffect(() => {
    if (!loading && !versionPending && !error) callbacks.current.onThreadCountsChange?.({ annotations: annotationCount, discussions: discussionCount });
  }, [annotationCount, discussionCount, loading, versionPending, error]);
  useEffect(() => {
    const activeRoots = comments.filter(c => !c.parentId && (!callbacks.current.review || (!!versionKey && c.contentVersion === versionKey)));
    callbacks.current.annotations?.setThreads(activeRoots);
  }, [comments, versionKey]);
  useEffect(() => {
    const previous = confirmedDraftVersion.current;
    if (previous.identity !== identity || (versionKey && previous.versionKey && versionKey !== previous.versionKey)) {
      // A new publication starts on its own composer; this is not the first document load.
      if (previous.identity === identity) initialVersionScope.current = manualVersionScope;
      setOtherVersions(false); setReplyTo(null); setFilter(callbacks.current.readerLayout ? 'open' : 'all');
    }
    // An unresolved metadata response does not change which publication owns the draft.
    if (previous.identity !== identity || versionKey) confirmedDraftVersion.current = { identity, versionKey };
  }, [identity, versionKey, manualVersionScope]);
  useEffect(() => {
    if (props.readerLayout || props.versionOnly || loading || !versionReady || error || !reportedCount || initialVersionScope.current === defaultVersionScope
      || initialVersionScope.current === manualVersionScope) return;
    initialVersionScope.current = defaultVersionScope;
    setOtherVersions(currentCount === 0);
  }, [props.readerLayout, props.versionOnly, loading, versionReady, error, reportedCount, currentCount, defaultVersionScope, manualVersionScope]);

  const load = useCallback(async (policy: 'show' | 'silent' | 'poll' = 'show'): Promise<boolean> => {
    const request = ++fetchId.current;
    if (policy === 'show') setLoading(true);
    if (policy !== 'poll') setError(null);
    const failed = (reason: string) => {
      if (policy === 'poll' && seen.current?.identity === identity) setSyncFailed(true);
      else setError(reason);
      return false;
    };
    try {
      const res = mode === 'share' ? await listShareComments(token!, password, siteId) : await listSiteComments(siteId!);
      if (!mounted.current || request !== fetchId.current || identity !== identityRef.current) return true;
      if (res.success && res.data) {
        const comments = res.data.comments;
        const ids = new Set(comments.map(comment => comment.id));
        const previous = seen.current?.identity === identity ? seen.current.ids : null;
        if (callbacks.current.readerLayout && previous) {
          const additions = comments.filter(comment => !previous.has(comment.id) && !comment.isMine && (!userId || comment.authorUserId !== userId));
          const currentPane = listRef.current;
          if (currentPane) keptScroll.current = currentPane.scrollTop;
          setNewThreads(current => {
            const next = new Map<string, ReadonlySet<string>>();
            for (const [threadId, messages] of current) {
              if (!ids.has(threadId)) continue;
              const remaining = new Set([...messages].filter(message => ids.has(message)));
              if (remaining.size) next.set(threadId, remaining);
            }
            for (const comment of additions) {
              const threadId = comment.parentId ?? comment.id;
              if (ids.has(threadId)) next.set(threadId, new Set([...(next.get(threadId) ?? []), comment.id]));
            }
            return next;
          });
          const activeId = callbacks.current.annotations?.activeId;
          if (activeId && previous.has(activeId) && !ids.has(activeId)) {
            callbacks.current.annotations?.setActiveId(null);
            setNotice({ text: '原讨论已删除' });
          }
        }
        seen.current = { identity, ids };
        setComments(comments); setCommentsEnabled(res.data.commentsEnabled); setCanComment(res.data.canComment);
        setLastSync(Date.now()); setSyncFailed(false);
        callbacks.current.onStateLoaded?.(res.data.commentsEnabled);
        return true;
      }
      return failed(res.error?.message || '加载讨论失败');
    } catch {
      return mounted.current && request === fetchId.current && identity === identityRef.current
        ? failed('网络错误，无法加载讨论') : true;
    } finally {
      if (mounted.current && request === fetchId.current && identity === identityRef.current) setLoading(false);
    }
  }, [mode, token, password, siteId, identity, userId]);
  const poll = useCallback(() => load('poll'), [load]);
  useDiscussionPolling(!!props.readerLayout, poll);
  useEffect(() => {
    void load(callbacks.current.readerLayout && seen.current?.identity === identity ? 'silent' : 'show');
  }, [load, identity, authToken]);
  useEffect(() => {
    const refresh = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === changeSource.current) return;
      void load('silent');
    };
    window.addEventListener('hosted-comments-changed', refresh);
    return () => window.removeEventListener('hosted-comments-changed', refresh);
  }, [load]);
  useEffect(() => {
    if (draftAnchor) { setReplyTo(null); textareaRef.current?.focus({ preventScroll: true }); }
  }, [draftAnchor]);
  useLayoutEffect(() => {
    if (keptScroll.current !== null && listRef.current) listRef.current.scrollTop = keptScroll.current;
    keptScroll.current = null;
  }, [comments, newThreads]);
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const markRead = useCallback((id: string) => setNewThreads(current => {
    if (!current.has(id)) return current;
    const next = new Map(current); next.delete(id); return next;
  }), []);
  useEffect(() => {
    const id = annotations?.activeId;
    if (!id || props.visible === false || loading) return;
    const selected = commentsRef.current.find(c => c.id === id);
    if (selected) setFilter(current => current === 'all' ? current : selected.isResolved ? 'resolved' : 'open');
    if (selected) markRead(id);
    const timer = window.setTimeout(() => {
      const row = threadElements.current.get(id);
      const list = listRef.current;
      if (!row || !list || !props.readerLayout) { row?.scrollIntoView({ block: 'nearest' }); return; }
      const item = row.getBoundingClientRect(), viewport = list.getBoundingClientRect();
      if (item.top < viewport.top || item.bottom > viewport.bottom) list.scrollTop += item.top - viewport.top - 10;
    }, 50);
    return () => window.clearTimeout(timer);
  }, [annotations?.activeId, loading, props.visible, props.readerLayout, markRead]);

  async function sendComment(content: string, options: HostedSiteCommentOptions) {
    const operationIdentity = identity;
    try {
      const res = mode === 'share' ? await addShareComment(token!, content, password, { ...options, siteId })
        : await addSiteComment(siteId!, content, options);
      if (!mounted.current || operationIdentity !== identityRef.current) return { error: '阅读上下文已切换，草稿已保留。' };
      if (res.success && res.data) {
        const created = res.data;
        fetchId.current++;
        seen.current?.ids.add(created.id);
        notifyChanged();
        setComments(prev => prev.some(c => c.id === created.id) ? prev : [created, ...prev]);
        void load('silent');
        return { comment: created };
      }
      return { error: res.error?.code === 'NETWORK_ERROR' ? '发送失败，网络连接中断。草稿已保留。' : res.error?.message || '发送失败，草稿已保留。' };
    } catch {
      return { error: '发送失败，网络连接中断。草稿已保留。' };
    }
  }
  const submit = async () => {
    if (!draft.trim() || submittingDraft.current || !canWrite) return;
    const operationDraftScope = draftScopeRef.current;
    const clientId = savedDraft.clientId ?? crypto.randomUUID();
    if (!savedDraft.clientId || savedDraft.error) setDraft({ text: draft, clientId });
    const options = replyTo ? { parentId: replyTo, clientId } : { anchor: draftAnchor ?? undefined, clientId,
      revisionId: review?.historical ? review.selected?.id : undefined, expectedContentVersion: versionKey };
    const attempt = {};
    submittingDraft.current = attempt;
    setSubmitting(true);
    try {
      const result = await sendComment(draft.trim(), options);
      if (!mounted.current || operationDraftScope !== draftScopeRef.current) return;
      if (!result.comment) {
        setDraft({ text: draft, clientId, error: result.error });
        if (props.readerLayout) textareaRef.current?.focus({ preventScroll: true });
        return;
      }
      setDraft({ text: '' });
      setReplyTo(null);
      if (recoveredReply) {
        storeRecoveries(recoverableReplies.filter(id => id !== recoveredReply));
        setOpenedRecovery(null);
      }
      if (props.threadKind !== 'discussion') annotations?.clearDraft();
      if (replyTo && props.readerLayout) {
        setShowOlderReplies(current => new Set(current).add(replyTo));
        markRead(replyTo);
        annotations?.setActiveId(replyTo);
        window.requestAnimationFrame(() => threadElements.current.get(replyTo)?.scrollIntoView?.({ block: 'start' }));
      }
      if (!replyTo) setFilter(props.readerLayout ? 'open' : 'all');
      if (props.readerLayout) setNotice({ text: replyTo ? '回复已发送' : draftAnchor ? '批注已发布' : '整页评论已发布' });
    } finally {
      if (submittingDraft.current === attempt) {
        submittingDraft.current = null;
        if (mounted.current) setSubmitting(false);
      }
    }
  };
  const remove = async (id: string) => {
    if (confirmDelete !== id) { setConfirmDelete(id); return; }
    const operationIdentity = identity;
    setBusyId(id); setError(null);
    try {
      const res = await deleteSiteComment(id);
      if (!mounted.current || operationIdentity !== identityRef.current) return;
      if (res.success) {
        fetchId.current++;
        notifyChanged();
        setComments(prev => prev.filter(c => c.id !== id && c.parentId !== id));
        markRead(id);
        if (replyTo === id) setReplyTo(null);
      }
      else setError(res.error?.message || '删除失败');
    } catch { if (mounted.current && operationIdentity === identityRef.current) setError('网络错误，删除失败'); }
    finally { if (mounted.current && operationIdentity === identityRef.current) { setBusyId(null); setConfirmDelete(null); } }
  };
  const resolve = async (comment: HostedSiteCommentDto, resolved = !comment.isResolved): Promise<string | null> => {
    const operationIdentity = identity;
    setBusyId(comment.id); setError(null);
    try {
      const source = mode === 'share' ? { token: token!, password, siteId } : { siteId: siteId! };
      const res = await setSiteCommentResolved(source, comment.id, resolved);
      if (!mounted.current || operationIdentity !== identityRef.current) return null;
      if (res.success && res.data) {
        fetchId.current++;
        setComments(prev => prev.map(c => c.id === comment.id ? res.data! : c));
        if (res.data.isResolved) annotations?.setActiveId(null);
        notifyChanged();
        if (props.readerLayout) setNotice(res.data.isResolved ? {
          text: comment.anchor ? `已解决第 ${versionRoots.filter(c => c.anchor).findIndex(c => c.id === comment.id) + 1} 条` : '已解决整页评论',
          undo: () => { void resolve(comment, false); },
        } : { text: '讨论已重新打开' });
        return null;
      }
      setError(res.error?.message || '更新讨论状态失败');
      return res.error?.message || '更新讨论状态失败';
    } catch {
      if (mounted.current && operationIdentity === identityRef.current) setError('网络错误，更新失败');
      return '网络错误，更新失败';
    }
    finally { if (mounted.current && operationIdentity === identityRef.current) setBusyId(null); }
  };
  const actionable = canWrite && !otherVersions;
  actionRef.current = {
    canReply: actionable,
    canResolve: id => actionable && roots.some(comment => comment.id === id && !!comment.canResolve),
    getReplies: id => commentsRef.current.filter(comment => comment.parentId === id).sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    reply: async (id, content, clientId) => {
      if (!actionable || !roots.some(comment => comment.id === id)) return '原讨论已删除或暂时无法回复。';
      const result = await sendComment(content.trim(), { parentId: id, clientId });
      if (result.error) return result.error;
      markRead(id);
      setShowOlderReplies(current => new Set(current).add(id));
      setNotice({ text: '回复已发送' });
      return null;
    },
    resolve: async id => {
      const comment = roots.find(item => item.id === id);
      return actionable && comment && comment.canResolve ? resolve(comment) : '暂时无法更改这条讨论的状态。';
    },
  };
  const bindActions = annotations?.bindDiscussionActions;
  useEffect(() => {
    if (!props.readerLayout || !bindActions) return;
    return bindActions({
      canReply: actionable,
      canResolve: id => actionRef.current?.canResolve(id) ?? false,
      getReplies: id => actionRef.current?.getReplies(id) ?? [],
      reply: (id, content, clientId) => actionRef.current!.reply(id, content, clientId),
      resolve: id => actionRef.current!.resolve(id),
    });
  }, [actionable, bindActions, props.readerLayout]);
  const visible = useMemo(() => roots.filter(c => filter === 'all' || (filter === 'resolved' ? c.isResolved : !c.isResolved)), [filter, roots]);
  const groups = useMemo(() => props.readerLayout && !otherVersions ? groupDiscussionThreads(visible, annotations?.anchorLocations) : [],
    [props.readerLayout, otherVersions, visible, annotations?.anchorLocations]);
  const replyGroups = useMemo(() => {
    const result = new Map<string, HostedSiteCommentDto[]>();
    for (const comment of comments) {
      if (!comment.parentId) continue;
      const replies = result.get(comment.parentId) ?? [];
      replies.push(comment); result.set(comment.parentId, replies);
    }
    for (const replies of result.values()) replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return result;
  }, [comments]);
  const numbers = useMemo(() => new Map(versionRoots.filter(comment => comment.anchor).map((comment, index) => [comment.id, index + 1])), [versionRoots]);
  const unread = roots.filter(comment => newThreads.has(comment.id));
  const walkable = roots.filter(comment => comment.anchor && !comment.isResolved).sort((a, b) => (numbers.get(a.id) ?? 0) - (numbers.get(b.id) ?? 0));
  const picked = walkable.findIndex(comment => comment.id === annotations?.activeId);
  const choose = (comment: HostedSiteCommentDto, moveDocument = false) => {
    markRead(comment.id);
    if (annotations && comment.anchor) {
      if (moveDocument) annotations.focus(comment.id);
      else annotations.setActiveId(comment.id);
    }
  };
  const walk = (direction: number) => {
    const index = picked === -1 ? (direction > 0 ? 0 : walkable.length - 1)
      : (picked + direction + walkable.length) % walkable.length;
    const comment = walkable[index];
    if (!comment) return;
    setFilter(current => current === 'resolved' ? 'open' : current);
    choose(comment, true);
  };
  const jumpUnread = () => {
    const first = unread[0];
    if (!first) return;
    setFilter('all');
    choose(first);
    window.requestAnimationFrame(() => threadElements.current.get(first.id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };
  const historicalWithComments = props.readerLayout && versionKey && !currentCount ? review?.versions?.find(version => !version.isCurrent
    && outsideRoots.some(comment => comment.contentVersion === version.contentVersionKey)) : undefined;
  const historyHintId = historicalWithComments?.id;
  const historyHintLabel = historicalWithComments?.versionLabel;
  const historyHintCount = historyHintId ? outsideRoots.filter(comment => comment.contentVersion === historicalWithComments!.contentVersionKey).length : 0;
  useEffect(() => {
    if (!loading && versionReady) callbacks.current.onHistoryHint?.(historyHintId && historyHintLabel && historyHintCount
      ? { id: historyHintId, label: historyHintLabel, count: historyHintCount } : null);
  }, [loading, versionReady, historyHintId, historyHintLabel, historyHintCount]);
  const startPicking = () => { setReplyTo(null); annotations?.select(); props.onPickElement?.(); };
  const replyTarget = roots.find(c => c.id === replyTo);
  const replyDeleted = !!replyTo && !replyTarget && !loading;
  const cancelContext = () => {
    if (replyTo) setReplyTo(null);
    else if (recoveredReply) setOpenedRecovery(null);
    else annotations?.clearDraft();
  };
  useLayoutEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, props.readerLayout ? 142 : 120)}px`;
  }, [draft, canWrite, otherVersions, props.readerLayout]);
  const pickEntry = annotations && props.threadKind !== 'discussion' ? <button type="button" onClick={loginToAnnotate ? props.onLogin : startPicking}
    aria-label={loginToAnnotate ? (isAuthenticated ? '重新登录后批注' : '登录后批注') : '绑定页面元素 / 选中文字'}
    disabled={!loginToAnnotate && (loading || !canWrite || !annotations.ready || submitting || review?.uploading)}
    title={pickingHint} aria-describedby={pickingHintId} className={loginToAnnotate ? 'review-login-action' : 'review-pick-action'}>
    {loginToAnnotate ? <><LogIn size={15} />{isAuthenticated ? '重新登录后批注' : '登录后批注'}</> : <><MousePointer2 size={15} /><span className="sr-only">选取位置</span></>}
  </button> : null;
  const renderThread = (comment: HostedSiteCommentDto) => {
    const replies = replyGroups.get(comment.id) ?? [];
    const number = numbers.get(comment.id);
    const location = annotations?.anchorLocations?.[comment.id];
    const messages = newThreads.get(comment.id);
    const older = props.readerLayout && !showOlderReplies.has(comment.id) ? Math.max(replies.length - 2, 0) : 0;
    const missing = !otherVersions && annotations?.missingIds.includes(comment.id);
    const originVersion = review?.versions.find(v => v.id === comment.revisionId || v.contentVersionKey === comment.contentVersion);
    const canOpenOrigin = !!originVersion && (props.readerLayout || originVersion.canPreview);
    const locate = () => {
      markRead(comment.id);
      if (otherVersions && originVersion) review?.setVersionPreview({ id: originVersion.id, commentId: comment.id });
      else if (annotations) {
        const focus = () => annotations.focus(comment.id);
        if (props.onLocateAnchor) props.onLocateAnchor(focus);
        else focus();
      }
    };
    const quote = comment.anchor?.text || (comment.anchor && elementLabel(comment.anchor.tagName));
    const pen = props.readerLayout && !otherVersions ? annotations?.penHues?.[comment.id] : undefined;
    const anchorAction = comment.anchor && <button type="button" onClick={locate} disabled={otherVersions ? !canOpenOrigin : !annotations?.ready}
      className="review-anchor-quote" title={`定位原文：${quote}`}
      data-pen={pen} style={pen === undefined ? undefined : { '--annotation-pen': pen } as CSSProperties}>
      <span className="review-anchor-number">{otherVersions ? <History size={13} /> : number}</span>
      <span className="review-anchor-label">{props.readerLayout ? `「${quote}」` : props.splitLayout ? quote : '原文'}</span>
      {props.readerLayout && location && <span className="review-thread-paragraph">第 {location.paragraph} 段</span>}
    </button>;
    return <article key={comment.id} id={`${pickingHintId}-thread-${comment.id}`}
      ref={element => { if (element) threadElements.current.set(comment.id, element); else threadElements.current.delete(comment.id); }}
      className={`review-thread${annotations?.activeId === comment.id ? ' is-active' : ''}${annotations?.readingId === comment.id ? ' is-following' : ''}${comment.isResolved ? ' is-resolved' : ''}`}
      onClick={props.readerLayout ? event => {
        if ((event.target as HTMLElement).closest('button, a, input, textarea') || window.getSelection()?.toString()) return;
        choose(comment);
      } : undefined}>
      {props.splitLayout && (anchorAction || <div className="review-thread-context"><span className="review-anchor-number">页</span>整页评论</div>)}
      <CommentMessage compact={props.readerLayout} isNew={!!messages?.size} comment={comment}
        busy={busyId === comment.id} confirming={confirmDelete === comment.id} onDelete={() => void remove(comment.id)}>
        {otherVersions && <div className="review-origin-version"><span>来自 {originVersion?.versionLabel ?? (comment.contentVersion ? '未收录的旧版本' : '未标版本的历史评论')}</span>
          {canOpenOrigin && <button type="button" onClick={locate}>预览 {originVersion!.versionLabel}</button>}</div>}
      </CommentMessage>
      {replies.length > 0 && <div className="review-replies">
        {older > 0 && <button className="review-older-replies" type="button" onClick={() => {
          markRead(comment.id);
          setShowOlderReplies(current => new Set(current).add(comment.id));
        }}>还有 {older} 条更早的回复</button>}
        {replies.slice(older).map(reply =>
          <CommentMessage compact={props.readerLayout} isNew={messages?.has(reply.id)} key={reply.id} comment={reply}
            busy={busyId === reply.id} confirming={confirmDelete === reply.id} onDelete={() => void remove(reply.id)} />)}
      </div>}
      <div className="review-thread-actions">
        {props.readerLayout && comment.isResolved && <span className="review-talk-resolved"><Check size={13} />已解决</span>}
        {actionable ? <button type="button" className="review-reply-action" disabled={submitting} onClick={() => {
          choose(comment); annotations?.clearDraft(); setReplyTo(comment.id); textareaRef.current?.focus({ preventScroll: true });
        }}><CornerDownRight size={13} />回复{!props.readerLayout && replies.length ? ` ${replies.length}` : ''}</button> : <span />}
        {!props.splitLayout && anchorAction}
        {comment.canResolve && commentsEnabled && <button type="button" className="review-resolve-action" aria-label={comment.isResolved ? '重新打开' : '标记解决'} title={comment.isResolved ? '重新打开' : '标记解决'} disabled={busyId !== null} onClick={() => void resolve(comment)}>
          {comment.isResolved ? <RotateCcw size={14} /> : <Check size={14} />}<span className={props.readerLayout ? undefined : 'sr-only'}>{comment.isResolved ? '重新打开' : props.readerLayout ? '解决' : '标记解决'}</span></button>}
      </div>
      {missing && <p className="review-anchor-missing">原位置已变更，批注内容已保留</p>}
    </article>;
  };
  return (
    <section aria-label="批注与讨论" className={`review-discussion${props.readerLayout ? ' review-discussion--b' : ''}`}>
      {props.readerLayout && <header className="review-talk-header">
        <div className="review-talk-title"><strong>讨论</strong>
          <span>{openCount} 条未解决{lastSync !== null && ' · '}{syncFailed
            ? <button type="button" onClick={() => void poll()}>同步失败，点此重试</button>
            : <DiscussionSyncTime value={lastSync} />}</span>
        </div>
        {walkable.length > 0 && annotations?.ready && <div className="review-talk-nav">
          <span>批注 {picked < 0 ? '–' : picked + 1} / {walkable.length}</span>
          <button type="button" aria-label="上一条未解决" onClick={() => walk(-1)}><ChevronUp size={15} /></button>
          <button type="button" aria-label="下一条未解决" onClick={() => walk(1)}><ChevronDown size={15} /></button>
        </div>}
        {annotations && <button className="review-talk-icon" type="button"
          disabled={!annotationCount} aria-label={annotations.hasHiddenPreviews ? '显示全部气泡' : '隐藏全部气泡'}
          onClick={annotations.hasHiddenPreviews ? annotations.showAllPreviews : annotations.hideAllPreviews}>
          {annotations.hasHiddenPreviews ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>}
        {props.headerActions}
        {props.onClose && <button className="review-talk-icon" type="button" aria-label="关闭讨论" onClick={props.onClose}><PanelRightClose size={15} /></button>}
      </header>}
      <div className="review-scope">
        {review && !props.readerLayout && <>
          <div className="review-scope-tabs" role="tablist" aria-label="批注版本范围">
            <button type="button" role="tab" disabled={versionPending} aria-selected={!otherVersions} onClick={() => { initialVersionScope.current = manualVersionScope; setOtherVersions(false); }}>本版 <span>{versionPending ? '—' : versionRoots.length}</span></button>
            {!props.versionOnly && <button type="button" role="tab" disabled={versionPending} aria-selected={otherVersions} onClick={() => { initialVersionScope.current = manualVersionScope; setOtherVersions(true); }}>其他版本 <span>{versionPending ? '—' : outsideRoots.length}</span></button>}
          </div>
          {review.error && <div className="review-scope-caption" role="status">版本信息暂不可用，已有意见仍可阅读</div>}
        </>}
        <div role="tablist" aria-label="讨论状态" className="review-status-tabs">
          {([{ value: 'open', label: '未解决', count: openCount }, { value: 'resolved', label: '已解决', count: resolvedCount },
            { value: 'all', label: '全部', count: roots.length }] as const).map(tab => (
            <button key={tab.value} type="button" role="tab" disabled={versionPending} aria-selected={filter === tab.value} onClick={() => setFilter(tab.value)}>{tab.label} <span>{versionPending ? '—' : tab.count}</span></button>
          ))}
        </div>
      </div>
      {historyHintId && <p className="review-talk-note">当前版本暂无意见，{historyHintLabel} 有 {historyHintCount} 条。<button type="button" onClick={() => review?.setVersionPreview({ id: historyHintId })}>在小窗查看</button></p>}
      {props.readerLayout && annotations?.connectionChecked && !annotations.ready && <p className="review-talk-note">这个页面不能加载批注脚本，只支持整页评论。</p>}
      {props.readerLayout && unread.length > 0 && <button className="review-talk-new" type="button" onClick={jumpUnread}><MessageSquare size={14} />{unread.length} 条讨论有新内容 · 查看</button>}
      <div className="review-thread-scroll" ref={listRef}>
        {loading || versionPending ? <MapSectionLoader text={versionPending ? '正在确认网页版本…' : '正在加载讨论…'} /> : <>
          {visible.length === 0 && !error && <div className="review-empty">
            {!props.readerLayout && <MessageSquare size={23} />}<strong>{filter === 'resolved' ? '还没有已解决的讨论' : filter === 'open' && resolvedCount ? '全部意见都已解决' : props.readerLayout ? '还没有意见' : props.threadKind === 'discussion' ? '讨论这份文档' : '让意见留在对应的位置'}</strong>
            <p>{otherVersions ? '其他版本的讨论会保留在这里。' : props.readerLayout
              ? '选中正文中的文字可添加批注，也可以在下方写整页评论。'
              : props.threadKind === 'discussion' ? '留下整页讨论，与其他读者交流。' : '选取一个元素或一段文字，开始第一条批注。'}</p>
          </div>}
          {groups.length ? groups.map(group => <Fragment key={group.key}>
            <h3 className="review-thread-group"><strong>{group.title}</strong><span>{group.threads.length} 条</span></h3>
            {group.threads.map(renderThread)}
          </Fragment>) : visible.map(renderThread)}
        </>}
        {error && <p role="alert" className="review-discussion-error">{error}<button type="button" onClick={() => void load()}>重新加载</button></p>}
      </div>
      <div className="review-composer">
        {!commentsEnabled || !canWrite ? <div className="review-composer-unavailable">
          {versionPending ? <MapSpinner size={19} /> : <Lock size={19} />}<strong>{!commentsEnabled ? '评论与批注已关闭' : !isAuthenticated ? '加入这份网页的讨论' : versionPending ? '正在确认网页版本' : '暂时无法开始批注'}</strong>
          <p id={pickingHintId}>{pickingHint}</p>{pickEntry}
          {(!annotations || props.threadKind === 'discussion') && !isAuthenticated && props.onLogin && <button type="button" className="review-login-action" onClick={props.onLogin}><LogIn size={15} />登录后评论</button>}
        </div> : otherVersions ? <div className="review-composer-unavailable"><History size={19} /><p>回到对应版本，继续那里的讨论。</p><button type="button" className="review-pick-action" onClick={() => setOtherVersions(false)}>返回本版发表评论</button></div> : <>
          {draftAnchor ? <div className="review-composer-anchor"><Link2 size={14} /><span><strong>{props.readerLayout ? '批注' : `已选中${draftAnchor.kind === 'text' ? '文字' : elementLabel(draftAnchor.tagName)}`}</strong><span>{props.readerLayout ? `「${draftAnchor.text || '无文字元素'}」` : draftAnchor.text || '无文字元素'}</span></span>
            <button type="button" aria-label="取消位置绑定" disabled={submitting} onClick={() => annotations?.clearDraft()}><X size={14} /></button></div>
            : replyTarget ? <div className="review-composer-anchor"><CornerDownRight size={14} /><span><strong>回复 {replyTarget.authorName}</strong><span>{props.readerLayout ? `「${annotationPreviewText(replyTarget.content, 22)}」` : replyTarget.content}</span></span><button type="button" aria-label="取消回复" disabled={submitting} onClick={() => setReplyTo(null)}><X size={14} /></button></div>
            : null}
          {replyDeleted && replyTo ? <div className="review-composer-error" role="alert">
            <CircleAlert size={14} /><span>原讨论已删除，草稿已保留。</span>
            <button type="button" disabled={submitting} onClick={() => {
              // The recovered text will be sent to the page, with different submission parameters.
              if (savedDraft.clientId || savedDraft.error) setDraft({ text: draft });
              setPendingPageDraft({ scope: draftScope, id: replyTo, text: draft });
              setOpenedRecovery(null);
              setReplyTo(null);
            }}>改为整页评论</button>
          </div> : savedDraft.error && <div className="review-composer-error" role="alert">
            <CircleAlert size={14} /><span>{savedDraft.error}</span>
            <button type="button" onClick={() => void submit()} disabled={submitting}>重试</button>
          </div>}
          {recoveredReply ? <div className="review-composer-error" role="status">
            <span>原回复可单独作为整页评论发送。</span>
            <button type="button" disabled={submitting} onClick={() => setOpenedRecovery(null)}>返回原整页草稿</button>
          </div> : draftMode === 'page' && recoverableReplies.length > 0 && <div className="review-composer-error" role="status">
            <CircleAlert size={14} /><span>合并超过 2000 字，两份草稿可单独发送。</span>
            <button type="button" disabled={submitting} onClick={() => {
              setOpenedRecovery({ scope: draftScope, id: recoverableReplies[0] });
              textareaRef.current?.focus({ preventScroll: true });
            }}>打开回复草稿</button>
          </div>}
          <div className="review-composer-row">
          <textarea ref={textareaRef} aria-label={replyTo ? '回复内容' : props.threadKind === 'discussion' ? '讨论内容' : '批注内容'} value={draft}
            readOnly={props.readerLayout && submitting} disabled={!props.readerLayout && submitting}
            onChange={e => setDraft({ text: e.target.value })} maxLength={2000} rows={1}
            onKeyDown={e => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (!replyDeleted) void submit(); }
              if (e.key === 'Escape' && !submitting && (replyTo || draftAnchor || recoveredReply)) { e.preventDefault(); e.stopPropagation(); cancelContext(); }
            }}
            placeholder={replyTo ? (props.readerLayout ? '写回复…' : `回复 ${replyTarget?.authorName ?? ''}…`) : draftAnchor ? (props.readerLayout ? '写下对这段文字的意见…' : '写下对这个位置的意见…') : props.threadKind === 'discussion' ? '写下你的看法…' : props.readerLayout ? '写整页评论…' : '写下意见…'} />
          {draftMode === 'page' && pickEntry}
          <button type="button" onClick={() => void submit()} disabled={!draft.trim() || submitting || replyDeleted} className="review-send-action" title="Ctrl / ⌘ + Enter 发送">
            {submitting ? <MapSpinner size={15} /> : <ArrowUp size={16} />}<span className="sr-only">{replyTo ? '发送回复' : props.threadKind === 'discussion' ? '发送讨论' : '发送批注'}</span></button></div>
          {draft.length >= 1800 && <div className="review-composer-count">{draft.length}/2000</div>}
          {props.readerLayout ? draftMode === 'page' && <div id={pickingHintId} className="review-talk-hint"><span>{annotations?.ready ? '选中正文文字可添加批注' : '此页面只支持整页评论'}</span><span>Ctrl + Enter 发送</span></div>
            : annotations && !annotations.draftAnchor && <p id={pickingHintId} className="review-composer-hint">{pickingHint}</p>}
        </>}
      </div>
      {props.readerLayout && notice && <div className="review-talk-toast" role="status">
        {notice.text}{notice.undo && <button type="button" onClick={notice.undo}>撤销</button>}
      </div>}
    </section>
  );
}

const dateInReview = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function DiscussionSyncTime({ value }: { value: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (value === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [value]);
  if (value === null) return null;
  const elapsed = Math.max(0, Math.floor((now - value) / 1000));
  return <>{elapsed <= 5 ? '刚刚同步' : `${elapsed} 秒前同步`}</>;
}

function CommentMessage({ comment, busy, confirming, onDelete, children, compact, isNew }: {
  comment: HostedSiteCommentDto; busy: boolean; confirming: boolean; onDelete: () => void; children?: ReactNode; compact?: boolean; isNew?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const limit = compact ? 110 : 280;
  const long = comment.content.length > limit;
  const updated = Date.parse(comment.createdAt);
  const time = compact && Number.isFinite(updated) && Date.now() - updated > 60_000 ? dateInReview.format(updated) : formatTime(comment.createdAt);
  const nameCharacters = [...(comment.authorName || '?')];
  const hue = nameCharacters.reduce((hash, character) => (hash * 31 + character.codePointAt(0)!) % 360, 0);
  return <div className="review-message">
    <div className="review-message-author">{compact && !comment.authorAvatarFileName
      ? <span className="review-talk-avatar" aria-hidden="true" style={{ '--talk-avatar-hue': hue } as CSSProperties}>{nameCharacters[0]}</span>
      : <img src={getUserAvatarUrl({ avatarFileName: comment.authorAvatarFileName, displayName: comment.authorName })} alt="" loading="lazy" />}
      <strong>{comment.authorName}</strong>{!compact && <span>·</span>}<time dateTime={comment.createdAt}>{time}</time>
      {compact && isNew && <span className="review-talk-unread">新</span>}
      {comment.canDelete && <button type="button" disabled={busy} onClick={onDelete} aria-label={confirming ? '确认删除讨论及回复' : '删除评论'} title={confirming ? '再次点击确认删除' : '删除评论'}>
        {busy ? <MapSpinner size={13} /> : confirming ? <span>确认删除</span> : <Trash2 size={13} />}</button>}
    </div>
    {children}
    <p className={`review-message-body${long && !expanded ? ' is-collapsed' : ''}`} style={{ overflowWrap: 'anywhere' }}>{expanded ? comment.content : annotationPreviewText(comment.content, limit)}</p>
    {long && <button type="button" className="review-tool review-discussion-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起全文' : compact ? `展开全文 · ${comment.content.length} 字` : '展开全文'}</button>}
  </div>;
}

function formatTime(iso: string): string {
  const diff = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}
