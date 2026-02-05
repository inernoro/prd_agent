import { useState, useMemo } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useToolboxStore } from '@/stores/toolboxStore';
import {
  ArrowLeft,
  Save,
  Loader2,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Plus,
  X,
  BookOpen,
  Wrench,
  MessageSquare,
  User,
  Zap,
  Settings,
  Send,
} from 'lucide-react';

const EMOJI_OPTIONS = [
  '🤖', '💡', '🎯', '📊', '🔧', '🎨', '✨', '🚀',
  '📝', '💬', '🔍', '⚡', '🌟', '🎪', '🎭', '🎮',
  '📋', '🐛', '🌐', '✍️', '🎵', '🎬', '📚', '🧠',
];

// 预设的能力工具
const CAPABILITY_TOOLS = [
  { key: 'webSearch', label: '联网搜索', icon: '🌐', description: '允许智能体搜索互联网获取最新信息' },
  { key: 'imageGen', label: '图片生成', icon: '🎨', description: '使用 AI 生成图片' },
  { key: 'codeInterpreter', label: '代码解释器', icon: '💻', description: '执行代码并返回结果' },
  { key: 'fileReader', label: '文件解析', icon: '📄', description: '读取和分析上传的文件' },
];

// Tab 配置
const CONFIG_TABS = [
  { key: 'persona', label: '人设与目标', icon: <User size={14} /> },
  { key: 'capabilities', label: '能力增强', icon: <Zap size={14} /> },
  { key: 'conversation', label: '对话体验', icon: <MessageSquare size={14} /> },
];

interface FormState {
  name: string;
  description: string;
  icon: string;
  prompt: string;
  tags: string;
  welcomeMessage: string;
  conversationStarters: string[];
  enabledTools: string[];
  knowledgeBase: string[];
  model: string;
  temperature: number;
  enableMemory: boolean;
}

export function ToolEditor() {
  const { view, editingItem, saveItem, backToGrid } = useToolboxStore();

  const [form, setForm] = useState<FormState>({
    name: editingItem?.name || '',
    description: editingItem?.description || '',
    icon: editingItem?.icon || '🤖',
    prompt: editingItem?.prompt || '',
    tags: editingItem?.tags?.join(', ') || '',
    welcomeMessage: '你好！我是你的 AI 助手，有什么可以帮你的吗？',
    conversationStarters: ['帮我写一段文案', '分析一下这个数据'],
    enabledTools: [],
    knowledgeBase: [],
    model: 'gpt-4o',
    temperature: 0.7,
    enableMemory: false,
  });

  const [saving, setSaving] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [activeTab, setActiveTab] = useState('persona');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [previewInput, setPreviewInput] = useState('');

  const isEdit = view === 'edit';
  const title = isEdit ? '编辑智能体' : '创建智能体';

  // 计算名称字数
  const nameCharCount = form.name.length;
  const maxNameLength = 20;

  // 解析标签
  const parsedTags = useMemo(() => {
    return form.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }, [form.tags]);

  const handleSave = async () => {
    if (!form.name.trim() || !form.prompt.trim()) return;

    setSaving(true);
    const success = await saveItem({
      ...(editingItem?.id ? { id: editingItem.id } : {}),
      name: form.name.trim(),
      description: form.description.trim(),
      icon: form.icon,
      prompt: form.prompt.trim(),
      tags: parsedTags,
      type: 'custom',
      category: 'custom',
    });
    setSaving(false);

    if (!success) {
      alert('保存失败，请重试');
    }
  };

  const addConversationStarter = () => {
    setForm({
      ...form,
      conversationStarters: [...form.conversationStarters, ''],
    });
  };

  const updateConversationStarter = (index: number, value: string) => {
    const newStarters = [...form.conversationStarters];
    newStarters[index] = value;
    setForm({ ...form, conversationStarters: newStarters });
  };

  const removeConversationStarter = (index: number) => {
    const newStarters = form.conversationStarters.filter((_, i) => i !== index);
    setForm({ ...form, conversationStarters: newStarters });
  };

  const toggleTool = (toolKey: string) => {
    const newTools = form.enabledTools.includes(toolKey)
      ? form.enabledTools.filter((t) => t !== toolKey)
      : [...form.enabledTools, toolKey];
    setForm({ ...form, enabledTools: newTools });
  };

  // 渲染人设与目标标签页
  const renderPersonaTab = () => (
    <div className="space-y-4">
      {/* 系统提示词 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            系统提示词 <span style={{ color: 'var(--status-error)' }}>*</span>
          </label>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
            <Sparkles size={12} />
            AI 优化
          </Button>
        </div>
        <div
          className="text-xs mb-2 px-3 py-2 rounded-lg"
          style={{
            background: 'rgba(var(--accent-primary-rgb, 99, 102, 241), 0.08)',
            color: 'var(--text-muted)',
            border: '1px solid rgba(var(--accent-primary-rgb, 99, 102, 241), 0.15)',
          }}
        >
          提示：使用结构化格式（# 角色、## 技能、## 限制）可以让 AI 更好地理解你的意图
        </div>
        <textarea
          value={form.prompt}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          placeholder={`# 角色
你是一位专业的产品文案专家。

## 技能
- 根据产品信息创作吸引人的营销文案
- 突出产品核心卖点
- 使用情感化语言打动用户

## 限制
- 文案要简洁有力，不超过 200 字
- 避免使用夸张或虚假宣传`}
          className="w-full h-56 p-3 rounded-xl border text-sm resize-none outline-none font-mono transition-all focus:ring-2 focus:ring-[var(--accent-primary)]/30"
          style={{
            background: 'rgba(255, 255, 255, 0.03)',
            borderColor: 'rgba(255, 255, 255, 0.08)',
            color: 'var(--text-primary)',
          }}
        />
      </div>
    </div>
  );

  // 渲染能力增强标签页
  const renderCapabilitiesTab = () => (
    <div className="space-y-4">
      {/* 能力工具 */}
      <div>
        <label className="block text-xs font-medium mb-3" style={{ color: 'var(--text-muted)' }}>
          <Wrench size={12} className="inline mr-1" />
          能力工具
        </label>
        <div className="grid grid-cols-2 gap-2">
          {CAPABILITY_TOOLS.map((tool) => (
            <button
              key={tool.key}
              onClick={() => toggleTool(tool.key)}
              className="p-3 rounded-xl text-left transition-all"
              style={{
                background: form.enabledTools.includes(tool.key)
                  ? 'rgba(var(--accent-primary-rgb, 99, 102, 241), 0.15)'
                  : 'rgba(255, 255, 255, 0.03)',
                border: form.enabledTools.includes(tool.key)
                  ? '1px solid rgba(var(--accent-primary-rgb, 99, 102, 241), 0.3)'
                  : '1px solid rgba(255, 255, 255, 0.08)',
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-lg">{tool.icon}</span>
                <span
                  className="text-sm font-medium"
                  style={{
                    color: form.enabledTools.includes(tool.key)
                      ? 'var(--accent-primary)'
                      : 'var(--text-primary)',
                  }}
                >
                  {tool.label}
                </span>
              </div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {tool.description}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 知识库 */}
      <div>
        <label className="block text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
          <BookOpen size={12} className="inline mr-1" />
          知识库
        </label>
        <div
          className="p-4 rounded-xl text-center cursor-pointer transition-all hover:border-[var(--accent-primary)]"
          style={{
            background: 'rgba(255, 255, 255, 0.03)',
            border: '1px dashed rgba(255, 255, 255, 0.15)',
          }}
        >
          <Plus size={20} className="mx-auto mb-2" style={{ color: 'var(--text-muted)' }} />
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            上传文档或连接知识库
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
            支持 PDF、Word、TXT、Markdown
          </div>
        </div>
      </div>
    </div>
  );

  // 渲染对话体验标签页
  const renderConversationTab = () => (
    <div className="space-y-4">
      {/* 欢迎语 */}
      <div>
        <label className="block text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
          开场白
        </label>
        <textarea
          value={form.welcomeMessage}
          onChange={(e) => setForm({ ...form, welcomeMessage: e.target.value })}
          placeholder="智能体发送的第一条消息..."
          className="w-full h-20 p-3 rounded-xl border text-sm resize-none outline-none transition-all focus:ring-2 focus:ring-[var(--accent-primary)]/30"
          style={{
            background: 'rgba(255, 255, 255, 0.03)',
            borderColor: 'rgba(255, 255, 255, 0.08)',
            color: 'var(--text-primary)',
          }}
        />
      </div>

      {/* 对话开场白 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            引导问题
          </label>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={addConversationStarter}
          >
            <Plus size={12} />
            添加
          </Button>
        </div>
        <div className="space-y-2">
          {form.conversationStarters.map((starter, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                type="text"
                value={starter}
                onChange={(e) => updateConversationStarter(index, e.target.value)}
                placeholder={`引导问题 ${index + 1}`}
                className="flex-1 px-3 py-2 rounded-lg border text-sm outline-none transition-all focus:ring-2 focus:ring-[var(--accent-primary)]/30"
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  borderColor: 'rgba(255, 255, 255, 0.08)',
                  color: 'var(--text-primary)',
                }}
              />
              {form.conversationStarters.length > 1 && (
                <button
                  onClick={() => removeConversationStarter(index)}
                  className="p-2 rounded-lg transition-colors hover:bg-white/10"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="text-xs mt-2" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
          这些问题会显示为快捷按钮，帮助用户快速开始对话
        </div>
      </div>
    </div>
  );

  // 渲染高级设置
  const renderAdvancedSettings = () => (
    <div className="space-y-4 pt-2">
      {/* 模型选择 */}
      <div>
        <label className="block text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
          模型
        </label>
        <select
          value={form.model}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
          className="w-full px-3 py-2 rounded-lg border text-sm outline-none"
          style={{
            background: 'rgba(255, 255, 255, 0.03)',
            borderColor: 'rgba(255, 255, 255, 0.08)',
            color: 'var(--text-primary)',
          }}
        >
          <option value="gpt-4o">GPT-4o</option>
          <option value="gpt-4o-mini">GPT-4o Mini</option>
          <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
          <option value="deepseek-chat">DeepSeek Chat</option>
        </select>
      </div>

      {/* 温度 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            创造性 (Temperature)
          </label>
          <span className="text-xs" style={{ color: 'var(--text-primary)' }}>
            {form.temperature.toFixed(1)}
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={form.temperature}
          onChange={(e) => setForm({ ...form, temperature: parseFloat(e.target.value) })}
          className="w-full"
        />
        <div className="flex justify-between text-xs mt-1" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
          <span>精确</span>
          <span>创造</span>
        </div>
      </div>

      {/* 长期记忆 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            长期记忆
          </div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            记住用户偏好和历史对话
          </div>
        </div>
        <button
          onClick={() => setForm({ ...form, enableMemory: !form.enableMemory })}
          className="w-11 h-6 rounded-full transition-colors relative"
          style={{
            background: form.enableMemory
              ? 'var(--accent-primary)'
              : 'rgba(255, 255, 255, 0.1)',
          }}
        >
          <div
            className="w-5 h-5 rounded-full bg-white absolute top-0.5 transition-transform"
            style={{
              transform: form.enableMemory ? 'translateX(22px)' : 'translateX(2px)',
            }}
          />
        </button>
      </div>
    </div>
  );

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {/* Header */}
      <TabBar
        title={title}
        icon={<span className="text-lg">{form.icon}</span>}
        items={[]}
        activeKey=""
        onChange={() => {}}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={backToGrid}>
              <ArrowLeft size={14} />
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={saving || !form.name.trim() || !form.prompt.trim()}
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              保存
            </Button>
          </div>
        }
      />

      {/* Main Content - 双栏布局 */}
      <div className="flex-1 min-h-0 flex gap-4 overflow-hidden">
        {/* 左侧：配置区 */}
        <div className="flex-1 min-w-0 overflow-auto">
          <div className="space-y-4 pb-4">
            {/* 基础信息 */}
            <GlassCard variant="subtle" padding="md">
              <div className="text-sm font-medium mb-4" style={{ color: 'var(--text-primary)' }}>
                基本信息
              </div>

              <div className="flex gap-4">
                {/* 图标 */}
                <div className="relative flex-shrink-0">
                  <button
                    onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                    className="w-20 h-20 rounded-2xl flex items-center justify-center text-4xl border transition-all hover:border-[var(--accent-primary)] hover:scale-105"
                    style={{
                      background: 'rgba(255, 255, 255, 0.03)',
                      borderColor: 'rgba(255, 255, 255, 0.1)',
                    }}
                  >
                    {form.icon}
                  </button>
                  {showEmojiPicker && (
                    <div
                      className="absolute top-full left-0 mt-2 p-3 rounded-xl border shadow-lg z-10 grid grid-cols-6 gap-2"
                      style={{
                        background: 'var(--bg-elevated)',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                      }}
                    >
                      {EMOJI_OPTIONS.map((emoji) => (
                        <button
                          key={emoji}
                          onClick={() => {
                            setForm({ ...form, icon: emoji });
                            setShowEmojiPicker(false);
                          }}
                          className="w-9 h-9 rounded-lg flex items-center justify-center text-xl hover:bg-white/10 transition-colors"
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* 名称和描述 */}
                <div className="flex-1 space-y-3">
                  {/* 名称 */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        名称 <span style={{ color: 'var(--status-error)' }}>*</span>
                      </label>
                      <span
                        className="text-xs"
                        style={{
                          color: nameCharCount > maxNameLength ? 'var(--status-error)' : 'var(--text-muted)',
                        }}
                      >
                        {nameCharCount}/{maxNameLength}
                      </span>
                    </div>
                    <input
                      type="text"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value.slice(0, maxNameLength) })}
                      placeholder="给你的智能体起个名字"
                      className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none transition-all focus:ring-2 focus:ring-[var(--accent-primary)]/30"
                      style={{
                        background: 'rgba(255, 255, 255, 0.03)',
                        borderColor: 'rgba(255, 255, 255, 0.08)',
                        color: 'var(--text-primary)',
                      }}
                    />
                  </div>

                  {/* 描述 */}
                  <div>
                    <label className="block text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
                      描述
                    </label>
                    <input
                      type="text"
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                      placeholder="简单描述这个智能体能做什么"
                      className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none transition-all focus:ring-2 focus:ring-[var(--accent-primary)]/30"
                      style={{
                        background: 'rgba(255, 255, 255, 0.03)',
                        borderColor: 'rgba(255, 255, 255, 0.08)',
                        color: 'var(--text-primary)',
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* 标签 */}
              <div className="mt-4">
                <label className="block text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                  标签（用逗号分隔）
                </label>
                <input
                  type="text"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  placeholder="例如：写作, 文案, 创意"
                  className="w-full px-3 py-2.5 rounded-xl border text-sm outline-none transition-all focus:ring-2 focus:ring-[var(--accent-primary)]/30"
                  style={{
                    background: 'rgba(255, 255, 255, 0.03)',
                    borderColor: 'rgba(255, 255, 255, 0.08)',
                    color: 'var(--text-primary)',
                  }}
                />
                {parsedTags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {parsedTags.map((tag) => (
                      <span
                        key={tag}
                        className="text-xs px-2 py-1 rounded-md"
                        style={{
                          background: 'rgba(var(--accent-primary-rgb, 99, 102, 241), 0.12)',
                          color: 'var(--accent-primary)',
                          border: '1px solid rgba(var(--accent-primary-rgb, 99, 102, 241), 0.2)',
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </GlassCard>

            {/* 核心配置标签页 */}
            <GlassCard variant="subtle" padding="md">
              {/* Tab 头部 */}
              <div
                className="flex items-center gap-1 p-1 rounded-xl mb-4"
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                }}
              >
                {CONFIG_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className="flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-1.5"
                    style={{
                      background: activeTab === tab.key
                        ? 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary, var(--accent-primary)) 100%)'
                        : 'transparent',
                      color: activeTab === tab.key ? 'white' : 'var(--text-muted)',
                    }}
                  >
                    {tab.icon}
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Tab 内容 */}
              {activeTab === 'persona' && renderPersonaTab()}
              {activeTab === 'capabilities' && renderCapabilitiesTab()}
              {activeTab === 'conversation' && renderConversationTab()}
            </GlassCard>

            {/* 高级设置（可折叠） */}
            <GlassCard variant="subtle" padding="md">
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="w-full flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <Settings size={14} style={{ color: 'var(--text-muted)' }} />
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    高级设置
                  </span>
                </div>
                {showAdvanced ? (
                  <ChevronDown size={16} style={{ color: 'var(--text-muted)' }} />
                ) : (
                  <ChevronRight size={16} style={{ color: 'var(--text-muted)' }} />
                )}
              </button>
              {showAdvanced && renderAdvancedSettings()}
            </GlassCard>
          </div>
        </div>

        {/* 右侧：实时预览 */}
        <div className="w-80 flex-shrink-0">
          <GlassCard variant="subtle" padding="none" className="h-full flex flex-col">
            {/* 预览头部 */}
            <div
              className="px-4 py-3 border-b"
              style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}
            >
              <div className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                实时预览
              </div>
            </div>

            {/* 预览内容 */}
            <div className="flex-1 overflow-auto p-4">
              {/* Agent 信息卡片 */}
              <div className="text-center mb-6">
                <div
                  className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-3"
                  style={{
                    background: 'rgba(var(--accent-primary-rgb, 99, 102, 241), 0.15)',
                    border: '1px solid rgba(var(--accent-primary-rgb, 99, 102, 241), 0.25)',
                  }}
                >
                  {form.icon}
                </div>
                <div
                  className="font-medium text-sm"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {form.name || '未命名智能体'}
                </div>
                <div
                  className="text-xs mt-1"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {form.description || '暂无描述'}
                </div>
              </div>

              {/* 欢迎消息 */}
              <div className="space-y-3">
                <div
                  className="p-3 rounded-xl rounded-tl-sm text-sm"
                  style={{
                    background: 'rgba(255, 255, 255, 0.05)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {form.welcomeMessage || '你好！有什么可以帮你的吗？'}
                </div>

                {/* 引导问题 */}
                {form.conversationStarters.filter(Boolean).length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {form.conversationStarters.filter(Boolean).map((starter, i) => (
                      <button
                        key={i}
                        className="px-3 py-1.5 rounded-full text-xs transition-colors hover:opacity-80"
                        style={{
                          background: 'rgba(var(--accent-primary-rgb, 99, 102, 241), 0.12)',
                          color: 'var(--accent-primary)',
                          border: '1px solid rgba(var(--accent-primary-rgb, 99, 102, 241), 0.2)',
                        }}
                      >
                        {starter}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 预览输入框 */}
            <div
              className="p-3 border-t"
              style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}
            >
              <div
                className="flex items-center gap-2 px-3 py-2 rounded-xl"
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                }}
              >
                <input
                  type="text"
                  value={previewInput}
                  onChange={(e) => setPreviewInput(e.target.value)}
                  placeholder="输入消息..."
                  className="flex-1 bg-transparent text-sm outline-none"
                  style={{ color: 'var(--text-primary)' }}
                />
                <button
                  className="p-1.5 rounded-lg transition-colors hover:bg-white/10"
                  style={{ color: 'var(--accent-primary)' }}
                >
                  <Send size={14} />
                </button>
              </div>
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
