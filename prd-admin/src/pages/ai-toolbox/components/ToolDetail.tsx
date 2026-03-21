import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useToolboxStore } from '@/stores/toolboxStore';
import { formatDistanceToNow } from '@/lib/dateUtils';
import {
  streamDirectChat,
  uploadAttachment,
  listToolboxSessions,
  createToolboxSession,
  deleteToolboxSession,
  listToolboxMessages,
  appendToolboxMessage,
  toggleToolboxItemPublish,
} from '@/services/real/aiToolbox';
import type { DirectChatMessage, ToolboxSessionInfo } from '@/services/real/aiToolbox';
import {
  ArrowLeft, Edit, Trash2, Zap, Tag, Calendar, User, Send,
  FileText, Palette, PenTool, Bug, Code2, Languages, FileSearch, BarChart3,
  Bot, Lightbulb, Target, Wrench, Sparkles, Rocket, MessageSquare,
  Brain, Cpu, Database, Globe, Image, Music, Video, BookOpen,
  GraduationCap, Briefcase, Heart, Star, Shield, Lock, Search, Layers,
  Swords, Paperclip, ImagePlus, X, File, Loader2,
  Plus, MessageCircle, Share2, Globe2, AlertCircle,
  Square, Copy, Check, RotateCcw, RefreshCw, Download, Eraser,
  ThumbsUp, ThumbsDown, Pencil,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import 'katex/dist/katex.min.css';
import { toast } from '@/lib/toast';

// 图标组件映射
const ICON_MAP: Record<string, LucideIcon> = {
  FileText, Palette, PenTool, Bug, Code2, Languages, FileSearch, BarChart3,
  Bot, Lightbulb, Target, Wrench, Sparkles, Rocket, MessageSquare, Zap,
  Brain, Cpu, Database, Globe, Image, Music, Video, BookOpen,
  GraduationCap, Briefcase, Heart, Star, Shield, Lock, Search, Layers, Swords,
};

const ICON_HUE_MAP: Record<string, number> = {
  FileText: 210, Palette: 330, PenTool: 45, Bug: 0, Code2: 180, Languages: 200,
  FileSearch: 50, BarChart3: 270, Bot: 210, Lightbulb: 45, Target: 0, Wrench: 30,
  Sparkles: 280, Rocket: 210, MessageSquare: 180, Zap: 45, Brain: 270, Cpu: 200,
  Database: 220, Globe: 180, Image: 330, Music: 300, Video: 0, BookOpen: 140,
  GraduationCap: 220, Briefcase: 30, Heart: 350, Star: 45, Shield: 210, Lock: 200,
  Search: 180, Layers: 240, Swords: 30,
};

function getIconComponent(iconName: string): LucideIcon {
  return ICON_MAP[iconName] || Bot;
}

function getAccentHue(iconName: string): number {
  return ICON_HUE_MAP[iconName] ?? 210;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Array<{ id: string; name: string; type: 'file' | 'image'; url?: string; size?: number }>;
  attachmentIds?: string[];
  timestamp: Date;
  isStreaming?: boolean;
}

interface Attachment {
  id: string;
  file: File;
  name: string;
  type: 'file' | 'image';
  preview?: string;
}

export function ToolDetail() {
  const { selectedItem, backToGrid, startEdit, deleteItem } = useToolboxStore();
  const [input, setInput] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Session management
  const [sessions, setSessions] = useState<ToolboxSessionInfo[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // Publish state
  const [isPublic, setIsPublic] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + 'px';
    }
  }, [input]);

  useEffect(() => {
    return () => { abortRef.current?.(); };
  }, []);

  // Load sessions when item changes
  useEffect(() => {
    if (!selectedItem) return;
    setIsPublic(!!selectedItem.isPublic);
    loadSessions();
  }, [selectedItem?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSessions = useCallback(async () => {
    if (!selectedItem) return;
    setSessionsLoading(true);
    try {
      const res = await listToolboxSessions(selectedItem.id);
      if (res.success && res.data) {
        setSessions(res.data.sessions);
        // Auto-select the most recent session, or none
        if (res.data.sessions.length > 0) {
          await switchToSession(res.data.sessions[0].id);
        }
      }
    } catch { /* silent */ }
    finally { setSessionsLoading(false); }
  }, [selectedItem?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchToSession = async (sessionId: string) => {
    setCurrentSessionId(sessionId);
    setMessages([]);
    try {
      const res = await listToolboxMessages(sessionId);
      if (res.success && res.data) {
        setMessages(res.data.messages.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content,
          attachmentIds: m.attachmentIds?.length ? m.attachmentIds : undefined,
          timestamp: new Date(m.createdAt),
        })));
      }
    } catch { /* silent */ }
  };

  const handleNewSession = async () => {
    if (!selectedItem) return;
    try {
      const res = await createToolboxSession(selectedItem.id);
      if (res.success && res.data) {
        setSessions(prev => [res.data!, ...prev]);
        setCurrentSessionId(res.data.id);
        setMessages([]);
      }
    } catch { /* silent */ }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      await deleteToolboxSession(sessionId);
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      if (currentSessionId === sessionId) {
        setCurrentSessionId(null);
        setMessages([]);
      }
    } catch { /* silent */ }
  };

  const handleTogglePublish = async () => {
    if (!selectedItem) return;
    const newValue = !isPublic;
    const res = await toggleToolboxItemPublish(selectedItem.id, newValue);
    if (res.success) setIsPublic(newValue);
  };

  if (!selectedItem) return null;

  const IconComponent = getIconComponent(selectedItem.icon);
  const accentHue = getAccentHue(selectedItem.icon);
  const isCustom = selectedItem.type === 'custom';

  // Get welcome message and starters from item (custom) or defaults (builtin)
  const welcomeMessage = selectedItem.welcomeMessage || getWelcomeText(selectedItem.agentKey);
  const conversationStarters: string[] = selectedItem.conversationStarters || [];

  const handleSend = async (overrideMessage?: string, overrideAttachmentIds?: string[], messagesSnapshot?: ChatMessage[]) => {
    const messageText = (overrideMessage || input).trim();
    if (!messageText && attachments.length === 0 && !overrideAttachmentIds?.length) return;
    if (!selectedItem) return;

    // Ensure we have a session
    let sessionId = currentSessionId;
    if (!sessionId) {
      try {
        const res = await createToolboxSession(selectedItem.id);
        if (res.success && res.data) {
          sessionId = res.data.id;
          setSessions(prev => [res.data!, ...prev]);
          setCurrentSessionId(sessionId);
        }
      } catch { /* continue without session */ }
    }

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: messageText,
      attachments: attachments.map(a => ({ id: a.id, name: a.name, type: a.type, url: a.preview, size: a.file.size })),
      attachmentIds: [], // will be filled after upload
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    const currentAttachments = [...attachments];
    setInput('');
    setAttachments([]);
    setIsLoading(true);

    // Upload new attachments, or reuse existing IDs (for regenerate)
    const attachmentIds: string[] = overrideAttachmentIds ? [...overrideAttachmentIds] : [];
    if (!overrideAttachmentIds) {
      for (const att of currentAttachments) {
        try {
          const result = await uploadAttachment(att.file);
          if (result.success && result.data?.attachmentId) {
            attachmentIds.push(result.data.attachmentId);
          } else {
            const errMsg = result.error?.message || '上传失败';
            toast.error(`文件 "${att.name}" 上传失败: ${errMsg}`);
          }
        } catch (err) {
          toast.error(`文件 "${att.name}" 上传异常`);
        }
      }
    }

    // Store attachmentIds on the user message for history tracking
    if (attachmentIds.length > 0) {
      setMessages(prev => prev.map(m => m.id === userMessage.id ? { ...m, attachmentIds } : m));
    }

    // Persist user message to backend
    if (sessionId) {
      appendToolboxMessage(sessionId, {
        role: 'user', content: messageText, attachmentIds,
      }).catch(() => {});
    }

    // Build history (include attachmentIds so backend can inject images for multi-turn context)
    const historySource = messagesSnapshot ?? messages;
    const history: DirectChatMessage[] = historySource.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.attachmentIds?.length ? { attachmentIds: m.attachmentIds } : {}),
    }));

    // Create streaming assistant placeholder
    const assistantId = (Date.now() + 1).toString();
    setMessages(prev => [...prev, { id: assistantId, role: 'assistant', content: '', timestamp: new Date(), isStreaming: true }]);

    let fullContent = '';

    const abort = streamDirectChat({
      message: messageText,
      agentKey: selectedItem.agentKey,
      itemId: isCustom ? selectedItem.id : undefined,
      sessionId: sessionId ?? undefined,
      history,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      onText: (content) => {
        fullContent += content;
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: m.content + content } : m));
      },
      onError: (error) => {
        setMessages(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: m.content || `[错误] ${error}`, isStreaming: false } : m
        ));
        setIsLoading(false);
        abortRef.current = null;
      },
      onDone: () => {
        setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, isStreaming: false } : m));
        setIsLoading(false);
        abortRef.current = null;
        // Persist assistant message
        if (sessionId && fullContent) {
          appendToolboxMessage(sessionId, { role: 'assistant', content: fullContent }).catch(() => {});
        }
      },
    });

    abortRef.current = abort;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, type: 'file' | 'image') => {
    const files = e.target.files;
    if (!files) return;
    const newAttachments: Attachment[] = Array.from(files).map(file => {
      const att: Attachment = { id: Math.random().toString(36).substr(2, 9), file, name: file.name, type };
      if (type === 'image' && file.type.startsWith('image/')) att.preview = URL.createObjectURL(file);
      return att;
    });
    setAttachments(prev => [...prev, ...newAttachments]);
    e.target.value = '';
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => {
      const att = prev.find(a => a.id === id);
      if (att?.preview) URL.revokeObjectURL(att.preview);
      return prev.filter(a => a.id !== id);
    });
  };

  const handleDelete = async () => {
    if (!confirm('确定要删除这个智能体吗？')) return;
    setIsDeleting(true);
    await deleteItem(selectedItem.id);
    setIsDeleting(false);
  };

  const handleRegenerate = (assistantMsgId: string) => {
    if (isLoading) return;
    const idx = messages.findIndex(m => m.id === assistantMsgId);
    if (idx < 1) return;
    const prevUserMsg = [...messages].slice(0, idx).reverse().find(m => m.role === 'user');
    if (!prevUserMsg) return;
    // Remove the old assistant message — use functional update to ensure
    // the state is committed before handleSend reads it via messagesRef
    const filteredMessages = messages.filter(m => m.id !== assistantMsgId);
    setMessages(filteredMessages);
    // Pass filtered snapshot so handleSend builds correct history
    handleSend(prevUserMsg.content, prevUserMsg.attachmentIds, filteredMessages);
  };

  const handleExportChat = () => {
    if (messages.length === 0) return;
    const lines = messages.map(m => {
      const time = m.timestamp.toLocaleString('zh-CN');
      const role = m.role === 'user' ? '我' : selectedItem.name;
      return `### ${role}  (${time})\n\n${m.content}\n`;
    });
    const md = `# ${selectedItem.name} — 对话记录\n\n${lines.join('\n---\n\n')}`;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedItem.name}_chat_${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('对话已导出');
  };

  const handleClearChat = () => {
    if (messages.length === 0) return;
    if (!confirm('确定清空当前会话消息？')) return;
    setMessages([]);
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {/* Header */}
      <TabBar
        title={selectedItem.name}
        icon={<IconComponent size={18} style={{ color: `hsla(${accentHue}, 70%, 70%, 1)` }} />}
        items={[]}
        activeKey=""
        onChange={() => {}}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={backToGrid}>
              <ArrowLeft size={14} />
              返回
            </Button>
            {isCustom && (
              <>
                <Button variant="secondary" size="sm" onClick={handleTogglePublish} title={isPublic ? '取消发布' : '发布到市场'}>
                  {isPublic ? <Globe2 size={14} /> : <Share2 size={14} />}
                  {isPublic ? '已公开' : '发布'}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => startEdit(selectedItem)}>
                  <Edit size={14} />
                  编辑
                </Button>
                <Button variant="secondary" size="sm" onClick={handleDelete} disabled={isDeleting} style={{ color: 'var(--status-error)' }}>
                  <Trash2 size={14} />
                  删除
                </Button>
              </>
            )}
          </div>
        }
      />

      <div className="flex-1 min-h-0 flex gap-4">
        {/* Left: Info + Sessions Panel */}
        <div className="w-72 flex-shrink-0 flex flex-col gap-3 overflow-y-auto">
          <GlassCard animated className="p-4" variant="subtle">
            <div className="flex items-center gap-3 mb-3">
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center"
                style={{
                  background: `linear-gradient(135deg, hsla(${accentHue}, 70%, 60%, 0.18) 0%, hsla(${accentHue}, 70%, 40%, 0.1) 100%)`,
                  boxShadow: `0 4px 16px -4px hsla(${accentHue}, 70%, 50%, 0.35), inset 0 1px 0 0 rgba(255,255,255,0.12)`,
                  border: `1px solid hsla(${accentHue}, 60%, 60%, 0.25)`,
                }}
              >
                <IconComponent size={24} style={{ color: `hsla(${accentHue}, 70%, 70%, 1)` }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate" style={{ color: 'var(--text-primary)' }}>{selectedItem.name}</div>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full"
                  style={{
                    background: isCustom ? 'rgba(34, 197, 94, 0.15)' : `hsla(${accentHue}, 60%, 50%, 0.15)`,
                    color: isCustom ? 'rgb(74, 222, 128)' : `hsla(${accentHue}, 70%, 70%, 1)`,
                  }}
                >
                  {isCustom ? '自定义' : '内置工具'}
                </span>
              </div>
            </div>
            <div className="text-xs mb-3 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{selectedItem.description}</div>
            <div className="space-y-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {selectedItem.usageCount > 0 && <div className="flex items-center gap-1.5"><Zap size={11} /><span>已使用 {selectedItem.usageCount} 次</span></div>}
              {selectedItem.createdByName && <div className="flex items-center gap-1.5"><User size={11} /><span>{selectedItem.createdByName}</span></div>}
              <div className="flex items-center gap-1.5"><Calendar size={11} /><span>{formatDistanceToNow(new Date(selectedItem.createdAt))}</span></div>
            </div>
            {selectedItem.tags.length > 0 && (
              <div className="mt-3 pt-3 border-t" style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}>
                <div className="flex items-center gap-1 text-[10px] mb-1.5" style={{ color: 'var(--text-muted)' }}><Tag size={10} /> 标签</div>
                <div className="flex flex-wrap gap-1">
                  {selectedItem.tags.map(tag => (
                    <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(255, 255, 255, 0.05)', color: 'var(--text-secondary)' }}>{tag}</span>
                  ))}
                </div>
              </div>
            )}
          </GlassCard>

          {/* Sessions List */}
          <GlassCard animated className="p-3 flex-1 min-h-0 flex flex-col" variant="subtle">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>会话列表</span>
              <button onClick={handleNewSession} className="p-1 rounded-lg hover:bg-white/10 transition-colors" title="新建会话">
                <Plus size={14} style={{ color: 'var(--text-muted)' }} />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
              {sessionsLoading && <div className="text-[11px] text-center py-2" style={{ color: 'var(--text-muted)' }}>加载中...</div>}
              {!sessionsLoading && sessions.length === 0 && (
                <div className="text-[11px] text-center py-4" style={{ color: 'var(--text-muted)' }}>暂无会话，发送消息自动创建</div>
              )}
              {sessions.map(s => (
                <div
                  key={s.id}
                  className="group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors"
                  style={{
                    background: s.id === currentSessionId ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                  }}
                  onClick={() => switchToSession(s.id)}
                >
                  <MessageCircle size={12} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>{s.title}</div>
                    <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{s.messageCount} 条消息</div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-white/10 transition-all"
                  >
                    <X size={10} style={{ color: 'var(--text-muted)' }} />
                  </button>
                </div>
              ))}
            </div>
          </GlassCard>
        </div>

        {/* Right: Chat Interface */}
        <GlassCard animated className="flex-1 min-w-0 flex flex-col" padding="none" overflow="hidden">
          {/* Chat toolbar */}
          {messages.length > 0 && (
            <div className="flex items-center justify-end gap-1 px-4 pt-2">
              <button
                onClick={handleExportChat}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] hover:bg-white/10 transition-colors"
                style={{ color: 'var(--text-muted)' }}
                title="导出对话"
              >
                <Download size={12} />
                <span>导出</span>
              </button>
              <button
                onClick={handleClearChat}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] hover:bg-white/10 transition-colors"
                style={{ color: 'var(--text-muted)' }}
                title="清空对话"
              >
                <Eraser size={12} />
                <span>清空</span>
              </button>
            </div>
          )}
          {/* Chat Messages */}
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-8">
                <div
                  className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                  style={{
                    background: `linear-gradient(135deg, hsla(${accentHue}, 70%, 60%, 0.15) 0%, hsla(${accentHue}, 70%, 40%, 0.08) 100%)`,
                    border: `1px solid hsla(${accentHue}, 60%, 60%, 0.2)`,
                  }}
                >
                  <IconComponent size={32} style={{ color: `hsla(${accentHue}, 70%, 70%, 0.8)` }} />
                </div>
                <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                  {selectedItem.name}
                </div>
                <div className="text-xs max-w-sm mb-4" style={{ color: 'var(--text-muted)' }}>
                  {welcomeMessage}
                </div>
                {/* Conversation Starters */}
                {conversationStarters.length > 0 && (
                  <div className="flex flex-wrap gap-2 justify-center max-w-md">
                    {conversationStarters.map((starter, i) => (
                      <button
                        key={i}
                        className="text-xs px-3 py-1.5 rounded-full transition-colors hover:bg-white/10"
                        style={{ border: '1px solid rgba(255, 255, 255, 0.1)', color: 'var(--text-secondary)' }}
                        onClick={() => handleSend(starter)}
                      >
                        {starter}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                {messages.map((message, idx) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    accentHue={accentHue}
                    onCopy={message.role === 'assistant' && message.content && !message.isStreaming ? () => {
                      navigator.clipboard.writeText(message.content);
                      toast.success('已复制到剪贴板');
                    } : undefined}
                    onRegenerate={message.role === 'assistant' && !message.isStreaming && message.content && !isLoading ? () => {
                      handleRegenerate(message.id);
                    } : undefined}
                    onRetry={message.content?.startsWith('[错误]') && idx === messages.length - 1 ? () => {
                      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
                      if (lastUserMsg) {
                        setMessages(prev => prev.filter(m => m.id !== message.id));
                        handleSend(lastUserMsg.content, lastUserMsg.attachmentIds);
                      }
                    } : undefined}
                    onFeedback={message.role === 'assistant' && message.content && !message.isStreaming ? () => {} : undefined}
                    onEditMessage={message.role === 'user' && !isLoading ? (newContent: string) => {
                      // Remove this message and all subsequent messages, then resend
                      const msgIdx = messages.findIndex(m => m.id === message.id);
                      const truncated = messages.slice(0, msgIdx);
                      setMessages(truncated);
                      handleSend(newContent, message.attachmentIds, truncated);
                    } : undefined}
                  />
                ))}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Attachments Preview */}
          {attachments.length > 0 && (
            <div className="px-4 py-2 border-t flex flex-wrap gap-2" style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}>
              {attachments.map(attachment => (
                <div key={attachment.id} className="relative group flex items-center gap-2 px-2 py-1.5 rounded-lg" style={{ background: 'rgba(255, 255, 255, 0.05)' }}>
                  {attachment.type === 'image' && attachment.preview
                    ? <img src={attachment.preview} alt="" className="w-8 h-8 rounded object-cover" />
                    : <File size={16} style={{ color: 'var(--text-muted)' }} />}
                  <span className="text-xs truncate max-w-[120px]" style={{ color: 'var(--text-secondary)' }}>{attachment.name}</span>
                  <button onClick={() => removeAttachment(attachment.id)} className="p-0.5 rounded hover:bg-white/10 transition-colors">
                    <X size={12} style={{ color: 'var(--text-muted)' }} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Input Area */}
          <div className="p-4 border-t" style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}>
            <div className="flex items-end gap-2 p-2 rounded-xl" style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
              <div className="flex items-center gap-1 pb-1">
                <button onClick={() => fileInputRef.current?.click()} className="p-1.5 rounded-lg hover:bg-white/10 transition-colors" title="上传文件">
                  <Paperclip size={18} style={{ color: 'var(--text-muted)' }} />
                </button>
                <button onClick={() => imageInputRef.current?.click()} className="p-1.5 rounded-lg hover:bg-white/10 transition-colors" title="上传图片">
                  <ImagePlus size={18} style={{ color: 'var(--text-muted)' }} />
                </button>
              </div>
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入你的消息..."
                rows={1}
                className="flex-1 bg-transparent border-none outline-none resize-none text-sm py-1.5"
                style={{ color: 'var(--text-primary)', maxHeight: '150px' }}
              />
              {isLoading ? (
                <Button variant="secondary" size="sm" onClick={() => { abortRef.current?.(); setIsLoading(false); }} className="mb-0.5" title="停止生成">
                  <Square size={14} />
                </Button>
              ) : (
                <Button variant="primary" size="sm" onClick={() => handleSend()} disabled={!input.trim() && attachments.length === 0} className="mb-0.5">
                  <Send size={16} />
                </Button>
              )}
            </div>
            <div className="flex items-center justify-between mt-1 px-1">
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Enter 发送，Shift+Enter 换行
              </span>
              <span className="text-[10px]" style={{ color: input.length > 4000 ? 'var(--status-error)' : 'var(--text-muted)' }}>
                {input.length > 0 && `${input.length} 字`}
              </span>
            </div>
            <input ref={fileInputRef} type="file" multiple className="hidden" accept=".pdf,.doc,.docx,.txt,.md,.json,.csv,.xlsx,.xls,.ppt,.pptx" onChange={(e) => handleFileSelect(e, 'file')} />
            <input ref={imageInputRef} type="file" multiple className="hidden" accept="image/*" onChange={(e) => handleFileSelect(e, 'image')} />
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

// Allow KaTeX class names and styles through sanitizer
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span || []), 'className', 'style'],
    div: [...(defaultSchema.attributes?.div || []), 'className', 'style'],
    math: ['xmlns'],
  },
  tagNames: [...(defaultSchema.tagNames || []), 'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mover', 'munder', 'mtable', 'mtr', 'mtd', 'mtext', 'annotation'],
};

const AssistantMarkdown = memo(function AssistantMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          const codeStr = String(children).replace(/\n$/, '');
          if (match) {
            return (
              <div className="relative group/code my-2">
                <div className="flex items-center justify-between px-3 py-1 rounded-t-lg text-[10px]" style={{ background: 'rgba(0, 0, 0, 0.5)', color: 'var(--text-muted)' }}>
                  <span>{match[1]}</span>
                  <button
                    onClick={() => { navigator.clipboard.writeText(codeStr); toast.success('代码已复制'); }}
                    className="opacity-0 group-hover/code:opacity-100 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 transition-all"
                  >
                    <Copy size={10} /> 复制
                  </button>
                </div>
                <SyntaxHighlighter
                  style={oneDark}
                  language={match[1]}
                  PreTag="div"
                  customStyle={{ margin: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0, borderBottomLeftRadius: '0.5rem', borderBottomRightRadius: '0.5rem', fontSize: '0.75rem' }}
                >
                  {codeStr}
                </SyntaxHighlighter>
              </div>
            );
          }
          return (
            <code className="px-1 py-0.5 rounded text-xs" style={{ background: 'rgba(255, 255, 255, 0.1)' }} {...props}>{children}</code>
          );
        },
        pre({ children }) { return <>{children}</>; },
        p({ children }) { return <p className="mb-2 last:mb-0">{children}</p>; },
        ul({ children }) { return <ul className="list-disc pl-4 mb-2">{children}</ul>; },
        ol({ children }) { return <ol className="list-decimal pl-4 mb-2">{children}</ol>; },
        li({ children }) { return <li className="mb-0.5">{children}</li>; },
        h1({ children }) { return <h1 className="text-base font-bold mb-2">{children}</h1>; },
        h2({ children }) { return <h2 className="text-sm font-bold mb-1.5">{children}</h2>; },
        h3({ children }) { return <h3 className="text-sm font-semibold mb-1">{children}</h3>; },
        blockquote({ children }) {
          return <blockquote className="border-l-2 pl-3 my-2" style={{ borderColor: 'rgba(255,255,255,0.2)', color: 'var(--text-secondary)' }}>{children}</blockquote>;
        },
        table({ children }) {
          return <div className="overflow-x-auto my-2"><table className="text-xs border-collapse w-full" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>{children}</table></div>;
        },
        th({ children }) { return <th className="border px-2 py-1 text-left font-semibold" style={{ borderColor: 'rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)' }}>{children}</th>; },
        td({ children }) { return <td className="border px-2 py-1" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>{children}</td>; },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

function MessageBubble({ message, accentHue, onCopy, onRegenerate, onRetry, onFeedback, onEditMessage }: {
  message: ChatMessage; accentHue: number;
  onCopy?: () => void; onRegenerate?: () => void; onRetry?: () => void;
  onFeedback?: (type: 'up' | 'down') => void;
  onEditMessage?: (newContent: string) => void;
}) {
  const isUser = message.role === 'user';
  const isError = message.content?.startsWith('[错误]');
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');

  const handleCopy = () => {
    if (!onCopy) return;
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFeedback = (type: 'up' | 'down') => {
    setFeedback(prev => prev === type ? null : type);
    onFeedback?.(type);
  };

  const handleStartEdit = () => {
    setEditText(message.content);
    setIsEditing(true);
  };

  const handleConfirmEdit = () => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== message.content) {
      onEditMessage?.(trimmed);
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  return (
    <div className={`group/msg flex items-start gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{
          background: isUser
            ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.2) 0%, rgba(99, 102, 241, 0.1) 100%)'
            : `linear-gradient(135deg, hsla(${accentHue}, 70%, 60%, 0.15) 0%, hsla(${accentHue}, 70%, 40%, 0.08) 100%)`,
          border: isUser
            ? '1px solid rgba(99, 102, 241, 0.3)'
            : `1px solid hsla(${accentHue}, 60%, 60%, 0.2)`,
        }}
      >
        {isUser ? <User size={16} style={{ color: 'rgb(129, 140, 248)' }} /> : <Bot size={16} style={{ color: `hsla(${accentHue}, 70%, 70%, 1)` }} />}
      </div>
      <div className={`flex flex-col gap-1 max-w-[75%] ${isUser ? 'items-end' : 'items-start'}`}>
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-1">
            {message.attachments.map(att => (
              <div key={att.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg" style={{ background: 'rgba(255, 255, 255, 0.05)' }}>
                {att.type === 'image' && att.url
                  ? <img src={att.url} alt="" className="w-16 h-16 rounded object-cover" />
                  : <><File size={14} style={{ color: 'var(--text-muted)' }} /><span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{att.name}</span></>}
              </div>
            ))}
          </div>
        )}
        <div
          className={`px-3 py-2 rounded-xl text-sm leading-relaxed ${isUser ? 'rounded-tr-sm' : 'rounded-tl-sm'}`}
          style={{
            background: isError
              ? 'rgba(239, 68, 68, 0.1)'
              : isUser
                ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(99, 102, 241, 0.08) 100%)'
                : 'rgba(255, 255, 255, 0.03)',
            color: isError ? 'rgb(248, 113, 113)' : 'var(--text-primary)',
            border: isError ? '1px solid rgba(239, 68, 68, 0.2)' : undefined,
            minHeight: '1.5em',
          }}
        >
          {isError && <AlertCircle size={14} className="inline mr-1 mb-0.5" />}
          {isEditing ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                className="w-full bg-transparent border rounded-lg p-2 text-sm outline-none resize-none"
                style={{ borderColor: 'rgba(99, 102, 241, 0.3)', color: 'var(--text-primary)', minHeight: '60px' }}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleConfirmEdit(); }
                  if (e.key === 'Escape') handleCancelEdit();
                }}
              />
              <div className="flex items-center gap-2 justify-end">
                <button onClick={handleCancelEdit} className="text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors" style={{ color: 'var(--text-muted)' }}>取消</button>
                <button onClick={handleConfirmEdit} className="text-xs px-2 py-1 rounded transition-colors" style={{ background: 'rgba(99, 102, 241, 0.2)', color: 'rgb(129, 140, 248)' }}>发送</button>
              </div>
            </div>
          ) : message.content ? (
            isUser ? message.content : <AssistantMarkdown content={message.content} />
          ) : (
            message.isStreaming && <Loader2 size={16} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          )}
        </div>
        {/* Action buttons row */}
        {!isEditing && (
          <div className="flex items-center gap-1 px-1">
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {message.timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
            {onCopy && (
              <button
                onClick={handleCopy}
                className="opacity-0 group-hover/msg:opacity-100 p-0.5 rounded hover:bg-white/10 transition-all"
                title="复制内容"
              >
                {copied
                  ? <Check size={12} style={{ color: 'rgb(74, 222, 128)' }} />
                  : <Copy size={12} style={{ color: 'var(--text-muted)' }} />}
              </button>
            )}
            {onFeedback && (
              <>
                <button
                  onClick={() => handleFeedback('up')}
                  className="opacity-0 group-hover/msg:opacity-100 p-0.5 rounded hover:bg-white/10 transition-all"
                  title="有帮助"
                >
                  <ThumbsUp size={12} style={{ color: feedback === 'up' ? 'rgb(74, 222, 128)' : 'var(--text-muted)' }} fill={feedback === 'up' ? 'rgb(74, 222, 128)' : 'none'} />
                </button>
                <button
                  onClick={() => handleFeedback('down')}
                  className="opacity-0 group-hover/msg:opacity-100 p-0.5 rounded hover:bg-white/10 transition-all"
                  title="没有帮助"
                >
                  <ThumbsDown size={12} style={{ color: feedback === 'down' ? 'rgb(248, 113, 113)' : 'var(--text-muted)' }} fill={feedback === 'down' ? 'rgb(248, 113, 113)' : 'none'} />
                </button>
              </>
            )}
            {onRegenerate && (
              <button
                onClick={onRegenerate}
                className="opacity-0 group-hover/msg:opacity-100 p-0.5 rounded hover:bg-white/10 transition-all"
                title="重新生成"
              >
                <RefreshCw size={12} style={{ color: 'var(--text-muted)' }} />
              </button>
            )}
            {onEditMessage && (
              <button
                onClick={handleStartEdit}
                className="opacity-0 group-hover/msg:opacity-100 p-0.5 rounded hover:bg-white/10 transition-all"
                title="编辑消息"
              >
                <Pencil size={12} style={{ color: 'var(--text-muted)' }} />
              </button>
            )}
            {onRetry && (
              <button
                onClick={onRetry}
                className="opacity-0 group-hover/msg:opacity-100 flex items-center gap-0.5 px-1.5 py-0.5 rounded hover:bg-white/10 transition-all text-[10px]"
                style={{ color: 'var(--status-error)' }}
                title="重试"
              >
                <RotateCcw size={11} />
                <span>重试</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function getWelcomeText(agentKey?: string): string {
  switch (agentKey) {
    case 'prd-agent': return '你可以上传 PRD 文档或直接粘贴内容，我会帮你解读需求、识别缺口并回答问题。';
    case 'visual-agent': return '描述你想要的图片，支持上传参考图。我会根据你的描述生成高质量图像。';
    case 'literary-agent': return '告诉我你想创作的主题，我可以帮你写文章、故事、诗歌等文学作品。';
    case 'defect-agent': return '描述你发现的问题，包括复现步骤和预期行为，支持上传截图。';
    case 'code-reviewer': return '粘贴代码或上传文件，我会进行代码审查并提供改进建议。';
    case 'translator': return '输入或上传需要翻译的内容，支持多种语言之间的互译。';
    case 'summarizer': return '粘贴长文本或上传文档，我会提取关键信息并生成摘要。';
    case 'data-analyst': return '描述分析需求或上传数据文件，我会帮你进行数据分析和可视化建议。';
    default: return '发送消息开始对话，支持上传文件和图片。';
  }
}
