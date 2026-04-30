import { useState, useRef, useEffect, useCallback } from 'react';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useToolboxStore } from '@/stores/toolboxStore';
import { Button } from '@/components/design/Button';
import { Surface } from '@/components/design';
import { streamCapabilityChat } from '@/services/real/aiToolbox';
import type { DirectChatMessage } from '@/services/real/aiToolbox';
import { cn } from '@/lib/cn';
import type { LucideIcon } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { ToolboxPageShell } from './ToolboxShell';
import {
  Wrench,
  Image,
  Brain,
  MessageSquare,
  Globe,
  Code2,
  FileText,
  Zap,
  Settings,
  Send,
  ChevronRight,
  Paperclip,
  X,
  ImageIcon,
  FileUp,
  Bot,
  User,
  Copy,
  RotateCcw,
  Sparkles,
} from 'lucide-react';

// 基础能力定义
interface Capability {
  key: string;
  name: string;
  description: string;
  icon: LucideIcon;
  hue: number;
  category: 'generation' | 'reasoning' | 'tools';
  status: 'available' | 'beta' | 'coming_soon';
  placeholder?: string;
  supportsImage?: boolean;
  supportsFile?: boolean;
}

const CAPABILITIES: Capability[] = [
  {
    key: 'image-gen',
    name: '图片生成',
    description: '使用 AI 模型生成图片，支持文生图、图生图',
    icon: Image,
    hue: 330,
    category: 'generation',
    status: 'available',
    placeholder: '描述你想生成的图片，例如：一只橙色的猫在阳光下睡觉...',
    supportsImage: true,
  },
  {
    key: 'text-gen',
    name: '文本生成',
    description: '智能文本生成，支持多种模型和参数调节',
    icon: MessageSquare,
    hue: 210,
    category: 'generation',
    status: 'available',
    placeholder: '输入你的问题或需求...',
  },
  {
    key: 'reasoning',
    name: '推理能力',
    description: '复杂推理与思考链，支持多步骤推理任务',
    icon: Brain,
    hue: 270,
    category: 'reasoning',
    status: 'available',
    placeholder: '输入需要推理的问题，例如：如果 A > B，B > C，那么 A 和 C 的关系是...',
  },
  {
    key: 'web-search',
    name: '联网搜索',
    description: '实时搜索互联网获取最新信息',
    icon: Globe,
    hue: 180,
    category: 'tools',
    status: 'available',
    placeholder: '输入搜索关键词或问题...',
  },
  {
    key: 'code-interpreter',
    name: '代码解释器',
    description: '执行代码并返回结果，支持多种编程语言',
    icon: Code2,
    hue: 160,
    category: 'tools',
    status: 'beta',
    placeholder: '输入需要执行的代码或编程任务...',
    supportsFile: true,
  },
  {
    key: 'file-reader',
    name: '文档解析',
    description: '解析 PDF、Word、Excel 等文档',
    icon: FileText,
    hue: 45,
    category: 'tools',
    status: 'available',
    placeholder: '上传文档后，输入你想了解的内容...',
    supportsFile: true,
  },
  {
    key: 'mcp-tools',
    name: 'MCP 工具',
    description: '连接外部 MCP 服务器扩展能力',
    icon: Zap,
    hue: 50,
    category: 'tools',
    status: 'beta',
    placeholder: '选择 MCP 工具并输入参数...',
  },
];

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  attachments?: { type: 'image' | 'file'; name: string; url?: string }[];
  status?: 'pending' | 'streaming' | 'done' | 'error';
}

export function BasicCapabilities() {
  const { isMobile } = useBreakpoint();
  const { pageTab, setPageTab } = useToolboxStore();
  const [selectedCapability, setSelectedCapability] = useState<string | null>(CAPABILITIES[0]?.key ?? null);
  const [inputText, setInputText] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [attachments, setAttachments] = useState<{ type: 'image' | 'file'; name: string; file: File }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<(() => void) | null>(null);

  const selectedCap = CAPABILITIES.find((c) => c.key === selectedCapability);
  const availableCount = CAPABILITIES.filter((c) => c.status === 'available').length;
  const betaCount = CAPABILITIES.filter((c) => c.status === 'beta').length;

  // 组件卸载或切换能力时中止流
  useEffect(() => {
    return () => {
      abortRef.current?.();
    };
  }, [selectedCapability]);

  const handleSend = useCallback(async () => {
    if (!inputText.trim() && attachments.length === 0) return;
    if (!selectedCap) return;

    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: inputText,
      timestamp: new Date(),
      attachments: attachments.map((a) => ({ type: a.type, name: a.name })),
    };

    setMessages((prev) => [...prev, userMessage]);
    const messageText = inputText;
    setInputText('');
    setAttachments([]);
    setIsGenerating(true);

    // 构建历史消息
    const history: DirectChatMessage[] = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    // 创建流式助手消息
    const assistantId = `msg-${Date.now() + 1}`;
    setMessages((prev) => [...prev, {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      status: 'streaming',
    }]);

    // 调用真实 SSE 流式 API
    const abort = streamCapabilityChat(selectedCap.key, {
      message: messageText,
      history,
      onText: (content) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + content } : m
          )
        );
      },
      onError: (error) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: m.content || `[错误] ${error}`, status: 'done' }
              : m
          )
        );
        setIsGenerating(false);
        abortRef.current = null;
      },
      onDone: () => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, status: 'done' } : m
          )
        );
        setIsGenerating(false);
        abortRef.current = null;
      },
    });

    abortRef.current = abort;
  }, [inputText, attachments, selectedCap, messages]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, type: 'image' | 'file') => {
    const files = e.target.files;
    if (files) {
      Array.from(files).forEach((file) => {
        setAttachments((prev) => [...prev, { type, name: file.name, file }]);
      });
    }
    e.target.value = '';
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const clearChat = () => {
    setMessages([]);
  };

  const getStatusBadge = (status: Capability['status']) => {
    switch (status) {
      case 'available':
        return (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-token-nested text-token-success border border-token-subtle">
            可用
          </span>
        );
      case 'beta':
        return (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-token-nested text-token-warning border border-token-subtle">
            Beta
          </span>
        );
      case 'coming_soon':
        return (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-token-nested text-token-muted border border-token-subtle">
            即将推出
          </span>
        );
    }
  };

  const groupedCapabilities = {
    generation: CAPABILITIES.filter((c) => c.category === 'generation'),
    reasoning: CAPABILITIES.filter((c) => c.category === 'reasoning'),
    tools: CAPABILITIES.filter((c) => c.category === 'tools'),
  };

  const categoryLabels: Record<string, string> = {
    generation: '生成能力',
    reasoning: '推理能力',
    tools: '工具能力',
  };

  return (
    <ToolboxPageShell
      pageTab={pageTab}
      onPageTabChange={setPageTab}
      contentClassName="overflow-hidden"
      primaryAction={
        <Button variant="secondary" size="sm">
          <Settings size={13} />
          配置模型池
        </Button>
      }
      controls={
        <div className="toolbox-capability-summary">
          <span className="toolbox-count-pill">{CAPABILITIES.length} 个能力</span>
          <span className="toolbox-mini-pill text-token-success">{availableCount} 可用</span>
          <span className="toolbox-mini-pill text-token-warning">{betaCount} Beta</span>
        </div>
      }
    >
      <div className={cn('toolbox-capability-layout', isMobile && 'toolbox-capability-layout-mobile')}>
        <Surface variant="default" className="toolbox-capability-list-panel rounded-xl p-3">
          <div className="space-y-4">
            {Object.entries(groupedCapabilities).map(([category, caps]) => (
              <div key={category}>
                <div className="text-[11px] font-medium mb-2 flex items-center gap-1.5 text-token-muted">
                  {categoryLabels[category]}
                  <span className="bg-token-nested text-token-muted-faint px-1.5 py-0.5 rounded text-[10px]">
                    {caps.length}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {caps.map((cap) => {
                    const Icon = cap.icon;
                    const isSelected = selectedCapability === cap.key;
                    return (
                      <button
                        key={cap.key}
                        onClick={() => {
                          setSelectedCapability(cap.key);
                          setMessages([]);
                        }}
                        data-active={isSelected}
                        className="toolbox-capability-row surface-row w-full p-2.5 rounded-xl text-left transition-all group"
                      >
                        <div className="flex items-center gap-2.5">
                          <div
                            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                            style={{
                              background: `linear-gradient(135deg, hsla(${cap.hue}, 70%, 60%, 0.18) 0%, hsla(${cap.hue}, 70%, 40%, 0.08) 100%)`,
                              border: `1px solid hsla(${cap.hue}, 60%, 60%, 0.25)`,
                            }}
                          >
                            <Icon size={16} style={{ color: `hsla(${cap.hue}, 70%, 70%, 1)` }} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-[12px] text-token-primary">
                                {cap.name}
                              </span>
                              {getStatusBadge(cap.status)}
                            </div>
                            <div className="text-[10px] truncate text-token-muted-faint">
                              {cap.description}
                            </div>
                          </div>
                          <ChevronRight
                            size={14}
                            className={cn(
                              'toolbox-capability-chevron flex-shrink-0 transition-all',
                              isSelected && 'toolbox-capability-chevron-active',
                            )}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Surface>

        {/* Chat Panel */}
        <Surface variant="default" className="toolbox-capability-workspace flex-1 min-w-0 flex flex-col rounded-xl overflow-hidden">
          {selectedCap ? (
            <>
              {/* Chat Header */}
              <div
                className="px-4 py-3 flex items-center justify-between border-b border-token-subtle"
                style={{
                  background: `linear-gradient(90deg, hsla(${selectedCap.hue}, 60%, 50%, 0.08) 0%, transparent 50%)`,
                }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center"
                    style={{
                      background: `linear-gradient(135deg, hsla(${selectedCap.hue}, 70%, 60%, 0.2) 0%, hsla(${selectedCap.hue}, 70%, 40%, 0.1) 100%)`,
                      border: `1px solid hsla(${selectedCap.hue}, 60%, 60%, 0.3)`,
                      boxShadow: `0 4px 12px -2px hsla(${selectedCap.hue}, 70%, 50%, 0.2)`,
                    }}
                  >
                    <selectedCap.icon size={20} style={{ color: `hsla(${selectedCap.hue}, 70%, 70%, 1)` }} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[14px] text-token-primary">
                        {selectedCap.name}
                      </span>
                      {getStatusBadge(selectedCap.status)}
                    </div>
                    <div className="text-[11px] text-token-muted">
                      AppCallerCode: <code className="bg-token-nested px-1 py-0.5 rounded text-[10px]">ai-toolbox.{selectedCap.key}</code>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {messages.length > 0 && (
                    <button
                      onClick={clearChat}
                      className="p-2 rounded-lg transition-colors hover:bg-white/5"
                      title="清空对话"
                    >
                      <RotateCcw size={14} className="text-token-muted" />
                    </button>
                  )}
                </div>
              </div>

              {/* Chat Messages */}
              <div className="flex-1 overflow-auto p-4 space-y-4">
                {messages.length === 0 ? (
                  <div className="h-full flex items-center justify-center">
                    <div className="text-center max-w-md">
                      <div
                        className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
                        style={{
                          background: `linear-gradient(135deg, hsla(${selectedCap.hue}, 70%, 60%, 0.12) 0%, hsla(${selectedCap.hue}, 70%, 40%, 0.06) 100%)`,
                          border: `1px solid hsla(${selectedCap.hue}, 60%, 60%, 0.2)`,
                        }}
                      >
                        <Sparkles size={28} style={{ color: `hsla(${selectedCap.hue}, 70%, 65%, 0.8)` }} />
                      </div>
                      <div className="text-[14px] font-medium mb-2 text-token-secondary">
                        测试 {selectedCap.name}
                      </div>
                      <div className="text-[12px] mb-4 text-token-muted-faint">
                        {selectedCap.description}
                      </div>
                      <div className="flex flex-wrap justify-center gap-2">
                        {selectedCap.supportsImage && (
                          <span className="bg-token-nested border border-token-subtle text-token-accent text-[10px] px-2 py-1 rounded-full flex items-center gap-1">
                            <ImageIcon size={10} /> 支持图片
                          </span>
                        )}
                        {selectedCap.supportsFile && (
                          <span className="bg-token-nested border border-token-subtle text-token-warning text-[10px] px-2 py-1 rounded-full flex items-center gap-1">
                            <FileUp size={10} /> 支持文件
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                    >
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                        style={{
                          background: msg.role === 'user'
                            ? 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary, var(--accent-primary)) 100%)'
                            : `linear-gradient(135deg, hsla(${selectedCap.hue}, 70%, 60%, 0.2) 0%, hsla(${selectedCap.hue}, 70%, 40%, 0.1) 100%)`,
                          border: msg.role === 'user'
                            ? 'none'
                            : `1px solid hsla(${selectedCap.hue}, 60%, 60%, 0.25)`,
                        }}
                      >
                        {msg.role === 'user' ? (
                          <User size={14} style={{ color: 'white' }} />
                        ) : (
                          <Bot size={14} style={{ color: `hsla(${selectedCap.hue}, 70%, 70%, 1)` }} />
                        )}
                      </div>
                      <div
                        className={`flex-1 max-w-[80%] ${msg.role === 'user' ? 'text-right' : ''}`}
                      >
                        {/* Attachments */}
                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className={`flex gap-2 mb-2 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                            {msg.attachments.map((att, i) => (
                              <div
                                key={i}
                                className="surface-inset text-token-secondary px-2 py-1 rounded-lg text-[10px] flex items-center gap-1.5"
                              >
                                {att.type === 'image' ? <ImageIcon size={10} /> : <FileText size={10} />}
                                {att.name}
                              </div>
                            ))}
                          </div>
                        )}
                        <div
                          className={cn(
                            'inline-block px-3 py-2 rounded-xl text-[13px] leading-relaxed',
                            msg.role === 'user' ? 'text-left text-white' : 'surface-inset text-token-primary'
                          )}
                          style={msg.role === 'user' ? {
                            background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary, var(--accent-primary)) 100%)',
                          } : undefined}
                        >
                          {msg.content}
                          {msg.status === 'streaming' && (
                            <span className="inline-block w-1.5 h-4 ml-0.5 bg-current animate-pulse" />
                          )}
                        </div>
                        {msg.role === 'assistant' && msg.status === 'done' && (
                          <div className="flex items-center gap-2 mt-1.5">
                            <button
                              className="p-1 rounded hover:bg-white/5 transition-colors"
                              title="复制"
                            >
                              <Copy size={12} className="text-token-muted-faint" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
                {isGenerating && messages[messages.length - 1]?.status !== 'streaming' && (
                  <div className="flex gap-3">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{
                        background: `linear-gradient(135deg, hsla(${selectedCap.hue}, 70%, 60%, 0.2) 0%, hsla(${selectedCap.hue}, 70%, 40%, 0.1) 100%)`,
                        border: `1px solid hsla(${selectedCap.hue}, 60%, 60%, 0.25)`,
                      }}
                    >
                      <MapSpinner size={14} color={`hsla(${selectedCap.hue}, 70%, 70%, 1)`} />
                    </div>
                    <div className="surface-inset text-token-muted px-3 py-2 rounded-xl text-[12px]">
                      正在思考...
                    </div>
                  </div>
                )}
              </div>

              {/* Input Area */}
              <div className="bg-token-nested border-t border-token-subtle p-3">
                {/* Attachments Preview */}
                {attachments.length > 0 && (
                  <div className="flex gap-2 mb-2 flex-wrap">
                    {attachments.map((att, i) => (
                      <div
                        key={i}
                        className="surface-inset text-token-secondary px-2 py-1 rounded-lg text-[11px] flex items-center gap-1.5 group"
                      >
                        {att.type === 'image' ? <ImageIcon size={12} /> : <FileText size={12} />}
                        <span className="max-w-[120px] truncate">{att.name}</span>
                        <button
                          onClick={() => removeAttachment(i)}
                          className="p-0.5 rounded hover:bg-white/10 transition-colors"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex items-end gap-2">
                  {/* Upload Buttons */}
                  <div className="flex gap-1">
                    {selectedCap.supportsImage && (
                      <>
                        <input
                          ref={imageInputRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => handleFileSelect(e, 'image')}
                        />
                        <button
                          onClick={() => imageInputRef.current?.click()}
                          className="p-2 rounded-lg transition-colors hover:bg-white/5 text-token-muted"
                          title="上传图片"
                        >
                          <ImageIcon size={16} />
                        </button>
                      </>
                    )}
                    {selectedCap.supportsFile && (
                      <>
                        <input
                          ref={fileInputRef}
                          type="file"
                          className="hidden"
                          onChange={(e) => handleFileSelect(e, 'file')}
                        />
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="p-2 rounded-lg transition-colors hover:bg-white/5 text-token-muted"
                          title="上传文件"
                        >
                          <Paperclip size={16} />
                        </button>
                      </>
                    )}
                  </div>

                  {/* Text Input */}
                  <div className="surface-inset flex-1 flex items-end rounded-xl px-3 py-2">
                    <textarea
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSend();
                        }
                      }}
                      placeholder={selectedCap.placeholder || '输入内容...'}
                      className="text-token-primary placeholder:text-token-muted flex-1 bg-transparent text-[13px] outline-none resize-none max-h-32"
                      rows={1}
                      disabled={isGenerating}
                    />
                  </div>

                  {/* Send Button */}
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleSend}
                    disabled={isGenerating || (!inputText.trim() && attachments.length === 0)}
                    className="px-3"
                  >
                    {isGenerating ? (
                      <MapSpinner size={14} />
                    ) : (
                      <Send size={14} />
                    )}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="surface-inset w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <Wrench size={36} className="text-token-accent opacity-70" />
                </div>
                <div className="text-[15px] font-medium mb-2 text-token-secondary">
                  选择一个能力开始测试
                </div>
                <div className="text-[12px] text-token-muted-faint">
                  从左侧列表选择基础能力，在这里进行交互测试
                </div>
              </div>
            </div>
          )}
        </Surface>
      </div>
    </ToolboxPageShell>
  );
}
