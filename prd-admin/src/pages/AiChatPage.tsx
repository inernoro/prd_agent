import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Dialog } from '@/components/ui/Dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { getAiChatHistory, suggestGroupName, uploadAiChatDocument } from '@/services';
import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';
import { readSseStream } from '@/lib/sse';
import { Paperclip, Plus, Send, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import type { AiChatStreamEvent } from '@/services/contracts/aiChat';
import { systemDialog } from '@/lib/systemDialog';
import { getAdminPrompts } from '@/services';
import { useLocation } from 'react-router-dom';

type LocalSession = {
  sessionId: string;
  documentId: string;
  documentTitle: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

type UiMessage = {
  id: string;
  role: 'User' | 'Assistant';
  content: string;
  groupSeq?: number;
  replyToMessageId?: string;
  resendOfMessageId?: string;
  timestamp: number;
  citations?: Array<{ headingId?: string | null; headingTitle?: string | null; excerpt?: string | null }>;
};

type PromptItem = {
  promptKey: string;
  title: string;
  order?: number;
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

function extractFirstNonEmptyLines(content: string, maxLines: number): string {
  const s = (content || '').replace(/\r\n/g, '\n');
  const lines = s.split('\n');
  const picked: string[] = [];
  for (const line of lines) {
    if (picked.length >= maxLines) break;
    if (!line.trim()) continue;
    picked.push(line.trimEnd());
  }
  return picked.join('\n');
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


  const [sessions, setSessions] = useState<LocalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('');

  const activeSession = useMemo(() => sessions.find((s) => s.sessionId === activeSessionId) ?? null, [sessions, activeSessionId]);

  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingAssistantMessageId, setStreamingAssistantMessageId] = useState<string>('');
  const abortRef = useRef<AbortController | null>(null);

  const [composer, setComposer] = useState('');
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [resendTargetMessageId, setResendTargetMessageId] = useState<string>('');

  // 提示词快捷标签
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [currentRole, setCurrentRole] = useState<'PM' | 'DEV' | 'QA'>('PM');
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
  const prdFileRef = useRef<HTMLInputElement | null>(null);

  // 附件（v1：本地读文本注入；todo4 会补齐长度控制/提示）
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingAttachmentText, setPendingAttachmentText] = useState<string>('');
  const [pendingAttachmentName, setPendingAttachmentName] = useState<string>('');


  useEffect(() => {
    if (!userId) return;
    const loaded = loadSessions(userId);
    // 最近更新优先
    loaded.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    setSessions(loaded);
    if (!activeSessionId && loaded.length > 0) setActiveSessionId(loaded[0].sessionId);
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
          .map((x: any) => ({
            promptKey: String(x.promptKey ?? '').trim(),
            title: String(x.title ?? '').trim(),
            order: typeof x.order === 'number' ? x.order : 999,
            role: String(x.role ?? '').trim().toUpperCase(),
          }))
          .filter((x) => x.promptKey && x.title && x.role === currentRole);
        // 按 order 排序
        mapped.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        setPrompts(mapped);
      })
      .catch(() => {
        // 静默失败
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, currentRole]);

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
      setMessages((prev) => {
        if (prev.some((m) => m.id === id)) return prev;
        return prev.concat({
          id,
          role: 'Assistant',
          content: '',
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
      stopStreaming();
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
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== targetId) return m;
        return { ...m, content: (m.content ?? '') + delta };
      })
    );
  };

  const sendMessage = async () => {
    const text = composer.trim();
    if (!text) return;
    if (!activeSessionId) {
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

    setPendingAttachmentText('');
    setPendingAttachmentName('');

    setMessages((prev) =>
      (resendId ? removeRoundByUserMessageId(prev, resendId) : prev).concat({
        id: `user-${Date.now()}`,
        role: 'User',
        content: finalText,
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
        body: JSON.stringify({ content: finalText }),
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
      res = await uploadAiChatDocument({ content });
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
    if (!sid) {
      await systemDialog.alert('后端未返回 sessionId');
      return;
    }

    // 生成一个更像人话的标题：
    // 1) fileName + 前三行 -> 意图模型建议名
    // 2) Markdown 一级标题
    // 3) 后端解析出来的 document.title（若非“未命名”）
    // 4) 文件名（去扩展名、归一化；若不“无意义”）
    // 5) 会话短 id 兜底
    const fileName = normalizeFileName(prdFileName);
    const snippet = extractFirstNonEmptyLines(content, 3).slice(0, 800);
    const mdTitle = extractMarkdownTitle(content);
    const docTitle = docTitleRaw.trim();
    const fileBase = normalizeCandidateName(stripFileExtension(fileName));

    let suggestedTitle = '';
    if (snippet) {
      try {
        const sres = await suggestGroupName({ fileName: fileName || null, snippet });
        if (sres.success) suggestedTitle = String(sres.data?.name ?? '').trim();
      } catch {
        // ignore: fallback below
      }
    }

    const finalTitle =
      (!isPlaceholderTitle(suggestedTitle) ? suggestedTitle : '') ||
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
    setMessages([]);
    saveMessages(userId, sid, []);
    setCreateOpen(false);
    setPrdText('');
    setPrdFileName('');
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

  const chatPanel = (
    <Card className="h-full min-h-0 overflow-hidden">
      <div className="h-full min-h-0 flex flex-col">
        <div className="flex items-center justify-between gap-3 pb-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="min-w-0 flex items-center gap-3">
            <button
              type="button"
              className="px-3 py-1.5 rounded-[10px] text-[13px] font-semibold hover:bg-white/5 transition-colors truncate"
              style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-primary)', maxWidth: '400px' }}
              onClick={() => setCreateOpen(true)}
              disabled={!userId}
              title="点击上传新的 PRD 文档"
            >
              {activeSession?.title || activeSession?.documentTitle || '点击上传 PRD'}
            </button>
            <div className="flex gap-1.5">
              {(['PM', 'DEV', 'QA'] as const).map((role) => (
                <button
                  key={role}
                  type="button"
                  className="px-2.5 py-1 rounded-[8px] text-[11px] font-medium hover:bg-white/5 transition-colors"
                  style={{
                    border: currentRole === role ? '1px solid color-mix(in srgb, var(--accent-gold) 40%, var(--border-subtle))' : '1px solid var(--border-subtle)',
                    background: currentRole === role ? 'color-mix(in srgb, var(--accent-gold) 10%, transparent)' : 'transparent',
                    color: currentRole === role ? 'var(--accent-gold)' : 'var(--text-secondary)',
                  }}
                  onClick={() => setCurrentRole(role)}
                >
                  {role}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              className="text-[11px] px-2.5 py-1.5 rounded-[8px] hover:bg-white/5 transition-colors"
              style={{ 
                border: '1px solid var(--border-subtle)', 
                color: debugMode ? 'var(--accent-gold)' : 'var(--text-secondary)',
                background: debugMode ? 'color-mix(in srgb, var(--accent-gold) 10%, transparent)' : 'transparent'
              }}
              onClick={() => setDebugMode((v) => !v)}
            >
              调试
            </button>
            {isStreaming ? (
              <Button variant="danger" size="sm" onClick={() => stopStreaming()}>
                <Square size={16} />
                取消
              </Button>
            ) : null}
          </div>
        </div>

        <div ref={scrollRef} className="mt-3 flex-1 min-h-0 overflow-auto pr-1 space-y-3">
          {messages.length === 0 ? (
            <div className="py-20 text-center">
              <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                {activeSessionId ? '开始提问吧' : '先上传 PRD'}
              </div>
              <div className="mt-1.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
                {activeSessionId ? '这是一条临时会话，用于功能测试对话链路。' : '新建会话后会获得 sessionId，然后可进行 SSE 流式对话。'}
              </div>
            </div>
          ) : (
            messages.map((m) => {
              const isUser = m.role === 'User';
              const isThisStreaming = !isUser && !!streamingAssistantMessageId && m.id === streamingAssistantMessageId;
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
                    {isUser && !isStreaming ? (
                      <div className="pointer-events-none absolute -top-3 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
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
                        `}</style>
                        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{m.content || ''}</ReactMarkdown>
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

        <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          {/* 提示词快捷标签 */}
          {prompts.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {prompts.map((p) => {
                const isHighlighted = highlightPromptKey && p.promptKey === highlightPromptKey;
                return (
                  <button
                    key={p.promptKey}
                    type="button"
                    className="px-3 py-1.5 rounded-[10px] text-[12px] hover:bg-white/5 transition-all duration-200"
                    style={{
                      border: isHighlighted ? '1px solid color-mix(in srgb, var(--accent-gold) 50%, var(--border-subtle))' : '1px solid var(--border-subtle)',
                      background: isHighlighted ? 'color-mix(in srgb, var(--accent-gold) 12%, transparent)' : 'transparent',
                      color: isHighlighted ? 'var(--accent-gold)' : 'var(--text-secondary)',
                    }}
                    onClick={() => {
                      setComposer(p.title);
                      requestAnimationFrame(() => {
                        adjustComposerHeight();
                        composerRef.current?.focus();
                      });
                    }}
                    disabled={!activeSessionId || isStreaming}
                    title={`点击插入：${p.title}`}
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
              disabled={!activeSessionId || isStreaming}
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
                placeholder={activeSessionId ? '输入你的问题…（Enter 发送，Shift+Enter 换行）' : '请先新建会话并上传 PRD'}
                className="w-full min-w-0 min-h-[40px] resize-none rounded-[12px] px-3.5 py-2.5 text-[13px] outline-none transition-colors"
                style={{
                  background: 'rgba(0,0,0,0.15)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                }}
                rows={1}
                disabled={!activeSessionId || isStreaming}
              />

              {pendingAttachmentText ? (
                <div className="mt-1.5 flex items-center gap-2">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-[8px] px-2 py-1 text-[11px] hover:bg-white/5 transition-colors"
                    style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                    onClick={() => attachInputRef.current?.click()}
                    disabled={!activeSessionId || isStreaming}
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
              disabled={!activeSessionId || isStreaming || !composer.trim()}
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
      </div>
    </Card>
  );

  const rightPanel = chatPanel;


  return (
    <>
      {rightPanel}

      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          if (createBusy) return;
          setCreateOpen(o);
        }}
        title="新建会话：上传 PRD（.md）"
        description="上传 PRD 后将获得 sessionId，用于本页的 SSE 对话（临时会话，不走群组）。"
        maxWidth={820}
        content={
          <div className="h-full min-h-0 flex flex-col gap-4">
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
              <input
                ref={prdFileRef}
                type="file"
                accept=".md"
                className="hidden"
                onChange={async (e) => {
                  const f = e.currentTarget.files?.[0] ?? null;
                  e.currentTarget.value = '';
                  if (f) await onPickPrdFile(f);
                }}
              />
            </div>

            <textarea
              value={prdText}
              onChange={(e) => setPrdText(e.target.value)}
              className="w-full flex-1 min-h-[280px] rounded-[16px] px-4 py-3 text-sm outline-none"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
              placeholder="粘贴 Markdown PRD 内容（注意：后端会校验大小/格式，过大将返回错误）"
              disabled={createBusy}
            />

            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={createBusy}>
                取消
              </Button>
              <Button variant="primary" onClick={() => void createSession()} disabled={createBusy}>
                {createBusy ? '创建中...' : '创建会话'}
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


