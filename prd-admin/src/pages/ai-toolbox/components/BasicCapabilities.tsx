import { useState, useRef } from 'react';
import { useToolboxStore, type ToolboxPageTab } from '@/stores/toolboxStore';
import { Button } from '@/components/design/Button';
import type { LucideIcon } from 'lucide-react';
import {
  Package,
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
  Loader2,
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

// 页面标签
const PAGE_TABS: { key: ToolboxPageTab; label: string; icon: React.ReactNode }[] = [
  { key: 'toolbox', label: 'AI 百宝箱', icon: <Package size={14} /> },
  { key: 'capabilities', label: '基础能力', icon: <Wrench size={14} /> },
];

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

// 页面容器样式 - 不透明背景
const pageContainerStyle: React.CSSProperties = {
  background: 'var(--bg-primary, #0f1419)',
  borderRadius: '16px',
  border: '1px solid rgba(255, 255, 255, 0.06)',
};

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  attachments?: { type: 'image' | 'file'; name: string; url?: string }[];
  status?: 'pending' | 'streaming' | 'done' | 'error';
}

export function BasicCapabilities() {
  const { pageTab, setPageTab } = useToolboxStore();
  const [selectedCapability, setSelectedCapability] = useState<string | null>(null);
  const [inputText, setInputText] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [attachments, setAttachments] = useState<{ type: 'image' | 'file'; name: string; file: File }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const selectedCap = CAPABILITIES.find((c) => c.key === selectedCapability);

  const handleSend = async () => {
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
    setInputText('');
    setAttachments([]);
    setIsGenerating(true);

    // 模拟 AI 响应
    const assistantMessage: ChatMessage = {
      id: `msg-${Date.now() + 1}`,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      status: 'streaming',
    };

    setMessages((prev) => [...prev, assistantMessage]);

    // 模拟流式输出
    const mockResponse = getMockResponse(selectedCap.key, inputText);
    let currentText = '';
    for (let i = 0; i < mockResponse.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      currentText += mockResponse[i];
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessage.id ? { ...m, content: currentText } : m
        )
      );
    }

    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantMessage.id ? { ...m, status: 'done' } : m
      )
    );
    setIsGenerating(false);
  };

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
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
            style={{
              background: 'rgba(34, 197, 94, 0.15)',
              color: 'rgb(74, 222, 128)',
              border: '1px solid rgba(34, 197, 94, 0.25)',
            }}
          >
            可用
          </span>
        );
      case 'beta':
        return (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
            style={{
              background: 'rgba(234, 179, 8, 0.15)',
              color: 'rgb(250, 204, 21)',
              border: '1px solid rgba(234, 179, 8, 0.25)',
            }}
          >
            Beta
          </span>
        );
      case 'coming_soon':
        return (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
            style={{
              background: 'rgba(255, 255, 255, 0.05)',
              color: 'rgba(255, 255, 255, 0.5)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
            }}
          >
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
    <div className="h-full min-h-0 flex flex-col gap-3" style={pageContainerStyle}>
      {/* Header */}
      <div className="px-4 pt-3">
        <div className="flex items-center justify-between">
          {/* Page Tab Switcher */}
          <div
            className="flex items-center gap-0.5 p-0.5 rounded-xl"
            style={{
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid rgba(255, 255, 255, 0.06)',
            }}
          >
            {PAGE_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setPageTab(tab.key)}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 flex items-center gap-2"
                style={{
                  background: pageTab === tab.key
                    ? 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary, var(--accent-primary)) 100%)'
                    : 'transparent',
                  color: pageTab === tab.key ? 'white' : 'rgba(255, 255, 255, 0.6)',
                  boxShadow: pageTab === tab.key
                    ? '0 2px 10px -2px rgba(var(--accent-primary-rgb, 99, 102, 241), 0.4)'
                    : 'none',
                }}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {/* Actions */}
          <Button variant="secondary" size="sm">
            <Settings size={13} />
            配置模型池
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 min-h-0 flex gap-3 overflow-hidden px-4 pb-3">
        {/* Capabilities List */}
        <div className="w-80 flex-shrink-0 overflow-auto">
          <div className="space-y-4">
            {Object.entries(groupedCapabilities).map(([category, caps]) => (
              <div key={category}>
                <div
                  className="text-[11px] font-medium mb-2 flex items-center gap-1.5"
                  style={{ color: 'rgba(255, 255, 255, 0.5)' }}
                >
                  {categoryLabels[category]}
                  <span
                    className="px-1.5 py-0.5 rounded text-[10px]"
                    style={{
                      background: 'rgba(255, 255, 255, 0.05)',
                      color: 'rgba(255, 255, 255, 0.4)',
                    }}
                  >
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
                        className="w-full p-2.5 rounded-xl text-left transition-all group"
                        style={{
                          background: isSelected
                            ? `linear-gradient(135deg, hsla(${cap.hue}, 70%, 50%, 0.15) 0%, hsla(${cap.hue}, 70%, 30%, 0.08) 100%)`
                            : 'rgba(255, 255, 255, 0.02)',
                          border: isSelected
                            ? `1px solid hsla(${cap.hue}, 60%, 60%, 0.35)`
                            : '1px solid rgba(255, 255, 255, 0.05)',
                        }}
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
                              <span
                                className="font-medium text-[12px]"
                                style={{ color: 'rgba(255, 255, 255, 0.95)' }}
                              >
                                {cap.name}
                              </span>
                              {getStatusBadge(cap.status)}
                            </div>
                            <div
                              className="text-[10px] truncate"
                              style={{ color: 'rgba(255, 255, 255, 0.45)' }}
                            >
                              {cap.description}
                            </div>
                          </div>
                          <ChevronRight
                            size={14}
                            className="flex-shrink-0 transition-all"
                            style={{
                              color: isSelected ? `hsla(${cap.hue}, 70%, 70%, 1)` : 'rgba(255, 255, 255, 0.2)',
                              transform: isSelected ? 'translateX(0)' : 'translateX(-4px)',
                              opacity: isSelected ? 1 : 0,
                            }}
                          />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Chat Panel */}
        <div
          className="flex-1 min-w-0 flex flex-col rounded-xl overflow-hidden"
          style={{
            background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.01) 100%)',
            border: '1px solid rgba(255, 255, 255, 0.06)',
          }}
        >
          {selectedCap ? (
            <>
              {/* Chat Header */}
              <div
                className="px-4 py-3 flex items-center justify-between"
                style={{
                  background: `linear-gradient(90deg, hsla(${selectedCap.hue}, 60%, 50%, 0.08) 0%, transparent 50%)`,
                  borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
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
                      <span
                        className="font-semibold text-[14px]"
                        style={{ color: 'rgba(255, 255, 255, 0.95)' }}
                      >
                        {selectedCap.name}
                      </span>
                      {getStatusBadge(selectedCap.status)}
                    </div>
                    <div className="text-[11px]" style={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                      AppCallerCode: <code className="px-1 py-0.5 rounded text-[10px]" style={{ background: 'rgba(255, 255, 255, 0.08)' }}>ai-toolbox.{selectedCap.key}</code>
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
                      <RotateCcw size={14} style={{ color: 'rgba(255, 255, 255, 0.5)' }} />
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
                      <div
                        className="text-[14px] font-medium mb-2"
                        style={{ color: 'rgba(255, 255, 255, 0.8)' }}
                      >
                        测试 {selectedCap.name}
                      </div>
                      <div
                        className="text-[12px] mb-4"
                        style={{ color: 'rgba(255, 255, 255, 0.45)' }}
                      >
                        {selectedCap.description}
                      </div>
                      <div className="flex flex-wrap justify-center gap-2">
                        {selectedCap.supportsImage && (
                          <span
                            className="text-[10px] px-2 py-1 rounded-full flex items-center gap-1"
                            style={{
                              background: 'rgba(99, 102, 241, 0.1)',
                              border: '1px solid rgba(99, 102, 241, 0.2)',
                              color: 'rgb(129, 140, 248)',
                            }}
                          >
                            <ImageIcon size={10} /> 支持图片
                          </span>
                        )}
                        {selectedCap.supportsFile && (
                          <span
                            className="text-[10px] px-2 py-1 rounded-full flex items-center gap-1"
                            style={{
                              background: 'rgba(234, 179, 8, 0.1)',
                              border: '1px solid rgba(234, 179, 8, 0.2)',
                              color: 'rgb(250, 204, 21)',
                            }}
                          >
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
                                className="px-2 py-1 rounded-lg text-[10px] flex items-center gap-1.5"
                                style={{
                                  background: 'rgba(255, 255, 255, 0.05)',
                                  border: '1px solid rgba(255, 255, 255, 0.1)',
                                  color: 'rgba(255, 255, 255, 0.7)',
                                }}
                              >
                                {att.type === 'image' ? <ImageIcon size={10} /> : <FileText size={10} />}
                                {att.name}
                              </div>
                            ))}
                          </div>
                        )}
                        <div
                          className={`inline-block px-3 py-2 rounded-xl text-[13px] leading-relaxed ${
                            msg.role === 'user' ? 'text-left' : ''
                          }`}
                          style={{
                            background: msg.role === 'user'
                              ? 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary, var(--accent-primary)) 100%)'
                              : 'rgba(255, 255, 255, 0.05)',
                            color: msg.role === 'user' ? 'white' : 'rgba(255, 255, 255, 0.9)',
                            border: msg.role === 'user' ? 'none' : '1px solid rgba(255, 255, 255, 0.08)',
                          }}
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
                              <Copy size={12} style={{ color: 'rgba(255, 255, 255, 0.4)' }} />
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
                      <Loader2 size={14} className="animate-spin" style={{ color: `hsla(${selectedCap.hue}, 70%, 70%, 1)` }} />
                    </div>
                    <div
                      className="px-3 py-2 rounded-xl text-[12px]"
                      style={{
                        background: 'rgba(255, 255, 255, 0.05)',
                        color: 'rgba(255, 255, 255, 0.5)',
                      }}
                    >
                      正在思考...
                    </div>
                  </div>
                )}
              </div>

              {/* Input Area */}
              <div
                className="p-3"
                style={{
                  borderTop: '1px solid rgba(255, 255, 255, 0.05)',
                  background: 'rgba(0, 0, 0, 0.2)',
                }}
              >
                {/* Attachments Preview */}
                {attachments.length > 0 && (
                  <div className="flex gap-2 mb-2 flex-wrap">
                    {attachments.map((att, i) => (
                      <div
                        key={i}
                        className="px-2 py-1 rounded-lg text-[11px] flex items-center gap-1.5 group"
                        style={{
                          background: 'rgba(255, 255, 255, 0.05)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          color: 'rgba(255, 255, 255, 0.7)',
                        }}
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
                          className="p-2 rounded-lg transition-colors hover:bg-white/5"
                          title="上传图片"
                          style={{ color: 'rgba(255, 255, 255, 0.5)' }}
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
                          className="p-2 rounded-lg transition-colors hover:bg-white/5"
                          title="上传文件"
                          style={{ color: 'rgba(255, 255, 255, 0.5)' }}
                        >
                          <Paperclip size={16} />
                        </button>
                      </>
                    )}
                  </div>

                  {/* Text Input */}
                  <div
                    className="flex-1 flex items-end rounded-xl px-3 py-2"
                    style={{
                      background: 'rgba(255, 255, 255, 0.04)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                    }}
                  >
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
                      className="flex-1 bg-transparent text-[13px] outline-none resize-none max-h-32"
                      style={{ color: 'rgba(255, 255, 255, 0.9)' }}
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
                      <Loader2 size={14} className="animate-spin" />
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
                <div
                  className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-4"
                  style={{
                    background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(99, 102, 241, 0.05) 100%)',
                    border: '1px solid rgba(99, 102, 241, 0.2)',
                  }}
                >
                  <Wrench size={36} style={{ color: 'rgba(129, 140, 248, 0.6)' }} />
                </div>
                <div
                  className="text-[15px] font-medium mb-2"
                  style={{ color: 'rgba(255, 255, 255, 0.8)' }}
                >
                  选择一个能力开始测试
                </div>
                <div className="text-[12px]" style={{ color: 'rgba(255, 255, 255, 0.4)' }}>
                  从左侧列表选择基础能力，在这里进行交互测试
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Mock response generator
function getMockResponse(capKey: string, input: string): string {
  const responses: Record<string, string> = {
    'image-gen': `好的，我已理解您的图片生成需求。\n\n正在基于描述 "${input.slice(0, 30)}..." 生成图片...\n\n[图片生成完成]\n\n生成参数：\n- 模型: FLUX.1-schnell\n- 尺寸: 1024x1024\n- 风格: 写实\n\n您可以继续描述或调整参数来优化生成效果。`,
    'text-gen': `根据您的需求，我来为您生成相关内容：\n\n${input}\n\n以上是基于您输入的文本生成的内容。如需调整风格、长度或其他参数，请告诉我。`,
    'reasoning': `让我来分析这个问题...\n\n**问题理解:**\n${input}\n\n**推理过程:**\n1. 首先，我们需要识别问题中的关键信息\n2. 然后，建立逻辑关系\n3. 最后，得出结论\n\n**结论:**\n基于以上推理，答案是...（这是一个测试响应）`,
    'web-search': `正在搜索 "${input}"...\n\n**搜索结果:**\n\n1. [示例结果 1] - 这是关于您搜索内容的相关信息...\n2. [示例结果 2] - 更多相关内容...\n3. [示例结果 3] - 补充信息...\n\n以上信息来自互联网搜索，仅供参考。`,
    'code-interpreter': `\`\`\`python\n# 正在执行代码...\nprint("Hello, World!")\n\`\`\`\n\n**执行结果:**\n\`\`\`\nHello, World!\n\`\`\`\n\n代码执行成功！如需修改或运行其他代码，请继续输入。`,
    'file-reader': `正在解析您上传的文档...\n\n**文档概要:**\n- 类型: PDF/Word/Excel\n- 页数: N/A\n- 主要内容: ${input || '等待您的具体问题'}\n\n请告诉我您想了解文档的哪些内容？`,
    'mcp-tools': `MCP 工具连接成功！\n\n**可用工具列表:**\n1. 数据库查询\n2. API 调用\n3. 文件操作\n\n请选择要使用的工具或输入具体指令。`,
  };
  return responses[capKey] || '测试响应：' + input;
}
