import { useState, useRef, useEffect, useCallback } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useToolboxStore } from '@/stores/toolboxStore';
import { formatDistanceToNow } from '@/lib/dateUtils';
import { streamDirectChat } from '@/services/real/aiToolbox';
import type { DirectChatMessage } from '@/services/real/aiToolbox';
import {
  ArrowLeft, Edit, Trash2, Zap, Tag, Calendar, User, Send,
  FileText, Palette, PenTool, Bug, Code2, Languages, FileSearch, BarChart3,
  Bot, Lightbulb, Target, Wrench, Sparkles, Rocket, MessageSquare,
  Brain, Cpu, Database, Globe, Image, Music, Video, BookOpen,
  GraduationCap, Briefcase, Heart, Star, Shield, Lock, Search, Layers,
  Paperclip, ImagePlus, X, File, Loader2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// 图标组件映射
const ICON_MAP: Record<string, LucideIcon> = {
  FileText, Palette, PenTool, Bug, Code2, Languages, FileSearch, BarChart3,
  Bot, Lightbulb, Target, Wrench, Sparkles, Rocket, MessageSquare, Zap,
  Brain, Cpu, Database, Globe, Image, Music, Video, BookOpen,
  GraduationCap, Briefcase, Heart, Star, Shield, Lock, Search, Layers,
};

// 图标名称到色相的映射
const ICON_HUE_MAP: Record<string, number> = {
  FileText: 210, Palette: 330, PenTool: 45, Bug: 0, Code2: 180, Languages: 200,
  FileSearch: 50, BarChart3: 270, Bot: 210, Lightbulb: 45, Target: 0, Wrench: 30,
  Sparkles: 280, Rocket: 210, MessageSquare: 180, Zap: 45, Brain: 270, Cpu: 200,
  Database: 220, Globe: 180, Image: 330, Music: 300, Video: 0, BookOpen: 140,
  GraduationCap: 220, Briefcase: 30, Heart: 350, Star: 45, Shield: 210, Lock: 200,
  Search: 180, Layers: 240,
};

function getIconComponent(iconName: string): LucideIcon {
  return ICON_MAP[iconName] || Bot;
}

function getAccentHue(iconName: string): number {
  return ICON_HUE_MAP[iconName] ?? 210;
}

// 消息类型
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Array<{
    id: string;
    name: string;
    type: 'file' | 'image';
    url?: string;
    size?: number;
  }>;
  timestamp: Date;
  isStreaming?: boolean;
}

// 附件类型
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

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 自动调整 textarea 高度
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + 'px';
    }
  }, [input]);

  // 组件卸载时中止进行中的流
  useEffect(() => {
    return () => {
      abortRef.current?.();
    };
  }, []);

  if (!selectedItem) return null;

  const IconComponent = getIconComponent(selectedItem.icon);
  const accentHue = getAccentHue(selectedItem.icon);

  const handleSend = useCallback(async () => {
    if (!input.trim() && attachments.length === 0) return;
    if (!selectedItem) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
      attachments: attachments.map(a => ({
        id: a.id,
        name: a.name,
        type: a.type,
        url: a.preview,
        size: a.file.size,
      })),
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    const messageText = input.trim();
    setInput('');
    setAttachments([]);
    setIsLoading(true);

    // 构建历史消息（排除当前消息）
    const history: DirectChatMessage[] = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    // 创建流式助手消息
    const assistantId = (Date.now() + 1).toString();
    setMessages(prev => [...prev, {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      isStreaming: true,
    }]);

    // 调用真实 SSE 流式 API
    const abort = streamDirectChat({
      message: messageText,
      agentKey: selectedItem.agentKey,
      itemId: selectedItem.type === 'custom' ? selectedItem.id : undefined,
      history,
      onText: (content) => {
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: m.content + content }
            : m
        ));
      },
      onError: (error) => {
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, content: m.content || `[错误] ${error}`, isStreaming: false }
            : m
        ));
        setIsLoading(false);
        abortRef.current = null;
      },
      onDone: () => {
        setMessages(prev => prev.map(m =>
          m.id === assistantId
            ? { ...m, isStreaming: false }
            : m
        ));
        setIsLoading(false);
        abortRef.current = null;
      },
    });

    abortRef.current = abort;
  }, [input, attachments, selectedItem, messages]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, type: 'file' | 'image') => {
    const files = e.target.files;
    if (!files) return;

    const newAttachments: Attachment[] = Array.from(files).map(file => {
      const attachment: Attachment = {
        id: Math.random().toString(36).substr(2, 9),
        file,
        name: file.name,
        type,
      };

      if (type === 'image' && file.type.startsWith('image/')) {
        attachment.preview = URL.createObjectURL(file);
      }

      return attachment;
    });

    setAttachments(prev => [...prev, ...newAttachments]);
    e.target.value = '';
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => {
      const attachment = prev.find(a => a.id === id);
      if (attachment?.preview) {
        URL.revokeObjectURL(attachment.preview);
      }
      return prev.filter(a => a.id !== id);
    });
  };

  const handleDelete = async () => {
    if (!confirm('确定要删除这个工具吗？')) return;
    setIsDeleting(true);
    await deleteItem(selectedItem.id);
    setIsDeleting(false);
  };

  const isCustom = selectedItem.type === 'custom';

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
                <Button variant="secondary" size="sm" onClick={() => startEdit(selectedItem)}>
                  <Edit size={14} />
                  编辑
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleDelete}
                  disabled={isDeleting}
                  style={{ color: 'var(--status-error)' }}
                >
                  <Trash2 size={14} />
                  删除
                </Button>
              </>
            )}
          </div>
        }
      />

      <div className="flex-1 min-h-0 flex gap-4">
        {/* Left: Info Panel */}
        <div className="w-72 flex-shrink-0 flex flex-col gap-3">
          <GlassCard className="p-4" variant="subtle">
            {/* Icon & Name */}
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
                <div className="font-medium text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                  {selectedItem.name}
                </div>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full"
                  style={{
                    background: selectedItem.type === 'builtin'
                      ? `hsla(${accentHue}, 60%, 50%, 0.15)`
                      : 'rgba(34, 197, 94, 0.15)',
                    color: selectedItem.type === 'builtin'
                      ? `hsla(${accentHue}, 70%, 70%, 1)`
                      : 'rgb(74, 222, 128)',
                  }}
                >
                  {selectedItem.type === 'builtin' ? '内置工具' : '自定义'}
                </span>
              </div>
            </div>

            {/* Description */}
            <div className="text-xs mb-3 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              {selectedItem.description}
            </div>

            {/* Meta */}
            <div className="space-y-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {selectedItem.usageCount > 0 && (
                <div className="flex items-center gap-1.5">
                  <Zap size={11} />
                  <span>已使用 {selectedItem.usageCount} 次</span>
                </div>
              )}
              {selectedItem.createdByName && (
                <div className="flex items-center gap-1.5">
                  <User size={11} />
                  <span>{selectedItem.createdByName}</span>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <Calendar size={11} />
                <span>{formatDistanceToNow(new Date(selectedItem.createdAt))}</span>
              </div>
            </div>

            {/* Tags */}
            {selectedItem.tags.length > 0 && (
              <div className="mt-3 pt-3 border-t" style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}>
                <div className="flex items-center gap-1 text-[10px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
                  <Tag size={10} />
                  标签
                </div>
                <div className="flex flex-wrap gap-1">
                  {selectedItem.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-[10px] px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(255, 255, 255, 0.05)', color: 'var(--text-secondary)' }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </GlassCard>

          {/* Agent Key */}
          {selectedItem.agentKey && (
            <GlassCard className="p-3" variant="subtle">
              <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>
                关联 Agent
              </div>
              <code
                className="text-xs px-2 py-1 rounded block"
                style={{ background: 'var(--bg-base)', color: `hsla(${accentHue}, 70%, 70%, 1)` }}
              >
                {selectedItem.agentKey}
              </code>
            </GlassCard>
          )}
        </div>

        {/* Right: Chat Interface */}
        <GlassCard className="flex-1 min-w-0 flex flex-col" padding="none" overflow="hidden">
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
                  开始与 {selectedItem.name} 对话
                </div>
                <div className="text-xs max-w-sm" style={{ color: 'var(--text-muted)' }}>
                  {getWelcomeText(selectedItem.agentKey)}
                </div>
              </div>
            ) : (
              <>
                {messages.map((message) => (
                  <MessageBubble key={message.id} message={message} accentHue={accentHue} />
                ))}
                {isLoading && messages[messages.length - 1]?.content === '' && (
                  <div className="flex items-start gap-3">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{
                        background: `linear-gradient(135deg, hsla(${accentHue}, 70%, 60%, 0.15) 0%, hsla(${accentHue}, 70%, 40%, 0.08) 100%)`,
                        border: `1px solid hsla(${accentHue}, 60%, 60%, 0.2)`,
                      }}
                    >
                      <IconComponent size={16} style={{ color: `hsla(${accentHue}, 70%, 70%, 1)` }} />
                    </div>
                    <div
                      className="px-3 py-2 rounded-xl rounded-tl-sm"
                      style={{ background: 'rgba(255, 255, 255, 0.03)' }}
                    >
                      <Loader2 size={16} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Attachments Preview */}
          {attachments.length > 0 && (
            <div className="px-4 py-2 border-t flex flex-wrap gap-2" style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}>
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  className="relative group flex items-center gap-2 px-2 py-1.5 rounded-lg"
                  style={{ background: 'rgba(255, 255, 255, 0.05)' }}
                >
                  {attachment.type === 'image' && attachment.preview ? (
                    <img src={attachment.preview} alt="" className="w-8 h-8 rounded object-cover" />
                  ) : (
                    <File size={16} style={{ color: 'var(--text-muted)' }} />
                  )}
                  <span className="text-xs truncate max-w-[120px]" style={{ color: 'var(--text-secondary)' }}>
                    {attachment.name}
                  </span>
                  <button
                    onClick={() => removeAttachment(attachment.id)}
                    className="p-0.5 rounded hover:bg-white/10 transition-colors"
                  >
                    <X size={12} style={{ color: 'var(--text-muted)' }} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Input Area */}
          <div className="p-4 border-t" style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}>
            <div
              className="flex items-end gap-2 p-2 rounded-xl"
              style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.08)' }}
            >
              {/* Attachment Buttons */}
              <div className="flex items-center gap-1 pb-1">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                  title="上传文件"
                >
                  <Paperclip size={18} style={{ color: 'var(--text-muted)' }} />
                </button>
                <button
                  onClick={() => imageInputRef.current?.click()}
                  className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                  title="上传图片"
                >
                  <ImagePlus size={18} style={{ color: 'var(--text-muted)' }} />
                </button>
              </div>

              {/* Text Input */}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={getPlaceholder(selectedItem.agentKey)}
                rows={1}
                className="flex-1 bg-transparent border-none outline-none resize-none text-sm py-1.5"
                style={{ color: 'var(--text-primary)', maxHeight: '150px' }}
              />

              {/* Send Button */}
              <Button
                variant="primary"
                size="sm"
                onClick={handleSend}
                disabled={!input.trim() && attachments.length === 0}
                className="mb-0.5"
              >
                <Send size={16} />
              </Button>
            </div>

            {/* Hidden File Inputs */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              accept=".pdf,.doc,.docx,.txt,.md,.json,.csv,.xlsx"
              onChange={(e) => handleFileSelect(e, 'file')}
            />
            <input
              ref={imageInputRef}
              type="file"
              multiple
              className="hidden"
              accept="image/*"
              onChange={(e) => handleFileSelect(e, 'image')}
            />
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

// 消息气泡组件
function MessageBubble({ message, accentHue }: { message: ChatMessage; accentHue: number }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex items-start gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Avatar */}
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
        {isUser ? (
          <User size={16} style={{ color: 'rgb(129, 140, 248)' }} />
        ) : (
          <Bot size={16} style={{ color: `hsla(${accentHue}, 70%, 70%, 1)` }} />
        )}
      </div>

      {/* Content */}
      <div className={`flex flex-col gap-1 max-w-[75%] ${isUser ? 'items-end' : 'items-start'}`}>
        {/* Attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-1">
            {message.attachments.map((att) => (
              <div
                key={att.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg"
                style={{ background: 'rgba(255, 255, 255, 0.05)' }}
              >
                {att.type === 'image' && att.url ? (
                  <img src={att.url} alt="" className="w-16 h-16 rounded object-cover" />
                ) : (
                  <>
                    <File size={14} style={{ color: 'var(--text-muted)' }} />
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {att.name}
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Message Text */}
        {message.content && (
          <div
            className={`px-3 py-2 rounded-xl text-sm leading-relaxed ${
              isUser ? 'rounded-tr-sm' : 'rounded-tl-sm'
            }`}
            style={{
              background: isUser
                ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(99, 102, 241, 0.08) 100%)'
                : 'rgba(255, 255, 255, 0.03)',
              color: 'var(--text-primary)',
            }}
          >
            {message.content}
          </div>
        )}

        {/* Timestamp */}
        <span className="text-[10px] px-1" style={{ color: 'var(--text-muted)' }}>
          {message.timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  );
}

function getPlaceholder(agentKey?: string): string {
  switch (agentKey) {
    case 'prd-agent':
      return '输入你的问题，或粘贴 PRD 内容...';
    case 'visual-agent':
      return '描述你想要生成的图片...';
    case 'literary-agent':
      return '输入你想要创作的内容主题...';
    case 'defect-agent':
      return '描述你发现的 Bug...';
    case 'code-reviewer':
      return '粘贴需要审查的代码...';
    case 'translator':
      return '输入需要翻译的内容...';
    case 'summarizer':
      return '粘贴需要摘要的文本...';
    case 'data-analyst':
      return '描述你的数据分析需求...';
    default:
      return '输入你的消息...';
  }
}

function getWelcomeText(agentKey?: string): string {
  switch (agentKey) {
    case 'prd-agent':
      return '你可以上传 PRD 文档或直接粘贴内容，我会帮你解读需求、识别缺口并回答问题。';
    case 'visual-agent':
      return '描述你想要的图片，支持上传参考图。我会根据你的描述生成高质量图像。';
    case 'literary-agent':
      return '告诉我你想创作的主题，我可以帮你写文章、故事、诗歌等文学作品。';
    case 'defect-agent':
      return '描述你发现的问题，包括复现步骤和预期行为，支持上传截图。';
    case 'code-reviewer':
      return '粘贴代码或上传文件，我会进行代码审查并提供改进建议。';
    case 'translator':
      return '输入或上传需要翻译的内容，支持多种语言之间的互译。';
    case 'summarizer':
      return '粘贴长文本或上传文档，我会提取关键信息并生成摘要。';
    case 'data-analyst':
      return '描述分析需求或上传数据文件，我会帮你进行数据分析和可视化建议。';
    default:
      return '发送消息开始对话，支持上传文件和图片。';
  }
}

