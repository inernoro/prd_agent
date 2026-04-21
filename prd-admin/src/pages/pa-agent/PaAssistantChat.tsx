import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Paperclip, X, ChevronRight, Loader2, Plus, Zap, Check, CheckCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PaMessage, PaTask, PaUploadResult, PaTaskEvent, PaSessionInfo } from '@/services/real/paAgentService';
import {
  getPaMessages, streamPaChat, createPaTask, uploadPaFile,
} from '@/services/real/paAgentService';

// ── Quick commands ─────────────────────────────────────────────────────────

const QUICK_COMMANDS = [
  { icon: '📋', label: '拆解任务', prompt: '帮我拆解这个目标，并按四象限排序：' },
  { icon: '⚡', label: '今日规划', prompt: '帮我规划今天的工作优先级，先说说你现在有哪些待办？' },
  { icon: '🎯', label: '聚焦目标', prompt: '我想聚焦最重要的事，帮我识别当前最该做的 1 件事：' },
  { icon: '📝', label: '会议复盘', prompt: '帮我整理会议 Action Item，格式为：责任人 | 事项 | 截止日期：' },
];

const SUPPORTED_TYPES = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json';

function fmtFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return '📄';
  if (['doc', 'docx'].includes(ext)) return '📝';
  if (['xls', 'xlsx'].includes(ext)) return '📊';
  if (['ppt', 'pptx'].includes(ext)) return '📑';
  return '📎';
}

// Strip JSON block from content for display
function stripTaskJson(content: string): string {
  return content.replace(/```json\s*[\s\S]*?```/g, '').trim();
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
    <button
      onClick={() => void handleSave()}
      disabled={saving || saved}
      className="mt-2 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-medium transition-all whitespace-nowrap"
      style={{
        background: saved ? 'rgba(34,197,94,0.12)' : 'rgba(99,102,241,0.1)',
        color: saved ? '#22c55e' : '#6366f1',
        border: `1px solid ${saved ? '#22c55e44' : '#6366f144'}`,
      }}
    >
      {saving ? <Loader2 size={11} className="animate-spin" />
        : saved ? <Check size={11} />
          : <Plus size={11} />}
      {saved ? '已加入看板' : `加入看板 · ${event.quadrant}`}
      {!saved && !saving && (
        <span
          className="ml-0.5 text-[10px] px-1 rounded font-bold"
          style={{ background: qc + '22', color: qc }}
        >
          {event.quadrant}
        </span>
      )}
    </button>
  );
}

// ── AutoSaveToast ──────────────────────────────────────────────────────────

function AutoSaveToast({ event, onDismiss }: { event: PaTaskEvent; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 4000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium mt-2 animate-pulse"
      style={{
        background: 'rgba(34,197,94,0.12)',
        color: '#22c55e',
        border: '1px solid rgba(34,197,94,0.25)',
      }}
    >
      <CheckCircle size={12} />
      已自动加入看板 · {event.quadrant} · {event.title}
    </div>
  );
}

// ── ChatBubble ──────────────────────────────────────────────────────────────

interface ChatBubbleProps {
  msg: PaMessage;
  sessionId: string;
  suggestEvent?: PaTaskEvent;
  autoEvent?: PaTaskEvent;
  onTaskSaved: (task: PaTask) => void;
}

function ChatBubble({ msg, sessionId, suggestEvent, autoEvent, onTaskSaved }: ChatBubbleProps) {
  const [autoDismissed, setAutoDismissed] = useState(false);
  const isUser = msg.role === 'user';
  const displayContent = stripTaskJson(msg.content);

  if (isUser) {
    return (
      <div className="flex justify-end mb-4">
        <div
          className="max-w-[80%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm leading-relaxed"
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
          className="rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-default)',
            color: 'var(--text-primary)',
          }}
        >
          <div className="prose prose-sm max-w-none" style={{ color: 'inherit' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
          </div>
        </div>
        {/* Auto-saved toast */}
        {autoEvent && !autoDismissed && (
          <AutoSaveToast event={autoEvent} onDismiss={() => setAutoDismissed(true)} />
        )}
        {/* Suggest button */}
        {suggestEvent && (
          <SuggestTaskButton event={suggestEvent} sessionId={sessionId} onSaved={onTaskSaved} />
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
          <div className="flex flex-col items-center justify-center h-full gap-6 px-2">
            <div className="text-center">
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-3"
                style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }}
              >
                <Zap size={26} color="#fff" />
              </div>
              <div className="text-base font-semibold mb-1">MBB 私人执行助理</div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                任务自动拆解 · 象限排序 · 智能识别待办
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 w-full max-w-sm">
              {QUICK_COMMANDS.map((cmd, i) => (
                <button
                  key={i}
                  onClick={() => void handleSend(cmd.prompt)}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs text-left transition-all hover:scale-[1.02]"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-secondary)',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#6366f166'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-default)'; }}
                >
                  <span className="text-base">{cmd.icon}</span>
                  <span className="font-medium">{cmd.label}</span>
                  <ChevronRight size={11} className="ml-auto shrink-0" style={{ color: 'var(--text-muted)' }} />
                </button>
              ))}
            </div>
            <p className="text-[11px] text-center" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
              明确待办会自动加入看板 · 潜在任务显示确认按钮
            </p>
          </div>
        ) : (
          <>
            {messages.map((msg) => {
              const event = taskEvents[msg.id];
              return (
                <ChatBubble
                  key={msg.id}
                  msg={msg}
                  sessionId={sessionId}
                  suggestEvent={event?.confidence === 'suggest' ? event : undefined}
                  autoEvent={event?.confidence === 'auto' ? event : undefined}
                  onTaskSaved={onTaskSaved ?? (() => {})}
                />
              );
            })}
            {/* Streaming bubble */}
            {isStreaming && (
              <div className="flex justify-start mb-4 gap-2.5">
                <div
                  className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5"
                  style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }}
                >
                  <Zap size={13} color="#fff" />
                </div>
                <div
                  className="max-w-[82%] rounded-2xl rounded-tl-sm px-4 py-3 text-sm"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                >
                  {streamingContent ? (
                    <div className="prose prose-sm max-w-none" style={{ color: 'inherit' }}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {stripTaskJson(streamingContent.replace(/\u200B/g, ''))}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      {[0, 150, 300].map(d => (
                        <span key={d} className="w-1.5 h-1.5 rounded-full animate-bounce"
                          style={{ background: 'var(--text-muted)', animationDelay: `${d}ms` }} />
                      ))}
                    </div>
                  )}
                  {streamingContent && (
                    <span className="inline-block w-0.5 h-4 align-middle animate-pulse ml-0.5"
                      style={{ background: '#6366f1' }} />
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
              <span>{fileIcon(attachment.fileName)}</span>
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
            placeholder={isStreaming ? '正在回复中...' : attachment ? '描述你想用这份文档做什么...' : '随时开始，Enter 发送，Shift+Enter 换行'}
            rows={1}
            className="w-full resize-none bg-transparent text-sm outline-none px-4 pt-3 pb-1"
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
