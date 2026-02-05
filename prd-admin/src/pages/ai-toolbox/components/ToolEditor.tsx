import { useState, useMemo } from 'react';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useToolboxStore } from '@/stores/toolboxStore';
import type { LucideIcon } from 'lucide-react';
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
  FileText,
  Palette,
  PenTool,
  Bug,
  Code2,
  Languages,
  FileSearch,
  BarChart3,
  Bot,
  Lightbulb,
  Target,
  Rocket,
  Brain,
  Cpu,
  Database,
  Globe,
  Image,
  Music,
  Video,
  GraduationCap,
  Briefcase,
  Heart,
  Star,
  Shield,
  Lock,
  Search,
  Layers,
} from 'lucide-react';

// 图标组件映射
const ICON_MAP: Record<string, LucideIcon> = {
  FileText, Palette, PenTool, Bug, Code2, Languages, FileSearch, BarChart3,
  Bot, Lightbulb, Target, Wrench, Sparkles, Rocket, MessageSquare, Zap,
  Brain, Cpu, Database, Globe, Image, Music, Video, BookOpen,
  GraduationCap, Briefcase, Heart, Star, Shield, Lock, Search, Layers,
};

// 可选的图标列表
const ICON_OPTIONS = Object.keys(ICON_MAP);

// 图标名称到色相的映射
const ICON_HUE_MAP: Record<string, number> = {
  FileText: 210, Palette: 330, PenTool: 45, Bug: 0, Code2: 180, Languages: 200,
  FileSearch: 50, BarChart3: 270, Bot: 210, Lightbulb: 45, Target: 0, Wrench: 30,
  Sparkles: 280, Rocket: 210, MessageSquare: 180, Zap: 45, Brain: 270, Cpu: 200,
  Database: 220, Globe: 180, Image: 330, Music: 300, Video: 0, BookOpen: 140,
  GraduationCap: 220, Briefcase: 30, Heart: 350, Star: 45, Shield: 210, Lock: 200,
  Search: 180, Layers: 240,
};

// 获取图标组件
function getIconComponent(iconName: string): LucideIcon {
  return ICON_MAP[iconName] || Bot;
}

// 获取强调色色相
function getAccentHue(iconName: string): number {
  return ICON_HUE_MAP[iconName] ?? 210;
}

// 预设的能力工具
const CAPABILITY_TOOLS = [
  { key: 'webSearch', label: '联网搜索', icon: 'Globe', description: '搜索互联网获取最新信息' },
  { key: 'imageGen', label: '图片生成', icon: 'Image', description: '使用 AI 生成图片' },
  { key: 'codeInterpreter', label: '代码解释器', icon: 'Code2', description: '执行代码并返回结果' },
  { key: 'fileReader', label: '文件解析', icon: 'FileText', description: '读取和分析文件' },
];

// Tab 配置
const CONFIG_TABS = [
  { key: 'persona', label: '人设与目标', icon: <User size={12} /> },
  { key: 'capabilities', label: '能力增强', icon: <Zap size={12} /> },
  { key: 'conversation', label: '对话体验', icon: <MessageSquare size={12} /> },
];

// 页面容器样式 - 不透明背景
const pageContainerStyle: React.CSSProperties = {
  background: 'var(--bg-primary, #0f1419)',
  borderRadius: '16px',
  border: '1px solid rgba(255, 255, 255, 0.06)',
};

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
    icon: editingItem?.icon || 'Bot',
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
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [activeTab, setActiveTab] = useState('persona');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [previewInput, setPreviewInput] = useState('');

  const title = view === 'edit' ? '编辑智能体' : '创建智能体';

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

  // 当前图标组件
  const CurrentIconComponent = getIconComponent(form.icon);
  const currentIconHue = getAccentHue(form.icon);

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
    <div className="space-y-3">
      {/* 系统提示词 */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[11px] font-medium" style={{ color: 'rgba(255, 255, 255, 0.7)' }}>
            系统提示词 <span style={{ color: 'rgb(239, 68, 68)' }}>*</span>
          </label>
          <Button variant="ghost" size="sm" className="h-6 text-[10px] gap-1 px-2">
            <Sparkles size={10} />
            AI 优化
          </Button>
        </div>
        <div
          className="text-[10px] mb-1.5 px-2.5 py-1.5 rounded-lg"
          style={{
            background: 'rgba(99, 102, 241, 0.1)',
            color: 'rgba(255, 255, 255, 0.6)',
            border: '1px solid rgba(99, 102, 241, 0.2)',
          }}
        >
          提示：使用结构化格式（# 角色、## 技能、## 限制）可以让 AI 更好地理解
        </div>
        <textarea
          value={form.prompt}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          placeholder={`# 角色
你是一位专业的产品文案专家。

## 技能
- 根据产品信息创作吸引人的营销文案
- 突出产品核心卖点

## 限制
- 文案要简洁有力，不超过 200 字`}
          className="w-full h-40 p-2.5 rounded-lg border text-[12px] resize-none outline-none font-mono transition-all focus:ring-1 focus:ring-[var(--accent-primary)]/30"
          style={{
            background: 'rgba(255, 255, 255, 0.03)',
            borderColor: 'rgba(255, 255, 255, 0.08)',
            color: 'rgba(255, 255, 255, 0.9)',
          }}
        />
      </div>
    </div>
  );

  // 渲染能力增强标签页
  const renderCapabilitiesTab = () => (
    <div className="space-y-3">
      {/* 能力工具 */}
      <div>
        <label className="block text-[11px] font-medium mb-2" style={{ color: 'rgba(255, 255, 255, 0.7)' }}>
          <Wrench size={10} className="inline mr-1" />
          能力工具
        </label>
        <div className="grid grid-cols-2 gap-1.5">
          {CAPABILITY_TOOLS.map((tool) => {
            const ToolIcon = getIconComponent(tool.icon);
            return (
              <button
                key={tool.key}
                onClick={() => toggleTool(tool.key)}
                className="p-2 rounded-lg text-left transition-all"
                style={{
                  background: form.enabledTools.includes(tool.key)
                    ? 'rgba(99, 102, 241, 0.15)'
                    : 'rgba(255, 255, 255, 0.03)',
                  border: form.enabledTools.includes(tool.key)
                    ? '1px solid rgba(99, 102, 241, 0.3)'
                    : '1px solid rgba(255, 255, 255, 0.06)',
                }}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <ToolIcon
                    size={14}
                    style={{
                      color: form.enabledTools.includes(tool.key)
                        ? 'rgb(129, 140, 248)'
                        : 'rgba(255, 255, 255, 0.6)',
                    }}
                  />
                  <span
                    className="text-[11px] font-medium"
                    style={{
                      color: form.enabledTools.includes(tool.key)
                        ? 'rgb(129, 140, 248)'
                        : 'rgba(255, 255, 255, 0.85)',
                    }}
                  >
                    {tool.label}
                  </span>
                </div>
                <div className="text-[10px]" style={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                  {tool.description}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 知识库 */}
      <div>
        <label className="block text-[11px] font-medium mb-1.5" style={{ color: 'rgba(255, 255, 255, 0.7)' }}>
          <BookOpen size={10} className="inline mr-1" />
          知识库
        </label>
        <div
          className="p-3 rounded-lg text-center cursor-pointer transition-all hover:border-[var(--accent-primary)]"
          style={{
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px dashed rgba(255, 255, 255, 0.12)',
          }}
        >
          <Plus size={16} className="mx-auto mb-1" style={{ color: 'rgba(255, 255, 255, 0.4)' }} />
          <div className="text-[10px]" style={{ color: 'rgba(255, 255, 255, 0.5)' }}>
            上传文档或连接知识库
          </div>
        </div>
      </div>
    </div>
  );

  // 渲染对话体验标签页
  const renderConversationTab = () => (
    <div className="space-y-3">
      {/* 欢迎语 */}
      <div>
        <label className="block text-[11px] font-medium mb-1.5" style={{ color: 'rgba(255, 255, 255, 0.7)' }}>
          开场白
        </label>
        <textarea
          value={form.welcomeMessage}
          onChange={(e) => setForm({ ...form, welcomeMessage: e.target.value })}
          placeholder="智能体发送的第一条消息..."
          className="w-full h-16 p-2.5 rounded-lg border text-[12px] resize-none outline-none transition-all focus:ring-1 focus:ring-[var(--accent-primary)]/30"
          style={{
            background: 'rgba(255, 255, 255, 0.03)',
            borderColor: 'rgba(255, 255, 255, 0.08)',
            color: 'rgba(255, 255, 255, 0.9)',
          }}
        />
      </div>

      {/* 对话开场白 */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[11px] font-medium" style={{ color: 'rgba(255, 255, 255, 0.7)' }}>
            引导问题
          </label>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px] gap-1 px-2"
            onClick={addConversationStarter}
          >
            <Plus size={10} />
            添加
          </Button>
        </div>
        <div className="space-y-1.5">
          {form.conversationStarters.map((starter, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <input
                type="text"
                value={starter}
                onChange={(e) => updateConversationStarter(index, e.target.value)}
                placeholder={`引导问题 ${index + 1}`}
                className="flex-1 px-2.5 py-1.5 rounded-lg border text-[12px] outline-none transition-all focus:ring-1 focus:ring-[var(--accent-primary)]/30"
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  borderColor: 'rgba(255, 255, 255, 0.08)',
                  color: 'rgba(255, 255, 255, 0.9)',
                }}
              />
              {form.conversationStarters.length > 1 && (
                <button
                  onClick={() => removeConversationStarter(index)}
                  className="p-1.5 rounded-lg transition-colors hover:bg-white/10"
                  style={{ color: 'rgba(255, 255, 255, 0.5)' }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="text-[10px] mt-1.5" style={{ color: 'rgba(255, 255, 255, 0.4)' }}>
          这些问题会显示为快捷按钮，帮助用户快速开始对话
        </div>
      </div>
    </div>
  );

  // 渲染高级设置
  const renderAdvancedSettings = () => (
    <div className="space-y-3 pt-2">
      {/* 模型选择 */}
      <div>
        <label className="block text-[11px] font-medium mb-1.5" style={{ color: 'rgba(255, 255, 255, 0.7)' }}>
          模型
        </label>
        <select
          value={form.model}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
          className="w-full px-2.5 py-1.5 rounded-lg border text-[12px] outline-none"
          style={{
            background: 'rgba(255, 255, 255, 0.03)',
            borderColor: 'rgba(255, 255, 255, 0.08)',
            color: 'rgba(255, 255, 255, 0.9)',
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
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[11px] font-medium" style={{ color: 'rgba(255, 255, 255, 0.7)' }}>
            创造性 (Temperature)
          </label>
          <span className="text-[11px]" style={{ color: 'rgba(255, 255, 255, 0.9)' }}>
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
          className="w-full h-1.5"
        />
        <div className="flex justify-between text-[10px] mt-1" style={{ color: 'rgba(255, 255, 255, 0.4)' }}>
          <span>精确</span>
          <span>创造</span>
        </div>
      </div>

      {/* 长期记忆 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[12px] font-medium" style={{ color: 'rgba(255, 255, 255, 0.9)' }}>
            长期记忆
          </div>
          <div className="text-[10px]" style={{ color: 'rgba(255, 255, 255, 0.5)' }}>
            记住用户偏好和历史对话
          </div>
        </div>
        <button
          onClick={() => setForm({ ...form, enableMemory: !form.enableMemory })}
          className="w-9 h-5 rounded-full transition-colors relative"
          style={{
            background: form.enableMemory
              ? 'var(--accent-primary)'
              : 'rgba(255, 255, 255, 0.1)',
          }}
        >
          <div
            className="w-4 h-4 rounded-full bg-white absolute top-0.5 transition-transform"
            style={{
              transform: form.enableMemory ? 'translateX(18px)' : 'translateX(2px)',
            }}
          />
        </button>
      </div>
    </div>
  );

  return (
    <div className="h-full min-h-0 flex flex-col gap-3" style={pageContainerStyle}>
      {/* Header */}
      <div className="px-4 pt-3">
        <TabBar
          title={title}
          icon={<CurrentIconComponent size={15} style={{ color: `hsla(${currentIconHue}, 70%, 70%, 1)` }} />}
          items={[]}
          activeKey=""
          onChange={() => {}}
          actions={
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={backToGrid}>
                <ArrowLeft size={13} />
                取消
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSave}
                disabled={saving || !form.name.trim() || !form.prompt.trim()}
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                保存
              </Button>
            </div>
          }
        />
      </div>

      {/* Main Content - 双栏布局 */}
      <div className="flex-1 min-h-0 flex gap-3 overflow-hidden px-4 pb-3">
        {/* 左侧：配置区 */}
        <div className="flex-1 min-w-0 overflow-auto">
          <div className="space-y-3">
            {/* 基础信息 */}
            <div
              className="p-3 rounded-xl"
              style={{
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid rgba(255, 255, 255, 0.05)',
              }}
            >
              <div className="text-[12px] font-medium mb-3" style={{ color: 'rgba(255, 255, 255, 0.9)' }}>
                基本信息
              </div>

              <div className="flex gap-3">
                {/* 图标选择器 */}
                <div className="relative flex-shrink-0">
                  <button
                    onClick={() => setShowIconPicker(!showIconPicker)}
                    className="w-14 h-14 rounded-xl flex items-center justify-center border transition-all hover:border-[var(--accent-primary)] hover:scale-105"
                    style={{
                      background: `linear-gradient(135deg, hsla(${currentIconHue}, 70%, 60%, 0.15) 0%, hsla(${currentIconHue}, 70%, 40%, 0.08) 100%)`,
                      borderColor: `hsla(${currentIconHue}, 60%, 60%, 0.25)`,
                    }}
                  >
                    <CurrentIconComponent
                      size={24}
                      style={{ color: `hsla(${currentIconHue}, 70%, 70%, 1)` }}
                    />
                  </button>
                  {showIconPicker && (
                    <div
                      className="absolute top-full left-0 mt-2 p-2 rounded-lg border shadow-lg z-10 grid grid-cols-8 gap-1 w-[280px]"
                      style={{
                        background: 'var(--bg-elevated, #1a1f2e)',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                      }}
                    >
                      {ICON_OPTIONS.map((iconName) => {
                        const Icon = getIconComponent(iconName);
                        const hue = getAccentHue(iconName);
                        return (
                          <button
                            key={iconName}
                            onClick={() => {
                              setForm({ ...form, icon: iconName });
                              setShowIconPicker(false);
                            }}
                            className="w-8 h-8 rounded flex items-center justify-center hover:bg-white/10 transition-colors"
                            style={{
                              background: form.icon === iconName
                                ? `hsla(${hue}, 60%, 50%, 0.2)`
                                : 'transparent',
                            }}
                          >
                            <Icon
                              size={16}
                              style={{ color: `hsla(${hue}, 70%, 70%, 1)` }}
                            />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* 名称和描述 */}
                <div className="flex-1 space-y-2">
                  {/* 名称 */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[10px]" style={{ color: 'rgba(255, 255, 255, 0.6)' }}>
                        名称 <span style={{ color: 'rgb(239, 68, 68)' }}>*</span>
                      </label>
                      <span
                        className="text-[10px]"
                        style={{
                          color: nameCharCount > maxNameLength ? 'rgb(239, 68, 68)' : 'rgba(255, 255, 255, 0.5)',
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
                      className="w-full px-2.5 py-2 rounded-lg border text-[12px] outline-none transition-all focus:ring-1 focus:ring-[var(--accent-primary)]/30"
                      style={{
                        background: 'rgba(255, 255, 255, 0.03)',
                        borderColor: 'rgba(255, 255, 255, 0.08)',
                        color: 'rgba(255, 255, 255, 0.9)',
                      }}
                    />
                  </div>

                  {/* 描述 */}
                  <div>
                    <label className="block text-[10px] mb-1" style={{ color: 'rgba(255, 255, 255, 0.6)' }}>
                      描述
                    </label>
                    <input
                      type="text"
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                      placeholder="简单描述这个智能体能做什么"
                      className="w-full px-2.5 py-2 rounded-lg border text-[12px] outline-none transition-all focus:ring-1 focus:ring-[var(--accent-primary)]/30"
                      style={{
                        background: 'rgba(255, 255, 255, 0.03)',
                        borderColor: 'rgba(255, 255, 255, 0.08)',
                        color: 'rgba(255, 255, 255, 0.9)',
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* 标签 */}
              <div className="mt-3">
                <label className="block text-[10px] mb-1.5" style={{ color: 'rgba(255, 255, 255, 0.6)' }}>
                  标签（用逗号分隔）
                </label>
                <input
                  type="text"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  placeholder="例如：写作, 文案, 创意"
                  className="w-full px-2.5 py-2 rounded-lg border text-[12px] outline-none transition-all focus:ring-1 focus:ring-[var(--accent-primary)]/30"
                  style={{
                    background: 'rgba(255, 255, 255, 0.03)',
                    borderColor: 'rgba(255, 255, 255, 0.08)',
                    color: 'rgba(255, 255, 255, 0.9)',
                  }}
                />
                {parsedTags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {parsedTags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          background: 'rgba(99, 102, 241, 0.15)',
                          color: 'rgb(129, 140, 248)',
                          border: '1px solid rgba(99, 102, 241, 0.25)',
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 核心配置标签页 */}
            <div
              className="p-3 rounded-xl"
              style={{
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid rgba(255, 255, 255, 0.05)',
              }}
            >
              {/* Tab 头部 */}
              <div
                className="flex items-center gap-0.5 p-0.5 rounded-lg mb-3"
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.04)',
                }}
              >
                {CONFIG_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className="flex-1 px-2 py-1.5 rounded-md text-[11px] font-medium transition-all flex items-center justify-center gap-1"
                    style={{
                      background: activeTab === tab.key
                        ? 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary, var(--accent-primary)) 100%)'
                        : 'transparent',
                      color: activeTab === tab.key ? 'white' : 'rgba(255, 255, 255, 0.6)',
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
            </div>

            {/* 高级设置（可折叠） */}
            <div
              className="p-3 rounded-xl"
              style={{
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid rgba(255, 255, 255, 0.05)',
              }}
            >
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="w-full flex items-center justify-between"
              >
                <div className="flex items-center gap-1.5">
                  <Settings size={12} style={{ color: 'rgba(255, 255, 255, 0.5)' }} />
                  <span className="text-[12px] font-medium" style={{ color: 'rgba(255, 255, 255, 0.9)' }}>
                    高级设置
                  </span>
                </div>
                {showAdvanced ? (
                  <ChevronDown size={14} style={{ color: 'rgba(255, 255, 255, 0.5)' }} />
                ) : (
                  <ChevronRight size={14} style={{ color: 'rgba(255, 255, 255, 0.5)' }} />
                )}
              </button>
              {showAdvanced && renderAdvancedSettings()}
            </div>
          </div>
        </div>

        {/* 右侧：实时预览 */}
        <div className="w-72 flex-shrink-0">
          <div
            className="h-full flex flex-col rounded-xl"
            style={{
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid rgba(255, 255, 255, 0.05)',
            }}
          >
            {/* 预览头部 */}
            <div
              className="px-3 py-2.5 border-b"
              style={{ borderColor: 'rgba(255, 255, 255, 0.05)' }}
            >
              <div className="text-[11px] font-medium" style={{ color: 'rgba(255, 255, 255, 0.6)' }}>
                实时预览
              </div>
            </div>

            {/* 预览内容 */}
            <div className="flex-1 overflow-auto p-3">
              {/* Agent 信息卡片 */}
              <div className="text-center mb-4">
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-2"
                  style={{
                    background: `linear-gradient(135deg, hsla(${currentIconHue}, 70%, 60%, 0.15) 0%, hsla(${currentIconHue}, 70%, 40%, 0.08) 100%)`,
                    border: `1px solid hsla(${currentIconHue}, 60%, 60%, 0.25)`,
                  }}
                >
                  <CurrentIconComponent
                    size={20}
                    style={{ color: `hsla(${currentIconHue}, 70%, 70%, 1)` }}
                  />
                </div>
                <div
                  className="font-medium text-[12px]"
                  style={{ color: 'rgba(255, 255, 255, 0.95)' }}
                >
                  {form.name || '未命名智能体'}
                </div>
                <div
                  className="text-[10px] mt-0.5"
                  style={{ color: 'rgba(255, 255, 255, 0.5)' }}
                >
                  {form.description || '暂无描述'}
                </div>
              </div>

              {/* 欢迎消息 */}
              <div className="space-y-2">
                <div
                  className="p-2.5 rounded-lg rounded-tl-sm text-[11px]"
                  style={{
                    background: 'rgba(255, 255, 255, 0.04)',
                    color: 'rgba(255, 255, 255, 0.85)',
                  }}
                >
                  {form.welcomeMessage || '你好！有什么可以帮你的吗？'}
                </div>

                {/* 引导问题 */}
                {form.conversationStarters.filter(Boolean).length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {form.conversationStarters.filter(Boolean).map((starter, i) => (
                      <button
                        key={i}
                        className="px-2 py-1 rounded-full text-[10px] transition-colors hover:opacity-80"
                        style={{
                          background: 'rgba(99, 102, 241, 0.12)',
                          color: 'rgb(129, 140, 248)',
                          border: '1px solid rgba(99, 102, 241, 0.2)',
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
              className="p-2.5 border-t"
              style={{ borderColor: 'rgba(255, 255, 255, 0.05)' }}
            >
              <div
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg"
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                }}
              >
                <input
                  type="text"
                  value={previewInput}
                  onChange={(e) => setPreviewInput(e.target.value)}
                  placeholder="输入消息..."
                  className="flex-1 bg-transparent text-[11px] outline-none"
                  style={{ color: 'rgba(255, 255, 255, 0.9)' }}
                />
                <button
                  className="p-1 rounded transition-colors hover:bg-white/10"
                  style={{ color: 'var(--accent-primary)' }}
                >
                  <Send size={12} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
