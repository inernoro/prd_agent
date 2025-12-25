import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Dialog } from '@/components/ui/Dialog';
import { getAiChatHistory, suggestGroupName, uploadAiChatDocument } from '@/services';
import { useAuthStore } from '@/stores/authStore';
import type { ApiResponse } from '@/types/api';
import { readSseStream } from '@/lib/sse';
import { Maximize2, Minimize2, Paperclip, Plus, Send, Square, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AiChatStreamEvent } from '@/services/contracts/aiChat';
import ImageGenPanel from '@/pages/ai-chat/ImageGenPanel';
import AdvancedImageMasterTab from '@/pages/ai-chat/AdvancedImageMasterTab';
import { useLayoutStore } from '@/stores/layoutStore';

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
  timestamp: number;
  citations?: Array<{ headingId?: string | null; headingTitle?: string | null; excerpt?: string | null }>;
};

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

function formatTime(ts: number) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

export default function AiChatPage() {
  const authUser = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const toggleNavCollapsed = useLayoutStore((s) => s.toggleNavCollapsed);
  const navCollapsed = useLayoutStore((s) => s.navCollapsed);
  const setFullBleedMain = useLayoutStore((s) => s.setFullBleedMain);

  const userId = authUser?.userId ?? '';

  const [tab, setTab] = useState<'chat' | 'imageGen' | 'imageMaster'>('chat');

  const [sessions, setSessions] = useState<LocalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('');

  const activeSession = useMemo(() => sessions.find((s) => s.sessionId === activeSessionId) ?? null, [sessions, activeSessionId]);

  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [composer, setComposer] = useState('');
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // 新建会话（上传 PRD）
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
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

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth' });
  }, [messages, isStreaming]);

  const stopStreaming = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  };

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
      alert('未登录');
      return;
    }
    if (isStreaming) return;

    const limited = applyContentLimit({
      question: text,
      attachmentName: pendingAttachmentName,
      attachmentText: pendingAttachmentText,
    });
    if (!limited.ok) {
      alert(limited.reason || `内容过长（上限 ${MAX_MESSAGE_CHARS} 字符）`);
      return;
    }
    if (limited.truncated) {
      // 轻提示：不阻塞发送，只告知发生截断
      // 禁止 emoji
      alert('附件内容过长，已自动截断后发送');
    }
    const finalText = limited.finalText;

    setPendingAttachmentText('');
    setPendingAttachmentName('');

    setMessages((prev) =>
      prev.concat({
        id: `user-${Date.now()}`,
        role: 'User',
        content: finalText,
        timestamp: Date.now(),
      })
    );
    setComposer('');
    requestAnimationFrame(() => adjustComposerHeight());

    const ac = new AbortController();
    abortRef.current = ac;
    setIsStreaming(true);

    let res: Response;
    try {
      const url = joinUrl(getApiBaseUrl(), `/api/v1/sessions/${encodeURIComponent(activeSessionId)}/messages`);
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
      alert('仅支持 .md 文件');
      return;
    }
    const content = await file.text();
    setPrdFileName(file.name);
    setPrdText(content);
  };

  const createSession = async () => {
    const content = prdText.trim();
    if (!content) return alert('请粘贴或选择 PRD 内容');
    if (!userId) return alert('未登录');

    setCreateBusy(true);
    let res: ApiResponse<any>;
    try {
      res = await uploadAiChatDocument({ content });
    } finally {
      setCreateBusy(false);
    }
    if (!res.success) {
      alert(res.error?.message || '上传失败');
      return;
    }

    const sid = String(res.data.sessionId || '');
    const docId = String(res.data.document?.id || '');
    const docTitleRaw = String(res.data.document?.title || '');
    if (!sid) {
      alert('后端未返回 sessionId');
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

  const renameSession = (sid: string) => {
    const cur = sessions.find((x) => x.sessionId === sid);
    const nextName = window.prompt('会话名称', cur?.title || '');
    if (nextName == null) return;
    const name = nextName.trim();
    setSessions((prev) => {
      const next = prev.map((x) => (x.sessionId === sid ? { ...x, title: name || x.title, updatedAt: Date.now() } : x));
      saveSessions(userId, next);
      return next;
    });
  };

  const deleteSession = (sid: string) => {
    const ok = window.confirm('确认删除该会话（仅删除本地记录）？');
    if (!ok) return;
    stopStreaming();
    setSessions((prev) => {
      const next = prev.filter((x) => x.sessionId !== sid);
      saveSessions(userId, next);
      return next;
    });
    try {
      localStorage.removeItem(storageKeyMessages(userId, sid));
    } catch {
      // ignore
    }
    if (activeSessionId === sid) {
      setActiveSessionId('');
      setMessages([]);
    }
  };

  const pickAttachment = async (file: File | null) => {
    if (!file) return;
    const fileName = normalizeFileName(file.name || '');
    const ext = getLowerExt(fileName);
    if (ext && !ALLOWED_TEXT_EXTS.includes(ext)) {
      alert(`暂仅支持文本附件：${ALLOWED_TEXT_EXTS.join(', ')}`);
      return;
    }

    let text = '';
    try {
      text = await file.text();
    } catch {
      alert('读取文件失败，请重试');
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

  const leftPanel = (
    <div className="w-[340px] shrink-0 min-h-0 flex flex-col gap-4">
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              临时会话
            </div>
            <div className="mt-1 text-xs truncate" style={{ color: 'var(--text-muted)' }}>
              上传 PRD → sessionId → 对话（功能测试向）
            </div>
          </div>
          <Button variant="primary" size="sm" className="shrink-0" onClick={() => setCreateOpen(true)} disabled={!userId}>
            <Plus size={16} />
            新建
          </Button>
        </div>
      </Card>

      <Card className="flex-1 min-h-0 overflow-hidden">
        <div className="h-full min-h-0 flex flex-col">
          <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
            会话列表（本地）
          </div>
          <div className="flex-1 min-h-0 overflow-auto pr-1 space-y-2">
            {sessions.length === 0 ? (
              <div className="py-10 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                暂无会话，请先新建并上传 PRD
              </div>
            ) : (
              sessions.map((s) => {
                const active = s.sessionId === activeSessionId;
                const displayTitle =
                  (!isPlaceholderTitle(s.title) ? s.title.trim() : '') ||
                  (!isPlaceholderTitle(s.documentTitle) ? s.documentTitle.trim() : '') ||
                  `会话 ${s.sessionId.slice(0, 8)}`;
                return (
                  <div
                    key={s.sessionId}
                    className="rounded-[14px] p-3"
                    style={{
                      border: active ? '1px solid var(--border-default)' : '1px solid var(--border-subtle)',
                      background: active ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
                    }}
                  >
                    <button type="button" className="w-full text-left" onClick={() => setActiveSessionId(s.sessionId)}>
                      <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {displayTitle}
                      </div>
                      <div className="mt-1 text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                        {s.sessionId}
                      </div>
                      <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {formatTime(s.updatedAt || s.createdAt)}
                      </div>
                    </button>
                    <div className="mt-2 flex gap-2">
                      <Button size="xs" variant="secondary" onClick={() => renameSession(s.sessionId)}>
                        重命名
                      </Button>
                      <Button size="xs" variant="danger" onClick={() => deleteSession(s.sessionId)}>
                        删除
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </Card>
    </div>
  );

  const chatPanel = (
    <Card className="flex-1 min-h-0 overflow-hidden">
      <div className="h-full min-h-0 flex flex-col">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {activeSession?.title || activeSession?.documentTitle || '未选择会话'}
            </div>
            <div className="mt-1 text-xs truncate" style={{ color: 'var(--text-muted)' }}>
              {activeSessionId ? `sessionId: ${activeSessionId}` : '请先新建会话并上传 PRD'}
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            {isStreaming ? (
              <Button variant="danger" size="sm" onClick={() => stopStreaming()}>
                <Square size={16} />
                取消
              </Button>
            ) : null}
          </div>
        </div>

        <div ref={scrollRef} className="mt-4 flex-1 min-h-0 overflow-auto pr-1 space-y-3">
          {messages.length === 0 ? (
            <div className="py-14 text-center">
              <div className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                {activeSessionId ? '开始提问吧' : '先上传 PRD'}
              </div>
              <div className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                {activeSessionId ? '这是一条临时会话，用于功能测试对话链路。' : '新建会话后会获得 sessionId，然后可进行 SSE 流式对话。'}
              </div>
            </div>
          ) : (
            messages.map((m) => {
              const isUser = m.role === 'User';
              return (
                <div key={m.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className="max-w-[82%] rounded-[16px] px-4 py-3"
                    style={{
                      background: isUser ? 'color-mix(in srgb, var(--accent-gold) 28%, rgba(255,255,255,0.02))' : 'rgba(255,255,255,0.04)',
                      border: '1px solid var(--border-subtle)',
                      color: 'var(--text-primary)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {isUser ? (
                      <div className="text-sm whitespace-pre-wrap">{m.content}</div>
                    ) : (
                      <div className="text-sm">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content || ''}</ReactMarkdown>
                      </div>
                    )}
                    {Array.isArray(m.citations) && m.citations.length > 0 ? (
                      <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                        <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
                          依据（引用）
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {m.citations.slice(0, 12).map((c, idx) => (
                            <span
                              key={`${c.headingId || c.headingTitle || 'c'}-${idx}`}
                              className="inline-flex items-center rounded-full px-2 py-1 text-[11px]"
                              style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.02)' }}
                              title={c.excerpt || c.headingTitle || c.headingId || ''}
                            >
                              {(c.headingTitle || c.headingId || '引用').slice(0, 40)}
                            </span>
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

        {/* 输入框：参照你给的“多能力输入框”布局（v1 仅接文件附件+跳转图片创作） */}
        <div className="mt-4 rounded-[20px] p-3" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.03)' }}>
          <div className="flex items-end gap-3">
            <button
              type="button"
              className="h-10 w-10 inline-flex items-center justify-center rounded-[14px] hover:bg-white/5"
              style={{ border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-secondary)' }}
              onClick={() => attachInputRef.current?.click()}
              title="添加附件（v1：读取为文本）"
              disabled={!activeSessionId || isStreaming}
            >
              <Plus size={18} />
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
                className="w-full min-w-0 min-h-[44px] resize-none rounded-[16px] px-4 py-3 text-sm outline-none"
                style={{
                  background: 'rgba(0,0,0,0.18)',
                  border: '1px solid rgba(255,255,255,0.10)',
                  color: 'var(--text-primary)',
                }}
                rows={1}
                disabled={!activeSessionId || isStreaming}
              />

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] hover:bg-white/5"
                  style={{ border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-secondary)' }}
                  onClick={() => attachInputRef.current?.click()}
                  disabled={!activeSessionId || isStreaming}
                  title="文件附件（v1：读取为文本注入）"
                >
                  <Paperclip size={14} />
                  文件附件
                  {pendingAttachmentText ? (
                    <span className="ml-1" style={{ color: 'var(--text-muted)' }}>
                      （已选）
                    </span>
                  ) : null}
                </button>

                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] hover:bg-white/5"
                  style={{ border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-secondary)' }}
                  onClick={() => setTab('imageGen')}
                  title="图片创作（跳转到同页 Tab）"
                >
                  <Sparkles size={14} />
                  图片创作
                </button>

                {pendingAttachmentText ? (
                  <span className="text-[12px] truncate" style={{ color: 'var(--text-muted)' }} title={pendingAttachmentName}>
                    附件：{pendingAttachmentName || 'unknown'}
                  </span>
                ) : null}
              </div>
            </div>

            <Button
              variant="primary"
              className="h-10 w-10 px-0! rounded-[999px]!"
              onClick={() => void sendMessage()}
              disabled={!activeSessionId || isStreaming || !composer.trim()}
              title="发送"
            >
              <Send size={18} />
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

  const rightPanel = (
    <div className="flex-1 min-h-0 flex flex-col gap-4 relative">
      {/* 顶部 Tab：专注模式下不占布局，避免压缩画布高度 */}
      {tab === 'imageMaster' && navCollapsed ? (
        <div className="absolute left-0 top-0 z-30" style={{ paddingLeft: 12, paddingTop: 12 }}>
          <button
            type="button"
            className="h-10 w-10 rounded-full inline-flex items-center justify-center"
            style={{
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(0,0,0,0.28)',
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)',
              boxShadow: '0 18px 60px rgba(0,0,0,0.45)',
              color: 'var(--text-secondary)',
            }}
            onClick={() => toggleNavCollapsed()}
            aria-label="还原布局"
            title="还原布局"
          >
            <Minimize2 size={18} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 shrink-0">
          <Button variant={tab === 'chat' ? 'primary' : 'secondary'} onClick={() => setTab('chat')}>
            初级对话交互
          </Button>
          <Button variant={tab === 'imageGen' ? 'primary' : 'secondary'} onClick={() => setTab('imageGen')}>
            中级图片绘制
          </Button>
          <Button variant={tab === 'imageMaster' ? 'primary' : 'secondary'} onClick={() => setTab('imageMaster')}>
            高级视觉创作
          </Button>
          {tab === 'imageMaster' ? (
            <button
              type="button"
              className="h-10 w-10 rounded-full inline-flex items-center justify-center"
              style={{
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.06)',
                color: 'var(--text-secondary)',
              }}
              onClick={() => toggleNavCollapsed()}
              aria-label={navCollapsed ? '还原布局' : '最大化'}
              title={navCollapsed ? '还原布局' : '最大化'}
            >
              {navCollapsed ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
          ) : null}
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col">
        {tab === 'chat' ? chatPanel : tab === 'imageGen' ? <ImageGenPanel /> : <AdvancedImageMasterTab />}
      </div>
    </div>
  );

  // 专注模式：同时开启 full-bleed 主内容区（跳出 AppShell 的 max-width 框架）
  // 仅在 高级视觉创作 + 已折叠导航 时启用
  useEffect(() => {
    const on = tab === 'imageMaster' && navCollapsed;
    setFullBleedMain(on);
    return () => setFullBleedMain(false);
  }, [navCollapsed, setFullBleedMain, tab]);

  return (
    <div className="h-full min-h-0 flex gap-4">
      {tab === 'chat' ? leftPanel : null}
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
    </div>
  );
}


