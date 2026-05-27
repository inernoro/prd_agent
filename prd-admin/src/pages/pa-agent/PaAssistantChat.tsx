import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Send, Paperclip, X, ChevronRight, Loader2, Plus, Zap, Check, CheckCircle,
  Scissors, AlarmClock, AlertTriangle, ListChecks, Brain, Eye, ExternalLink,
  FileText, FileSpreadsheet, FileType, File as FileIcon,
} from 'lucide-react';
import type {
  PaMessage, PaTask, PaUploadResult, PaTaskEvent, PaSessionInfo, PaProfileEvent,
} from '@/services/real/paAgentService';
import {
  getPaMessages, streamPaChat, createPaTask, uploadPaFile,
} from '@/services/real/paAgentService';
import { StreamingText } from '@/components/streaming';
import { ChatMarkdown } from './ChatMarkdown';
import { PaSecretaryHeroArt } from '@/pages/ai-toolbox/components/PaSecretaryHeroArt';

/** 「进一步了解我」外链 — 米多内部 wp 链接，承载毒舌秘书完整产品介绍 */
const LEARN_MORE_URL = 'https://map.ebcone.net/s/wp/0q1-vbQ9HehA';

// ── Quick commands（毒舌秘书风格，零 emoji） ──────────────────────────────

const QUICK_COMMANDS: Array<{
  icon: React.ReactNode;
  label: string;
  prompt: string;
}> = [
  { icon: <Scissors size={14} />, label: '拆任务',  prompt: '帮我拆一下：' },
  { icon: <ListChecks size={14} />, label: '今天有什么', prompt: '今天有什么' },
  { icon: <AlertTriangle size={14} />, label: '有哪些逾期', prompt: '有哪些逾期' },
  { icon: <AlarmClock size={14} />, label: '我焦虑了，列重点', prompt: '我焦虑了，给我列重点' },
];

// ── 毒舌一句（按象限取，前端拼接，不调后端） ───────────────────────────

const QUADRANT_LABEL: Record<string, string> = {
  Q1: '立刻干', Q2: '计划干', Q3: '快速干', Q4: '养着干',
};

const QUADRANT_SAVAGE: Record<string, string> = {
  Q1: '这件事今天必须搞定，别想跑。',
  Q2: '重要不紧急——但「不紧急」不等于「不做」。',
  Q3: '能授权就授权，别自己扛。',
  Q4: '养着可以，别忘了它存在。',
};

const SUPPORTED_TYPES = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json';

function fmtFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function FileTypeIcon({ name, size = 12 }: { name: string; size?: number }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return <FileType size={size} />;
  if (['doc', 'docx'].includes(ext)) return <FileText size={size} />;
  if (['xls', 'xlsx', 'csv'].includes(ext)) return <FileSpreadsheet size={size} />;
  return <FileIcon size={size} />;
}

// Strip JSON block from content for display
function stripTaskJson(content: string): string {
  return content.replace(/```json\s*[\s\S]*?```/g, '').trim();
}

/** 流式首包未到前的等待态：橙色「让我想想...」+ 动态省略号 */
function PaThinkingIndicator() {
  return (
    <div
      className="pa-thinking-indicator"
      role="status"
      aria-live="polite"
      aria-label="让我想想"
    >
      <span className="pa-thinking-label">让我想想</span>
      <span className="pa-thinking-ellipsis" aria-hidden="true">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </div>
  );
}

// ── SuggestTaskButton ──────────────────────────────────────────────────────

interface SuggestTaskButtonProps {
  event: PaTaskEvent;
  sessionId: string;
  onSaved: (task: PaTask) => void;
}

function SuggestTaskButton({ event, sessionId, onSaved }: SuggestTaskButtonProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const qColor: Record<string, string> = {
    Q1: '#ef4444', Q2: '#22c55e', Q3: '#f59e0b', Q4: '#9ca3af',
  };
  const qc = qColor[event.quadrant] ?? '#6366f1';
  const qLabel = QUADRANT_LABEL[event.quadrant] ?? event.quadrant;
  const savage = QUADRANT_SAVAGE[event.quadrant];

  const handleSave = async () => {
    if (saving || saved) return;
    setSaving(true);
    const res = await createPaTask({
      title: event.title,
      quadrant: event.quadrant,
      sessionId,
      reasoning: event.reasoning,
      subTasks: event.subTasks,
      contentHash: btoa(encodeURIComponent(event.title + event.quadrant)).slice(0, 32),
    });
    setSaving(false);
    if (res.success && res.data) {
      setSaved(true);
      onSaved(res.data);
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-1">
      <button
        onClick={() => void handleSave()}
        disabled={saving || saved}
        className="self-start inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-medium transition-all whitespace-nowrap"
        style={{
          background: saved ? 'rgba(34,197,94,0.12)' : 'rgba(99,102,241,0.1)',
          color: saved ? '#22c55e' : '#6366f1',
          border: `1px solid ${saved ? '#22c55e44' : '#6366f144'}`,
        }}
      >
        {saving ? <Loader2 size={11} className="animate-spin" />
          : saved ? <Check size={11} />
            : <Plus size={11} />}
        {saved ? '已加入看板' : `加入看板 · ${qLabel}`}
        {!saved && !saving && (
          <span
            className="ml-0.5 text-[10px] px-1 rounded font-bold"
            style={{ background: qc + '22', color: qc }}
          >
            {event.quadrant}
          </span>
        )}
      </button>
      {savage && (
        <span className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {savage}
        </span>
      )}
    </div>
  );
}

// ── ProfileUpdateToast ─────────────────────────────────────────────────────

function ProfileUpdateToast({ event, onDismiss }: { event: PaProfileEvent; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 7000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  const isSuggest = event.confidence === 'suggest';
  const items = [...event.addedMemories.map(m => m.text), ...event.changedFields];
  if (items.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-1">
      <div
        className="self-start inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium"
        style={{
          background: isSuggest ? 'rgba(245,158,11,0.12)' : 'rgba(99,102,241,0.12)',
          color: isSuggest ? '#fcd34d' : '#a5b4fc',
          border: isSuggest
            ? '1px solid rgba(245,158,11,0.3)'
            : '1px solid rgba(99,102,241,0.3)',
        }}
        title={isSuggest
          ? '秘书觉得可能要记下来 — 在「我的画像」里确认才会参与未来对话'
          : '秘书已经记下来了 — 下次对话会带上'}
      >
        {isSuggest ? <Eye size={11} /> : <Brain size={11} />}
        {isSuggest ? '秘书想记下：' : '秘书记住了：'}
        <span className="font-normal max-w-[240px] truncate">
          {items.slice(0, 2).join(' / ')}
          {items.length > 2 && ` 等 ${items.length} 项`}
        </span>
      </div>
    </div>
  );
}

// ── AutoSaveToast ──────────────────────────────────────────────────────────

function AutoSaveToast({ event, onDismiss }: { event: PaTaskEvent; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  const qLabel = QUADRANT_LABEL[event.quadrant] ?? event.quadrant;
  const savage = QUADRANT_SAVAGE[event.quadrant];

  return (
    <div className="mt-2 flex flex-col gap-1">
      <div
        className="self-start inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium"
        style={{
          background: 'rgba(34,197,94,0.12)',
          color: '#22c55e',
          border: '1px solid rgba(34,197,94,0.25)',
        }}
      >
        <CheckCircle size={12} />
        已记 · {event.quadrant} {qLabel} · {event.title}
      </div>
      {savage && (
        <span className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {savage}
        </span>
      )}
    </div>
  );
}

// ── ChatBubble ──────────────────────────────────────────────────────────────

interface ChatBubbleProps {
  msg: PaMessage;
  sessionId: string;
  suggestEvent?: PaTaskEvent;
  autoEvent?: PaTaskEvent;
  profileEvent?: PaProfileEvent;
  onTaskSaved: (task: PaTask) => void;
}

function ChatBubble({ msg, sessionId, suggestEvent, autoEvent, profileEvent, onTaskSaved }: ChatBubbleProps) {
  const [autoDismissed, setAutoDismissed] = useState(false);
  const [profileDismissed, setProfileDismissed] = useState(false);
  const isUser = msg.role === 'user';
  const displayContent = stripTaskJson(msg.content);

  if (isUser) {
    return (
      <div className="flex justify-end mb-4">
        <div
          className="max-w-[80%] rounded-2xl rounded-br-sm px-4 py-2.5 pa-fs-sm"
          style={{ background: 'linear-gradient(135deg,#3b82f6,#6366f1)', color: '#fff' }}
        >
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-4 gap-2.5">
      <div
        className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5"
        style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }}
      >
        <Zap size={13} color="#fff" />
      </div>
      <div className="max-w-[82%]">
        <div
          className="rounded-2xl rounded-tl-sm px-4 py-3 pa-fs-sm"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-primary)',
          }}
        >
          <ChatMarkdown content={displayContent} />
        </div>
        {/* Auto-saved toast */}
        {autoEvent && !autoDismissed && (
          <AutoSaveToast event={autoEvent} onDismiss={() => setAutoDismissed(true)} />
        )}
        {/* Suggest button */}
        {suggestEvent && (
          <SuggestTaskButton event={suggestEvent} sessionId={sessionId} onSaved={onTaskSaved} />
        )}
        {/* Profile update toast */}
        {profileEvent && !profileDismissed && (
          <ProfileUpdateToast event={profileEvent} onDismiss={() => setProfileDismissed(true)} />
        )}
      </div>
    </div>
  );
}

// ── PaAssistantChat ────────────────────────────────────────────────────────

interface PaAssistantChatProps {
  sessionId: string;
  onTaskSaved?: (task: PaTask) => void;
  onSessionUpdated?: (updates: Partial<PaSessionInfo>) => void;
}

export function PaAssistantChat({ sessionId, onTaskSaved, onSessionUpdated }: PaAssistantChatProps) {
  const [messages, setMessages] = useState<PaMessage[]>([]);
  const [taskEvents, setTaskEvents] = useState<Record<string, PaTaskEvent>>({});
  const [profileEvents, setProfileEvents] = useState<Record<string, PaProfileEvent>>({});
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [input, setInput] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [attachment, setAttachment] = useState<PaUploadResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<(() => void) | null>(null);

  const scrollToBottom = useCallback((smooth = true) => {
    bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    setMessages([]);
    setTaskEvents({});
    setProfileEvents({});
    setLoadingHistory(true);
    (async () => {
      try {
        const res = await getPaMessages(sessionId);
        if (res.success && Array.isArray(res.data)) {
          setMessages(res.data);
          setTimeout(() => scrollToBottom(false), 50);
        }
      } catch { /* ignore */ } finally {
        setLoadingHistory(false);
      }
    })();
  }, [sessionId, scrollToBottom]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent, scrollToBottom]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [input]);

  const handleFileSelect = useCallback(async (file: File) => {
    if (file.size > 10 * 1024 * 1024) { setUploadError('文件不能超过 10MB'); return; }
    setUploadError(null);
    setUploading(true);
    const res = await uploadPaFile(file);
    setUploading(false);
    if (res.success && res.data) setAttachment(res.data);
    else setUploadError(res.error?.message ?? '上传失败');
  }, []);

  const handleSend = useCallback(async (text: string) => {
    if ((!text.trim() && !attachment) || isStreaming) return;
    const finalText = text.trim() || `请分析这份文档：${attachment?.fileName ?? ''}`;

    const userMsg: PaMessage = {
      id: `u-${Date.now()}`,
      userId: '', sessionId,
      role: 'user',
      content: attachment ? `${finalText}\n\n[附件: ${attachment.fileName}]` : finalText,
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsStreaming(true);
    setStreamingContent('');

    const attachedText = attachment?.extractedText;
    const attachedFileName = attachment?.fileName;
    setAttachment(null);

    let fullContent = '';
    const assistantMsgId = `a-${Date.now()}`;

    abortRef.current = await streamPaChat({
      sessionId,
      message: finalText,
      attachedText,
      attachedFileName,
      onChunk: chunk => {
        if (chunk.content) {
          fullContent += chunk.content;
          setStreamingContent(fullContent);
        }
      },
      onDone: () => {
        setIsStreaming(false);
        setStreamingContent('');
        const assistantMsg: PaMessage = {
          id: assistantMsgId,
          userId: '', sessionId,
          role: 'assistant',
          content: fullContent,
          createdAt: new Date().toISOString(),
        };
        setMessages(prev => [...prev, assistantMsg]);
        abortRef.current = null;
        // Update session preview
        onSessionUpdated?.({
          lastMessagePreview: finalText.slice(0, 40) + (finalText.length > 40 ? '…' : ''),
          updatedAt: new Date().toISOString(),
        });
      },
      onError: err => {
        setIsStreaming(false);
        setStreamingContent('');
        setMessages(prev => [...prev, {
          id: `err-${Date.now()}`, userId: '', sessionId,
          role: 'assistant',
          content: `> 出了点问题：${err}\n\n请重试或换个说法。`,
          createdAt: new Date().toISOString(),
        }]);
        abortRef.current = null;
      },
      onTask: (event) => {
        setTaskEvents(prev => ({ ...prev, [assistantMsgId]: event }));
        if (event.autoSaved) {
          // Also notify parent for board refresh
          onTaskSaved?.({ id: event.taskId ?? '', userId: '', title: event.title,
            quadrant: event.quadrant, subTasks: [], status: 'pending',
            createdAt: '', updatedAt: '' });
        }
        // Update session title if provided (first message)
        if (event.confidence === 'auto' || event.confidence === 'suggest') {
          onSessionUpdated?.({ updatedAt: new Date().toISOString() });
        }
      },
      onProfileUpdate: (event) => {
        setProfileEvents(prev => ({ ...prev, [assistantMsgId]: event }));
      },
    });
  }, [isStreaming, sessionId, attachment, onTaskSaved, onSessionUpdated]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend(input); }
  }, [handleSend, input]);

  const isEmpty = messages.length === 0 && !loadingHistory;
  const canSend = (!!input.trim() || !!attachment) && !isStreaming;

  return (
    <div
      className="h-full flex flex-col"
      onDragOver={e => e.preventDefault()}
      onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void handleFileSelect(f); }}
    >
      {/* Messages */}
      <div className="flex-1 overflow-auto px-4 py-4">
        {loadingHistory ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 size={22} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full gap-7 px-4 pa-empty-enter">
            <div className="text-center max-w-md">
              <div className="w-[88px] h-[88px] rounded-[22px] flex items-center justify-center mx-auto mb-4 pa-hero-icon pa-secretary-avatar-shell">
                <PaSecretaryHeroArt size={56} />
              </div>
              {/* display 标题层 */}
              <div
                className="font-semibold mb-2"
                style={{ fontSize: 'calc(22px * var(--pa-fs-scale))', lineHeight: 'calc(28px * var(--pa-fs-scale))', letterSpacing: '-0.01em', color: 'var(--text-primary)' }}
              >
                毒舌秘书
              </div>
              {/* 一段两行：用户指定的新文案 */}
              <div
                className="mb-1"
                style={{ fontSize: 'calc(13.5px * var(--pa-fs-scale))', lineHeight: 'calc(22px * var(--pa-fs-scale))', color: 'var(--text-secondary)' }}
              >
                把模糊想法转成 MECE 执行清单的 MBB 级私人助理。
              </div>
              <div
                style={{ fontSize: 'calc(12px * var(--pa-fs-scale))', lineHeight: 'calc(20px * var(--pa-fs-scale))', color: 'var(--text-muted)', opacity: 0.85 }}
              >
                毒舌幽默、不堆鸡汤、能落盘。
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2.5 w-full max-w-md">
              {QUICK_COMMANDS.map((cmd, i) => (
                <button
                  key={i}
                  onClick={() => void handleSend(cmd.prompt)}
                  className="pa-quick-cmd group flex items-center gap-2 px-3 py-2.5 rounded-xl pa-fs-xs text-left"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span className="pa-quick-cmd-icon shrink-0 w-6 h-6 rounded-lg flex items-center justify-center transition-all">
                    {cmd.icon}
                  </span>
                  <span className="font-medium truncate flex-1">{cmd.label}</span>
                  <ChevronRight size={11} className="opacity-30 group-hover:opacity-90 group-hover:translate-x-0.5 transition-all" />
                </button>
              ))}
            </div>

            {/* 二级 CTA：进一步了解我（ghost 按钮，外链新窗口） */}
            <a
              href={LEARN_MORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="pa-learn-more group inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[11px] font-medium border"
              style={{
                background: 'transparent',
                color: 'var(--text-muted)',
              }}
              title="打开毒舌秘书完整介绍（外链 · 新窗口）"
            >
              <span>进一步了解我</span>
              <ExternalLink
                size={10}
                className="opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all"
              />
            </a>

            <div className="flex items-center gap-2 text-[10.5px]" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
              <kbd
                className="px-1.5 py-0.5 rounded font-mono text-[10px]"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                Enter
              </kbd>
              <span>发送</span>
              <span className="opacity-40">·</span>
              <kbd
                className="px-1.5 py-0.5 rounded font-mono text-[10px]"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                Shift+Enter
              </kbd>
              <span>换行</span>
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg) => {
              const event = taskEvents[msg.id];
              const profileEvent = profileEvents[msg.id];
              return (
                <ChatBubble
                  key={msg.id}
                  msg={msg}
                  sessionId={sessionId}
                  suggestEvent={event?.confidence === 'suggest' ? event : undefined}
                  autoEvent={event?.confidence === 'auto' ? event : undefined}
                  profileEvent={profileEvent}
                  onTaskSaved={onTaskSaved ?? (() => {})}
                />
              );
            })}
            {/* Streaming bubble — 用 StreamingText 实现 blur-focus 入场，
                避免 ReactMarkdown 每个 chunk 全量重渲染导致的抖动 */}
            {isStreaming && (
              <div className="flex justify-start mb-4 gap-2.5 streaming-bubble-enter">
                <div
                  className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5"
                  style={{
                    background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
                    boxShadow: '0 0 0 2px rgba(99,102,241,0.12), 0 8px 24px -8px rgba(139,92,246,0.45)',
                  }}
                >
                  <Zap size={13} color="#fff" />
                </div>
                <div
                  className="max-w-[82%] rounded-2xl rounded-tl-sm px-4 py-3 pa-fs-sm pa-thinking-bubble"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                    boxShadow: '0 1px 0 rgba(255,255,255,0.02) inset',
                  }}
                >
                  {streamingContent ? (
                    <StreamingText
                      text={stripTaskJson(streamingContent.replace(/\u200B/g, ''))}
                      streaming
                      mode="blur"
                      cursorContent="dot"
                    />
                  ) : (
                    <PaThinkingIndicator />
                  )}
                </div>
              </div>
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0 px-3 pb-3">
        {uploadError && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg mb-2 text-xs"
            style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
            <span>{uploadError}</span>
            <button onClick={() => setUploadError(null)} className="ml-auto"><X size={12} /></button>
          </div>
        )}
        {attachment && (
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs"
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>
              <FileTypeIcon name={attachment.fileName} />
              <span className="max-w-[120px] truncate">{attachment.fileName}</span>
              <span style={{ color: 'var(--text-muted)' }}>{fmtFileSize(attachment.fileSize)}</span>
              <button onClick={() => setAttachment(null)} style={{ color: 'var(--text-muted)' }}><X size={11} /></button>
            </div>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {attachment.charCount.toLocaleString()} 字符
            </span>
          </div>
        )}

        <div
          className="rounded-2xl overflow-hidden transition-all"
          style={{ background: 'var(--bg-elevated)', border: '1.5px solid var(--border-default)' }}
          onFocusCapture={e => { (e.currentTarget as HTMLElement).style.borderColor = '#6366f166'; }}
          onBlurCapture={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-default)'; }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isStreaming}
            placeholder={isStreaming ? '正在回复中...' : attachment ? '说说你想拿这份文档干什么。' : '说事实，不说感受。'}
            rows={1}
            className="w-full resize-none bg-transparent pa-fs-sm outline-none px-4 pt-3 pb-1"
            style={{ color: 'var(--text-primary)', minHeight: 42, maxHeight: 140 }}
          />
          <div className="flex items-center justify-between px-3 pb-2.5 pt-1 gap-2">
            <div className="flex items-center gap-1">
              <input ref={fileInputRef} type="file" accept={SUPPORTED_TYPES} className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void handleFileSelect(f); e.target.value = ''; }} />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || isStreaming}
                className="flex items-center gap-1 px-2 py-1.5 rounded-xl text-xs transition-all"
                style={{ color: uploading ? '#6366f1' : 'var(--text-muted)' }}
                onMouseEnter={e => { if (!uploading && !isStreaming) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                {uploading ? <Loader2 size={14} className="animate-spin" /> : <Paperclip size={14} />}
                <span className="hidden sm:inline">{uploading ? '解析中' : '附件'}</span>
              </button>
              <span className="text-[10px] hidden md:block" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
                PDF · Word · Excel · PPT
              </span>
            </div>
            <button
              onClick={() => void handleSend(input)}
              disabled={!canSend}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-medium transition-all"
              style={{
                background: canSend ? 'linear-gradient(135deg,#6366f1,#8b5cf6)' : 'var(--bg-hover)',
                color: canSend ? '#fff' : 'var(--text-muted)',
              }}
            >
              <Send size={13} />
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
