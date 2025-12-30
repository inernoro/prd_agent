import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useSessionStore } from '../../stores/sessionStore';
import { usePrdCitationPreviewStore } from '../../stores/prdCitationPreviewStore';
import { usePrdPreviewNavStore } from '../../stores/prdPreviewNavStore';
import type { Message, MessageBlock } from '../../types';
import MarkdownRenderer from '../Markdown/MarkdownRenderer';
import WizardLoader from './WizardLoader';

type MsgStoreState = ReturnType<typeof useMessageStore.getState>;

const phaseText: Record<string, string> = {
  requesting: '正在请求大模型…',
  connected: '已连接，等待首包…',
  receiving: '正在接收信息…',
  typing: '开始输出…',
};

function ThinkingIndicator({ label }: { label?: string }) {
  return (
    <WizardLoader label={label || '处理中'} size={92} />
  );
}

function unwrapMarkdownFences(text: string) {
  if (!text) return text;
  // 兼容：LLM 常用 ```markdown / ```md 包裹“本来就想渲染的 Markdown”，会被当作代码块显示
  // 这里仅解包 markdown/md 语言标记，其它代码块保持不动
  return text.replace(/```(?:markdown|md)\s*\n([\s\S]*?)\n```/g, '$1');
}

function injectSectionNumberLinks(raw: string) {
  if (!raw) return raw;
  // 避免重复注入
  if (raw.includes('](prd-nav:') || raw.includes('](prd-nav://')) return raw;

  // 支持形如：
  // - （章节4.2，4.3）
  // - (章节 4.2, 4.3)
  // - （4.2，4.3）
  // 目标：把每个章节号变成内部链接，点击后用 title 去预览页匹配（包含匹配即可命中 “4.2 xxx”）
  const re = /[（(]\s*(?:章节\s*)?(\d+(?:\.\d+){0,3})(?:\s*[,，、]\s*(\d+(?:\.\d+){0,3}))*\s*[）)]/g;
  return raw.replace(re, (m) => {
    // 抽取全部数字（不依赖捕获组数量）
    const nums = (m.match(/\d+(?:\.\d+){0,3}/g) || []).slice(0, 8);
    if (nums.length === 0) return m;
    const left = m.trim().startsWith('(') ? '(' : '（';
    const right = m.trim().endsWith(')') ? ')' : '）';
    const sep = m.includes('、') ? '、' : (m.includes('，') ? '，' : ', ');
    const prefix = /章节/.test(m) ? '章节' : '';
    const linked = nums.map((n, i) => {
      const label = `${prefix}${n}`;
      const href = `prd-nav:${n}`;
      // prefix 只在第一个展示，避免 “章节4.2，章节4.3”
      const show = i === 0 ? label : n;
      return `[${show}](${href})`;
    }).join(sep);
    return `${left}${linked}${right}`;
  });
}

/**
 * 将回答中的“来源：...”行改造成可点击的章节来源标记（chip）。
 * 目标形态（示例）：
 *   来源： [1.2.3](prd-nav:1.2.3) 文本理解的天然效率上限。
 *   来源： [7.3](prd-nav:7.3) LLM支持、[4.1](prd-nav:4.1) 文档上传与解析…
 *
 * 说明：不依赖后端 citations；若 citations 存在，仍可通过点击底部“来源”或引用抽屉导航查看摘录。
 */
function injectSourceLines(raw: string) {
  if (!raw) return raw;
  // 避免重复注入
  if (raw.includes('prd-source-line:1')) return raw;

  const toChip = (numRaw: string, titleRaw?: string) => {
    const num = String(numRaw || '').trim().replace(/\.$/, ''); // 兼容 "11."
    if (!num) return numRaw;
    const title = String(titleRaw || '').trim();
    // markdown link title：ReactMarkdown 会传到 a renderer 的 title
    const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : '';
    return `[${num}](prd-nav:${num}${titlePart})`;
  };

  const lines = String(raw).split('\n');
  const out: string[] = [];
  for (const line of lines) {
    // 允许缩进/列表项前缀：- 来源： / • 来源： / * 来源：
    const m = /^(\s*(?:[-*•]\s*)?)来源\s*[:：]\s*(.+)$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const prefix = m[1] || '';
    const rest = (m[2] || '').trim();
    if (!rest) {
      out.push(line);
      continue;
    }

    // 策略：优先匹配 “编号 + 空格 + 标题片段”
    // - 编号形态：11 / 7.3 / 1.2.3 / 11.
    // - 标题片段：直到遇到分隔符（，、,；;）或行尾
    const re = /(\d+(?:\.\d+){0,3}\.?)\s*([^\s，、,；;]+[^\n，、,；;]*)?/g;
    let next = rest;
    // 仅对来源行做替换：把每个编号替换成 chip；如果紧跟着标题，则把标题放到 chip 的 title 里
    next = next.replace(re, (all, n, t) => {
      // 防止误把年份/数量当来源：来源行里一般不会出现 2025 这种，但仍限制长度
      const num = String(n || '').trim();
      if (!num) return all;
      // 如果标题看起来是“纯连接词”，忽略
      const title = String(t || '').trim();
      return toChip(num, title);
    });

    // 用 data 行标记避免重复注入
    out.push(`${prefix}来源： ${next} <!-- prd-source-line:1 -->`);
  }
  return out.join('\n');
}

function parseCitationIndexFromHref(href: string) {
  const h = String(href || '');
  if (!h.startsWith('prd-citation:') && !h.startsWith('prd-citation://')) return null;
  const idxStr = h.replace('prd-citation://', 'prd-citation:').split(':')[1] || '';
  const idx = Number(idxStr);
  return Number.isFinite(idx) ? idx : null;
}

function parseNavTitleFromHref(href: string) {
  const h = String(href || '');
  if (!h.startsWith('prd-nav:') && !h.startsWith('prd-nav://')) return null;
  const t = h.replace('prd-nav://', 'prd-nav:').slice('prd-nav:'.length);
  const title = String(t || '').trim();
  return title ? title : null;
}

function MessageListInner() {
  const messages = useMessageStore((s: MsgStoreState) => s.messages);
  const isStreaming = useMessageStore((s: MsgStoreState) => s.isStreaming);
  const streamingMessageId = useMessageStore((s: MsgStoreState) => s.streamingMessageId);
  const streamingPhase = useMessageStore((s: MsgStoreState) => s.streamingPhase);
  const isPinnedToBottom = useMessageStore((s: MsgStoreState) => s.isPinnedToBottom);
  const setPinnedToBottom = useMessageStore((s: MsgStoreState) => s.setPinnedToBottom);
  const scrollToBottomSeq = useMessageStore((s: MsgStoreState) => s.scrollToBottomSeq);
  const isLoadingOlder = useMessageStore((s: MsgStoreState) => s.isLoadingOlder);
  const hasMoreOlder = useMessageStore((s: MsgStoreState) => s.hasMoreOlder);
  const loadOlderMessages = useMessageStore((s: MsgStoreState) => s.loadOlderMessages);
  const pendingAssistantId = useMessageStore((s: MsgStoreState) => s.pendingAssistantId);
  const { sessionId, activeGroupId, document: prdDocument } = useSessionStore();
  const openCitationDrawer = usePrdCitationPreviewStore((s) => s.open);
  const openWithCitations = usePrdPreviewNavStore((s) => s.openWithCitations);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const pendingAssistantRef = useRef<HTMLDivElement>(null);

  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
  const [containerHeight, setContainerHeight] = useState(0);
  const estimatedRowHeight = 120;
  const windowSize = useMemo(() => {
    if (!containerHeight) return 80;
    const screens = Math.ceil(containerHeight / estimatedRowHeight);
    return clamp(screens * 3, 50, 180);
  }, [containerHeight]);

  // pinned 场景下限制最大渲染窗口，避免“跳到最新”时一次性 mount 太多节点导致滚动同步卡顿
  const pinnedWindowSize = useMemo(() => Math.min(windowSize, 60), [windowSize]);

  const [range, setRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const rangeRef = useRef(range);
  rangeRef.current = range;

  const pendingAnchorRef = useRef<{ id: string; offset: number } | null>(null);
  const firstNonEmptyLoggedRef = useRef(false);
  const emptyVisibleLoggedKeyRef = useRef<string | null>(null);
  const firstScrollLoggedRef = useRef(false);
  const ioLogCountRef = useRef(0);
  const ensuredInitialRangeRef = useRef(false);

  // 关键修复：避免“messages 已存在但 range 仍是 0”导致白屏（用户一滚动才触发 range 更新）
  // 这里用 layoutEffect，保证首帧就有可见消息；本身只是一次 setState，不涉及滚动/读布局。
  useLayoutEffect(() => {
    if (ensuredInitialRangeRef.current) return;
    if (!messages || messages.length === 0) return;
    const r = rangeRef.current;
    if (r.start !== 0 || r.end !== 0) return;
    const end = messages.length;
    const start = Math.max(0, end - (isPinnedToBottom ? pinnedWindowSize : windowSize));
    ensuredInitialRangeRef.current = true;
    setRange({ start, end });
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'promptLag-pre',hypothesisId:'H16',location:'MessageList.tsx:ensureInitialRange:layoutEffect',message:'ensure_initial_range_set',data:{messagesLen:messages.length,isPinnedToBottom:Boolean(isPinnedToBottom),start:Number(start),end:Number(end),windowSize:Number(windowSize),pinnedWindowSize:Number(pinnedWindowSize)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  }, [messages.length, isPinnedToBottom, pinnedWindowSize, windowSize]);

  // #region agent log
  useLayoutEffect(() => {
    const el = containerRef.current;
    const rest = (globalThis as any).history?.scrollRestoration ?? null;
    fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'promptLag-pre',hypothesisId:'H10',location:'MessageList.tsx:mount:layoutEffect',message:'mount_state',data:{scrollTop:el?.scrollTop??null,scrollHeight:el?.scrollHeight??null,clientHeight:el?.clientHeight??null,historyScrollRestoration:rest,isPinnedToBottom:Boolean(isPinnedToBottom),messagesLen:messages.length,windowSize:Number(windowSize),pinnedWindowSize:Number(pinnedWindowSize),rangeStart:Number(range.start),rangeEnd:Number(range.end)},timestamp:Date.now()})}).catch(()=>{});
  }, []);
  // #endregion

  // #region agent log
  useEffect(() => {
    if (firstNonEmptyLoggedRef.current) return;
    if (!messages || messages.length === 0) return;
    firstNonEmptyLoggedRef.current = true;
    const el = containerRef.current;
    fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'promptLag-pre',hypothesisId:'H11',location:'MessageList.tsx:firstMessages:effect',message:'first_non_empty_messages',data:{scrollTop:el?.scrollTop??null,scrollHeight:el?.scrollHeight??null,clientHeight:el?.clientHeight??null,isPinnedToBottom:Boolean(isPinnedToBottom),messagesLen:messages.length,windowSize:Number(windowSize),pinnedWindowSize:Number(pinnedWindowSize)},timestamp:Date.now()})}).catch(()=>{});
  }, [messages.length, isPinnedToBottom, pinnedWindowSize, windowSize]);
  // #endregion

  const getAnchorOffset = (messageId: string) => {
    const root = containerRef.current;
    if (!root) return null;
    const containerRect = root.getBoundingClientRect();
    const el = root.querySelector(`[data-msg-id="${messageId}"]`) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.top - containerRect.top;
  };

  const applyAnchor = () => {
    const root = containerRef.current;
    const pending = pendingAnchorRef.current;
    if (!root || !pending) return;
    const newOffset = getAnchorOffset(pending.id);
    if (newOffset == null) return;
    const delta = newOffset - pending.offset;
    if (Number.isFinite(delta) && Math.abs(delta) > 0.5) {
      root.scrollTop += delta;
    }
    pendingAnchorRef.current = null;
  };

  // 监听容器高度（决定窗口大小）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setContainerHeight(el.clientHeight || 0);
    });
    ro.observe(el);
    setContainerHeight(el.clientHeight || 0);
    return () => ro.disconnect();
  }, []);

  // pinned 场景：窗口永远锚定在最新尾部
  useEffect(() => {
    if (!isPinnedToBottom) return;
    const end = messages.length;
    const start = Math.max(0, end - pinnedWindowSize);
    setRange({ start, end });
  }, [isPinnedToBottom, messages.length, pinnedWindowSize]);

  // 初始化（首次进入时，把窗口放到尾部）
  useEffect(() => {
    if (range.end !== 0 || range.start !== 0) return;
    const end = messages.length;
    const start = Math.max(0, end - pinnedWindowSize);
    setRange({ start, end });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, pinnedWindowSize]);

  const pendingScrollToBottomSeqRef = useRef<number>(0);

  // 用户主动发送/提示词：强制跳到最新一页
  // 注意：这里不再做“同步滚动”（会触发 300ms 级别的同步布局/卡顿），只做状态更新与记录，
  // 真正的滚动延后到 useEffect（浏览器完成一次 paint 之后）执行。
  useLayoutEffect(() => {
    // 关键：用 layout effect 同步滚动，避免用户点击发送后“空等一帧甚至更久”
    if (!scrollToBottomSeq) return;
    // #region agent log
    const _t0 = (globalThis as any).performance?.now?.() ?? Date.now();
    const _tf0 = (globalThis as any).performance?.now?.() ?? Date.now();
    fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'promptLag-pre',hypothesisId:'H2',location:'MessageList.tsx:scrollToBottomSeq:layoutEffect:before',message:'before_scrollIntoView',data:{msgCount:messages.length,pendingId:pendingAssistantId||null},timestamp:Date.now()})}).catch(()=>{});
    const _tf1 = (globalThis as any).performance?.now?.() ?? Date.now();
    // #endregion
    const _tp0 = (globalThis as any).performance?.now?.() ?? Date.now();
    setPinnedToBottom(true);
    const _tp1 = (globalThis as any).performance?.now?.() ?? Date.now();
    pendingScrollToBottomSeqRef.current = scrollToBottomSeq;
    const root = containerRef.current;
    const _ts0 = (globalThis as any).performance?.now?.() ?? Date.now();
    const _ts1 = (globalThis as any).performance?.now?.() ?? Date.now();
    // #region agent log
    const _t1 = (globalThis as any).performance?.now?.() ?? Date.now();
    // breakdown：拆分同步段到底卡在 fetch / setPinnedToBottom / scroll 写入（或走了 scrollIntoView fallback）
    fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'promptLag-pre',hypothesisId:'H6',location:'MessageList.tsx:scrollToBottomSeq:layoutEffect:breakdown',message:'layout_effect_breakdown',data:{dtFetchCallMs:Number(_tf1)-Number(_tf0),dtPinnedCallMs:Number(_tp1)-Number(_tp0),dtScrollCallMs:Number(_ts1)-Number(_ts0),rootExists:!!root,scrollMethod:root?'scrollTop':'scrollIntoView',isPinnedToBottom:Boolean(isPinnedToBottom),msgCount:messages.length},timestamp:Date.now()})}).catch(()=>{});
    fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'promptLag-pre',hypothesisId:'H2',location:'MessageList.tsx:scrollToBottomSeq:layoutEffect:after',message:'after_scrollIntoView',data:{dtMs:Number(_t1)-Number(_t0),msgCount:messages.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  }, [scrollToBottomSeq, setPinnedToBottom]);

  // 真正的滚动：放到 paint 之后，避免在 layoutEffect 里触发同步布局导致"卡一下"
  useEffect(() => {
    if (!scrollToBottomSeq) return;
    if (pendingScrollToBottomSeqRef.current !== scrollToBottomSeq) return;
    const root = containerRef.current;
    // #region agent log
    const _t0 = (globalThis as any).performance?.now?.() ?? Date.now();
    // #endregion
    // 有 pending assistant（用户刚发送）时用 auto 立即滚动，确保用户立刻看到消息和加载动画；
    // 流式期间也用 auto 避免高频 smooth；其他场景用 smooth 提供丝滑体验
    const shouldInstant = !!pendingAssistantId || isStreaming;
    // 优先滚动到 pending assistant 元素（让 AI 加载动画完整显示），否则滚动到底部哨兵
    const scrollTarget = pendingAssistantRef.current || bottomRef.current;
    scrollTarget?.scrollIntoView({ behavior: shouldInstant ? 'auto' : 'smooth', block: 'end' });
    // #region agent log
    const _t1 = (globalThis as any).performance?.now?.() ?? Date.now();
    fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'promptLag-pre',hypothesisId:'H7',location:'MessageList.tsx:scrollToBottomSeq:effect:scrollAfterPaint',message:'scroll_after_paint',data:{dtMs:Number(_t1)-Number(_t0),rootExists:!!root,scrollMethod:'scrollIntoView',pinnedWindowSize:Number(pinnedWindowSize),msgCount:messages.length,pendingAssistantId:pendingAssistantId||null,shouldInstant:Boolean(shouldInstant),scrollTarget:pendingAssistantRef.current?'pendingAssistant':'bottom'},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  }, [scrollToBottomSeq, messages.length, isStreaming, pendingAssistantId]);

  useEffect(() => {
    if (!pendingAssistantId) return;
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'promptLag-pre',hypothesisId:'H3',location:'MessageList.tsx:pendingAssistantId:effect',message:'pending_assistant_visible',data:{pendingId:pendingAssistantId,msgCount:messages.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  }, [pendingAssistantId, messages.length]);

  const shiftEarlier = useCallback(() => {
    const r = rangeRef.current;
    if (r.start <= 0) return;
    const anchorId = messages[r.start]?.id;
    if (!anchorId) return;
    const offset = getAnchorOffset(anchorId);
    if (offset == null) return;
    pendingAnchorRef.current = { id: anchorId, offset };
    const shift = Math.min(30, r.start);
    const newStart = Math.max(0, r.start - shift);
    const newEnd = Math.min(messages.length, newStart + windowSize);
    setRange({ start: newStart, end: newEnd });
  }, [messages, windowSize]);

  const shiftLater = useCallback(() => {
    const r = rangeRef.current;
    if (r.end >= messages.length) return;
    const anchorIdx = Math.max(r.start, r.end - 1);
    const anchorId = messages[anchorIdx]?.id;
    if (!anchorId) return;
    const offset = getAnchorOffset(anchorId);
    if (offset == null) return;
    pendingAnchorRef.current = { id: anchorId, offset };
    const remaining = messages.length - r.end;
    const shift = Math.min(30, remaining);
    const newEnd = Math.min(messages.length, r.end + shift);
    const newStart = Math.max(0, newEnd - windowSize);
    setRange({ start: newStart, end: newEnd });
  }, [messages, windowSize]);

  const tryLoadOlder = useCallback(async () => {
    const root0 = containerRef.current;
    const atTop = (root0?.scrollTop ?? 0) < 2;
    const scrollable = root0 ? (root0.scrollHeight - root0.clientHeight > 2) : false;
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'whiteScreen-topLoad',hypothesisId:'H19',location:'MessageList.tsx:tryLoadOlder:entry',message:'try_load_older_entry',data:{isPinnedToBottom:Boolean(isPinnedToBottom),atTop:Boolean(atTop),scrollable:Boolean(scrollable),isLoadingOlder:Boolean(isLoadingOlder),hasMoreOlder:Boolean(hasMoreOlder),groupId:activeGroupId?String(activeGroupId):null,messagesLen:messages.length,rangeStart:Number(rangeRef.current.start),rangeEnd:Number(rangeRef.current.end),scrollTop:root0?.scrollTop??null,scrollHeight:root0?.scrollHeight??null,clientHeight:root0?.clientHeight??null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    // pinned 仅用于"自动锁底滚动"。加载更早消息的行为不应该被 pinned 阻断：
    // - 内容不足一屏时 pinned 常驻 true（导致永远无法分页）
    // - 用户滚到顶部/点击"加载更早"时，即便 pinned=true 也应允许
    if (isPinnedToBottom && !atTop && scrollable) return;
    if (!activeGroupId) return;
    if (isLoadingOlder) return;
    if (!hasMoreOlder) return;

    const r = rangeRef.current;
    if (r.start !== 0) return;
    const anchorId = messages[0]?.id;
    if (!anchorId) return;
    const offset = getAnchorOffset(anchorId);
    if (offset == null) return;
    pendingAnchorRef.current = { id: anchorId, offset };

    // #region agent log
    const _root = containerRef.current;
    fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'whiteScreen-topLoad',hypothesisId:'H20',location:'MessageList.tsx:tryLoadOlder:before',message:'try_load_older_before',data:{messagesLen:messages.length,rangeStart:Number(r.start),rangeEnd:Number(r.end),scrollTop:_root?.scrollTop??null,scrollHeight:_root?.scrollHeight??null,clientHeight:_root?.clientHeight??null,isLoadingOlder:Boolean(isLoadingOlder),hasMoreOlder:Boolean(hasMoreOlder)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    const { added } = await loadOlderMessages({ groupId: activeGroupId, limit: 20 });

    // #region agent log
    const _root2 = containerRef.current;
    fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'whiteScreen-topLoad',hypothesisId:'H20',location:'MessageList.tsx:tryLoadOlder:after',message:'try_load_older_after',data:{added:Number(added),messagesLen:messages.length,rangeStart:Number(rangeRef.current.start),rangeEnd:Number(rangeRef.current.end),scrollTop:_root2?.scrollTop??null,scrollHeight:_root2?.scrollHeight??null,clientHeight:_root2?.clientHeight??null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    if (added > 0) {
      // 新消息 prepend 到数组头部：窗口索引整体后移，保持当前视口不跳
      const rr = rangeRef.current;
      setRange({ start: rr.start + added, end: rr.end + added });
    }
  }, [hasMoreOlder, isLoadingOlder, isPinnedToBottom, loadOlderMessages, messages, activeGroupId]);

  // 窗口变更后：用 anchor 补偿 scrollTop，避免视口跳动
  useLayoutEffect(() => {
    applyAnchor();
  }, [range.start, range.end]);

  const extractNavNumbers = (content: string) => {
    const s = String(content || '');
    const re = /prd-nav:(\d+(?:\.\d+){0,3})/g;
    const set = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const n = String(m[1] || '').trim();
      if (n) set.add(n);
      if (set.size >= 30) break;
    }
    return Array.from(set);
  };

  // 记录用户是否“锁定在底部”：用于从预览页返回时恢复到最新对话
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let raf: number | null = null;
    const onScroll = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        if (!firstScrollLoggedRef.current) {
          firstScrollLoggedRef.current = true;
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'promptLag-pre',hypothesisId:'H14',location:'MessageList.tsx:onScroll:first',message:'first_scroll_event',data:{scrollTop:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,messagesLen:messages.length,rangeStart:Number(rangeRef.current.start),rangeEnd:Number(rangeRef.current.end)},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
        }
        const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        // 仅根据“离底距离”判断是否锁底，避免窗口化 range 更新滞后导致 pinned 误被置为 false
        setPinnedToBottom(distanceToBottom < 180);
      });
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    // mount 时立即同步一次（防止初始状态不一致）
    onScroll();
    return () => {
      el.removeEventListener('scroll', onScroll as EventListener);
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [setPinnedToBottom, messages.length]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // 若用户“锁底”，则无条件滚到最新；否则沿用“接近底部才滚动”的策略
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceToBottom < 140;
    if (!isPinnedToBottom && !isNearBottom) return;

    // 流式期间使用 auto，避免高频 smooth scroll 导致主线程卡顿
    // #region agent log
    const _t0 = (globalThis as any).performance?.now?.() ?? Date.now();
    // #endregion
    bottomRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth' });
    // #region agent log
    const _t1 = (globalThis as any).performance?.now?.() ?? Date.now();
    fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'promptLag-pre',hypothesisId:'H9',location:'MessageList.tsx:messagesEffect:scrollIntoView',message:'messages_effect_scroll',data:{dtMs:Number(_t1)-Number(_t0),isStreaming:Boolean(isStreaming),behavior:isStreaming?'auto':'smooth',isPinnedToBottom:Boolean(isPinnedToBottom),messagesLen:messages.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  }, [messages, isStreaming, streamingMessageId, isPinnedToBottom]);

  // 重挂载（例如从预览页返回）时：如果用户此前锁底，则直接滚到最新
  useEffect(() => {
    if (!isPinnedToBottom) return;
    if (!messages || messages.length === 0) return;
    const el = containerRef.current;
    const rest = (globalThis as any).history?.scrollRestoration ?? null;
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'promptLag-pre',hypothesisId:'H17',location:'MessageList.tsx:mountScroll:effect:before',message:'mount_scroll_before',data:{scrollTop:el?.scrollTop??null,scrollHeight:el?.scrollHeight??null,clientHeight:el?.clientHeight??null,distanceToBottom:el? (el.scrollHeight-el.scrollTop-el.clientHeight):null,historyScrollRestoration:rest,isPinnedToBottom:Boolean(isPinnedToBottom),messagesLen:messages.length,rangeStart:Number(rangeRef.current.start),rangeEnd:Number(rangeRef.current.end)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    const raf = requestAnimationFrame(() => {
      // #region agent log
      const _t0 = (globalThis as any).performance?.now?.() ?? Date.now();
      // #endregion
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
      // #region agent log
      const _t1 = (globalThis as any).performance?.now?.() ?? Date.now();
      const el2 = containerRef.current;
      fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'promptLag-pre',hypothesisId:'H17',location:'MessageList.tsx:mountScroll:effect:after',message:'mount_scroll_after',data:{dtMs:Number(_t1)-Number(_t0),scrollTop:el2?.scrollTop??null,scrollHeight:el2?.scrollHeight??null,clientHeight:el2?.clientHeight??null,distanceToBottom:el2? (el2.scrollHeight-el2.scrollTop-el2.clientHeight):null,bottomExists:!!bottomRef.current},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 关键：pinned 时不要等 effect 更新 range，直接按最新尾部计算，确保“发送后立刻看到消息”
  const effectiveRange = useMemo(() => {
    if (isPinnedToBottom) {
      const end = messages.length;
      const start = Math.max(0, end - pinnedWindowSize);
      return { start, end };
    }
    return range;
  }, [isPinnedToBottom, messages.length, range, pinnedWindowSize]);

  const hiddenAbove = Math.max(0, effectiveRange.start);
  const hiddenBelow = Math.max(0, messages.length - effectiveRange.end);
  const visible = useMemo(
    () => messages.slice(effectiveRange.start, effectiveRange.end),
    [messages, effectiveRange.start, effectiveRange.end]
  );

  // #region agent log
  // DOM 快照：用于判断“白屏但 DOM 已经有消息节点”的情况（WebView 未 paint / 合成层问题）
  useEffect(() => {
    if (!messages || messages.length === 0) return;
    const root = containerRef.current;
    if (!root) return;
    const raf = requestAnimationFrame(() => {
      const nodes = root.querySelectorAll('[data-msg-id]');
      const first = (nodes[0] as HTMLElement | undefined) ?? null;
      const rRoot = root.getBoundingClientRect();
      const rFirst = first ? first.getBoundingClientRect() : null;
      const canCS = typeof getComputedStyle !== 'undefined';
      const csRoot = canCS ? getComputedStyle(root) : null;
      const csFirst = first && canCS ? getComputedStyle(first) : null;
      fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'promptLag-pre',hypothesisId:'H18',location:'MessageList.tsx:domSnapshot:effect',message:'dom_snapshot_after_paint',data:{messagesLen:messages.length,visibleStart:Number(effectiveRange.start),visibleEnd:Number(effectiveRange.end),visibleLen:Number(visible.length),nodeCount:Number(nodes.length),root:{w:rRoot.width,h:rRoot.height,top:rRoot.top,left:rRoot.left},first:first?{w:rFirst?.width??null,h:rFirst?.height??null,top:rFirst?.top??null,left:rFirst?.left??null,display:csFirst?.display??null,opacity:csFirst?.opacity??null,visibility:csFirst?.visibility??null}:null,rootStyle:{overflowY:csRoot?.overflowY??null,display:csRoot?.display??null,position:csRoot?.position??null},scrollTop:root.scrollTop,scrollHeight:root.scrollHeight,clientHeight:root.clientHeight},timestamp:Date.now()})}).catch(()=>{});
    });
    return () => cancelAnimationFrame(raf);
  }, [messages.length, visible.length, effectiveRange.start, effectiveRange.end]);
  // #endregion

  // 白屏检测：messages 非空但 visible 为空（往往与 range/observer 初始化或 scroll restoration 相关）
  useEffect(() => {
    if (!messages || messages.length === 0) return;
    if (visible.length !== 0) return;
    const key = `${messages.length}:${effectiveRange.start}:${effectiveRange.end}:${Number(isPinnedToBottom)}`;
    if (emptyVisibleLoggedKeyRef.current === key) return;
    emptyVisibleLoggedKeyRef.current = key;
    const el = containerRef.current;
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'promptLag-pre',hypothesisId:'H12',location:'MessageList.tsx:visibleEmpty:effect',message:'visible_empty_with_messages',data:{messagesLen:messages.length,visibleLen:visible.length,effectiveStart:Number(effectiveRange.start),effectiveEnd:Number(effectiveRange.end),rangeStart:Number(range.start),rangeEnd:Number(range.end),isPinnedToBottom:Boolean(isPinnedToBottom),scrollTop:el?.scrollTop??null,scrollHeight:el?.scrollHeight??null,clientHeight:el?.clientHeight??null,historyScrollRestoration:(globalThis as any).history?.scrollRestoration??null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  }, [messages.length, visible.length, effectiveRange.start, effectiveRange.end, isPinnedToBottom, range.start, range.end]);

  // 观察顶部/底部哨兵：窗口化滑动（不依赖第三方虚拟化库）
  useEffect(() => {
    const root = containerRef.current;
    const topEl = topSentinelRef.current;
    const bottomEl = bottomRef.current;
    if (!root || !topEl || !bottomEl) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          if (ioLogCountRef.current < 6) {
            ioLogCountRef.current += 1;
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/f6540f77-1082-4fdd-952b-071b289fee0c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'promptLag-pre',hypothesisId:'H13',location:'MessageList.tsx:io:intersect',message:'io_intersect',data:{target:e.target===topEl?'top':'bottom',isPinnedToBottom:Boolean(isPinnedToBottom),rangeStart:Number(rangeRef.current.start),rangeEnd:Number(rangeRef.current.end),messagesLen:messages.length},timestamp:Date.now()})}).catch(()=>{});
            // #endregion
          }
          if (e.target === topEl) {
            const root = containerRef.current;
            const atTop = (root?.scrollTop ?? 0) < 2;
            // pinned=true 但同时在顶部（内容不足一屏/滚动阈值误判）时，仍应允许触发加载更早消息
            if (isPinnedToBottom && !atTop) continue;
            // 先在本地已加载数据中“展开”更早部分；start==0 后触发瀑布加载（向前分页）
            if (rangeRef.current.start > 0) {
              shiftEarlier();
            } else {
              void tryLoadOlder();
            }
          } else if (e.target === bottomEl) {
            if (!isPinnedToBottom) shiftLater();
          }
        }
      },
      { root, rootMargin: '160px 0px 160px 0px', threshold: 0.01 }
    );

    io.observe(topEl);
    io.observe(bottomEl);
    return () => io.disconnect();
  }, [isPinnedToBottom, shiftEarlier, shiftLater, tryLoadOlder]);

  const MessageBubble = useMemo(() => memo(function Bubble({
    message,
    isMessageStreaming,
    showThinking,
    thinkingLabel,
    activeGroupId,
    prdDocumentId,
    openCitationDrawer,
    openWithCitations,
  }: {
    message: Message;
    isMessageStreaming: boolean;
    showThinking: boolean;
    thinkingLabel: string;
    activeGroupId: string | null;
    prdDocumentId: string | null;
    openCitationDrawer: (args: any) => void;
    openWithCitations: (args: any) => void;
  }) {
    const assistantCitations =
      message.role === 'Assistant' && Array.isArray(message.citations) ? message.citations : [];

    const renderedAssistantContent = message.role === 'Assistant'
      ? injectSourceLines(injectSectionNumberLinks(unwrapMarkdownFences(message.content)))
      : message.content;

    const navNumbers = message.role === 'Assistant' ? extractNavNumbers(renderedAssistantContent) : [];
    const citationsCount = Math.min(assistantCitations.length, 30);
    const sourcesCount = citationsCount > 0 ? citationsCount : navNumbers.length;
    const hasSources = message.role === 'Assistant' && sourcesCount > 0;

    return (
      <div
        data-msg-id={message.id}
        className={`flex ${message.role === 'User' ? 'justify-end' : 'justify-start'}`}
      >
        <div
          className={`max-w-[80%] p-4 rounded-2xl ${
            message.role === 'User'
              ? 'bg-primary-500 text-white rounded-br-md'
              : 'bg-surface-light dark:bg-surface-dark border border-border rounded-bl-md'
          }`}
        >
        {message.role === 'User' ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div>
            {showThinking ? (
              <div className="mb-2">
                <ThinkingIndicator label={thinkingLabel} />
              </div>
            ) : null}
            {/* Block Protocol：按块渲染，流式期间也能稳定 Markdown 排版 */}
            {Array.isArray(message.blocks) && message.blocks.length > 0 ? (
              // 非流式阶段：用整段 message.content 统一渲染，避免分块导致“列表/编号/段落上下文”丢失
              !isMessageStreaming ? (
                <MarkdownRenderer
                  className="prose prose-sm dark:prose-invert max-w-none"
                  content={renderedAssistantContent}
                  citations={assistantCitations ?? []}
                  onOpenCitation={(idx) => {
                    if (!activeGroupId || !prdDocumentId) return;
                    const citations = assistantCitations ?? [];
                    if (!citations.length) return;
                    const safeIdx = Math.max(0, Math.min(citations.length - 1, idx));
                    const c = citations[safeIdx];
                    const targetHeadingId = (c?.headingId || '').trim();
                    const targetHeadingTitle = (c?.headingTitle || '').trim();
                    openWithCitations({
                      targetHeadingId: targetHeadingId || null,
                      targetHeadingTitle: targetHeadingTitle || null,
                      citations,
                      activeCitationIndex: safeIdx,
                    });
                    openCitationDrawer({
                      documentId: prdDocumentId,
                      groupId: activeGroupId,
                      targetHeadingId: targetHeadingId || null,
                      targetHeadingTitle: targetHeadingTitle || null,
                      citations,
                      activeCitationIndex: safeIdx,
                    });
                  }}
                  onInternalLinkClick={(href) => {
                    const idx = parseCitationIndexFromHref(href);
                    const navTitle = parseNavTitleFromHref(href);
                    if (idx == null && !navTitle) return;
                    const citations = assistantCitations ?? [];
                    if (!activeGroupId || !prdDocumentId) return true;
                    if (idx != null && citations.length > 0) {
                      const c = citations[Math.max(0, Math.min(citations.length - 1, idx))];
                      const targetHeadingId = (c?.headingId || '').trim();
                      const targetHeadingTitle = (c?.headingTitle || '').trim();
                      openWithCitations({
                        targetHeadingId: targetHeadingId || null,
                        targetHeadingTitle: targetHeadingTitle || null,
                        citations: citations ?? [],
                        activeCitationIndex: idx,
                      });
                      openCitationDrawer({
                        documentId: prdDocumentId,
                        groupId: activeGroupId,
                        targetHeadingId: targetHeadingId || null,
                        targetHeadingTitle: targetHeadingTitle || null,
                        citations: citations ?? [],
                        activeCitationIndex: idx,
                      });
                      return true;
                    }
                    // 无 citations：按章节号/文本跳转
                    openWithCitations({
                      targetHeadingId: null,
                      targetHeadingTitle: navTitle || null,
                      citations: citations ?? [],
                      activeCitationIndex: 0,
                    });
                    openCitationDrawer({
                      documentId: prdDocumentId,
                      groupId: activeGroupId,
                      targetHeadingId: null,
                      targetHeadingTitle: navTitle || null,
                      citations: citations ?? [],
                      activeCitationIndex: 0,
                    });
                    return true;
                  }}
                />
              ) : (
                <div className="space-y-2">
                  {message.blocks.map((b: MessageBlock) => (
                    <div key={b.id} className="prose prose-sm dark:prose-invert max-w-none">
                      {b.kind === 'codeBlock' ? (
                        // 如果后端/模型标记为 markdown 代码块，用户通常期望“按 Markdown 渲染”而不是当代码展示
                        (b.language === 'markdown' || b.language === 'md') ? (
                          <MarkdownRenderer content={unwrapMarkdownFences(b.content)} />
                        ) : (
                          <pre className="overflow-x-auto rounded-md border border-border bg-gray-50 dark:bg-gray-900 p-3">
                            <code className="whitespace-pre">{b.content}</code>
                          </pre>
                        )
                      ) : (
                        // 流式过程中 markdown 语法常常未闭合（列表/表格/引用等），会导致样式“缺一截”
                        // 因此：未完成的 block 先纯文本展示，blockEnd 后再用 ReactMarkdown 渲染
                        b.isComplete === false ? (
                          <p className="whitespace-pre-wrap break-words">{b.content}</p>
                        ) : (
                          <MarkdownRenderer content={unwrapMarkdownFences(b.content)} />
                        )
                      )}
                    </div>
                  ))}
                </div>
              )
            ) : (
              // 兼容旧协议：无 blocks 时沿用原逻辑（流式阶段先纯文本，done 后 markdown）
              isMessageStreaming ? (
                <div>
                  <p className="whitespace-pre-wrap break-words">{message.content}</p>
                </div>
              ) : (
                <MarkdownRenderer
                  className="prose prose-sm dark:prose-invert max-w-none"
                  content={renderedAssistantContent}
                  citations={assistantCitations ?? []}
                  onOpenCitation={(idx) => {
                    if (!activeGroupId || !prdDocumentId) return;
                    const citations = assistantCitations ?? [];
                    if (!citations.length) return;
                    const safeIdx = Math.max(0, Math.min(citations.length - 1, idx));
                    const c = citations[safeIdx];
                    const targetHeadingId = (c?.headingId || '').trim();
                    const targetHeadingTitle = (c?.headingTitle || '').trim();
                    openWithCitations({
                      targetHeadingId: targetHeadingId || null,
                      targetHeadingTitle: targetHeadingTitle || null,
                      citations,
                      activeCitationIndex: safeIdx,
                    });
                    openCitationDrawer({
                      documentId: prdDocumentId,
                      groupId: activeGroupId,
                      targetHeadingId: targetHeadingId || null,
                      targetHeadingTitle: targetHeadingTitle || null,
                      citations,
                      activeCitationIndex: safeIdx,
                    });
                  }}
                  onInternalLinkClick={(href) => {
                    const idx = parseCitationIndexFromHref(href);
                    const navTitle = parseNavTitleFromHref(href);
                    if (idx == null && !navTitle) return;
                    const citations = assistantCitations ?? [];
                    if (!activeGroupId || !prdDocumentId) return true;
                    if (idx != null && citations.length > 0) {
                      const c = citations[Math.max(0, Math.min(citations.length - 1, idx))];
                      const targetHeadingId = (c?.headingId || '').trim();
                      const targetHeadingTitle = (c?.headingTitle || '').trim();
                      openWithCitations({
                        targetHeadingId: targetHeadingId || null,
                        targetHeadingTitle: targetHeadingTitle || null,
                        citations: citations ?? [],
                        activeCitationIndex: idx,
                      });
                      openCitationDrawer({
                        documentId: prdDocumentId,
                        groupId: activeGroupId,
                        targetHeadingId: targetHeadingId || null,
                        targetHeadingTitle: targetHeadingTitle || null,
                        citations: citations ?? [],
                        activeCitationIndex: idx,
                      });
                      return true;
                    }
                    // 无 citations：按章节号/文本跳转
                    openWithCitations({
                      targetHeadingId: null,
                      targetHeadingTitle: navTitle || null,
                      citations: citations ?? [],
                      activeCitationIndex: 0,
                    });
                    openCitationDrawer({
                      documentId: prdDocumentId,
                      groupId: activeGroupId,
                      targetHeadingId: null,
                      targetHeadingTitle: navTitle || null,
                      citations: citations ?? [],
                      activeCitationIndex: 0,
                    });
                    return true;
                  }}
                />
              )
            )}
          </div>
        )}

        {hasSources ? (
          <div className="mt-3 pt-2">
            <button
              type="button"
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] leading-5 border border-border bg-background-light/40 dark:bg-background-dark/30 text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 hover:bg-gray-50 dark:hover:bg-white/10"
              title="查看本条回复的来源（右侧展开）"
              onClick={() => {
                if (!activeGroupId || !prdDocumentId) return;
                const citations = assistantCitations ?? [];
                if (citations.length > 0) {
                  const c0 = citations[0];
                  const targetHeadingId = (c0?.headingId || '').trim();
                  const targetHeadingTitle = (c0?.headingTitle || '').trim();
                  openWithCitations({
                    targetHeadingId: targetHeadingId || null,
                    targetHeadingTitle: targetHeadingTitle || null,
                    citations,
                    activeCitationIndex: 0,
                  });
                  openCitationDrawer({
                    documentId: prdDocumentId,
                    groupId: activeGroupId,
                    targetHeadingId: targetHeadingId || null,
                    targetHeadingTitle: targetHeadingTitle || null,
                    citations,
                    activeCitationIndex: 0,
                  });
                  return;
                }
                const first = (navNumbers[0] || '').trim();
                if (!first) return;
                openWithCitations({
                  targetHeadingId: null,
                  targetHeadingTitle: first,
                  citations: [],
                  activeCitationIndex: 0,
                });
                openCitationDrawer({
                  documentId: prdDocumentId,
                  groupId: activeGroupId,
                  targetHeadingId: null,
                  targetHeadingTitle: first,
                  citations: [],
                  activeCitationIndex: 0,
                });
              }}
            >
              来源（{sourcesCount}）
            </button>
          </div>
        ) : null}

        {isMessageStreaming && (
          <span className="inline-block w-2 h-4 bg-primary-500 animate-pulse ml-1" />
        )}
        
        {message.senderName && (
          <p className="text-xs opacity-70 mt-2">
            {message.senderName} · {message.viewRole}
          </p>
        )}
        </div>
      </div>
    );
  }), []);

  return (
    <div
      ref={containerRef}
      // 强制合成层：缓解 WebKit/Tauri WebView 偶发“不 repaint，滚一下才显示”的现象
      className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 transform-gpu"
    >
      <div ref={topSentinelRef} />

      {isLoadingOlder ? (
        <div className="flex justify-center">
          <div className="max-w-[80%] p-3 rounded-2xl bg-surface-light dark:bg-surface-dark border border-border">
            <WizardLoader label="正在加载更早消息…" size={72} />
          </div>
        </div>
      ) : hasMoreOlder && effectiveRange.start === 0 ? (
        <div className="flex justify-center">
          <button
            type="button"
            className="text-xs text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 border border-border rounded-full px-3 py-1 bg-background-light/40 dark:bg-background-dark/30"
            title="加载更早的消息（向前分页）"
            onClick={() => void tryLoadOlder()}
          >
            仅加载最近 3 轮，点击/上拉加载更早消息
          </button>
        </div>
      ) : null}

      {hiddenAbove > 0 ? (
        <div className="flex justify-center">
          <button
            type="button"
            className="text-xs text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 border border-border rounded-full px-3 py-1 bg-background-light/40 dark:bg-background-dark/30"
            title="加载更早的消息（仅展开本地已加载部分）"
            onClick={() => shiftEarlier()}
          >
            已折叠 {hiddenAbove} 条，继续上拉/点击加载更多
          </button>
        </div>
      ) : null}

      {visible.map((message: Message) => {
        // 请求中占位 assistant：单独渲染，避免影响其它消息气泡的 memo 化
        if (pendingAssistantId && message.id === pendingAssistantId && message.role === 'Assistant' && !message.content) {
          return (
            <div key={message.id} ref={pendingAssistantRef} data-msg-id={message.id} className="flex justify-start">
              <div className="max-w-[80%] p-4 rounded-2xl bg-surface-light dark:bg-surface-dark border border-border rounded-bl-md">
                <WizardLoader label="正在请求大模型…" size={92} />
              </div>
            </div>
          );
        }

        const isMessageStreaming = isStreaming && streamingMessageId === message.id;
        const showThinking = isMessageStreaming && !!streamingPhase && streamingPhase !== 'typing';
        const thinkingLabel = showThinking ? (phaseText[streamingPhase] || '处理中…') : '';

        return (
          <MessageBubble
            key={message.id}
            message={message}
            isMessageStreaming={isMessageStreaming}
            showThinking={showThinking}
            thinkingLabel={thinkingLabel}
            activeGroupId={activeGroupId}
            prdDocumentId={prdDocument?.id ?? null}
            openCitationDrawer={openCitationDrawer as any}
            openWithCitations={openWithCitations as any}
          />
        );
      })}

      {messages.length === 0 && !isStreaming && (
        <div className="h-full flex items-center justify-center text-text-secondary">
          <div className="text-center">
            <div className="w-12 h-12 mx-auto mb-3 bg-primary-100 dark:bg-primary-900/30 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
            </div>
            {!sessionId && activeGroupId ? (
              <>
                <p className="text-lg mb-2">待上传</p>
                <p className="text-sm">该群组未绑定 PRD，无法进行对话。</p>
                <p className="text-xs mt-2 text-text-secondary">
                  请在左侧选择/上传 PRD，并点击{' '}
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new Event('prdAgent:openBindPrdPicker'))}
                    className="underline hover:text-primary-500"
                    title="上传并绑定 PRD"
                  >
                    上传 PRD 并绑定到当前群组
                  </button>
                </p>
              </>
            ) : (
              <>
                <p className="text-lg mb-2">你好!</p>
                <p className="text-sm">有什么关于这份PRD的问题，尽管问我</p>
              </>
            )}
          </div>
        </div>
      )}

      {hiddenBelow > 0 ? (
        <div className="flex justify-center">
          <button
            type="button"
            className="text-xs text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 border border-border rounded-full px-3 py-1 bg-background-light/40 dark:bg-background-dark/30"
            title="回到最新对话"
            onClick={() => {
              setPinnedToBottom(true);
              const end = messages.length;
              const start = Math.max(0, end - windowSize);
              setRange({ start, end });
              requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'auto' }));
            }}
          >
            下面还有 {hiddenBelow} 条，点击回到最新
          </button>
        </div>
      ) : null}

      <div ref={bottomRef} />
    </div>
  );
}

export default memo(MessageListInner);
