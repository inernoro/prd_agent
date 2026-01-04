import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useSessionStore } from '../../stores/sessionStore';
import { usePrdCitationPreviewStore } from '../../stores/prdCitationPreviewStore';
import { usePrdPreviewNavStore } from '../../stores/prdPreviewNavStore';
import { useAuthStore } from '../../stores/authStore';
import { useUserDirectoryStore } from '../../stores/userDirectoryStore';
import { useUiPrefsStore } from '../../stores/uiPrefsStore';
import type { Message, MessageBlock } from '../../types';
import MarkdownRenderer from '../Markdown/MarkdownRenderer';
import AsyncIconButton from '../ui/AsyncIconButton';
import { copyText } from '../../lib/clipboard';
import WizardLoader from './WizardLoader';

type MsgStoreState = ReturnType<typeof useMessageStore.getState>;

// 注意：阶段文案（如“正在接收信息…”）会造成“AI 回复未带头像/昵称”的割裂观感。
// 这里改为：阶段仅用动画表达，避免在 UI 中出现多处状态文案。

const roleZh: Record<string, string> = {
  ADMIN: '超级管理员',
  PM: '产品经理',
  DEV: '开发者',
  QA: '测试',
};

function roleTheme(role?: string | null): { badgeClass: string; avatarBgClass: string } {
  const r = String(role || '').trim().toUpperCase();
  switch (r) {
    case 'ADMIN':
      return {
        badgeClass: 'bg-amber-500/10 text-amber-700 border-amber-300/40 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-400/30',
        avatarBgClass: 'bg-gradient-to-br from-amber-500/75 to-orange-500/75',
      };
    case 'DEV':
      return {
        badgeClass: 'bg-sky-500/10 text-sky-700 border-sky-300/40 dark:bg-sky-500/15 dark:text-sky-200 dark:border-sky-400/30',
        avatarBgClass: 'bg-gradient-to-br from-sky-500/75 to-cyan-500/75',
      };
    case 'QA':
      return {
        badgeClass: 'bg-violet-500/10 text-violet-700 border-violet-300/40 dark:bg-violet-500/15 dark:text-violet-200 dark:border-violet-400/30',
        avatarBgClass: 'bg-gradient-to-br from-violet-500/75 to-fuchsia-500/75',
      };
    case 'PM':
      return {
        badgeClass: 'bg-emerald-500/10 text-emerald-700 border-emerald-300/40 dark:bg-emerald-500/15 dark:text-emerald-200 dark:border-emerald-400/30',
        avatarBgClass: 'bg-gradient-to-br from-emerald-500/75 to-teal-500/75',
      };
    default:
      return {
        badgeClass: 'bg-black/5 text-text-secondary border-black/10 dark:bg-white/8 dark:text-white/70 dark:border-white/15',
        avatarBgClass: 'bg-gradient-to-br from-slate-600/75 to-slate-400/75 dark:from-white/25 dark:to-white/10',
      };
  }
}

function initials(name?: string | null): string {
  const t = String(name || '').trim();
  if (!t) return '?';
  // 中文/英文统一取首字符（避免复杂分词）
  return t.slice(0, 1).toUpperCase();
}

function ThinkingIndicator({ label }: { label?: string }) {
  // 不展示文字：仅展示动画；aria/title 仍会使用 WizardLoader 内部默认值
  const safeLabel = (label || '').trim() || undefined;
  return (
    <WizardLoader label={safeLabel} labelMode="overlay" size={92} />
  );
}

function formatChatTime(ts: unknown): string {
  const d =
    ts instanceof Date
      ? ts
      : (typeof ts === 'string' || typeof ts === 'number')
        ? new Date(ts)
        : null;
  if (!d || Number.isNaN(d.getTime())) return '';

  const pad2 = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const day0 = startOfDay(now);
  const day1 = new Date(day0); day1.setDate(day1.getDate() - 1);
  const day2 = new Date(day0); day2.setDate(day2.getDate() - 2);

  const weekStart = (x: Date) => {
    // 以周一为一周开始（更通用）
    const s = startOfDay(x);
    const dow = (s.getDay() + 6) % 7; // Mon=0 ... Sun=6
    s.setDate(s.getDate() - dow);
    return s;
  };

  const ampm = (x: Date) => (x.getHours() < 12 ? '上午' : '下午');
  const hour12 = (x: Date) => {
    const h = x.getHours();
    if (h === 0) return 12;
    if (h <= 12) return h;
    return h - 12;
  };
  const hm = `${hour12(d)}:${pad2(d.getMinutes())}`;

  if (d >= day0) return `${ampm(d)} ${hm}`;
  if (d >= day1) return `昨天 ${ampm(d)} ${hm}`;
  if (d >= day2) return `前天 ${ampm(d)} ${hm}`;

  const ws = weekStart(now);
  if (d >= ws) {
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] || '本周';
    return `${wd} ${ampm(d)} ${hm}`;
  }

  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function formatDurationShort(ms: unknown): string {
  const n = typeof ms === 'number' ? ms : Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  // 统一用秒（更短，不易撑破气泡）
  const s = n / 1000;
  return `${s.toFixed(s < 10 ? 1 : 0)}s`;
}

// function formatDurationMs(ms: unknown): string {
//   const n = typeof ms === 'number' ? ms : Number(ms);
//   if (!Number.isFinite(n) || n < 0) return '';
//   // 统一用 ms，便于 debug；需要更友好展示再做 UI 调整
//   return `${Math.round(n)}ms`;
// }

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

function isSystemNoticeMessage(message: Message): boolean {
  // 系统提示（如 SSE 订阅失败）不作为“对话气泡”，而是居中提示条（参考图2）
  const id = String(message?.id || '');
  const content = String(message?.content || '');
  if (id.startsWith('group-stream-error-')) return true;
  // 兼容其它来源的失败提示
  if (content.startsWith('群消息订阅失败：')) return true;
  if (content.startsWith('请求失败：')) return true;
  return false;
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
  const ensuredInitialRangeRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const showScrollToBottomRef = useRef(false);
  showScrollToBottomRef.current = showScrollToBottom;

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
  }, [messages.length, isPinnedToBottom, pinnedWindowSize, windowSize]);

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
  const prevIsStreamingRef = useRef<boolean>(false);
  const lastStreamingTransitionAtRef = useRef<number>(0);

  // 用户主动发送/提示词：强制跳到最新一页
  // 注意：这里不再做“同步滚动”（会触发 300ms 级别的同步布局/卡顿），只做状态更新与记录，
  // 真正的滚动延后到 useEffect（浏览器完成一次 paint 之后）执行。
  useLayoutEffect(() => {
    // 关键：用 layout effect 同步滚动，避免用户点击发送后“空等一帧甚至更久”
    if (!scrollToBottomSeq) return;
    setPinnedToBottom(true);
    pendingScrollToBottomSeqRef.current = scrollToBottomSeq;
  }, [scrollToBottomSeq, setPinnedToBottom]);

  // 真正的滚动：放到 paint 之后，避免在 layoutEffect 里触发同步布局导致"卡一下"
  useEffect(() => {
    if (!scrollToBottomSeq) return;
    if (pendingScrollToBottomSeqRef.current !== scrollToBottomSeq) return;
    // 有 pending assistant（用户刚发送）时用 auto 立即滚动，确保用户立刻看到消息和加载动画；
    // 流式期间也用 auto 避免高频 smooth；其他场景用 smooth 提供丝滑体验
    const shouldInstant = !!pendingAssistantId || isStreaming;
    // 优先滚动到 pending assistant 元素（让 AI 加载动画完整显示），否则滚动到底部哨兵
    const scrollTarget = pendingAssistantRef.current || bottomRef.current;
    scrollTarget?.scrollIntoView({ behavior: shouldInstant ? 'auto' : 'smooth', block: 'end' });
  }, [scrollToBottomSeq, messages.length, isStreaming, pendingAssistantId]);

  // 记录 streaming 状态切换时间：用于抑制“done 后 smooth 再滚一次”的晃动
  useEffect(() => {
    const prev = prevIsStreamingRef.current;
    if (prev !== isStreaming) {
      prevIsStreamingRef.current = isStreaming;
      lastStreamingTransitionAtRef.current = Date.now();
    }
  }, [isStreaming]);

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

    const { added } = await loadOlderMessages({ groupId: activeGroupId, limit: 20 });

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
    // 滞回阈值：避免“临界抖动”导致 pinned/show 状态在滚动时频繁翻转
    const PIN_ON_PX = 120;
    const PIN_OFF_PX = 240;
    const SHOW_ON_PX = 220;
    const SHOW_OFF_PX = 120;

    const onScroll = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        // pinned：滞回
        const prevPinned = useMessageStore.getState().isPinnedToBottom;
        const nextPinned =
          prevPinned ? distanceToBottom <= PIN_OFF_PX : distanceToBottom <= PIN_ON_PX;
        if (nextPinned !== prevPinned) {
          setPinnedToBottom(nextPinned);
        }

        // scroll-to-bottom icon：滞回（并与 pinned 脱钩，避免 pinned=true 但仍“离底较远”的瞬态）
        const prevShow = showScrollToBottomRef.current;
        const nextShow =
          prevShow ? distanceToBottom >= SHOW_OFF_PX : distanceToBottom >= SHOW_ON_PX;
        if (nextShow !== prevShow) {
          setShowScrollToBottom(nextShow);
        }
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
    // 已在最底部（或极接近）：不要再触发 smooth scroll，避免出现“到 done 时又滚一次”的观感
    if (distanceToBottom < 8) return;
    if (!isPinnedToBottom && !isNearBottom) return;

    // 经验：done 时 content 高度会“最后抖一次”，如果此时用 smooth，会出现“到结尾又滚一遍”的晃动
    // 策略：
    // - streaming 期间始终 auto
    // - streaming 刚结束后的 1.2s 内也用 auto（避免 smooth 二次滚动）
    // - 其余场景：仅在用户接近底部时允许 smooth（提供轻微过渡）
    const sinceFlip = Date.now() - (lastStreamingTransitionAtRef.current || 0);
    const shouldAuto = isStreaming || sinceFlip < 1200;
    bottomRef.current?.scrollIntoView({ behavior: shouldAuto ? 'auto' : 'smooth' });
  }, [messages, isStreaming, streamingMessageId, isPinnedToBottom]);

  // 重挂载（例如从预览页返回）时：如果用户此前锁底，则直接滚到最新
  useEffect(() => {
    if (!isPinnedToBottom) return;
    if (!messages || messages.length === 0) return;
    const raf = requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
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
    const currentUser = useAuthStore((s) => s.user ?? null);
    const currentUserId = currentUser?.userId ?? null;
    const resolveUsername = useUserDirectoryStore((s) => s.resolveUsername);
    const resolveRole = useUserDirectoryStore((s) => s.resolveRole);
    const assistantFontScale = useUiPrefsStore((s) => s.assistantFontScale);
    const assistantContentStyle = useMemo(() => {
      // 仅对 Assistant 正文缩放（不影响气泡壳/头像/昵称行）
      const n = Number(assistantFontScale);
      const safe = Number.isFinite(n) && n > 0 ? n : 1;
      return { fontSize: `${safe}em` } as const;
    }, [assistantFontScale]);
    const tsText = formatChatTime((message as any)?.timestamp);
    const ttftMs = (message as any)?.ttftMs;
    const totalMs = (message as any)?.totalMs;
    const ttftAtText = formatChatTime((message as any)?.serverFirstTokenAtUtc);
    // const doneAtText = formatChatTime((message as any)?.serverDoneAtUtc); // 保留：若未来需要展示 doneAt 再启用
    const doneMinusFirstTokenMs = (() => {
      const done = (message as any)?.serverDoneAtUtc;
      const first = (message as any)?.serverFirstTokenAtUtc;
      if (done instanceof Date && first instanceof Date) {
        return Math.max(0, Math.round(done.getTime() - first.getTime()));
      }
      // 兼容：没有 Date 对象（或历史字段缺失）时，用 totalMs - ttftMs 兜底
      if (typeof totalMs === 'number' && typeof ttftMs === 'number') {
        return Math.max(0, Math.round(totalMs - ttftMs));
      }
      return null;
    })();
    const firstTokenDisplay = ttftAtText || tsText;
    const isError = message.role === 'Assistant' && (
      String(message.id || '').startsWith('error-') ||
      String(message.content || '').startsWith('请求失败：') ||
      String(message.content || '').includes('Unauthorized') ||
      String(message.content || '').includes('HTTP ')
    );
        const assistantCitations =
          message.role === 'Assistant' && Array.isArray(message.citations) ? message.citations : [];

        const renderedAssistantContent = message.role === 'Assistant'
          ? injectSourceLines(injectSectionNumberLinks(unwrapMarkdownFences(message.content)))
          : message.content;

        const navNumbers = message.role === 'Assistant' ? extractNavNumbers(renderedAssistantContent) : [];
        const citationsCount = Math.min(assistantCitations.length, 30);
        const sourcesCount = citationsCount > 0 ? citationsCount : navNumbers.length;
        const hasSources = message.role === 'Assistant' && sourcesCount > 0;
        const hasHoverToolbar = (
          (message.role === 'Assistant' && String(message.content || '').trim()) ||
          (message.role === 'User' && String(message.content || '').trim())
        );
        const isMine =
          message.role === 'User' &&
          !!currentUserId &&
          !!message.senderId &&
          String(message.senderId) === String(currentUserId);

        const metaSeq = typeof (message as any)?.groupSeq === 'number' && (message as any).groupSeq > 0
          ? `#${(message as any).groupSeq}`
          : '';

        const metaRightText = (() => {
          if (message.role === 'User') return tsText || '刚刚';
          if (!firstTokenDisplay) return '';
          const dur = typeof doneMinusFirstTokenMs === 'number' ? ` · ${formatDurationShort(doneMinusFirstTokenMs)}` : '';
          return `${firstTokenDisplay}${dur}`;
        })();

        const showMeta = !!(metaSeq || metaRightText);

        const senderDisplayName = (() => {
          if (message.role === 'Assistant') return 'PRD Agent';
          if (isMine) return (currentUser?.displayName || (currentUser as any)?.username || '我') as string;
          // 优先显示 username（由 get_group_members 拉取一次后缓存）
          const fromDir = resolveUsername(message.senderId);
          return String(fromDir || message.senderName || message.senderId || '用户');
        })();

        const badgeText = (() => {
          if (message.role === 'Assistant') {
            const vr = String(message.viewRole || '').trim();
            return vr ? (roleZh[vr] || vr) : '';
          }
          const sr = String((message as any).senderRole || resolveRole(message.senderId) || '').trim();
          return sr ? (roleZh[sr] || sr) : '';
        })();

        const theme = roleTheme(message.role === 'Assistant' ? String(message.viewRole || '') : String((message as any).senderRole || ''));

        return (
          <div
        data-msg-id={message.id}
            className={`flex ${
              message.role === 'User'
                ? (isMine ? 'justify-end' : 'justify-start')
                : 'justify-start'
            } ${
              hasHoverToolbar ? 'pb-12' : ''
            }`}
          >
            {/* 头像（左/右） */}
            {(!isMine || message.role === 'Assistant') ? (
              <div className="shrink-0 mr-3 mt-1">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold text-white ${theme.avatarBgClass} border border-black/10 dark:border-white/15 shadow-sm`}>
                  {message.role === 'Assistant' ? 'AI' : initials(senderDisplayName)}
                </div>
              </div>
            ) : null}

            <div className="min-w-0 max-w-[80%]">
              {/* 名字 + 角色 */}
              <div className={`mb-1 flex items-center gap-2 ${isMine ? 'justify-end' : 'justify-start'} select-none min-w-0`}>
                <span
                  className="text-[12px] leading-5 text-text-secondary max-w-[260px] truncate"
                  title={senderDisplayName}
                >
                  {senderDisplayName}
                </span>
                {badgeText ? (
                  <span className={`text-[11px] leading-5 px-2 rounded-full border ${theme.badgeClass}`}>
                    {badgeText}
                  </span>
                ) : null}
              </div>

              <div
                className="relative group/message"
              >
              <div
                className={`${showMeta ? 'relative px-4 pt-3 pb-6' : 'p-4'} rounded-2xl ${
                  message.role === 'User'
                    ? (isMine
                      ? 'bg-primary-500 text-white rounded-br-md shadow-sm'
                      : 'bg-surface-light/85 dark:bg-surface-dark/75 border border-border rounded-bl-md shadow-sm')
                    : isError
                      ? 'bg-red-50 dark:bg-red-950/30 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-200 rounded-bl-md'
                      : 'bg-surface-light/85 dark:bg-surface-dark/75 ring-1 ring-black/5 dark:ring-white/10 rounded-bl-md shadow-sm'
                }`}
              >
              {message.role === 'User' ? (
                <p
                  className={`whitespace-pre-wrap ${isMine ? '' : 'text-text-primary'}`}
                  style={{
                    // 当输出 ASCII 表格（依赖空格对齐）时，必须用等宽字体，否则右侧会错乱
                    fontFamily: 'var(--font-mono)',
                    fontVariantLigatures: 'none',
                  }}
                >
                  {message.content}
                </p>
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
                      style={assistantContentStyle}
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
                    <div className="space-y-2" style={assistantContentStyle}>
                      {message.blocks.map((b: MessageBlock) => (
                        <div key={b.id} className="prose prose-sm dark:prose-invert max-w-none" style={assistantContentStyle}>
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
                    <div style={assistantContentStyle}>
                      <p className="whitespace-pre-wrap break-words">{message.content}</p>
                    </div>
                  ) : (
                    <MarkdownRenderer
                      className="prose prose-sm dark:prose-invert max-w-none"
                      style={assistantContentStyle}
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
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] leading-5 ui-chip text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 hover:bg-black/5 dark:hover:bg-white/5"
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

            {/* 时间 + seq：贴近气泡底部（气泡内固定一行） */}
            {showMeta ? (
              <div
                className={`absolute left-4 right-4 bottom-1 flex items-center justify-between gap-2 text-[10px] leading-4 select-none min-w-0 ${
                  message.role === 'User'
                    ? (isMine ? 'text-white/70' : 'text-text-secondary')
                    : 'text-text-secondary'
                }`}
              >
                <span className="opacity-60 shrink-0">{metaSeq}</span>
                <span className="min-w-0 flex-1 text-right truncate">{metaRightText}</span>
              </div>
            ) : null}

        {/* 非 typing 阶段已经有“接收/请求”提示，不要再渲染光标块占位（会挡住文案的目标位置） */}
        {isMessageStreaming && !showThinking && (
              <span className="inline-block w-2 h-4 bg-primary-500 animate-pulse ml-1" />
            )}
            
              </div>

              {message.role === 'User' && String(message.content || '').trim() ? (
                <div className={`pointer-events-none absolute top-full ${isMine ? 'right-2' : 'left-2'} mt-1 z-20 opacity-0 group-hover/message:opacity-100 transition-opacity`}>
                  <div className="pointer-events-auto inline-flex items-center gap-1 rounded-lg ui-glass-panel px-1 py-1">
                    <AsyncIconButton
                      title="重发（在输入框中编辑后重新发送）"
                      onAction={async () => {
                        window.dispatchEvent(new CustomEvent('prdAgent:prefillChatInput', {
                          detail: { content: message.content, resendMessageId: message.id },
                        }));
                      }}
                      icon={(
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536M9 11l6.232-6.232a2.5 2.5 0 013.536 3.536L12.536 14.536A4 4 0 0110 15H7v-3a4 4 0 011-2.5z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 21H7a2 2 0 01-2-2V8" />
                        </svg>
                      )}
                      className="inline-flex items-center justify-center w-8 h-8 rounded-md text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 hover:bg-black/5 dark:hover:bg-white/5"
                    />
                    <AsyncIconButton
                      title="复制消息"
                      onAction={async () => {
                        await copyText(message.content);
                      }}
                      icon={(
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h6a2 2 0 002-2M8 5a2 2 0 012-2h6a2 2 0 012 2v11a2 2 0 01-2 2h-1" />
                        </svg>
                      )}
                      className="inline-flex items-center justify-center w-8 h-8 rounded-md text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 hover:bg-black/5 dark:hover:bg-white/5"
                    />
                  </div>
                </div>
              ) : null}

              {message.role === 'Assistant' && String(message.content || '').trim() ? (
                <div className="pointer-events-none absolute top-full right-2 mt-1 z-20 opacity-0 group-hover/message:opacity-100 transition-opacity">
                  <div className="pointer-events-auto inline-flex items-center gap-1 rounded-lg ui-glass-panel px-1 py-1">
                    <AsyncIconButton
                      title="复制回复（Markdown）"
                      onAction={async () => {
                        await copyText(message.content);
                      }}
                      icon={(
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h6a2 2 0 002-2M8 5a2 2 0 012-2h6a2 2 0 012 2v11a2 2 0 01-2 2h-1" />
                        </svg>
                      )}
                      className="inline-flex items-center justify-center w-8 h-8 rounded-md text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 hover:bg-black/5 dark:hover:bg-white/5"
                    />
                  </div>
                </div>
              ) : null}
              </div>
            </div>

            {/* 自己的头像放右侧（更像聊天软件） */}
            {isMine ? (
              <div className="shrink-0 ml-3 mt-1">
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold text-white bg-gradient-to-br from-primary-500/80 to-sky-500/70 border border-white/15 shadow-sm">
                  {initials(senderDisplayName)}
                </div>
              </div>
            ) : null}
          </div>
    );
  }), []);

  const scrollToLatest = useCallback(() => {
    setPinnedToBottom(true);
    const end = messages.length;
    const start = Math.max(0, end - windowSize);
    setRange({ start, end });
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'auto' }));
  }, [messages.length, setPinnedToBottom, windowSize]);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={containerRef}
        // 强制合成层：缓解 WebKit/Tauri WebView 偶发“不 repaint，滚一下才显示”的现象
        className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 transform-gpu"
      >
        <div ref={topSentinelRef} />

      {isLoadingOlder ? (
        <div className="flex justify-center">
          <div className="max-w-[80%] p-3 rounded-2xl ui-glass-panel">
            <WizardLoader label="正在加载更早消息…" labelMode="below" size={72} />
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
        // 系统提示已改为 overlay（SystemNoticeOverlay），避免“锁底”导致提示永远贴底
        if (isSystemNoticeMessage(message)) return null;

        // 请求中占位 assistant：单独渲染，避免影响其它消息气泡的 memo 化
        if (pendingAssistantId && message.id === pendingAssistantId && message.role === 'Assistant' && !message.content) {
          // 统一走 MessageBubble：让占位也带头像/昵称，动画作为气泡内容内联
          return (
            <div key={message.id} ref={pendingAssistantRef} data-msg-id={message.id}>
              <MessageBubble
                message={message}
                isMessageStreaming={false}
                showThinking={true}
                thinkingLabel=""
                activeGroupId={activeGroupId}
                prdDocumentId={prdDocument?.id ?? null}
                openCitationDrawer={openCitationDrawer as any}
                openWithCitations={openWithCitations as any}
              />
            </div>
          );
        }

        const isMessageStreaming = isStreaming && streamingMessageId === message.id;
        const showThinking = isMessageStreaming && !!streamingPhase && streamingPhase !== 'typing';
        const thinkingLabel = ''; // 不展示阶段文案（仅动画）

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

        <div ref={bottomRef} />
      </div>

      {/* 右下角悬浮“回到底部”按钮：仅在用户不在底部时显示（避免滚动时一闪一闪） */}
      <button
        type="button"
        onClick={scrollToLatest}
        className={`absolute bottom-4 right-4 z-20 h-11 w-11 rounded-full ui-glass-panel flex items-center justify-center transition-all ${
          showScrollToBottom ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 translate-y-1 pointer-events-none'
        } hover:scale-105 hover:bg-black/5 dark:hover:bg-white/10`}
        title={hiddenBelow > 0 ? `下面还有 ${hiddenBelow} 条，点击回到最新` : '回到最新对话'}
        aria-label="回到最新对话"
      >
        <svg className="w-5 h-5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
        {hiddenBelow > 0 ? (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-primary-500 text-white text-[10px] leading-[18px] text-center">
            {hiddenBelow > 99 ? '99+' : hiddenBelow}
          </span>
        ) : null}
      </button>
    </div>
  );
}

export default memo(MessageListInner);
