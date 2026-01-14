import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { GlassSwitch } from '@/components/design/GlassSwitch';
import { Dialog } from '@/components/ui/Dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { getAiChatHistory, uploadAiChatDocument } from '@/services';
import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';
import { readSseStream } from '@/lib/sse';
import { apiRequest } from '@/services/real/apiClient';
import { MessageSquare, Paperclip, Plus, Send, Square } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import type { AiChatStreamEvent } from '@/services/contracts/aiChat';
import { systemDialog } from '@/lib/systemDialog';
import { getAdminPrompts, getAdminSystemPrompts } from '@/services';
import { useLocation } from 'react-router-dom';

type LocalSession = {
  sessionId: string;
  documentId: string;
  documentTitle: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archivedAtUtc?: string | null;
};

type UiMessage = {
  id: string;
  role: 'User' | 'Assistant';
  content: string;
  /**
   * 高级流式渲染：把“已完成的段落/行块”拆成多个 markdown part，
   * 只增量 append 新 part，避免整段 ReactMarkdown 反复重排导致“闪烁/颗粒感”。
   */
  mdParts?: string[];
  groupSeq?: number;
  replyToMessageId?: string;
  resendOfMessageId?: string;
  timestamp: number;
  citations?: Array<{ headingId?: string | null; headingTitle?: string | null; excerpt?: string | null }>;
  // 元数据（调试页：用于展示“本轮系统提示词”）
  viewRole?: 'PM' | 'DEV' | 'QA';
  promptKey?: string;
  promptTitle?: string;
  promptTemplate?: string;
};

type PromptItem = {
  promptKey: string;
  title: string;
  order?: number;
  promptTemplate?: string;
  role?: 'PM' | 'DEV' | 'QA';
};

function StreamingDot() {
  return (
    <span
      className="inline-flex items-center align-middle ml-1"
      style={{ width: '1em', height: '1em', verticalAlign: 'middle' }}
      aria-label="流式输出中"
      title="流式输出中"
    >
      <span className="inline-block rounded-full border-2 border-current border-t-transparent animate-spin" style={{ width: '100%', height: '100%' }} />
    </span>
  );
}

/**
 * LLM 经常用 ```markdown / ```md 包裹"本来就想渲染的 Markdown"，
 * 这会导致 ReactMarkdown 将其当作代码块显示（<pre><code>），而非解析内部的 markdown 语法。
 * 这里仅解包 markdown/md 语言标记，其它代码块保持不动。
 */
function unwrapMarkdownFences(text: string): string {
  if (!text) return text;
  return text.replace(/```(?:markdown|md)\s*\n([\s\S]*?)\n```/g, '$1');
}

const AssistantMarkdown = memo(function AssistantMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
      {content}
    </ReactMarkdown>
  );
});

const LiveTail = memo(function LiveTail({ text }: { text: string }) {
  const t = String(text || '');
  if (!t) return null;
  const lines = t.split('\n');
  const last = lines[lines.length - 1] ?? '';
  const prefix = lines.length > 1 ? lines.slice(0, -1).join('\n') + '\n' : '';
  return (
    <div className="prd-md-stream-live" aria-label="流式输出预览">
      {prefix ? <span className="prd-md-stream-live-prefix">{prefix}</span> : null}
      <span className="prd-md-stream-live-last">{last}</span>
      <span className="prd-md-stream-caret" aria-hidden="true" />
    </div>
  );
});

const MAX_MESSAGE_CHARS = 16 * 1024;
const ALLOWED_TEXT_EXTS = ['.md', '.txt', '.log', '.json', '.csv'];

function normalizeFileName(name: string) {
  return (name ?? '').trim();
}

function stripFileExtension(fileName: string): string {
  const s = normalizeFileName(fileName);
  if (!s) return '';
  return s.replace(/\.[a-z0-9]+$/i, '');
}

function normalizeCandidateName(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '';
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMeaninglessName(raw: string): boolean {
  const s = normalizeCandidateName(stripFileExtension(raw));
  if (!s) return true;
  const cleaned = s
    .replace(/\b(final|v\d+|version|copy)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return true;
  if (/^[\d\s]+$/.test(cleaned)) return true;
  if (/^[\W_]+$/.test(cleaned)) return true;
  if (/^[a-f0-9]{8,}$/i.test(cleaned)) return true;
  if (cleaned.length <= 2) return true;
  const hasCjk = /[\u4e00-\u9fa5]/.test(cleaned);
  const hasLetter = /[a-z]/i.test(cleaned);
  return !(hasCjk || hasLetter);
}

function extractMarkdownTitle(content: string): string {
  const s = (content || '').replace(/\r\n/g, '\n');
  const m = s.match(/^#\s+(.+)\s*$/m);
  return (m?.[1] || '').trim();
}

function isPlaceholderTitle(s: string | null | undefined): boolean {
  const t = (s ?? '').trim();
  if (!t) return true;
  // 只要看起来像“未命名/unknown”都当占位
  return /^未命名/.test(t) || /^unknown$/i.test(t);
}

function getLowerExt(fileName: string): string {
  const n = normalizeFileName(fileName).toLowerCase();
  const idx = n.lastIndexOf('.');
  if (idx < 0) return '';
  return n.slice(idx);
}

function buildAttachmentBlock(name: string, text: string) {
  const safeName = normalizeFileName(name) || 'unknown';
  const body = String(text ?? '');
  return `\n\n---\n附件（${safeName}）:\n\n\`\`\`\n${body}\n\`\`\`\n`;
}

function applyContentLimit(args: { question: string; attachmentName: string; attachmentText: string }) {
  const question = String(args.question ?? '');
  const attachmentName = normalizeFileName(args.attachmentName);
  const attachmentText = String(args.attachmentText ?? '');

  if (!attachmentText) {
    return { ok: true as const, finalText: question, truncated: false, reason: null as string | null };
  }

  if (question.length > MAX_MESSAGE_CHARS) {
    return { ok: false as const, finalText: '', truncated: false, reason: `内容过长：问题本身已超过 ${MAX_MESSAGE_CHARS} 字符` };
  }

  // 预留一些字符用于附件包裹的固定结构
  const overhead = buildAttachmentBlock(attachmentName || 'unknown', '').length;
  const remaining = MAX_MESSAGE_CHARS - question.length - overhead;
  if (remaining <= 0) {
    return { ok: false as const, finalText: '', truncated: false, reason: `内容过长：问题过长，无法附加附件（上限 ${MAX_MESSAGE_CHARS} 字符）` };
  }

  let truncated = false;
  let body = attachmentText;
  if (body.length > remaining) {
    truncated = true;
    const suffix = '\n\n...(附件内容过长，已自动截断)...';
    const maxBody = Math.max(0, remaining - suffix.length);
    body = attachmentText.slice(0, maxBody) + suffix;
  }

  const finalText = question + buildAttachmentBlock(attachmentName, body);
  if (finalText.length > MAX_MESSAGE_CHARS) {
    // 极端情况下（例如文件名很长/UTF16长度差异）兜底再截断
    truncated = true;
    const hard = finalText.slice(0, MAX_MESSAGE_CHARS - 32) + '\n...(已截断)...';
    return { ok: true as const, finalText: hard, truncated, reason: null as string | null };
  }

  return { ok: true as const, finalText, truncated, reason: null as string | null };
}

function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function storageKeySessions(userId: string) {
  return `prdAdmin.aiChat.sessions.${userId}`;
}

function storageKeyMessages(userId: string, sessionId: string) {
  return `prdAdmin.aiChat.messages.${userId}.${sessionId}`;
}

function loadSessions(userId: string): LocalSession[] {
  const list = safeJsonParse<LocalSession[]>(localStorage.getItem(storageKeySessions(userId)));
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x.sessionId === 'string' && x.sessionId.trim())
    .map((x) => ({
      sessionId: String(x.sessionId),
      documentId: String((x as any).documentId ?? ''),
      documentTitle: String((x as any).documentTitle ?? ''),
      title: String((x as any).title ?? ''),
      createdAt: Number((x as any).createdAt ?? Date.now()),
      updatedAt: Number((x as any).updatedAt ?? Date.now()),
    }));
}

function saveSessions(userId: string, sessions: LocalSession[]) {
  localStorage.setItem(storageKeySessions(userId), JSON.stringify(sessions ?? []));
}

function loadMessages(userId: string, sessionId: string): UiMessage[] {
  const list = safeJsonParse<UiMessage[]>(localStorage.getItem(storageKeyMessages(userId, sessionId)));
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x.id === 'string' && x.id.trim())
    .map((x) => ({
      id: String((x as any).id ?? ''),
      role: (x as any).role === 'User' ? 'User' : 'Assistant',
      content: String((x as any).content ?? ''),
      timestamp: Number((x as any).timestamp ?? Date.now()),
      citations: Array.isArray((x as any).citations) ? (x as any).citations : undefined,
    }));
}

function saveMessages(userId: string, sessionId: string, messages: UiMessage[]) {
  localStorage.setItem(storageKeyMessages(userId, sessionId), JSON.stringify(messages ?? []));
}

function getApiBaseUrl() {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
  return raw.trim().replace(/\/+$/, '');
}

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

export default function AiChatPage() {
  const location = useLocation();
  const authUser = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);

  const userId = authUser?.userId ?? '';

  const query = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const highlightPromptKey = useMemo(() => (query.get('promptKey') ?? '').trim(), [query]);

  // 接收测试模式数据
  const testData = useMemo(() => {
    const state = location.state as any;
    if (!state?.testMode) return null;
    return {
      role: state.role as 'PM' | 'DEV' | 'QA',
      promptKey: String(state.promptKey || ''),
      promptTitle: String(state.promptTitle || ''),
      promptTemplate: String(state.promptTemplate || ''),
    };
  }, [location.state]);

  const isTestMode = !!testData;


  const [sessions, setSessions] = useState<LocalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [activeSessionExpired, setActiveSessionExpired] = useState(false);
  const expiredNotifiedSessionIdRef = useRef<string>('');
  const [includeArchivedSessions] = useState(false);

  const activeSession = useMemo(() => sessions.find((s) => s.sessionId === activeSessionId) ?? null, [sessions, activeSessionId]);

  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingAssistantMessageId, setStreamingAssistantMessageId] = useState<string>('');
  const abortRef = useRef<AbortController | null>(null);

  // -------- Streaming smoothing（高帧率“尾巴” + 低频提交 Markdown）--------
  // - delta 很碎时，如果每个 delta 都 setMessages，会导致 ReactMarkdown 频繁 parse + 版式重排（“颗粒感”）
  // - 这里改为：delta 写入 buffer；rAF 高频刷新“灰度尾巴”；低频把 chunk 提交到 message.content
  const rafSchedule: (cb: FrameRequestCallback) => number =
    typeof requestAnimationFrame === 'function'
      ? (cb) => requestAnimationFrame(cb)
      : (cb) => (setTimeout(() => cb(Date.now()), 16) as unknown as number);

  const rafCancel: (id: number) => void =
    typeof cancelAnimationFrame === 'function'
      ? (id) => cancelAnimationFrame(id)
      : (id) => clearTimeout(id as unknown as any);

  // Markdown parse/重排比较重：降低提交频率，减少“闪烁/颗粒感”
  const COMMIT_INTERVAL_MS = 120;
  const LIVE_TAIL_MAX_CHARS = 480;

  const pendingByMessageRef = useRef<Map<string, string>>(new Map());
  const liveTailByMessageRef = useRef<Map<string, string>>(new Map());
  const [liveTailById, setLiveTailById] = useState<Record<string, string>>({});
  const flushRafRef = useRef<number | null>(null);
  const flushTimeoutRef = useRef<number | null>(null);
  const lastCommitAtRef = useRef(0);
  const stopAfterDrainRef = useRef(false);
  const lastStreamingAssistantIdRef = useRef<string>('');

  const takeCommitChunk = (buf: string) => {
    const s = String(buf || '');
    if (!s) return '';
    // 尽量“按边界提交”：避免同一行在 Markdown/纯文本之间来回切换导致闪烁
    const max = Math.max(80, Math.min(520, Math.ceil(s.length / 3)));
    const slice = s.slice(0, max);

    const sliceLines = slice.split('\n');

    const looksLikeTableSep = (line: string) => {
      const l = String(line || '').trim();
      if (!l) return false;
      // 典型：|---|---| 或 ---|---（允许对齐冒号）
      return /^(\|?\s*:?-{3,}:?\s*)+(\|\s*:?-{3,}:?\s*)+\|?$/.test(l);
    };

    const hasTableHeaderAndSep = () => {
      // 只在“本段开头”附近检测（uncommitted buffer 从上次边界开始）
      if (sliceLines.length < 2) return false;
      const a = (sliceLines[0] || '').trim();
      const b = (sliceLines[1] || '').trim();
      if (!a.includes('|')) return false;
      return looksLikeTableSep(b);
    };

    // 表格：不要按单行 commit，否则会破坏 Markdown table 解析，导致“像纯文本”
    if (hasTableHeaderAndSep()) {
      // 只有当表格块“结束”（出现空行）才 commit 整块
      const blankIdx = sliceLines.findIndex((x, i) => i >= 2 && String(x).trim() === '');
      if (blankIdx >= 0) {
        const upto = sliceLines.slice(0, blankIdx + 1).join('\n');
        return upto + '\n';
      }
      return '';
    }

    // 1) 优先按“段落边界”提交（最稳定：ReactMarkdown 结构更少抖动）
    const pp = slice.lastIndexOf('\n\n');
    if (pp >= 0) return slice.slice(0, pp + 2);

    // 2) 次优按换行提交（列表/标题/段落更稳定）
    const nl = slice.lastIndexOf('\n');
    if (nl >= 0) {
      const line = slice.slice(0, nl);
      // 如果这一行看起来“收尾了”（有标点/够长），就提交；否则继续留在 tail 里等它完整
      if (/[。！？.!?；;：:]\s*$/.test(line) || line.length >= 140) return slice.slice(0, nl + 1);
      return '';
    }

    // 次优：按句子/空格/标点边界提交（没有换行的长段落也能渐进显示）
    const boundaries = ['。', '！', '？', '.', '!', '?', '，', ',', '；', ';', '：', ':', ' '];
    let best = -1;
    for (const b of boundaries) {
      const idx = slice.lastIndexOf(b);
      if (idx > best) best = idx;
    }
    if (best >= 0) return slice.slice(0, best + 1);

    // 3) 兜底：没有任何边界，只有 buffer 很大时才提交一小段，避免 UI 完全不动
    if (s.length >= 800) return slice.slice(0, Math.min(slice.length, 160));
    return '';
  };

  const clearStreamingBuffers = useCallback(() => {
    pendingByMessageRef.current.clear();
    liveTailByMessageRef.current.clear();
    setLiveTailById({});
    stopAfterDrainRef.current = false;
    lastCommitAtRef.current = 0;
    lastStreamingAssistantIdRef.current = '';
    if (flushRafRef.current != null) {
      rafCancel(flushRafRef.current);
      flushRafRef.current = null;
    }
    if (flushTimeoutRef.current != null) {
      clearTimeout(flushTimeoutRef.current as any);
      flushTimeoutRef.current = null;
    }
  }, []);

  const flushStreamingBuffers = useCallback((opts?: { forceAll?: boolean }) => {
    const forceAll = !!opts?.forceAll;
    const pending = pendingByMessageRef.current;

    if (pending.size === 0) {
      // 可能出现“短暂没 delta”的空窗：此时也应清理 tail，避免残影
      if (liveTailByMessageRef.current.size > 0) {
        liveTailByMessageRef.current.clear();
        setLiveTailById({});
      }
      if (stopAfterDrainRef.current) {
        stopAfterDrainRef.current = false;
        // streaming 结束：把 mdParts 合并回整段渲染，避免 table/list 因分块丢上下文
        const lastId = lastStreamingAssistantIdRef.current;
        if (lastId) {
          setMessages((prev) => prev.map((m) => (m.id === lastId ? { ...m, mdParts: undefined } : m)));
        }
        clearStreamingBuffers();
        setIsStreaming(false);
        setStreamingAssistantMessageId('');
      }
      return;
    }

    // 1) 先做“低频提交”（会修改 pending），避免同一帧里 tail+markdown 出现重复字符导致闪烁
    const now = Date.now();
    const canCommit = forceAll || now - (lastCommitAtRef.current || 0) >= COMMIT_INTERVAL_MS;
    if (canCommit) {
      lastCommitAtRef.current = now;
      const chunksById = new Map<string, string>();
      for (const [id, buf] of pending.entries()) {
        const chunk = forceAll ? buf : takeCommitChunk(buf);
        if (!chunk) continue;
        chunksById.set(id, (chunksById.get(id) ?? '') + chunk);
        const rest = buf.slice(chunk.length);
        if (rest) pending.set(id, rest);
        else pending.delete(id);
      }
      if (chunksById.size > 0) {
        setMessages((prev) =>
          prev.map((m) => {
            const c = chunksById.get(m.id);
            if (!c) return m;
            const nextContent = (m.content ?? '') + c;
            const prevParts = Array.isArray(m.mdParts) ? m.mdParts : null;
            const nextParts = prevParts ? [...prevParts, c] : prevParts;
            return { ...m, content: nextContent, ...(nextParts ? { mdParts: nextParts } : null) };
          })
        );
      }
    }

    // 2) 再刷新 live tail（此时 pending 已是最新）
    let tailsChanged = false;
    const activeIds = new Set<string>();
    for (const id of pending.keys()) activeIds.add(id);
    for (const k of Array.from(liveTailByMessageRef.current.keys())) {
      if (!activeIds.has(k)) {
        liveTailByMessageRef.current.delete(k);
        tailsChanged = true;
      }
    }
    pending.forEach((buf, id) => {
      const tail = buf.length > LIVE_TAIL_MAX_CHARS ? buf.slice(-LIVE_TAIL_MAX_CHARS) : buf;
      const prevTail = liveTailByMessageRef.current.get(id) ?? '';
      if (prevTail !== tail) {
        liveTailByMessageRef.current.set(id, tail);
        tailsChanged = true;
      }
    });
    if (tailsChanged) {
      const obj: Record<string, string> = {};
      liveTailByMessageRef.current.forEach((v, k) => {
        if (v) obj[k] = v;
      });
      setLiveTailById(obj);
    }

    // 继续调度（rAF + 兜底 timeout，避免后台 tab 节流）
    if (!forceAll && (pending.size > 0 || stopAfterDrainRef.current)) {
      if (flushRafRef.current == null) {
        flushRafRef.current = rafSchedule(() => {
          flushRafRef.current = null;
          flushStreamingBuffers();
        });
      }
      if (flushTimeoutRef.current == null) {
        flushTimeoutRef.current = setTimeout(() => {
          flushTimeoutRef.current = null;
          flushStreamingBuffers();
        }, 50) as any;
      }
    }
  }, [clearStreamingBuffers]);

  const scheduleStreamingFlush = useCallback(() => {
    if (flushRafRef.current != null) return;
    flushRafRef.current = rafSchedule(() => {
      flushRafRef.current = null;
      flushStreamingBuffers();
    });
  }, [flushStreamingBuffers]);

  const [composer, setComposer] = useState('');
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [resendTargetMessageId, setResendTargetMessageId] = useState<string>('');

  // 提示词快捷标签
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [currentRole, setCurrentRole] = useState<'PM' | 'DEV' | 'QA'>('PM');
  const [selectedPromptKey, setSelectedPromptKey] = useState<string>(''); // 本轮使用的 promptKey（可选）
  const [debugMode, setDebugMode] = useState(false);

  // 新建会话（上传 PRD）
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  // 引用抽屉（右侧展开）
  const [citationDrawerOpen, setCitationDrawerOpen] = useState(false);
  const [citationDrawerCitations, setCitationDrawerCitations] = useState<
    Array<{ headingId?: string | null; headingTitle?: string | null; excerpt?: string | null }>
  >([]);
  const [citationDrawerActiveIndex, setCitationDrawerActiveIndex] = useState(0);
  const openCitationDrawer = useCallback(
    (citations: Array<{ headingId?: string | null; headingTitle?: string | null; excerpt?: string | null }>, idx?: number) => {
      const cs = Array.isArray(citations) ? citations : [];
      if (cs.length === 0) return;
      const i = typeof idx === 'number' && Number.isFinite(idx) ? Math.max(0, Math.min(cs.length - 1, idx)) : 0;
      setCitationDrawerCitations(cs);
      setCitationDrawerActiveIndex(i);
      setCitationDrawerOpen(true);
    },
    []
  );

  const [prdText, setPrdText] = useState('');
  const [prdFileName, setPrdFileName] = useState('');
  const [prdTitle, setPrdTitle] = useState(''); // 用户自定义标题
  const prdFileRef = useRef<HTMLInputElement | null>(null);
  const [prdDragOver, setPrdDragOver] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);

  // 附件（v1：本地读文本注入；todo4 会补齐长度控制/提示）
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingAttachmentText, setPendingAttachmentText] = useState<string>('');
  const [pendingAttachmentName, setPendingAttachmentName] = useState<string>('');

  // 角色系统提示词（用于查看“系统提示词内容”）
  const [systemPromptByRole, setSystemPromptByRole] = useState<Record<string, string>>({});
  const [promptViewerOpen, setPromptViewerOpen] = useState(false);
  const [promptViewer, setPromptViewer] = useState<{
    role: 'PM' | 'DEV' | 'QA';
    promptKey?: string;
    promptTitle?: string;
    systemPrompt?: string;
    promptTemplate?: string;
  } | null>(null);

  const refreshSessionsFromServer = useCallback(
    async (args?: { includeArchived?: boolean; silent?: boolean }) => {
      if (!userId) return;
      const inc = args?.includeArchived ?? includeArchivedSessions;
      const qs = new URLSearchParams();
      if (inc) qs.set('includeArchived', 'true');
      const suffix = qs.toString() ? `?${qs.toString()}` : '';

      try
      {
        const res = await apiRequest<{ items: any[] }>(`/api/v1/sessions${suffix}`, { method: 'GET' });
        if (!res.success) {
          if (!args?.silent) {
            void systemDialog.alert(res.error?.message || '获取会话列表失败');
          }
          // fallback：兼容旧版本本地缓存
          const loaded = loadSessions(userId);
          loaded.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          setSessions(loaded);
          if (!activeSessionId && loaded.length > 0) setActiveSessionId(loaded[0].sessionId);
          return;
        }

        const items = Array.isArray((res.data as any)?.items) ? (res.data as any).items : [];
        const mapped: LocalSession[] = items
          .map((x: any) => {
            const sid = String(x?.sessionId ?? '').trim();
            const did = String(x?.documentId ?? '').trim();
            if (!sid || !did) return null;
            const title = String(x?.title ?? '').trim() || `会话 ${sid.slice(0, 8)}`;
            const createdAt = x?.createdAt ? new Date(String(x.createdAt)).getTime() : Date.now();
            const lastActiveAt = x?.lastActiveAt ? new Date(String(x.lastActiveAt)).getTime() : createdAt;
            return {
              sessionId: sid,
              documentId: did,
              documentTitle: String(x?.documentTitle ?? '').trim(),
              title,
              createdAt,
              updatedAt: lastActiveAt,
              archivedAtUtc: x?.archivedAtUtc ? String(x.archivedAtUtc) : null,
            } as LocalSession;
          })
          .filter(Boolean) as LocalSession[];

        mapped.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        setSessions(mapped);

        // activeSessionId 兜底：空/不存在则取最近活跃
        if (mapped.length > 0) {
          const exists = activeSessionId && mapped.some((s) => s.sessionId === activeSessionId);
          if (!exists) setActiveSessionId(mapped[0].sessionId);
        } else {
          if (activeSessionId) setActiveSessionId('');
        }
      } catch {
        if (!args?.silent) {
          void systemDialog.alert('获取会话列表失败（网络错误）');
        }
      }
    },
    [userId, includeArchivedSessions, activeSessionId]
  );

  const ensureSessionAlive = useCallback(
    async (args?: { silent?: boolean }) => {
      const sid = String(activeSessionId || '').trim();
      if (!sid) return;
      if (!token) return;
      try {
        // SessionsController.GetSession 会刷新 LastActiveAt 与 TTL（滑动过期）
        const res = await apiRequest(`/api/v1/sessions/${encodeURIComponent(sid)}`, { method: 'GET' });
        if (res.success) {
          if (activeSessionExpired) setActiveSessionExpired(false);
          if (expiredNotifiedSessionIdRef.current === sid) expiredNotifiedSessionIdRef.current = '';
          return;
        }
        const code = String(res.error?.code || '');
        if (code === 'SESSION_NOT_FOUND' || code === 'SESSION_EXPIRED') {
          setActiveSessionExpired(true);
          if (expiredNotifiedSessionIdRef.current !== sid) {
            expiredNotifiedSessionIdRef.current = sid;
            if (!args?.silent) {
              void systemDialog.alert('当前会话已过期，请重新上传 PRD 创建新会话');
            }
          }
        }
      } catch {
        // ignore：断网/后端不可达时不把会话标记为过期
      }
    },
    [activeSessionId, token, activeSessionExpired]
  );

  // keep-alive：避免用户长时间阅读后首次提问直接触发“会话不存在或已过期”
  useEffect(() => {
    if (!userId || !activeSessionId || !token) return;
    setActiveSessionExpired(false);
    void ensureSessionAlive({ silent: true });

    const intervalMs = 5 * 60 * 1000;
    const timer = window.setInterval(() => void ensureSessionAlive({ silent: true }), intervalMs);

    const onFocus = () => void ensureSessionAlive({ silent: true });
    window.addEventListener('focus', onFocus);

    const onVis = () => {
      if (!document.hidden) void ensureSessionAlive({ silent: true });
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [userId, activeSessionId, token, ensureSessionAlive]);

  // 下拉菜单打开时刷新会话列表
  useEffect(() => {
    if (!sessionMenuOpen) return;
    void refreshSessionsFromServer({ includeArchived: includeArchivedSessions, silent: true });
  }, [sessionMenuOpen, includeArchivedSessions, refreshSessionsFromServer]);


  useEffect(() => {
    if (!userId) return;
    void refreshSessionsFromServer({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // 加载提示词列表（用于底部快捷标签）
  useEffect(() => {
    if (!token) return;
    getAdminPrompts()
      .then((res) => {
        if (!res.success) return;
        const items = Array.isArray(res.data?.settings?.prompts) ? res.data.settings.prompts : [];
        const mapped: PromptItem[] = items
          .map((x: any) => {
            const roleRaw = String(x.role ?? '').trim().toUpperCase();
            const role = roleRaw === 'PM' || roleRaw === 'DEV' || roleRaw === 'QA' ? (roleRaw as 'PM' | 'DEV' | 'QA') : undefined;
            return {
              promptKey: String(x.promptKey ?? '').trim(),
              title: String(x.title ?? '').trim(),
              promptTemplate: String(x.promptTemplate ?? '').trim(),
              order: typeof x.order === 'number' ? x.order : 999,
              role,
            };
          })
          .filter((x) => x.promptKey && x.title && x.role === currentRole);
        // 按 order 排序
        mapped.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        setPrompts(mapped);
        // 如果当前已选择的 promptKey 不在该角色列表里，则清空
        if (selectedPromptKey && !mapped.some((p) => p.promptKey === selectedPromptKey)) {
          setSelectedPromptKey('');
        }
      })
      .catch(() => {
        // 静默失败
      });
     
  }, [token, currentRole, selectedPromptKey]);

  // 加载角色系统提示词（用于查看“系统提示词内容”）
  useEffect(() => {
    if (!token) return;
    getAdminSystemPrompts()
      .then((res) => {
        if (!res.success) return;
        const entries = Array.isArray(res.data?.settings?.entries) ? res.data.settings.entries : [];
        const map: Record<string, string> = {};
        for (const e of entries) {
          const r = String((e as any).role ?? '').trim().toUpperCase();
          const sp = String((e as any).systemPrompt ?? '');
          if (r) map[r] = sp;
        }
        setSystemPromptByRole(map);
      })
      .catch(() => {});
  }, [token]);

  // 测试模式：自动切换角色、填充输入框
  useEffect(() => {
    if (!testData) return;

    // 1. 切换角色
    if (testData.role && testData.role !== currentRole) {
      setCurrentRole(testData.role);
    }

    // 2. 自动填充输入框（显示完整的 promptTemplate）
    if (testData.promptTemplate && !composer) {
      setComposer(testData.promptTemplate);
      // 自动调整输入框高度
      requestAnimationFrame(() => {
        const el = composerRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testData]);

  useEffect(() => {
    if (!userId || !activeSessionId) {
      setMessages([]);
      return;
    }

    // 先用本地缓存“秒开”
    setMessages(loadMessages(userId, activeSessionId));

    // 再拉一次后端历史覆盖（避免本地/后端不一致）
    getAiChatHistory({ sessionId: activeSessionId, limit: 50 })
      .then((res) => {
        if (!res.success) return;
        const mapped: UiMessage[] = (res.data ?? []).map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content ?? '',
          groupSeq: typeof m.groupSeq === 'number' ? m.groupSeq : undefined,
          replyToMessageId: (m as any).replyToMessageId ? String((m as any).replyToMessageId) : undefined,
          resendOfMessageId: (m as any).resendOfMessageId ? String((m as any).resendOfMessageId) : undefined,
          viewRole: ((m as any).viewRole ? String((m as any).viewRole).trim().toUpperCase() : undefined) as any,
          timestamp: new Date(m.timestamp).getTime(),
        }));
        setMessages(mapped);
        saveMessages(userId, activeSessionId, mapped);
      })
      .catch(() => {});
  }, [userId, activeSessionId]);

  useEffect(() => {
    if (!userId || !activeSessionId) return;
    saveMessages(userId, activeSessionId, messages);
  }, [userId, activeSessionId, messages]);

  const refreshHistory = useCallback(async (sid: string) => {
    const sessionId = String(sid || '').trim();
    if (!sessionId) return;
    try {
      const res = await getAiChatHistory({ sessionId, limit: 80 });
      if (!res.success) return;
      const mapped: UiMessage[] = (res.data ?? []).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content ?? '',
        groupSeq: typeof m.groupSeq === 'number' ? m.groupSeq : undefined,
        replyToMessageId: (m as any).replyToMessageId ? String((m as any).replyToMessageId) : undefined,
        resendOfMessageId: (m as any).resendOfMessageId ? String((m as any).resendOfMessageId) : undefined,
        viewRole: ((m as any).viewRole ? String((m as any).viewRole).trim().toUpperCase() : undefined) as any,
        timestamp: new Date(m.timestamp).getTime(),
      }));
      setMessages(mapped);
      if (userId && sessionId) saveMessages(userId, sessionId, mapped);
    } catch {
      // ignore
    }
  }, [userId]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth' });
  }, [messages, isStreaming]);

  const stopStreaming = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    // 用户取消：强制结束（不等待 tail drain）
    // 先尽量把 pending 写入内容，避免丢字；然后清空状态
    flushStreamingBuffers({ forceAll: true });
    clearStreamingBuffers();
    setIsStreaming(false);
    setStreamingAssistantMessageId('');
  };

  const removeRoundByUserMessageId = useCallback((list: UiMessage[], targetUserMessageId: string) => {
    const tid = String(targetUserMessageId || '').trim();
    if (!tid) return list;
    const idx = list.findIndex((x) => x.id === tid);
    if (idx < 0) return list;
    // 删除该 User 消息，以及其后直到下一个 User 的所有消息（旧轮次默认不展示）
    let end = idx + 1;
    while (end < list.length && list[end].role !== 'User') end += 1;
    return list.slice(0, idx).concat(list.slice(end));
  }, []);

  const adjustComposerHeight = () => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  const applyStreamEvent = (evt: AiChatStreamEvent) => {
    const t = String(evt?.type ?? '');
    if (!t) return;

    if (t === 'start') {
      const id = String(evt.messageId || `assistant-${Date.now()}`);
      setStreamingAssistantMessageId(id);
      lastStreamingAssistantIdRef.current = id;
      // 新一轮：清理该 message 的残留 buffer/tail（避免串帧）
      pendingByMessageRef.current.delete(id);
      liveTailByMessageRef.current.delete(id);
      setLiveTailById((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setMessages((prev) => {
        if (prev.some((m) => m.id === id)) return prev;
        return prev.concat({
          id,
          role: 'Assistant',
          content: '',
          mdParts: [],
          timestamp: Date.now(),
        });
      });
      return;
    }

    if (t === 'citations') {
      const id = String(evt.messageId || '');
      if (!id) return;
      const cs = Array.isArray(evt.citations) ? evt.citations : [];
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, citations: cs } : m)));
      return;
    }

    if (t === 'error') {
      const msg = String(evt.errorMessage || '请求失败');
      const code = String(evt.errorCode || '');
      if (code === 'SESSION_NOT_FOUND' || code === 'SESSION_EXPIRED') {
        setActiveSessionExpired(true);
      }
      setMessages((prev) =>
        prev.concat({
          id: `error-${Date.now()}`,
          role: 'Assistant',
          content: `请求失败：${msg}`,
          timestamp: Date.now(),
        })
      );
      stopStreaming();
      return;
    }

    if (t === 'done') {
      // done：让尾巴吐完再结束，避免最后一段“瞬间刷出来”
      stopAfterDrainRef.current = true;
      scheduleStreamingFlush();
      // 安全兜底：最多 2s 后强制把剩余全部提交并结束
      setTimeout(() => {
        if (!stopAfterDrainRef.current) return;
        flushStreamingBuffers({ forceAll: true });
      }, 2000);
      if (activeSessionId) {
        // 关键：刷新一次历史，把本地临时 user id 替换成服务端落库 id，
        // 这样“刚发送的消息”也可以立即使用“重发”。
        void refreshHistory(activeSessionId);
      }
      return;
    }

    // 统一把流式文本写入目标 message（messageId）
    const targetId = String(evt.messageId || '');
    const delta = evt.content ? String(evt.content) : '';
    if (!targetId || !delta) return;
    const pending = pendingByMessageRef.current;
    pending.set(targetId, (pending.get(targetId) ?? '') + delta);
    scheduleStreamingFlush();
  };

  const sendMessage = async () => {
    const text = composer.trim();
    if (!text) return;
    if (!activeSessionId) {
      setCreateOpen(true);
      return;
    }
    if (activeSessionExpired) {
      setCreateOpen(true);
      return;
    }
    if (!token) {
      await systemDialog.alert('未登录');
      return;
    }
    if (isStreaming) return;

    const limited = applyContentLimit({
      question: text,
      attachmentName: pendingAttachmentName,
      attachmentText: pendingAttachmentText,
    });
    if (!limited.ok) {
      await systemDialog.alert(limited.reason || `内容过长（上限 ${MAX_MESSAGE_CHARS} 字符）`);
      return;
    }
    if (limited.truncated) {
      // 轻提示：不阻塞发送，只告知发生截断
      // 禁止 emoji
      void systemDialog.alert('附件内容过长，已自动截断后发送');
    }
    const finalText = limited.finalText;
    const resendId = resendTargetMessageId ? String(resendTargetMessageId) : '';
    const effectivePromptKey = (selectedPromptKey || '').trim();
    const promptMeta = prompts.find((p) => p.promptKey === effectivePromptKey) ?? null;

    setPendingAttachmentText('');
    setPendingAttachmentName('');

    setMessages((prev) =>
      (resendId ? removeRoundByUserMessageId(prev, resendId) : prev).concat({
        id: `user-${Date.now()}`,
        role: 'User',
        content: finalText,
        viewRole: currentRole,
        promptKey: effectivePromptKey || undefined,
        promptTitle: promptMeta?.title,
        promptTemplate: promptMeta?.promptTemplate,
        timestamp: Date.now(),
      })
    );
    setComposer('');
    if (resendId) setResendTargetMessageId('');
    requestAnimationFrame(() => adjustComposerHeight());

    const ac = new AbortController();
    abortRef.current = ac;
    setIsStreaming(true);

    let res: Response;
    try {
      const url = resendId
        ? joinUrl(getApiBaseUrl(), `/api/v1/sessions/${encodeURIComponent(activeSessionId)}/messages/${encodeURIComponent(resendId)}/resend`)
        : joinUrl(getApiBaseUrl(), `/api/v1/sessions/${encodeURIComponent(activeSessionId)}/messages`);
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ 
          content: finalText,
          role: currentRole,
          promptKey: effectivePromptKey || null,
        }),
        signal: ac.signal,
      });
    } catch (e) {
      setIsStreaming(false);
      abortRef.current = null;
      const msg = e instanceof Error ? e.message : '网络错误';
      setMessages((prev) => prev.concat({ id: `neterr-${Date.now()}`, role: 'Assistant', content: `请求失败：${msg}`, timestamp: Date.now() }));
      return;
    }

    if (!res.ok) {
      setIsStreaming(false);
      abortRef.current = null;
      const t = await res.text();
      setMessages((prev) =>
        prev.concat({
          id: `httperr-${Date.now()}`,
          role: 'Assistant',
          content: t || `HTTP ${res.status} ${res.statusText}`,
          timestamp: Date.now(),
        })
      );
      return;
    }

    await readSseStream(
      res,
      (evt) => {
        if (!evt.data) return;
        try {
          const obj = JSON.parse(evt.data) as AiChatStreamEvent;
          applyStreamEvent(obj);
        } catch {
          // ignore
        }
      },
      ac.signal
    );
  };

  const onPickPrdFile = async (file: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.md')) {
      await systemDialog.alert('仅支持 .md 文件');
      return;
    }
    const content = await file.text();
    setPrdFileName(file.name);
    setPrdText(content);
  };

  const createSession = async () => {
    const content = prdText.trim();
    if (!content) {
      await systemDialog.alert('请粘贴或选择 PRD 内容');
      return;
    }
    if (!userId) {
      await systemDialog.alert('未登录');
      return;
    }

    setCreateBusy(true);
    let res: ApiResponse<any>;
    try {
      res = await uploadAiChatDocument({ content, title: prdTitle.trim() || null });
    } finally {
      setCreateBusy(false);
    }
    if (!res.success) {
      await systemDialog.alert(res.error?.message || '上传失败');
      return;
    }

    const sid = String(res.data.sessionId || '');
    const docId = String(res.data.document?.id || '');
    const docTitleRaw = String(res.data.document?.title || '');
    const docTitle = docTitleRaw.trim();
    if (!sid) {
      await systemDialog.alert('后端未返回 sessionId');
      return;
    }

    // 确定标题：优先用户输入 > Markdown 标题 > 文件名 > 短 id
    const userTitle = prdTitle.trim();
    const fileName = normalizeFileName(prdFileName);
    const mdTitle = extractMarkdownTitle(content);
    const fileBase = normalizeCandidateName(stripFileExtension(fileName));

    const finalTitle =
      (userTitle ? userTitle : '') ||
      (!isPlaceholderTitle(mdTitle) ? mdTitle : '') ||
      (!isPlaceholderTitle(docTitle) ? docTitle : '') ||
      (!isMeaninglessName(fileBase) ? fileBase : '') ||
      `会话 ${sid.slice(0, 8)}`;

    const now = Date.now();
    const next: LocalSession = {
      sessionId: sid,
      documentId: docId,
      documentTitle: docTitle,
      title: finalTitle,
      createdAt: now,
      updatedAt: now,
    };

    setSessions((prev) => {
      const merged = [next, ...prev.filter((x) => x.sessionId !== sid)];
      saveSessions(userId, merged);
      return merged;
    });
    setActiveSessionId(sid);
    setActiveSessionExpired(false);
    expiredNotifiedSessionIdRef.current = '';
    setMessages([]);
    saveMessages(userId, sid, []);
    setCreateOpen(false);
    setPrdText('');
    setPrdFileName('');
    setPrdTitle('');

    // 刷新服务端会话列表（IM 形态）
    void refreshSessionsFromServer({ silent: true });
  };

  const pickAttachment = async (file: File | null) => {
    if (!file) return;
    const fileName = normalizeFileName(file.name || '');
    const ext = getLowerExt(fileName);
    if (ext && !ALLOWED_TEXT_EXTS.includes(ext)) {
      await systemDialog.alert(`暂仅支持文本附件：${ALLOWED_TEXT_EXTS.join(', ')}`);
      return;
    }

    let text = '';
    try {
      text = await file.text();
    } catch {
      await systemDialog.alert('读取文件失败，请重试');
      return;
    }

    // 先做一次预截断：避免把超大文本塞进状态导致页面卡顿
    const softMax = 12 * 1024;
    if (text.length > softMax) {
      const suffix = '\n\n...(附件内容过长，已预先截断，发送时仍会按 16KB 上限再次截断)...';
      text = text.slice(0, Math.max(0, softMax - suffix.length)) + suffix;
    }

    setPendingAttachmentName(fileName);
    setPendingAttachmentText(text || '');
  };

  // 头部切换下拉菜单
  const sessionDropdownMenu = sessionMenuOpen && (
    <>
      <div className="fixed inset-0 z-[100]" onClick={() => setSessionMenuOpen(false)} />
      <div
        className="absolute left-0 top-full mt-1 z-[110] w-[320px] max-h-[400px] overflow-auto rounded-[14px] p-2 shadow-lg"
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}
      >
        {sessions.map((s) => {
          const isActive = s.sessionId === activeSessionId;
          const isArchived = !!s.archivedAtUtc;
          return (
            <div
              key={s.sessionId}
              className="flex items-center gap-2 px-2 py-1 rounded-[10px] group"
              style={{
                background: isActive ? 'rgba(255,255,255,0.06)' : 'transparent',
              }}
            >
              <button
                type="button"
                className="flex-1 min-w-0 text-left px-1 py-1 rounded-[8px] hover:bg-white/5 transition-colors"
                onClick={() => {
                  pickSession(s.sessionId);
                  setSessionMenuOpen(false);
                }}
                title={s.title}
              >
                <div className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {s.title || `${s.sessionId.slice(0, 8)}`}
                </div>
                {isArchived && (
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>已归档</div>
                )}
              </button>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <button
                  type="button"
                  className="p-1 rounded-[6px] hover:bg-white/10 text-[10px]"
                  style={{ color: 'var(--text-muted)' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    void archiveSession(s.sessionId, !isArchived);
                  }}
                  title={isArchived ? '取消归档' : '归档'}
                >
                  {isArchived ? '恢复' : '归档'}
                </button>
                <button
                  type="button"
                  className="p-1 rounded-[6px] hover:bg-red-500/20 text-[10px]"
                  style={{ color: 'var(--status-error)' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteSession(s.sessionId);
                  }}
                  title="删除"
                >
                  删除
                </button>
              </div>
            </div>
          );
        })}
        <div className="border-t my-2" style={{ borderColor: 'var(--border-subtle)' }} />
        <button
          type="button"
          className="w-full text-left px-3 py-2 rounded-[10px] hover:bg-white/5 transition-colors flex items-center gap-2"
          onClick={() => {
            setSessionMenuOpen(false);
            setCreateOpen(true);
          }}
        >
          <Plus size={14} style={{ opacity: 0.6 }} />
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>上传新 PRD</span>
        </button>
      </div>
    </>
  );

  // 头部左侧内容：会话切换 + 角色切换
  const headerLeftContent = (
    <div className="flex items-center gap-3">
      {/* 会话切换按钮 + 下拉菜单 */}
      <div className="relative z-[120]">
        <button
          type="button"
          className="px-3 h-[28px] rounded-[9px] text-[12px] font-semibold hover:bg-white/5 transition-colors truncate flex items-center gap-1.5"
          style={{ border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)', maxWidth: '280px', background: 'rgba(255,255,255,0.04)' }}
          onClick={() => {
            if (sessions.length === 0) {
              setCreateOpen(true);
            } else {
              setSessionMenuOpen((v) => !v);
            }
          }}
          disabled={!userId}
          title={sessions.length > 0 ? '点击切换对话' : '上传 PRD'}
        >
          <span className="truncate">
            {activeSession?.title || activeSession?.documentTitle || '上传 PRD'}
          </span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ opacity: sessions.length > 0 ? 0.75 : 0.35, flexShrink: 0 }}>
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        {sessionDropdownMenu}
      </div>
      {/* 角色切换 */}
      <GlassSwitch
        options={[
          { key: 'PM', label: 'PM' },
          { key: 'DEV', label: 'DEV' },
          { key: 'QA', label: 'QA' },
        ]}
        value={currentRole}
        onChange={(key) => setCurrentRole(key as 'PM' | 'DEV' | 'QA')}
        accentHue={45}
        size="sm"
      />
    </div>
  );

  // 头部右侧按钮
  const headerRightActions = (
    <>
      <Button
        variant="primary"
        size="sm"
        onClick={() => setCreateOpen(true)}
        disabled={!userId}
        title="新建/上传 PRD（创建新的对话）"
      >
        <Plus size={16} />
        新建
      </Button>
      <button
        type="button"
        className="text-[11px] h-[28px] px-2.5 rounded-[9px] transition-colors"
        style={{ 
          border: '1px solid rgba(255,255,255,0.12)', 
          color: isTestMode ? 'var(--accent-gold)' : 'var(--text-secondary)',
          background: isTestMode ? 'rgba(214, 178, 106, 0.08)' : 'rgba(255,255,255,0.04)',
          cursor: isTestMode ? 'default' : 'pointer',
        }}
        onClick={() => !isTestMode && setDebugMode((v) => !v)}
        title={
          isTestMode && testData
            ? `测试提示词：${testData.promptTitle}`
            : debugMode
              ? '调试模式：显示消息 ID / replyTo / resendOf 等技术信息'
              : '正常对话：隐藏调试信息'
        }
      >
        {isTestMode && testData?.promptTemplate 
          ? '未保存的提示词测试' 
          : isTestMode 
            ? '使用已生效的提示词'
            : debugMode
              ? '调试模式'
              : '正常对话'}
      </button>
      {isStreaming ? (
        <Button variant="danger" size="sm" onClick={() => stopStreaming()}>
          <Square size={16} />
          取消
        </Button>
      ) : null}
    </>
  );

  const chatPanel = (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {/* 头部 TabBar */}
      <TabBar
        title="PRD Agent"
        icon={<MessageSquare size={16} />}
        actions={
          <>
            {headerLeftContent}
            {headerRightActions}
          </>
        }
      />

      {/* 内容区 */}
      <GlassCard className="flex-1 min-h-0 flex flex-col" overflow="hidden" padding="none" glow accentHue={210}>
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 pr-3 space-y-3">
          {messages.length === 0 ? (
            activeSessionId ? (
              <div className="py-20 text-center">
                <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                  开始提问吧
                </div>
                <div className="mt-1.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
                  {activeSessionExpired
                    ? '当前会话已过期，请重新上传 PRD。'
                    : '直接在下方输入问题，开始对话。'}
                </div>
              </div>
            ) : (
              /* 无会话时：直接显示拖拽上传区域 */
              <div className="h-full flex flex-col items-center justify-center gap-4">
                <div
                  className="w-full max-w-[520px] rounded-[20px] p-6 flex flex-col items-center gap-4 transition-colors"
                  style={{
                    border: `2px dashed ${prdDragOver ? 'var(--accent-gold)' : 'var(--border-subtle)'}`,
                    background: prdDragOver ? 'rgba(214,178,106,0.08)' : 'rgba(255,255,255,0.02)',
                  }}
                  onDragOver={(e) => { e.preventDefault(); setPrdDragOver(true); }}
                  onDragLeave={() => setPrdDragOver(false)}
                  onDrop={async (e) => {
                    e.preventDefault();
                    setPrdDragOver(false);
                    const f = e.dataTransfer.files?.[0] ?? null;
                    if (f) {
                      await onPickPrdFile(f);
                      if (prdText || f) setCreateOpen(true);
                    }
                  }}
                >
                  <div className="text-center">
                    <div className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                      拖拽 PRD 文件到此处
                    </div>
                    <div className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                      或点击下方按钮选择文件
                    </div>
                  </div>
                  <Button
                    variant="primary"
                    onClick={() => prdFileRef.current?.click()}
                    disabled={createBusy}
                  >
                    选择 .md 文件
                  </Button>
                </div>
              </div>
            )
          ) : (
            messages.map((m) => {
              const isUser = m.role === 'User';
              const isThisStreaming = !isUser && !!streamingAssistantMessageId && m.id === streamingAssistantMessageId;
              const liveTail = isThisStreaming ? (liveTailById[m.id] || '') : '';
              return (
                <div key={m.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className="max-w-[85%] rounded-[14px] px-3.5 py-2.5 relative group"
                    style={{
                      background: isUser ? 'color-mix(in srgb, var(--accent-gold) 22%, rgba(255,255,255,0.02))' : 'rgba(255,255,255,0.03)',
                      border: isUser ? '1px solid color-mix(in srgb, var(--accent-gold) 30%, var(--border-subtle))' : '1px solid var(--border-subtle)',
                      color: 'var(--text-primary)',
                      wordBreak: 'break-word',
                    }}
                  >
                    {/* 系统提示词 Tag：展示“本轮将使用的系统提示词/提示词模板”，点击可查看内容 */}
                    {isUser ? (
                      <div className="mb-2 flex items-center gap-2">
                        <span
                          className="text-[10px] px-2 py-0.5 rounded-full select-none"
                          style={{
                            border: '1px solid var(--border-subtle)',
                            color: 'var(--text-secondary)',
                            background: 'rgba(255,255,255,0.02)',
                          }}
                          title="本轮回答角色"
                        >
                          角色：{m.viewRole || currentRole}
                        </span>
                        <button
                          type="button"
                          className="text-[10px] px-2 py-0.5 rounded-full hover:bg-white/5 transition-colors"
                          style={{
                            border: '1px solid color-mix(in srgb, var(--accent-gold) 30%, var(--border-subtle))',
                            color: 'var(--accent-gold)',
                            background: 'color-mix(in srgb, var(--accent-gold) 10%, transparent)',
                          }}
                          onClick={() => {
                            const role = (m.viewRole || currentRole) as 'PM' | 'DEV' | 'QA';
                            setPromptViewer({
                              role,
                              promptKey: m.promptKey || undefined,
                              promptTitle: m.promptTitle || undefined,
                              systemPrompt: systemPromptByRole[role] ?? '',
                              promptTemplate: m.promptTemplate || undefined,
                            });
                            setPromptViewerOpen(true);
                          }}
                          title="点击查看本轮使用的系统提示词/提示词模板"
                        >
                          系统提示词{m.promptTitle ? `：${m.promptTitle}` : m.promptKey ? `：${m.promptKey}` : '：默认'}
                        </button>
                      </div>
                    ) : null}
                    {isUser && !isStreaming ? (
                      // 放到右下角，避免遮住“角色/系统提示词”等头部信息（尤其在内容以标题开头时更明显）
                      <div className="pointer-events-none absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <div className="pointer-events-auto flex gap-1">
                          <button
                            type="button"
                            className="text-[11px] rounded-full px-2 py-1 hover:bg-white/5"
                            style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.02)' }}
                            onClick={() => {
                              setComposer(m.content || '');
                              setResendTargetMessageId(m.id);
                              requestAnimationFrame(() => {
                                adjustComposerHeight();
                                composerRef.current?.focus();
                              });
                            }}
                            title="重发：软删除旧轮次，并以当前内容重新发起一次请求"
                          >
                            重发
                          </button>
                        </div>
                      </div>
                    ) : null}
                    {isUser ? (
                      <div className="text-sm whitespace-pre-wrap">{m.content}</div>
                    ) : (
                      <div className="text-sm prd-md">
                        <style>{`
                          .prd-md { font-size: 13px; line-height: 1.7; color: var(--text-primary); }
                          .prd-md h1, .prd-md h2, .prd-md h3 { color: var(--text-primary); font-weight: 700; margin: 16px 0 10px; }
                          .prd-md h1 { font-size: 18px; }
                          .prd-md h2 { font-size: 16px; }
                          .prd-md h3 { font-size: 14px; }
                          .prd-md p { margin: 10px 0; }
                          .prd-md ul, .prd-md ol { margin: 10px 0; padding-left: 20px; }
                          .prd-md li { margin: 5px 0; }
                          .prd-md strong { font-weight: 600; color: var(--text-primary); }
                          .prd-md em { font-style: italic; color: var(--text-secondary); }
                          .prd-md code { font-family: ui-monospace, monospace; font-size: 12px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); padding: 2px 6px; border-radius: 6px; }
                          .prd-md pre { background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 12px; overflow: auto; margin: 12px 0; }
                          .prd-md pre code { background: transparent; border: 0; padding: 0; }
                          .prd-md blockquote { margin: 12px 0; padding: 8px 12px; border-left: 3px solid color-mix(in srgb, var(--accent-gold) 40%, transparent); background: color-mix(in srgb, var(--accent-gold) 6%, transparent); color: var(--text-primary); border-radius: 10px; }
                          .prd-md a { color: rgba(147, 197, 253, 0.95); text-decoration: underline; }
                          .prd-md hr { border: 0; border-top: 1px solid rgba(255,255,255,0.12); margin: 16px 0; }

                          /* 流式输出“高级感”：高帧率灰度尾巴（未提交部分） */
                          .prd-md-stream-live { margin-top: 8px; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.6; color: var(--text-muted); opacity: 0.92; filter: saturate(0.55); }
                          .prd-md-stream-live-prefix { opacity: 0.55; }
                          .prd-md-stream-live-last { background-image: linear-gradient(to right, currentColor 0%, currentColor 55%, color-mix(in srgb, currentColor 15%, transparent) 100%); -webkit-background-clip: text; background-clip: text; color: transparent; }
                          .prd-md-stream-caret { display: inline-block; width: 0.6ch; height: 1em; margin-left: 2px; background: currentColor; border-radius: 2px; vertical-align: -2px; animation: prd-md-caret-blink 1s steps(1, end) infinite; opacity: 0.75; }
                          @keyframes prd-md-caret-blink { 50% { opacity: 0; } }
                          .prd-md-block-enter { animation: prd-md-block-in 160ms ease-out both; }
                          @keyframes prd-md-block-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
                        `}</style>
                        {Array.isArray(m.mdParts) && m.mdParts.length > 0 ? (
                          <div className="space-y-2">
                            {m.mdParts.map((part, idx) => (
                              <div key={`${m.id}-mdp-${idx}-${part.length}`} className="prd-md-block-enter">
                                <AssistantMarkdown content={unwrapMarkdownFences(part)} />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <AssistantMarkdown content={unwrapMarkdownFences(m.content || '')} />
                        )}
                        {isThisStreaming && liveTail ? <LiveTail text={liveTail} /> : null}
                        {isThisStreaming ? (
                          <div className="mt-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                            输出中
                            <StreamingDot />
                          </div>
                        ) : null}
                      </div>
                    )}
                    {typeof m.groupSeq === 'number' && m.groupSeq > 0 ? (
                      <div className="mt-2 text-[11px] leading-4 select-none opacity-60" style={{ color: 'var(--text-muted)' }}>
                        #{m.groupSeq}
                      </div>
                    ) : null}
                    {debugMode ? (
                      <div className="mt-2 text-[11px] leading-4 opacity-70" style={{ color: 'var(--text-muted)' }}>
                        <div>id: {m.id}</div>
                        {m.replyToMessageId ? <div>replyTo: {m.replyToMessageId}</div> : null}
                        {m.resendOfMessageId ? <div>resendOf: {m.resendOfMessageId}</div> : null}
                      </div>
                    ) : null}
                    {Array.isArray(m.citations) && m.citations.length > 0 ? (
                      <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            依据（引用）
                          </div>
                          <button
                            type="button"
                            className="text-[11px] rounded-full px-2 py-1 hover:bg-white/5"
                            style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.02)' }}
                            onClick={() => openCitationDrawer(m.citations || [], 0)}
                            title="右侧展开引用内容"
                          >
                            查看引用（{Math.min(m.citations.length, 50)}）
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {m.citations.slice(0, 12).map((c, idx) => (
                            <button
                              key={`${c.headingId || c.headingTitle || 'c'}-${idx}`}
                              type="button"
                              className="inline-flex items-center rounded-full px-2 py-1 text-[11px] hover:bg-white/5"
                              style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.02)' }}
                              title={c.excerpt || c.headingTitle || c.headingId || ''}
                              onClick={() => openCitationDrawer(m.citations || [], idx)}
                            >
                              {(c.headingTitle || c.headingId || '引用').slice(0, 40)}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>

        <div className="shrink-0 px-4 pb-4 pt-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          {/* 提示词快捷标签 */}
          {prompts.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {prompts.map((p) => {
                const isHighlighted = highlightPromptKey && p.promptKey === highlightPromptKey;
                const isSelected = !!p.promptKey && p.promptKey === selectedPromptKey;
                return (
                  <button
                    key={p.promptKey}
                    type="button"
                    className="px-3 py-1.5 rounded-[10px] text-[12px] hover:bg-white/5 transition-all duration-200"
                    style={{
                      border: isSelected
                        ? '1px solid color-mix(in srgb, var(--accent-gold) 60%, var(--border-subtle))'
                        : isHighlighted
                          ? '1px solid color-mix(in srgb, var(--accent-gold) 50%, var(--border-subtle))'
                          : '1px solid var(--border-subtle)',
                      background: isSelected
                        ? 'color-mix(in srgb, var(--accent-gold) 16%, transparent)'
                        : isHighlighted
                          ? 'color-mix(in srgb, var(--accent-gold) 12%, transparent)'
                          : 'transparent',
                      color: isSelected || isHighlighted ? 'var(--accent-gold)' : 'var(--text-secondary)',
                    }}
                    onClick={() => {
                      setComposer(p.title);
                      setSelectedPromptKey(p.promptKey);
                      requestAnimationFrame(() => {
                        adjustComposerHeight();
                        composerRef.current?.focus();
                      });
                    }}
                    disabled={!activeSessionId || activeSessionExpired || isStreaming}
                    title={`点击使用提示词：${p.promptKey}`}
                  >
                    {p.title}
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex items-start gap-2">
            <button
              type="button"
              className="h-9 w-9 inline-flex items-center justify-center rounded-[10px] hover:bg-white/5 transition-colors shrink-0"
              style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
              onClick={() => attachInputRef.current?.click()}
              title="添加附件"
              disabled={!activeSessionId || activeSessionExpired || isStreaming}
            >
              <Plus size={17} />
            </button>

            <div className="flex-1 min-w-0">
              <textarea
                ref={composerRef}
                value={composer}
                onChange={(e) => {
                  setComposer(e.target.value);
                  adjustComposerHeight();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void sendMessage();
                  }
                }}
                placeholder={
                  activeSessionId
                    ? activeSessionExpired
                      ? '当前会话已过期，请先重新上传 PRD'
                      : '输入你的问题…（Enter 发送，Shift+Enter 换行）'
                    : '请先新建会话并上传 PRD'
                }
                className="w-full min-w-0 min-h-[40px] resize-none rounded-[12px] px-3.5 py-2.5 text-[13px] outline-none transition-colors"
                style={{
                  background: 'rgba(0,0,0,0.15)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                }}
                rows={1}
                disabled={!activeSessionId || activeSessionExpired || isStreaming}
              />

              {pendingAttachmentText ? (
                <div className="mt-1.5 flex items-center gap-2">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-[11px] hover:bg-white/5 transition-colors"
                    style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                    onClick={() => attachInputRef.current?.click()}
                    disabled={!activeSessionId || activeSessionExpired || isStreaming}
                  >
                    <Paperclip size={12} />
                    文件附件
                  </button>
                  <span className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }} title={pendingAttachmentName}>
                    {pendingAttachmentName || 'unknown'}
                  </span>
                </div>
              ) : null}
            </div>

            <Button
              variant="primary"
              className="h-9 w-9 px-0! rounded-[10px]! shrink-0"
              onClick={() => void sendMessage()}
              disabled={!activeSessionId || activeSessionExpired || isStreaming || !composer.trim()}
              title="发送"
            >
              <Send size={17} />
            </Button>
          </div>

          <input
            ref={attachInputRef}
            type="file"
            className="hidden"
            onChange={async (e) => {
              const f = e.currentTarget.files?.[0] ?? null;
              e.currentTarget.value = '';
              await pickAttachment(f);
            }}
          />
        </div>
      </GlassCard>
    </div>
  );

  const rightPanel = chatPanel;

  const pickSession = (sid: string) => {
    const id = String(sid || '').trim();
    if (!id) return;
    setActiveSessionId(id);
    setActiveSessionExpired(false);
    expiredNotifiedSessionIdRef.current = '';
  };

  const archiveSession = async (sid: string, archive: boolean) => {
    const id = String(sid || '').trim();
    if (!id) return;
    const path = archive
      ? `/api/v1/sessions/${encodeURIComponent(id)}/archive`
      : `/api/v1/sessions/${encodeURIComponent(id)}/unarchive`;
    const res = await apiRequest(path, { method: 'POST' });
    if (!res.success) {
      await systemDialog.alert(res.error?.message || '操作失败');
      return;
    }
    void refreshSessionsFromServer({ includeArchived: includeArchivedSessions, silent: true });
  };

  const deleteSession = async (sid: string) => {
    const id = String(sid || '').trim();
    if (!id) return;
    const ok = window.confirm('确认删除该会话？删除后将不可恢复。');
    if (!ok) return;
    const res = await apiRequest(`/api/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', emptyResponseData: true as any });
    if (!res.success) {
      await systemDialog.alert(res.error?.message || '删除失败');
      return;
    }
    if (activeSessionId === id) {
      setActiveSessionId('');
      setMessages([]);
    }
    void refreshSessionsFromServer({ includeArchived: includeArchivedSessions, silent: true });
  };


  return (
    <>
      {/* 全局 PRD 文件选择 input（始终存在于 DOM） */}
      <input
        ref={prdFileRef}
        type="file"
        accept=".md"
        className="hidden"
        onChange={async (e) => {
          const f = e.currentTarget.files?.[0] ?? null;
          e.currentTarget.value = '';
          if (f) {
            await onPickPrdFile(f);
            // 选择文件后自动打开弹窗
            if (!createOpen) setCreateOpen(true);
          }
        }}
      />

      {rightPanel}

      {/* 系统提示词查看弹窗 */}
      <Dialog
        open={promptViewerOpen}
        onOpenChange={(o) => {
          setPromptViewerOpen(o);
          if (!o) setPromptViewer(null);
        }}
        title="系统提示词"
        description={
          promptViewer
            ? `角色：${promptViewer.role}${promptViewer.promptKey ? ` · promptKey=${promptViewer.promptKey}` : ''}`
            : '查看本轮使用的系统提示词/提示词模板'
        }
        maxWidth={980}
        content={
          <div className="h-full min-h-0 flex flex-col gap-3">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              角色系统提示词
            </div>
            <pre
              className="w-full rounded-[14px] p-3 text-[12px] overflow-auto"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-primary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                minHeight: 120,
              }}
            >
              {(promptViewer?.systemPrompt || '').trim() || '（未获取到系统提示词，可能无权限或配置为空）'}
            </pre>

            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              提示词模板（promptTemplate）
            </div>
            <pre
              className="w-full rounded-[14px] p-3 text-[12px] overflow-auto"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-primary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                minHeight: 160,
              }}
            >
              {(promptViewer?.promptTemplate || '').trim() ||
                (promptViewer?.promptKey ? '（该 promptKey 未配置 promptTemplate 或为空）' : '（本轮未选择 promptKey，使用默认系统提示词）')}
            </pre>

            {promptViewer?.promptTitle ? (
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                标题：{promptViewer.promptTitle}
              </div>
            ) : null}
          </div>
        }
      />

      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          if (createBusy) return;
          setCreateOpen(o);
        }}
        title="上传 PRD"
        description="上传 PRD 文档后即可开始对话。"
        maxWidth={960}
        content={
          <div className="h-full min-h-0 flex flex-col gap-4">
            {/* 标题输入 */}
            <div className="flex items-center gap-3">
              <label className="text-sm shrink-0" style={{ color: 'var(--text-secondary)' }}>标题</label>
              <input
                type="text"
                value={prdTitle}
                onChange={(e) => setPrdTitle(e.target.value)}
                className="flex-1 h-10 rounded-[10px] px-3 text-sm outline-none"
                style={{
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                }}
                placeholder="输入对话标题（可选，留空则使用文件名）"
                disabled={createBusy}
              />
            </div>

            {/* 文件选择 */}
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => prdFileRef.current?.click()}
                disabled={createBusy}
                title="选择 .md 文件并读取内容"
              >
                选择文件
              </Button>
              <div className="text-sm truncate" style={{ color: 'var(--text-muted)' }} title={prdFileName}>
                {prdFileName ? `已选择：${prdFileName}` : '未选择文件（可直接粘贴）'}
              </div>
            </div>

            {/* PRD 内容 */}
            <textarea
              value={prdText}
              onChange={(e) => setPrdText(e.target.value)}
              className="w-full flex-1 min-h-[420px] rounded-[16px] px-4 py-3 text-sm outline-none resize-y"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-primary)',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                lineHeight: 1.6,
              }}
              placeholder="粘贴 Markdown PRD 内容..."
              disabled={createBusy}
            />

            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={createBusy}>
                取消
              </Button>
              <Button variant="primary" onClick={() => void createSession()} disabled={createBusy}>
                {createBusy ? '处理中...' : '开始对话'}
              </Button>
            </div>
          </div>
        }
      />

      {/* 右侧引用抽屉（AiChat 专用，不依赖 PRD 预览页） */}
      <DialogPrimitive.Root open={citationDrawerOpen} onOpenChange={setCitationDrawerOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay
            className="fixed inset-0 z-[120] prd-dialog-overlay"
            style={{ background: 'rgba(0,0,0,0.55)' }}
          />
          <DialogPrimitive.Content
            className="fixed right-0 top-0 z-[130] h-full w-[440px] max-w-[92vw] flex flex-col"
            style={{
              background: 'color-mix(in srgb, var(--bg-elevated) 92%, black)',
              borderLeft: '1px solid var(--border-default)',
              boxShadow: '-18px 0 60px rgba(0,0,0,0.45)',
            }}
          >
            <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border-default)' }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    引用内容
                  </div>
                  <div className="mt-1 text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                    {citationDrawerCitations.length > 0
                      ? `引用 ${Math.min(citationDrawerActiveIndex + 1, citationDrawerCitations.length)}/${citationDrawerCitations.length}`
                      : '暂无引用'}
                  </div>
                </div>
                <DialogPrimitive.Close
                  className="h-9 w-9 inline-flex items-center justify-center rounded-[12px] hover:bg-white/5 shrink-0"
                  style={{ color: 'var(--text-secondary)' }}
                  aria-label="关闭"
                  title="关闭"
                >
                  ×
                </DialogPrimitive.Close>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
              {citationDrawerCitations.map((c, idx) => {
                const active = idx === citationDrawerActiveIndex;
                const title = (c.headingTitle || c.headingId || `引用 ${idx + 1}` || '').trim();
                const excerpt = (c.excerpt || '').trim();
                return (
                  <button
                    key={`${c.headingId || c.headingTitle || 'c'}-${idx}`}
                    type="button"
                    className="w-full text-left rounded-[14px] px-3 py-2"
                    style={{
                      border: '1px solid var(--border-subtle)',
                      background: active ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.02)',
                      color: 'var(--text-primary)',
                    }}
                    onClick={() => setCitationDrawerActiveIndex(idx)}
                    title={title}
                  >
                    <div className="text-xs font-semibold truncate">{title}</div>
                    {excerpt ? (
                      <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>
                        {excerpt}
                      </div>
                    ) : (
                      <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        （无摘录）
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}


