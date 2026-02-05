import { useState } from 'react';
import { useToolboxStore, type ToolboxPageTab } from '@/stores/toolboxStore';
import { GlassCard } from '@/components/design/GlassCard';
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
  Play,
  ChevronRight,
  Loader2,
  Check,
  AlertCircle,
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
  },
  {
    key: 'text-gen',
    name: '文本生成',
    description: '智能文本生成，支持多种模型和参数调节',
    icon: MessageSquare,
    hue: 210,
    category: 'generation',
    status: 'available',
  },
  {
    key: 'reasoning',
    name: '推理能力',
    description: '复杂推理与思考链，支持多步骤推理任务',
    icon: Brain,
    hue: 270,
    category: 'reasoning',
    status: 'available',
  },
  {
    key: 'web-search',
    name: '联网搜索',
    description: '实时搜索互联网获取最新信息',
    icon: Globe,
    hue: 180,
    category: 'tools',
    status: 'available',
  },
  {
    key: 'code-interpreter',
    name: '代码解释器',
    description: '执行代码并返回结果，支持多种编程语言',
    icon: Code2,
    hue: 160,
    category: 'tools',
    status: 'beta',
  },
  {
    key: 'file-reader',
    name: '文档解析',
    description: '解析 PDF、Word、Excel 等文档',
    icon: FileText,
    hue: 45,
    category: 'tools',
    status: 'available',
  },
  {
    key: 'mcp-tools',
    name: 'MCP 工具',
    description: '连接外部 MCP 服务器扩展能力',
    icon: Zap,
    hue: 50,
    category: 'tools',
    status: 'beta',
  },
];

// 页面容器样式 - 不透明背景
const pageContainerStyle: React.CSSProperties = {
  background: 'var(--bg-primary, #0f1419)',
  borderRadius: '16px',
  border: '1px solid rgba(255, 255, 255, 0.06)',
};

interface TestResult {
  status: 'idle' | 'running' | 'success' | 'error';
  message?: string;
}

export function BasicCapabilities() {
  const { pageTab, setPageTab } = useToolboxStore();
  const [selectedCapability, setSelectedCapability] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [testInput, setTestInput] = useState('');

  const handleTest = async (capKey: string) => {
    setTestResults((prev) => ({
      ...prev,
      [capKey]: { status: 'running' },
    }));

    // 模拟测试延迟
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // 模拟测试结果
    setTestResults((prev) => ({
      ...prev,
      [capKey]: {
        status: Math.random() > 0.2 ? 'success' : 'error',
        message: Math.random() > 0.2 ? '测试成功' : '连接超时，请重试',
      },
    }));
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

  const getTestStatusIcon = (capKey: string) => {
    const result = testResults[capKey];
    if (!result) return null;

    switch (result.status) {
      case 'running':
        return <Loader2 size={14} className="animate-spin" style={{ color: 'var(--accent-primary)' }} />;
      case 'success':
        return <Check size={14} style={{ color: 'rgb(74, 222, 128)' }} />;
      case 'error':
        return <AlertCircle size={14} style={{ color: 'rgb(248, 113, 113)' }} />;
      default:
        return null;
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
        <div className="flex-1 min-w-0 overflow-auto">
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
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                  {caps.map((cap) => {
                    const Icon = cap.icon;
                    const isSelected = selectedCapability === cap.key;
                    return (
                      <button
                        key={cap.key}
                        onClick={() => setSelectedCapability(cap.key)}
                        className="p-3 rounded-xl text-left transition-all group"
                        style={{
                          background: isSelected
                            ? `linear-gradient(135deg, hsla(${cap.hue}, 70%, 50%, 0.12) 0%, hsla(${cap.hue}, 70%, 30%, 0.08) 100%)`
                            : 'rgba(255, 255, 255, 0.02)',
                          border: isSelected
                            ? `1px solid hsla(${cap.hue}, 60%, 60%, 0.3)`
                            : '1px solid rgba(255, 255, 255, 0.05)',
                        }}
                      >
                        <div className="flex items-start gap-2.5">
                          <div
                            className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                            style={{
                              background: `linear-gradient(135deg, hsla(${cap.hue}, 70%, 60%, 0.15) 0%, hsla(${cap.hue}, 70%, 40%, 0.08) 100%)`,
                              border: `1px solid hsla(${cap.hue}, 60%, 60%, 0.2)`,
                            }}
                          >
                            <Icon size={18} style={{ color: `hsla(${cap.hue}, 70%, 70%, 1)` }} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span
                                className="font-medium text-[12px]"
                                style={{ color: 'rgba(255, 255, 255, 0.95)' }}
                              >
                                {cap.name}
                              </span>
                              {getStatusBadge(cap.status)}
                              {getTestStatusIcon(cap.key)}
                            </div>
                            <div
                              className="text-[11px] line-clamp-2"
                              style={{ color: 'rgba(255, 255, 255, 0.5)' }}
                            >
                              {cap.description}
                            </div>
                          </div>
                          <ChevronRight
                            size={14}
                            className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                            style={{ color: 'rgba(255, 255, 255, 0.4)' }}
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

        {/* Test Panel */}
        <div className="w-80 flex-shrink-0">
          <GlassCard variant="subtle" className="h-full flex flex-col">
            {selectedCapability ? (
              <>
                {(() => {
                  const cap = CAPABILITIES.find((c) => c.key === selectedCapability);
                  if (!cap) return null;
                  const Icon = cap.icon;
                  const testResult = testResults[cap.key];

                  return (
                    <>
                      {/* Header */}
                      <div
                        className="px-3 py-2.5 border-b flex items-center gap-2.5"
                        style={{ borderColor: 'rgba(255, 255, 255, 0.05)' }}
                      >
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center"
                          style={{
                            background: `linear-gradient(135deg, hsla(${cap.hue}, 70%, 60%, 0.15) 0%, hsla(${cap.hue}, 70%, 40%, 0.08) 100%)`,
                            border: `1px solid hsla(${cap.hue}, 60%, 60%, 0.2)`,
                          }}
                        >
                          <Icon size={16} style={{ color: `hsla(${cap.hue}, 70%, 70%, 1)` }} />
                        </div>
                        <div>
                          <div
                            className="text-[12px] font-medium"
                            style={{ color: 'rgba(255, 255, 255, 0.95)' }}
                          >
                            {cap.name}
                          </div>
                          <div className="text-[10px]" style={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                            测试此能力
                          </div>
                        </div>
                      </div>

                      {/* Input */}
                      <div className="flex-1 p-3 overflow-auto">
                        <div className="space-y-3">
                          <div>
                            <label
                              className="block text-[11px] font-medium mb-1.5"
                              style={{ color: 'rgba(255, 255, 255, 0.7)' }}
                            >
                              测试输入
                            </label>
                            <textarea
                              value={testInput}
                              onChange={(e) => setTestInput(e.target.value)}
                              placeholder={`输入测试内容...`}
                              className="w-full h-24 p-2.5 rounded-lg border text-[12px] resize-none outline-none transition-all focus:ring-1 focus:ring-[var(--accent-primary)]/30"
                              style={{
                                background: 'rgba(255, 255, 255, 0.03)',
                                borderColor: 'rgba(255, 255, 255, 0.08)',
                                color: 'rgba(255, 255, 255, 0.9)',
                              }}
                            />
                          </div>

                          {/* Test Result */}
                          {testResult && testResult.status !== 'idle' && (
                            <div
                              className="p-2.5 rounded-lg text-[11px]"
                              style={{
                                background:
                                  testResult.status === 'success'
                                    ? 'rgba(34, 197, 94, 0.1)'
                                    : testResult.status === 'error'
                                    ? 'rgba(239, 68, 68, 0.1)'
                                    : 'rgba(99, 102, 241, 0.1)',
                                border:
                                  testResult.status === 'success'
                                    ? '1px solid rgba(34, 197, 94, 0.2)'
                                    : testResult.status === 'error'
                                    ? '1px solid rgba(239, 68, 68, 0.2)'
                                    : '1px solid rgba(99, 102, 241, 0.2)',
                                color:
                                  testResult.status === 'success'
                                    ? 'rgb(74, 222, 128)'
                                    : testResult.status === 'error'
                                    ? 'rgb(248, 113, 113)'
                                    : 'rgb(129, 140, 248)',
                              }}
                            >
                              {testResult.status === 'running'
                                ? '测试中...'
                                : testResult.message}
                            </div>
                          )}

                          {/* Model Pool Info */}
                          <div
                            className="p-2.5 rounded-lg"
                            style={{
                              background: 'rgba(255, 255, 255, 0.02)',
                              border: '1px solid rgba(255, 255, 255, 0.05)',
                            }}
                          >
                            <div
                              className="text-[10px] font-medium mb-1.5"
                              style={{ color: 'rgba(255, 255, 255, 0.6)' }}
                            >
                              绑定的模型池
                            </div>
                            <div
                              className="text-[11px]"
                              style={{ color: 'rgba(255, 255, 255, 0.4)' }}
                            >
                              使用 AppCallerCode: <code className="px-1 py-0.5 rounded" style={{ background: 'rgba(255, 255, 255, 0.05)' }}>ai-toolbox</code>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Actions */}
                      <div
                        className="p-3 border-t"
                        style={{ borderColor: 'rgba(255, 255, 255, 0.05)' }}
                      >
                        <Button
                          variant="primary"
                          size="sm"
                          className="w-full"
                          onClick={() => handleTest(cap.key)}
                          disabled={testResult?.status === 'running'}
                        >
                          {testResult?.status === 'running' ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <Play size={13} />
                          )}
                          {testResult?.status === 'running' ? '测试中...' : '运行测试'}
                        </Button>
                      </div>
                    </>
                  );
                })()}
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <div
                    className="w-14 h-14 rounded-xl flex items-center justify-center mx-auto mb-3"
                    style={{
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(255, 255, 255, 0.05)',
                    }}
                  >
                    <Wrench size={28} style={{ color: 'rgba(255, 255, 255, 0.3)' }} />
                  </div>
                  <div
                    className="text-[12px] font-medium mb-1"
                    style={{ color: 'rgba(255, 255, 255, 0.7)' }}
                  >
                    选择一个能力
                  </div>
                  <div className="text-[11px]" style={{ color: 'rgba(255, 255, 255, 0.4)' }}>
                    点击左侧能力卡片进行测试
                  </div>
                </div>
              </div>
            )}
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
