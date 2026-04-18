import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Paperclip, X, FileText, ChevronRight, Loader2, Plus, Zap } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PaMessage, PaTask, PaUploadResult } from '@/services/real/paAgentService';
import {
  getPaMessages,
  streamPaChat,
  createPaTask,
  uploadPaFile,
} from '@/services/real/paAgentService';

// ── Quick commands ─────────────────────────────────────────────────────────

const QUICK_COMMANDS = [
  { icon: '📋', label: '拆解任务', prompt: '帮我拆解这个目标，并按四象限排序：' },
  { icon: '⚡', label: '今日规划', prompt: '帮我规划今天的工作优先级，先说说你现在有哪些待办？' },
  { icon: '🎯', label: '聚焦目标', prompt: '我想聚焦最重要的事，帮我识别当前最该做的 1 件事：' },
  { icon: '📝', label: '会议复盘', prompt: '帮我整理会议 Action Item，格式为：责任人 | 事项 | 截止日期：' },
];

const SUPPORTED_TYPES = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json';

// ── Helpers ────────────────────────────────────────────────────────────────

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
  if (['md', 'txt'].includes(ext)) return '📃';
  return '📎';
}

function extractTaskPayload(content: string): {
  action: string; title: string; quadrant: 'Q1'|'Q2'|'Q3'|'Q4'; reasoning?: string; subTasks?: string[];
} | null {
  const match = content.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const p = JSON.parse(match[1]) as Record<string, unknown>;
    if (p.action === 'save_task') return p as never;
  } catch { /* ignore */ }
  return null;
}

// ── Sub-components ─────────────────────────────────────────────────────────

interface AttachmentChipProps {
  file: PaUploadResult;
  onRemove: () => void;
}

function AttachmentChip({ file, onRemove }: AttachmentChipProps) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
        color: 'var(--text-secondary)',
      }}
    >
      <span>{fileIcon(file.fileName)}</span>
      <span className="max-w-[120px] truncate">{file.fileName}</span>
      <span style={{ color: 'var(--text-muted)' }}>{fmtFileSize(file.fileSize)}</span>
      <button
        onClick={onRemove}
        className="ml-0.5 rounded-full p-0.5 hover:opacity-70 transition-opacity"
        style={{ color: 'var(--text-muted)' }}
      >
        <X size={11} />
      </button>
    </div>
  );
}

interface SaveTaskButtonProps {
  payload: ReturnType<typeof extractTaskPayload>;
  sessionId: string;
  onSaved: (task: PaTask) => void;
}

function SaveTaskButton({ payload, sessionId, onSaved }: SaveTaskButtonProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = useCallback(async () => {
    if (!payload || saving || saved) return;
    setSaving(true);
    const res = await createPaTask({
      title: payload.title,
      quadrant: payload.quadrant,
      sessionId,
      reasoning: payload.reasoning,
      subTasks: payload.subTasks,
      contentHash: btoa(encodeURIComponent(payload.title + payload.quadrant)).slice(0, 32),
    });
    setSaving(false);
    if (res.success && res.data) {
      setSaved(true);
      onSaved(res.data);
    }
  }, [payload, saving, saved, sessionId, onSaved]);

  const quadrantColor: Record<string, string> = {
    Q1: '#ef4444', Q2: '#22c55e', Q3: '#eab308', Q4: '#8b8b8b',
  };
  const qColor = quadrantColor[payload?.quadrant ?? 'Q2'] ?? '#3b82f6';

  return (
    <button
      onClick={() => void handleSave()}
      disabled={saving || saved}
      className="mt-2 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full font-medium transition-all whitespace-nowrap"
      style={{
        background: saved ? 'rgba(34,197,94,0.15)' : 'rgba(59,130,246,0.1)',
        color: saved ? '#22c55e' : '#3b82f6',
        border: `1px solid ${saved ? '#22c55e44' : '#3b82f644'}`,
        opacity: saving ? 0.7 : 1,
      }}
    >
      {saving ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
      {saved ? '已加入任务清单' : `存入看板 · ${payload?.quadrant}`}
      {!saved && !saving && (
        <span
          className="ml-0.5 text-[10px] px-1 rounded"
          style={{ background: qColor + '22', color: qColor }}
        >
          {payload?.quadrant}
        </span>
      )}
    </button>
  );
}

interface ChatBubbleProps {
  msg: PaMessage;
  sessionId: string;
  onTaskSaved: (task: PaTask) => void;
  isLatest?: boolean;
}

function ChatBubble({ msg, sessionId, onTaskSaved, isLatest }: ChatBubbleProps) {
  const payload = msg.role === 'assistant' ? extractTaskPayload(msg.content) : null;
  const displayContent = payload
    ? msg.content.replace(/```json\s*[\s\S]*?```/, '').trim()
    : msg.content;

  const isUser = msg.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end mb-4 group">
        <div
          className="max-w-[80%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm leading-relaxed"
          style={{
            background: 'linear-gradient(135deg, #3b82f6, #6366f1)',
            color: '#fff',
          }}
        >
          {msg.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-4 gap-2.5">
      <div
        className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-sm mt-0.5"
        style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
      >
        <Zap size={14} color="#fff" />
      </div>
      <div className="max-w-[82%]">
        <div
          className="rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle, var(--border-default))',
            color: 'var(--text-primary)',
          }}
        >
          <div className="prose prose-sm max-w-none" style={{ color: 'inherit' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
          </div>
          {isLatest && (
            <div
              className="mt-0.5 text-[10px]"
              style={{ color: 'var(--text-muted)' }}
            >
              刚刚
            </div>
          )}
        </div>
        {payload && (
          <SaveTaskButton payload={payload} sessionId={sessionId} onSaved={onTaskSaved} />
        )}
      </div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

interface PaAssistantChatProps {
  sessionId: string;
  onTaskSaved?: (task: PaTask) => void;
}

export function PaAssistantChat({ sessionId, onTaskSaved }: PaAssistantChatProps) {
  const [messages, setMessages] = useState<PaMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [input, setInput] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(true);

  // File upload
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
    (async () => {
      setLoadingHistory(true);
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

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [input]);

  const handleFileSelect = useCallback(async (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      setUploadError('文件不能超过 10MB');
      return;
    }
    setUploadError(null);
    setUploading(true);
    const res = await uploadPaFile(file);
    setUploading(false);
    if (res.success && res.data) {
      setAttachment(res.data);
    } else {
      setUploadError(res.error?.message ?? '上传失败，请重试');
    }
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFileSelect(file);
    e.target.value = '';
  }, [handleFileSelect]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFileSelect(file);
  }, [handleFileSelect]);

  const handleSend = useCallback(async (text: string) => {
    if ((!text.trim() && !attachment) || isStreaming) return;

    const finalText = text.trim() || (attachment ? `请分析这份文档：${attachment.fileName}` : '');

    const userMsg: PaMessage = {
      id: `temp-${Date.now()}`,
      userId: '',
      sessionId,
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
          id: `temp-a-${Date.now()}`,
          userId: '',
          sessionId,
          role: 'assistant',
          content: fullContent,
          createdAt: new Date().toISOString(),
        };
        setMessages(prev => [...prev, assistantMsg]);
        abortRef.current = null;
      },
      onError: err => {
        setIsStreaming(false);
        setStreamingContent('');
        const errMsg: PaMessage = {
          id: `temp-err-${Date.now()}`,
          userId: '',
          sessionId,
          role: 'assistant',
          content: `> 出了点问题：${err}\n\n请重试或换个说法。`,
          createdAt: new Date().toISOString(),
        };
        setMessages(prev => [...prev, errMsg]);
        abortRef.current = null;
      },
    });
  }, [isStreaming, sessionId, attachment]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend(input);
    }
  }, [handleSend, input]);

  const handleTaskSaved = useCallback((task: PaTask) => {
    onTaskSaved?.(task);
  }, [onTaskSaved]);

  const isEmpty = messages.length === 0 && !loadingHistory;
  const canSend = (input.trim() || attachment) && !isStreaming;

  return (
    <div
      className="h-full flex flex-col"
      onDragOver={e => e.preventDefault()}
      onDrop={handleDrop}
      style={{ color: 'var(--text-primary)' }}
    >
      {/* Messages */}
      <div className="flex-1 overflow-auto px-4 py-4">
        {loadingHistory ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 size={22} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        ) : isEmpty ? (
          /* ── Empty state ── */
          <div className="flex flex-col items-center justify-center h-full gap-6 px-2">
            <div className="text-center">
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-3"
                style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
              >
                <Zap size={26} color="#fff" />
              </div>
              <div className="text-lg font-semibold mb-1">你的 MBB 级私人助理</div>
              <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                任务拆解 · 四象限规划 · 高效执行
              </div>
            </div>

            {/* Quick commands */}
            <div className="grid grid-cols-2 gap-2 w-full max-w-sm">
              {QUICK_COMMANDS.map((cmd, i) => (
                <button
                  key={i}
                  onClick={() => void handleSend(cmd.prompt)}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm text-left transition-all hover:scale-[1.02]"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-secondary)',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#6366f166'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-default)'; }}
                >
                  <span className="text-base">{cmd.icon}</span>
                  <span className="font-medium text-xs">{cmd.label}</span>
                  <ChevronRight size={12} className="ml-auto shrink-0" style={{ color: 'var(--text-muted)' }} />
                </button>
              ))}
            </div>

            <p className="text-xs text-center" style={{ color: 'var(--text-muted)' }}>
              支持上传 PDF · Word · Excel · PPT 等文档
            </p>
          </div>
        ) : (
          /* ── Messages list ── */
          <>
            {messages.map((msg, idx) => (
              <ChatBubble
                key={msg.id}
                msg={msg}
                sessionId={sessionId}
                onTaskSaved={handleTaskSaved}
                isLatest={idx === messages.length - 1 && msg.role === 'assistant'}
              />
            ))}

            {/* Streaming bubble */}
            {isStreaming && (
              <div className="flex justify-start mb-4 gap-2.5">
                <div
                  className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-sm mt-0.5"
                  style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
                >
                  <Zap size={14} color="#fff" />
                </div>
                <div
                  className="max-w-[82%] rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed"
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {streamingContent ? (
                    <div className="prose prose-sm max-w-none" style={{ color: 'inherit' }}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {streamingContent.replace(/\u200B/g, '')}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--text-muted)', animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--text-muted)', animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--text-muted)', animationDelay: '300ms' }} />
                    </div>
                  )}
                  {streamingContent && (
                    <span
                      className="inline-block w-0.5 h-4 align-middle animate-pulse ml-0.5"
                      style={{ background: '#6366f1' }}
                    />
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
        {/* Upload error */}
        {uploadError && (
          <div
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg mb-2 text-xs"
            style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}
          >
            <span>{uploadError}</span>
            <button onClick={() => setUploadError(null)} className="ml-auto">
              <X size={12} />
            </button>
          </div>
        )}

        {/* Attachment chip */}
        {attachment && (
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <AttachmentChip file={attachment} onRemove={() => setAttachment(null)} />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {attachment.charCount.toLocaleString()} 字符已提取
            </span>
          </div>
        )}

        <div
          className="rounded-2xl overflow-hidden"
          style={{
            background: 'var(--bg-elevated)',
            border: '1.5px solid var(--border-default)',
            transition: 'border-color 0.15s',
          }}
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
            style={{
              color: 'var(--text-primary)',
              minHeight: 42,
              maxHeight: 140,
            }}
          />

          <div className="flex items-center justify-between px-3 pb-2.5 pt-1 gap-2">
            <div className="flex items-center gap-1">
              {/* File upload button */}
              <input
                ref={fileInputRef}
                type="file"
                accept={SUPPORTED_TYPES}
                className="hidden"
                onChange={handleFileInputChange}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || isStreaming}
                title="上传文档 (PDF·Word·Excel·PPT·TXT)"
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs transition-all"
                style={{
                  color: uploading ? '#6366f1' : 'var(--text-muted)',
                  background: uploading ? 'rgba(99,102,241,0.08)' : 'transparent',
                }}
                onMouseEnter={e => {
                  if (!uploading && !isStreaming) {
                    e.currentTarget.style.background = 'var(--bg-hover)';
                    e.currentTarget.style.color = 'var(--text-secondary)';
                  }
                }}
                onMouseLeave={e => {
                  if (!uploading) {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'var(--text-muted)';
                  }
                }}
              >
                {uploading ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Paperclip size={15} />
                )}
                <span className="hidden sm:inline">{uploading ? '解析中...' : '附件'}</span>
              </button>

              {/* Format hint */}
              <span className="text-[10px] hidden md:block" style={{ color: 'var(--text-muted)' }}>
                PDF · Word · Excel · PPT
              </span>
            </div>

            {/* Send button */}
            <button
              onClick={() => void handleSend(input)}
              disabled={!canSend}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-medium transition-all"
              style={{
                background: canSend
                  ? 'linear-gradient(135deg, #6366f1, #8b5cf6)'
                  : 'var(--bg-hover)',
                color: canSend ? '#fff' : 'var(--text-muted)',
                opacity: isStreaming ? 0.6 : 1,
              }}
            >
              <Send size={13} />
              <span>发送</span>
            </button>
          </div>
        </div>

        {/* File types hint */}
        <div className="flex items-center justify-center gap-1 mt-1.5">
          {[<FileText size={10} />, 'PDF', '·', 'Word', '·', 'Excel', '·', 'PPT', '·', 'TXT'].map((item, i) => (
            <span key={i} className="text-[10px]" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
              {item}
            </span>
          ))}
          <span className="text-[10px]" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>拖拽上传</span>
        </div>
      </div>
    </div>
  );
}
