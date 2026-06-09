import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileText,
  Globe,
  X,
  ChevronLeft,
  ChevronRight,
  Wand2,
  Send,
  Plus,
  Upload,
  BookOpen,
  Bot,
  Zap,
  ChevronDown,
  Check,
  AlertCircle,
  RotateCcw,
} from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  type MdToPptDiagEvent,
  type MdToPptEngine,
  type OutlineSlide,
  streamMdToPptConvert,
  streamMdToPptPatch,
  publishMdToPpt,
  getMdToPptRun,
  getMdToPptOutline,
} from '@/services/real/mdToPptService';
import { apiRequest } from '@/services/real/apiClient';

// ─── Types ───────────────────────────────────────────────────────────────────

type ChatRole = 'user' | 'assistant';

interface Attachment {
  name: string;
  content: string;
}

interface KbRef {
  storeName: string;
  entryTitle: string;
  content: string;
}

type MsgPhase = 'outline' | 'generating' | 'done' | 'error' | 'patching' | 'text';

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  phase?: MsgPhase;
  outline?: OutlineSlide[];
  totalPages?: number;
  summary?: string;
  runId?: string;
  attachments?: Attachment[];
  kbRefs?: KbRef[];
  error?: string;
}

interface SessionState {
  messages: ChatMessage[];
  activeRunId: string;
  theme: string;
  engine: MdToPptEngine;
}

interface KbStore {
  id: string;
  name: string;
  documentCount: number;
}

interface KbEntry {
  id: string;
  title: string;
  summary?: string;
  contentType: string;
}

const SESSION_KEY = 'md-to-ppt-chat-v1';

const THEME_OPTIONS = [
  { value: 'dark-glass', label: '深色玻璃' },
  { value: 'light-clean', label: '浅色简洁' },
  { value: 'gradient-purple', label: '紫色渐变' },
  { value: 'corporate-blue', label: '商务蓝' },
  { value: 'warm-earth', label: '暖色大地' },
];

// 按内容长度估算页数（约 700 字/页，夹在 4~20 页）
function estimatePages(content: string): number {
  const len = content.trim().length;
  if (len === 0) return 8;
  return Math.max(4, Math.min(20, Math.round(len / 700)));
}

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// 校验是否为有效 PPT HTML
function looksLikeDeck(html: string): boolean {
  if (!html || html.length < 200) return false;
  const low = html.toLowerCase();
  if (!low.includes('<!doctype html') && !low.includes('<html')) return false;
  if (low.includes('id="root"')) return false;
  return low.includes('reveal') || low.includes('<section');
}

// ─── 安全 iframe 渲染（P1 安全债偿还）─────────────────────────────────────────
//
// 旧方案：sandbox="allow-scripts allow-same-origin" + nav-guard 注入
//   风险：same-origin + allow-scripts 让生成 HTML 以本管理后台同源运行，
//         prompt-injection 出的 <script> 能读 auth token / 冒用用户身份调 API。
//
// 新方案（本次实现）：sandbox="allow-scripts"（opaque origin）+ storage shim
//   - 去掉 allow-same-origin → iframe 得到 opaque origin，天然与主应用源隔离，
//     无法读取主应用的 localStorage/sessionStorage/cookie/IndexedDB。
//   - 注入 in-memory storage shim → 替换 window.localStorage/sessionStorage，
//     避免 reveal.js init 访问 storage 时抛错导致整页空白。
//   - 注入 nav-guard（保留）→ 阻止生成 HTML 中的链接把 iframe 导航到主应用。
//
// 验收口径：生成含 <script>fetch(...localStorage...)</script> 的 deck，
//   确认脚本拿不到主应用 token、不能以用户身份调 API，且 reveal 仍正常渲染可翻页。
function prepareIframeHtml(html: string): string {
  if (!html) return html;

  // 1. in-memory storage shim（遮蔽 opaque origin 下 reveal 对 storage 的访问）
  // 所有 \u 转义，源码内不出现任何 emoji 字面量（CLAUDE 规则 #0）
  const storageshim =
    '<script>' +
    '(function(){' +
    'var m={};' +
    'var s={' +
    'getItem:function(k){return m.hasOwnProperty(k)?m[k]:null;},' +
    'setItem:function(k,v){m[k]=String(v);},' +
    'removeItem:function(k){delete m[k];},' +
    'clear:function(){m={};},' +
    'key:function(i){return Object.keys(m)[i]||null;},' +
    'get length(){return Object.keys(m).length;}' +
    '};' +
    'try{Object.defineProperty(window,"localStorage",{get:function(){return s;},configurable:true});}catch(e){}' +
    'try{Object.defineProperty(window,"sessionStorage",{get:function(){return s;},configurable:true});}catch(e){}' +
    '})();' +
    '</script>';

  // 2. nav-guard（阻止 reveal 内链接把 iframe 导航到主应用）
  const navguard =
    '<script>(function(){try{' +
    'var n=function(){return null;};' +
    'try{history.pushState=n;history.replaceState=n;}catch(e){}' +
    "document.addEventListener('click',function(e){var t=e.target;while(t&&t!==document){if(t.tagName==='A'){var h=t.getAttribute('href')||'';if(h&&h.charAt(0)!=='#'){e.preventDefault();e.stopPropagation();}break;}t=t.parentNode;}},true);" +
    '}catch(e){}})();</script>';

  const inject = storageshim + navguard;

  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + inject);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + inject);
  return inject + html;
}

// 生成阶段提示文案
function genStageMsg(sec: number, isPatch: boolean): string {
  if (isPatch)
    return sec < 8 ? '正在理解修改指令...' : sec < 25 ? '正在重排指定页面...' : '正在收尾排版...';
  if (sec < 5) return '正在分析内容结构...';
  if (sec < 18) return '正在设计版式与配色...';
  if (sec < 38) return '正在逐页生成幻灯片...';
  if (sec < 60) return '正在排版与收尾...';
  return '内容较多，正在精修中（大模型生成约需 1 分钟）...';
}

// 读取 sessionStorage（安全）
function loadSession(): SessionState | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

function saveSession(s: SessionState): void {
  try {
    // 不持久化 HTML 到 sessionStorage（太大），只存消息和 runId
    const toSave: SessionState = {
      ...s,
      messages: s.messages.map((m) => ({ ...m, outline: m.outline })),
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(toSave));
  } catch {
    /* ignore quota errors */
  }
}

// ─── KB 选择迷你弹层 ──────────────────────────────────────────────────────────

interface KbPickerProps {
  onClose: () => void;
  onSelect: (ref: KbRef) => void;
}

function KbPicker({ onClose, onSelect }: KbPickerProps) {
  const [stores, setStores] = useState<KbStore[]>([]);
  const [selectedStore, setSelectedStore] = useState<KbStore | null>(null);
  const [entries, setEntries] = useState<KbEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [entryLoading, setEntryLoading] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiRequest<{ items: KbStore[] }>('/api/document-store/stores?pageSize=50')
      .then((res) => {
        if (res.success && res.data) setStores(res.data.items ?? []);
      })
      .finally(() => setLoading(false));
  }, []);

  const openStore = useCallback(async (store: KbStore) => {
    setSelectedStore(store);
    setLoading(true);
    const res = await apiRequest<{ items: KbEntry[] }>(
      `/api/document-store/stores/${encodeURIComponent(store.id)}/entries?pageSize=200&all=true`
    );
    if (res.success && res.data) setEntries(res.data.items ?? []);
    setLoading(false);
  }, []);

  const pickEntry = useCallback(
    async (entry: KbEntry) => {
      if (!selectedStore) return;
      setEntryLoading(entry.id);
      const res = await apiRequest<{ content: string | null; title: string }>(
        `/api/document-store/entries/${encodeURIComponent(entry.id)}/content`
      );
      setEntryLoading(null);
      if (res.success && res.data) {
        onSelect({
          storeName: selectedStore.name,
          entryTitle: res.data.title || entry.title,
          content: res.data.content ?? '',
        });
      }
    },
    [selectedStore, onSelect]
  );

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-80 rounded-xl border border-white/10 bg-[var(--bg-elevated)] shadow-xl"
        style={{ maxHeight: '70vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-white/8">
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            {selectedStore ? selectedStore.name : '选择知识库'}
          </span>
          <button
            onClick={onClose}
            className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
          >
            <X size={14} />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {loading && (
            <div className="flex justify-center py-6">
              <MapSpinner size={16} />
            </div>
          )}

          {!loading && !selectedStore &&
            stores.map((st) => (
              <button
                key={st.id}
                onClick={() => void openStore(st)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/4 border-b border-white/5 text-left"
              >
                <BookOpen size={14} className="shrink-0 text-blue-400" />
                <div>
                  <div className="text-xs font-medium text-[var(--text-primary)]">{st.name}</div>
                  <div className="text-[10px] text-[var(--text-tertiary)]">
                    {st.documentCount} 篇文档
                  </div>
                </div>
              </button>
            ))}

          {!loading &&
            selectedStore &&
            entries.map((entry) => (
              <button
                key={entry.id}
                onClick={() => void pickEntry(entry)}
                disabled={entryLoading === entry.id}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/4 border-b border-white/5 text-left disabled:opacity-50"
              >
                {entryLoading === entry.id ? (
                  <MapSpinner size={12} />
                ) : (
                  <FileText size={12} className="shrink-0 text-[var(--text-tertiary)]" />
                )}
                <div className="min-w-0">
                  <div className="text-xs text-[var(--text-primary)] truncate">{entry.title}</div>
                  {entry.summary && (
                    <div className="text-[10px] text-[var(--text-tertiary)] truncate">
                      {entry.summary}
                    </div>
                  )}
                </div>
              </button>
            ))}

          {!loading && selectedStore && entries.length === 0 && (
            <div className="py-6 text-center text-xs text-[var(--text-tertiary)]">
              该知识库暂无文档
            </div>
          )}
        </div>

        {selectedStore && (
          <div className="shrink-0 px-4 py-2 border-t border-white/8">
            <button
              onClick={() => { setSelectedStore(null); setEntries([]); }}
              className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              返回知识库列表
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Outline 确认气泡内容 ──────────────────────────────────────────────────────

interface OutlineBubbleProps {
  msg: ChatMessage;
  onConfirm: (msg: ChatMessage) => void;
  onAdjust: (msg: ChatMessage, instruction: string) => void;
  disabled: boolean;
}

function OutlineBubble({ msg, onConfirm, onAdjust, disabled }: OutlineBubbleProps) {
  const [adjustText, setAdjustText] = useState('');
  const [showAdjust, setShowAdjust] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      {msg.summary && (
        <p className="text-xs text-[var(--text-secondary)]">{msg.summary}</p>
      )}
      <div className="text-[10px] text-[var(--text-tertiary)] mb-1">
        建议 {msg.totalPages ?? msg.outline?.length ?? 0} 页大纲：
      </div>
      <div className="flex flex-col gap-1.5">
        {(msg.outline ?? []).map((slide, i) => (
          <div
            key={i}
            className="rounded-md bg-white/4 border border-white/6 px-2.5 py-1.5"
          >
            <div className="text-[11px] font-semibold text-[var(--text-primary)] mb-0.5">
              {i + 1}. {slide.title}
            </div>
            {slide.bullets.length > 0 && (
              <ul className="space-y-0.5">
                {slide.bullets.map((b, j) => (
                  <li key={j} className="text-[10px] text-[var(--text-tertiary)] pl-2">
                    - {b}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {showAdjust && (
        <div className="flex gap-1.5 mt-1">
          <input
            type="text"
            value={adjustText}
            onChange={(e) => setAdjustText(e.target.value)}
            placeholder="调整说明，如：把第3页改成竞品分析"
            className="flex-1 text-xs bg-white/5 text-[var(--text-primary)] placeholder-[var(--text-tertiary)] border border-white/10 rounded-md px-2 py-1.5 outline-none focus:border-purple-500/40"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && adjustText.trim()) {
                onAdjust(msg, adjustText.trim());
                setAdjustText('');
                setShowAdjust(false);
              }
            }}
          />
          <button
            disabled={!adjustText.trim() || disabled}
            onClick={() => {
              if (adjustText.trim()) {
                onAdjust(msg, adjustText.trim());
                setAdjustText('');
                setShowAdjust(false);
              }
            }}
            className="px-2 py-1 rounded-md bg-white/6 text-[10px] text-[var(--text-secondary)] hover:bg-white/10 disabled:opacity-40"
          >
            调整
          </button>
        </div>
      )}

      <div className="flex gap-2 mt-1">
        <button
          onClick={() => onConfirm(msg)}
          disabled={disabled}
          className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 border border-purple-500/25 disabled:opacity-40"
        >
          <Check size={11} />
          确认，生成 PPT
        </button>
        <button
          onClick={() => setShowAdjust((v) => !v)}
          disabled={disabled}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs bg-white/5 text-[var(--text-secondary)] hover:bg-white/8 border border-white/8 disabled:opacity-40"
        >
          调整大纲
        </button>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function MdToPptAgentPage() {
  // ─── Global settings (收进设置区，不占对话空间）
  const [theme, setTheme] = useState('dark-glass');
  const [engine, setEngine] = useState<MdToPptEngine>('map');
  const [showSettings, setShowSettings] = useState(false);

  // ─── Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // ─── Artifact state（右侧）
  const [generatedHtml, setGeneratedHtml] = useState('');
  const [activeRunId, setActiveRunId] = useState('');
  const [publishedUrl, setPublishedUrl] = useState('');
  const [isPublishing, setIsPublishing] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [artifactPhase, setArtifactPhase] = useState<'idle' | 'outlining' | 'generating' | 'patching' | 'done'>('idle');
  const [diagLines, setDiagLines] = useState<MdToPptDiagEvent[]>([]);

  // ─── Attachments & KB
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [pendingKbRefs, setPendingKbRefs] = useState<KbRef[]>([]);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [showKbPicker, setShowKbPicker] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ─── Elapsed timer for artifact progress
  useEffect(() => {
    if (artifactPhase === 'generating' || artifactPhase === 'patching') {
      setElapsedSec(0);
      const t = window.setInterval(() => setElapsedSec((s) => s + 1), 1000);
      return () => window.clearInterval(t);
    } else {
      setElapsedSec(0);
    }
  }, [artifactPhase]);

  // ─── Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ─── Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  // ─── Session persistence: load on mount
  useEffect(() => {
    const saved = loadSession();
    if (!saved) return;

    setTheme(saved.theme ?? 'dark-glass');
    setEngine(saved.engine ?? 'map');
    setMessages(saved.messages ?? []);

    // 如果有 activeRunId，尝试重连拉取 HTML
    const runId = saved.activeRunId;
    if (!runId) return;

    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      const run = await getMdToPptRun(runId);
      if (cancelled) return;
      if (!run) return;
      if (run.status === 'done' && run.html) {
        setGeneratedHtml(run.html);
        setActiveRunId(runId);
        setArtifactPhase('done');
      } else if (run.status === 'running') {
        setArtifactPhase('generating');
        timer = window.setTimeout(poll, 3000);
      }
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // ─── Session persistence: save on state change
  useEffect(() => {
    saveSession({ messages, activeRunId, theme, engine });
  }, [messages, activeRunId, theme, engine]);

  // ─── Nav: translate page
  const deckNav = useCallback((dir: 'prev' | 'next') => {
    try {
      const w = iframeRef.current?.contentWindow as unknown as {
        Reveal?: Record<string, () => void>;
      };
      if (w?.Reveal && typeof w.Reveal[dir] === 'function') w.Reveal[dir]();
    } catch {
      /* opaque origin: cannot access contentWindow — use postMessage if needed */
    }
  }, []);

  // ─── Add message helper
  const pushMsg = useCallback(
    (msg: Omit<ChatMessage, 'id'>): ChatMessage => {
      const full: ChatMessage = { ...msg, id: genId() };
      setMessages((prev) => [...prev, full]);
      return full;
    },
    []
  );

  const updateLastAssistantMsg = useCallback((update: Partial<ChatMessage>) => {
    setMessages((prev) => {
      const last = [...prev].reverse().find((m) => m.role === 'assistant');
      if (!last) return prev;
      return prev.map((m) => (m.id === last.id ? { ...m, ...update } : m));
    });
  }, []);

  // ─── File attachment
  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = '';
      const content = await file.text();
      setPendingAttachments((prev) => [...prev, { name: file.name, content }]);
      setShowPlusMenu(false);
    },
    []
  );

  // ─── KB pick callback
  const handleKbSelect = useCallback((ref: KbRef) => {
    setPendingKbRefs((prev) => [...prev, ref]);
    setShowKbPicker(false);
  }, []);

  // ─── Remove attachment / KB ref
  const removeAttachment = useCallback((idx: number) => {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const removeKbRef = useCallback((idx: number) => {
    setPendingKbRefs((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // ─── Outline flow
  const requestOutline = useCallback(
    async (userText: string, attachments: Attachment[], kbRefs: KbRef[]) => {
      setIsProcessing(true);
      setArtifactPhase('outlining');
      setDiagLines([]);

      const attachmentText = attachments.map((a) => `## 附件：${a.name}\n\n${a.content}`).join('\n\n');
      const kbContext = kbRefs.map((r) => `## 知识库「${r.storeName}」>「${r.entryTitle}」\n\n${r.content}`).join('\n\n');

      // 历史摘要：只取最近 3 轮用户消息
      const historyMsgs = messages.filter((m) => m.role === 'user').slice(-3);
      const chatHistory = historyMsgs.map((m) => `用户: ${m.content}`).join('\n');

      const targetPages = estimatePages(userText + attachmentText + kbContext);

      const assistantMsg = pushMsg({
        role: 'assistant',
        content: '正在规划大纲...',
        phase: 'outline',
      });

      const result = await getMdToPptOutline({
        content: userText,
        attachmentText: attachmentText || undefined,
        kbContext: kbContext || undefined,
        chatHistory: chatHistory || undefined,
        targetPages,
      });

      if (!result.success) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, content: '大纲生成失败：' + result.error, phase: 'error', error: result.error }
              : m
          )
        );
        setIsProcessing(false);
        setArtifactPhase('idle');
        return;
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? {
                ...m,
                content: '大纲已生成，请确认后生成 PPT：',
                phase: 'outline',
                outline: result.data.outline,
                totalPages: result.data.totalPages,
                summary: result.data.summary,
              }
            : m
        )
      );

      setIsProcessing(false);
      setArtifactPhase('idle');
    },
    [messages, pushMsg]
  );

  // ─── Convert flow（确认大纲后执行）
  const startConvert = useCallback(
    (outlineMsg: ChatMessage) => {
      if (isProcessing) return;

      // 找对应的用户消息（大纲消息之前最近的 user 消息）
      const msgIdx = messages.findIndex((m) => m.id === outlineMsg.id);
      const userMsg = [...messages.slice(0, msgIdx)].reverse().find((m) => m.role === 'user');
      const userContent = userMsg?.content ?? '';
      const attachmentText = (userMsg?.attachments ?? [])
        .map((a) => `## 附件：${a.name}\n\n${a.content}`)
        .join('\n\n');
      const kbContext = (userMsg?.kbRefs ?? [])
        .map((r) => `## KB「${r.storeName}」>「${r.entryTitle}」\n\n${r.content}`)
        .join('\n\n');

      // 大纲结构注入
      const outlineText = (outlineMsg.outline ?? [])
        .map((s, i) => `${i + 1}. ${s.title}\n${s.bullets.map((b) => `   - ${b}`).join('\n')}`)
        .join('\n');

      const fullContent =
        [userContent, attachmentText, kbContext]
          .filter(Boolean)
          .join('\n\n---\n\n')
          .trim() +
        (outlineText ? `\n\n---\n\n## 大纲结构（请严格按此页数和标题生成）\n\n${outlineText}` : '');

      setIsProcessing(true);
      setArtifactPhase('generating');
      setPublishedUrl('');

      const genMsg = pushMsg({
        role: 'assistant',
        content: '正在生成 PPT...',
        phase: 'generating',
      });

      const cleanup = streamMdToPptConvert({
        content: fullContent,
        theme,
        slideCount: outlineMsg.totalPages,
        engine,
        onRun: (runId) => {
          if (runId) setActiveRunId(runId);
          try {
            sessionStorage.setItem(SESSION_KEY + '-run', runId);
          } catch { /* ignore */ }
        },
        onModel: () => {},
        onDiag: (d) => setDiagLines((prev) => [...prev, d]),
        onDelta: () => {},
        onDone: (result) => {
          const html = result.html;
          if (!looksLikeDeck(html)) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === genMsg.id
                  ? { ...m, content: '生成结果异常，未得到有效 PPT，请重试。', phase: 'error' }
                  : m
              )
            );
            setIsProcessing(false);
            setArtifactPhase('idle');
            return;
          }
          setGeneratedHtml(html);
          setArtifactPhase('done');
          setIsProcessing(false);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === genMsg.id
                ? {
                    ...m,
                    content: 'PPT 已生成！你可以继续对话精修，例如：「第3页改两栏对比」「整体换商务蓝」「加一页讲 ROI」',
                    phase: 'done',
                  }
                : m
            )
          );
        },
        onError: (err) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === genMsg.id
                ? { ...m, content: '生成失败：' + err, phase: 'error', error: err }
                : m
            )
          );
          setIsProcessing(false);
          setArtifactPhase('idle');
        },
      });

      cleanupRef.current = cleanup;
    },
    [isProcessing, messages, pushMsg, theme, engine]
  );

  // ─── Patch flow（对话式精修）
  const startPatch = useCallback(
    (instruction: string) => {
      if (!generatedHtml || isProcessing) return;

      setIsProcessing(true);
      setArtifactPhase('patching');

      const patchMsg = pushMsg({
        role: 'assistant',
        content: '正在修改 PPT...',
        phase: 'patching',
      });

      const cleanup = streamMdToPptPatch({
        currentHtml: generatedHtml,
        slideRequest: instruction,
        engine,
        onRun: (runId) => {
          if (runId) setActiveRunId(runId);
        },
        onModel: () => {},
        onDiag: (d) => setDiagLines((prev) => [...prev, d]),
        onDelta: () => {},
        onDone: (result) => {
          const html = result.html;
          if (!looksLikeDeck(html)) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === patchMsg.id
                  ? { ...m, content: '修改结果异常，请重试。', phase: 'error' }
                  : m
              )
            );
            setIsProcessing(false);
            setArtifactPhase('done');
            return;
          }
          setGeneratedHtml(html);
          setArtifactPhase('done');
          setIsProcessing(false);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === patchMsg.id
                ? { ...m, content: '已更新，右侧预览已刷新。继续告诉我你想修改什么。', phase: 'done' }
                : m
            )
          );
        },
        onError: (err) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === patchMsg.id
                ? { ...m, content: '修改失败：' + err, phase: 'error', error: err }
                : m
            )
          );
          setIsProcessing(false);
          setArtifactPhase('done');
        },
      });

      cleanupRef.current = cleanup;
    },
    [generatedHtml, isProcessing, pushMsg, engine]
  );

  // ─── Outline adjust（调整大纲后重新请求）
  const adjustOutline = useCallback(
    (outlineMsg: ChatMessage, instruction: string) => {
      if (isProcessing) return;

      // 找对应的用户消息
      const msgIdx = messages.findIndex((m) => m.id === outlineMsg.id);
      const userMsg = [...messages.slice(0, msgIdx)].reverse().find((m) => m.role === 'user');
      const userContent = userMsg?.content ?? '';

      // 追加一条用户消息
      pushMsg({ role: 'user', content: instruction });

      void requestOutline(userContent + '\n\n调整要求：' + instruction, [], []);
    },
    [isProcessing, messages, pushMsg, requestOutline]
  );

  // ─── Main send handler
  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isProcessing) return;

    const atts = [...pendingAttachments];
    const kbs = [...pendingKbRefs];
    setInput('');
    setPendingAttachments([]);
    setPendingKbRefs([]);
    setShowPlusMenu(false);

    pushMsg({
      role: 'user',
      content: text,
      attachments: atts.length > 0 ? atts : undefined,
      kbRefs: kbs.length > 0 ? kbs : undefined,
    });

    // 决策：如果已有 HTML → patch；否则 → 请求大纲
    if (generatedHtml) {
      // 对话精修模式
      startPatch(text);
    } else {
      // 初次生成：大纲先行
      void requestOutline(text, atts, kbs);
    }
  }, [input, isProcessing, pendingAttachments, pendingKbRefs, generatedHtml, pushMsg, startPatch, requestOutline]);

  // ─── Publish
  const handlePublish = useCallback(async () => {
    if (!generatedHtml) return;
    setIsPublishing(true);
    const result = await publishMdToPpt({
      htmlContent: generatedHtml,
      title: 'PPT 演示',
    });
    setIsPublishing(false);
    if (result.success && result.siteUrl) {
      setPublishedUrl(result.siteUrl);
    }
  }, [generatedHtml]);

  // ─── Abort
  const handleAbort = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setIsProcessing(false);
    setArtifactPhase(generatedHtml ? 'done' : 'idle');
    updateLastAssistantMsg({ content: '已中止。', phase: 'text' });
  }, [generatedHtml, updateLastAssistantMsg]);

  // ─── Reset
  const handleReset = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setMessages([]);
    setGeneratedHtml('');
    setActiveRunId('');
    setPublishedUrl('');
    setIsProcessing(false);
    setArtifactPhase('idle');
    setPendingAttachments([]);
    setPendingKbRefs([]);
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }, []);

  const isStreaming = artifactPhase === 'generating' || artifactPhase === 'patching';

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-white/8">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-purple-500/15 flex items-center justify-center">
            <FileText size={13} className="text-purple-400" />
          </div>
          <span className="text-sm font-semibold text-[var(--text-primary)]">PPT 创作工作台</span>
        </div>

        <div className="flex items-center gap-2">
          {/* 设置收起区 */}
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] px-2 py-1 rounded-md hover:bg-white/4"
          >
            设置
            <ChevronDown
              size={10}
              className={`transition-transform ${showSettings ? 'rotate-180' : ''}`}
            />
          </button>

          {isStreaming && (
            <button
              onClick={handleAbort}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-red-400 hover:bg-red-500/10 border border-red-500/20"
            >
              <X size={11} />
              中止
            </button>
          )}

          {generatedHtml && !isStreaming && (
            <button
              onClick={() => void handlePublish()}
              disabled={isPublishing}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-blue-500/15 text-blue-400 hover:bg-blue-500/20 border border-blue-500/25 disabled:opacity-50"
            >
              {isPublishing ? <MapSpinner size={11} /> : <Globe size={11} />}
              {isPublishing ? '发布中...' : '发布为网页'}
            </button>
          )}

          <button
            onClick={handleReset}
            title="新建对话"
            className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-white/5"
          >
            <RotateCcw size={12} />
          </button>
        </div>
      </div>

      {/* Settings panel（收起） */}
      {showSettings && (
        <div className="shrink-0 flex items-center gap-4 px-4 py-2 border-b border-white/6 bg-white/2 text-[11px]">
          {/* 引擎 */}
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--text-tertiary)]">引擎</span>
            <div className="flex rounded-md border border-white/10 overflow-hidden">
              <button
                onClick={() => setEngine('map')}
                className={[
                  'flex items-center gap-1 px-2 py-1',
                  engine === 'map' ? 'bg-purple-500/20 text-purple-300' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
                ].join(' ')}
              >
                <Zap size={9} /> MAP
              </button>
              <button
                onClick={() => setEngine('agent')}
                className={[
                  'flex items-center gap-1 px-2 py-1 border-l border-white/10',
                  engine === 'agent' ? 'bg-blue-500/20 text-blue-300' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
                ].join(' ')}
              >
                <Bot size={9} /> Agent
              </button>
            </div>
          </div>

          {/* 风格 */}
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--text-tertiary)]">风格</span>
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              className="appearance-none text-[11px] py-1 pl-2 pr-5 rounded-md bg-white/5 text-[var(--text-primary)] border border-white/8 outline-none cursor-pointer"
            >
              {THEME_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Published URL banner */}
      {publishedUrl && (
        <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 bg-green-500/8 border-b border-green-500/15 text-xs text-green-400">
          <Globe size={12} />
          <span>已发布：</span>
          <a href={publishedUrl} target="_blank" rel="noreferrer" className="underline hover:text-green-300">
            {publishedUrl}
          </a>
        </div>
      )}

      {/* Main: left chat + right artifact */}
      <div className="flex flex-1 min-h-0">

        {/* ─── Left: Chat panel ─────────────────────────────────────────────── */}
        <div
          className="w-72 shrink-0 flex flex-col border-r border-white/8"
          style={{ minHeight: 0 }}
        >
          {/* Messages */}
          <div
            className="flex-1 px-3 py-3 flex flex-col gap-3"
            style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
          >
            {/* Empty state */}
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center">
                  <Wand2 size={18} className="text-purple-400" />
                </div>
                <div>
                  <p className="text-xs font-medium text-[var(--text-secondary)]">
                    告诉我你想做什么样的 PPT
                  </p>
                  <p className="text-[10px] text-[var(--text-tertiary)] mt-1 leading-relaxed">
                    例：把这段内容做成 8 页的商务汇报<br />
                    支持附件和知识库引用
                  </p>
                </div>
              </div>
            )}

            {/* Message list */}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                {/* Role indicator */}
                <span className="text-[9px] text-[var(--text-tertiary)] px-0.5">
                  {msg.role === 'user' ? '你' : 'AI'}
                </span>

                {/* Bubble */}
                <div
                  className={[
                    'rounded-xl px-3 py-2 text-xs leading-relaxed max-w-[90%]',
                    msg.role === 'user'
                      ? 'bg-purple-500/15 text-[var(--text-primary)] border border-purple-500/20'
                      : 'bg-white/5 text-[var(--text-secondary)] border border-white/8',
                  ].join(' ')}
                >
                  {/* User message content */}
                  {msg.role === 'user' && (
                    <div>
                      <p>{msg.content}</p>
                      {(msg.attachments ?? []).map((a, i) => (
                        <div key={i} className="mt-1 flex items-center gap-1 text-[10px] text-[var(--text-tertiary)]">
                          <Upload size={9} />
                          {a.name}
                        </div>
                      ))}
                      {(msg.kbRefs ?? []).map((r, i) => (
                        <div key={i} className="mt-1 flex items-center gap-1 text-[10px] text-[var(--text-tertiary)]">
                          <BookOpen size={9} />
                          {r.storeName} &gt; {r.entryTitle}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Assistant: outline phase */}
                  {msg.role === 'assistant' && msg.phase === 'outline' && msg.outline && (
                    <OutlineBubble
                      msg={msg}
                      onConfirm={startConvert}
                      onAdjust={adjustOutline}
                      disabled={isProcessing}
                    />
                  )}

                  {/* Assistant: generating / patching / outlining */}
                  {msg.role === 'assistant' &&
                    (msg.phase === 'generating' || msg.phase === 'patching') && (
                      <div className="flex items-center gap-2">
                        <MapSpinner size={11} />
                        <span>{msg.content}</span>
                      </div>
                    )}

                  {/* Assistant: outline (still loading) */}
                  {msg.role === 'assistant' && msg.phase === 'outline' && !msg.outline && (
                    <div className="flex items-center gap-2">
                      <MapSpinner size={11} />
                      <span>{msg.content}</span>
                    </div>
                  )}

                  {/* Assistant: error */}
                  {msg.role === 'assistant' && msg.phase === 'error' && (
                    <div className="flex items-start gap-2 text-red-400">
                      <AlertCircle size={11} className="mt-0.5 shrink-0" />
                      <span>{msg.content}</span>
                    </div>
                  )}

                  {/* Assistant: done / text */}
                  {msg.role === 'assistant' &&
                    (msg.phase === 'done' || msg.phase === 'text' || !msg.phase) && (
                      <p>{msg.content}</p>
                    )}
                </div>
              </div>
            ))}

            <div ref={chatEndRef} />
          </div>

          {/* ─── Input area */}
          <div className="shrink-0 border-t border-white/8 p-2 flex flex-col gap-1.5">
            {/* Pending attachments & KB refs */}
            {(pendingAttachments.length > 0 || pendingKbRefs.length > 0) && (
              <div className="flex flex-wrap gap-1.5 px-1">
                {pendingAttachments.map((a, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/6 text-[10px] text-[var(--text-secondary)] border border-white/8"
                  >
                    <Upload size={9} />
                    <span className="truncate max-w-[80px]">{a.name}</span>
                    <button onClick={() => removeAttachment(i)}>
                      <X size={9} />
                    </button>
                  </div>
                ))}
                {pendingKbRefs.map((r, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/10 text-[10px] text-blue-300 border border-blue-500/15"
                  >
                    <BookOpen size={9} />
                    <span className="truncate max-w-[80px]">{r.entryTitle}</span>
                    <button onClick={() => removeKbRef(i)}>
                      <X size={9} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Input row */}
            <div className="flex items-end gap-1.5">
              {/* "+" menu */}
              <div className="relative shrink-0">
                <button
                  onClick={() => setShowPlusMenu((v) => !v)}
                  disabled={isProcessing}
                  className="flex items-center justify-center w-7 h-7 rounded-lg bg-white/5 text-[var(--text-tertiary)] hover:bg-white/8 hover:text-[var(--text-secondary)] border border-white/8 disabled:opacity-40"
                >
                  <Plus size={13} />
                </button>

                {showPlusMenu && (
                  <div className="absolute bottom-full left-0 mb-1 w-40 rounded-lg border border-white/10 bg-[var(--bg-elevated)] shadow-xl z-10">
                    <button
                      className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-[var(--text-secondary)] hover:bg-white/5"
                      onClick={() => {
                        setShowPlusMenu(false);
                        fileInputRef.current?.click();
                      }}
                    >
                      <Upload size={12} />
                      添加文件
                    </button>
                    <button
                      className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-[var(--text-secondary)] hover:bg-white/5 border-t border-white/6"
                      onClick={() => {
                        setShowPlusMenu(false);
                        setShowKbPicker(true);
                      }}
                    >
                      <BookOpen size={12} />
                      引用知识库
                    </button>
                  </div>
                )}
              </div>

              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={
                  generatedHtml
                    ? '继续精修，如：第3页改两栏对比...'
                    : '告诉 AI 你想做什么 PPT...'
                }
                rows={2}
                disabled={isProcessing}
                className="flex-1 resize-none text-xs bg-white/5 text-[var(--text-primary)] placeholder-[var(--text-tertiary)] border border-white/8 rounded-lg px-2.5 py-2 outline-none focus:border-purple-500/30 disabled:opacity-50"
                style={{ minHeight: 0 }}
              />

              <button
                onClick={handleSend}
                disabled={!input.trim() || isProcessing}
                className="shrink-0 flex items-center justify-center w-7 h-7 rounded-lg bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 border border-purple-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isProcessing ? <MapSpinner size={12} /> : <Send size={12} />}
              </button>
            </div>
          </div>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.txt,.markdown,.pdf,.doc,.docx"
            onChange={(e) => void handleFileChange(e)}
            className="hidden"
          />
        </div>

        {/* ─── Right: Artifact panel ──────────────────────────────────────── */}
        <div className="flex-1 min-w-0 flex flex-col" style={{ minHeight: 0 }}>
          {/* Idle / empty */}
          {artifactPhase === 'idle' && !generatedHtml && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--text-tertiary)]">
              <div className="w-12 h-12 rounded-2xl bg-purple-500/8 flex items-center justify-center">
                <Wand2 size={22} className="text-purple-400/60" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-[var(--text-secondary)]">
                  PPT 预览区
                </p>
                <p className="text-xs mt-1 text-[var(--text-tertiary)]">
                  在左侧对话框输入需求，AI 将生成 reveal.js 网页 PPT
                </p>
              </div>
            </div>
          )}

          {/* Outlining progress */}
          {artifactPhase === 'outlining' && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <MapSpinner size={20} />
              <p className="text-sm text-[var(--text-secondary)]">正在规划大纲...</p>
              <p className="text-xs text-[var(--text-tertiary)]">分析内容结构，生成最优页面分配</p>
            </div>
          )}

          {/* Generating progress */}
          {(artifactPhase === 'generating' || artifactPhase === 'patching') && (
            <div className="flex-1 flex flex-col items-center justify-center gap-4">
              <MapSpinner size={20} />
              <div className="text-center">
                <p className="text-sm text-[var(--text-secondary)]">
                  {genStageMsg(elapsedSec, artifactPhase === 'patching')}
                </p>
                <p className="text-xs text-[var(--text-tertiary)] mt-1 tabular-nums">
                  已等待 {elapsedSec}s
                </p>
              </div>
              {diagLines.length > 0 && (
                <div className="w-72 rounded-md bg-white/3 border border-white/6 overflow-hidden">
                  <div className="px-3 py-1 text-[9px] text-[var(--text-tertiary)] font-semibold border-b border-white/5">
                    Agent 诊断
                  </div>
                  <div style={{ maxHeight: '100px', overflowY: 'auto', overscrollBehavior: 'contain' }}>
                    {diagLines.slice(-10).map((d, i) => (
                      <div key={i} className="px-3 py-0.5 text-[9px] font-mono text-[var(--text-tertiary)]">
                        [{d.stage}]{' '}
                        {d.message ? String(d.message) : d.warning ? String(d.warning) : ''}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Done: iframe preview */}
          {(artifactPhase === 'done' || (artifactPhase === 'idle' && generatedHtml)) && generatedHtml && (
            <div className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
              {/* Toolbar */}
              <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-white/8">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => deckNav('prev')}
                    title="上一页"
                    className="flex items-center justify-center w-7 h-7 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-[var(--text-secondary)]"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    onClick={() => deckNav('next')}
                    title="下一页"
                    className="flex items-center justify-center w-7 h-7 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-[var(--text-secondary)]"
                  >
                    <ChevronRight size={14} />
                  </button>
                  <span className="text-[10px] text-[var(--text-tertiary)]">翻页</span>
                </div>
                <span className="text-[10px] text-[var(--text-tertiary)]">
                  {generatedHtml.length.toLocaleString()} 字符 · reveal.js PPT
                </span>
              </div>

              {/* iframe —— sandbox="allow-scripts"（opaque origin，无 same-origin）
                    配合上方 prepareIframeHtml() 注入的 storage shim，
                    reveal.js init 不会因 storage 访问抛错导致整页空白。
                    生成 HTML 中的 <script> 无法访问主应用的 token/cookie/storage。 */}
              <iframe
                ref={iframeRef}
                className="flex-1 w-full border-0"
                srcDoc={prepareIframeHtml(generatedHtml)}
                sandbox="allow-scripts"
                title="PPT 预览"
                style={{ minHeight: 0 }}
              />
            </div>
          )}
        </div>
      </div>

      {/* KB picker modal */}
      {showKbPicker && (
        <KbPicker onClose={() => setShowKbPicker(false)} onSelect={handleKbSelect} />
      )}

      {/* Plus menu backdrop */}
      {showPlusMenu && (
        <div
          className="fixed inset-0 z-[5]"
          onClick={() => setShowPlusMenu(false)}
        />
      )}
    </div>
  );
}

export default MdToPptAgentPage;
