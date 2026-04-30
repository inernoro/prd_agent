import { useState, useMemo, useEffect, useRef } from 'react';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { Surface } from '@/components/design/Surface';
import { useToolboxStore } from '@/stores/toolboxStore';
import { listWorkflows } from '@/services';
import type { Workflow } from '@/services/contracts/workflowAgent';
import type { LucideIcon } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { cn } from '@/lib/cn';
import {
  ArrowLeft,
  Save,
  Sparkles,
  ChevronDown,
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
  Swords,
  Info,
  File,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { uploadAttachment } from '@/services/real/aiToolbox';

// 图标组件映射
const ICON_MAP: Record<string, LucideIcon> = {
  FileText, Palette, PenTool, Bug, Code2, Languages, FileSearch, BarChart3,
  Bot, Lightbulb, Target, Wrench, Sparkles, Rocket, MessageSquare, Zap,
  Brain, Cpu, Database, Globe, Image, Music, Video, BookOpen,
  GraduationCap, Briefcase, Heart, Star, Shield, Lock, Search, Layers, Swords,
  Workflow: WorkflowIcon,
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
  Search: 180, Layers: 240, Swords: 30, Workflow: 270,
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
  { key: 'webSearch', label: '联网搜索', icon: 'Globe', description: '搜索互联网获取最新信息', hue: 180 },
  { key: 'imageGen', label: '图片生成', icon: 'Image', description: '使用 AI 生成图片', hue: 330 },
  { key: 'codeInterpreter', label: '代码解释器', icon: 'Code2', description: '执行代码并返回结果', hue: 160 },
  { key: 'fileReader', label: '文件解析', icon: 'FileText', description: '读取和分析文件', hue: 45 },
  { key: 'workflowTrigger', label: '发送到工作流', icon: 'Workflow', description: '将消息发送到绑定的工作流执行', hue: 270 },
];

// Tab 配置
const CONFIG_TABS = [
  { key: 'persona', label: '人设与目标', icon: <User size={12} />, hue: 270 },
  { key: 'capabilities', label: '能力增强', icon: <Zap size={12} />, hue: 45 },
  { key: 'conversation', label: '对话体验', icon: <MessageSquare size={12} />, hue: 180 },
];

// 页面容器样式 — 页面级不使用 surface 类，保持透明让卡片自身表达玻璃质感
const pageContainerClassName = '';
const pageContainerStyle: React.CSSProperties = {};

interface FormState {
  name: string;
  description: string;
  icon: string;
  prompt: string;
  tags: string;
  welcomeMessage: string;
  conversationStarters: string[];
  enabledTools: string[];
  workflowId: string;
  knowledgeBase: string[];
  temperature: number;
  enableMemory: boolean;
}

export function ToolEditor() {
  const { view, editingItem, saveItem, backToGrid } = useToolboxStore();

  const isEditing = view === 'edit' && !!editingItem?.id;
  const [form, setForm] = useState<FormState>({
    name: editingItem?.name || '',
    description: editingItem?.description || '',
    icon: editingItem?.icon || 'Bot',
    prompt: editingItem?.prompt || editingItem?.systemPrompt || '',
    tags: editingItem?.tags?.join(', ') || '',
    welcomeMessage: editingItem?.welcomeMessage ?? '你好！我是你的 AI 助手，有什么可以帮你的吗？',
    conversationStarters: editingItem?.conversationStarters?.length ? [...editingItem.conversationStarters] : ['帮我写一段文案', '分析一下这个数据'],
    enabledTools: editingItem?.enabledTools ?? [],
    workflowId: editingItem?.workflowId ?? '',
    knowledgeBase: editingItem?.knowledgeBaseIds ?? [],
    temperature: editingItem?.temperature ?? 0.7,
    enableMemory: editingItem?.enableMemory ?? false,
  });

  const [saving, setSaving] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [activeTab, setActiveTab] = useState('persona');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [previewInput, setPreviewInput] = useState('');
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [wfDropdownOpen, setWfDropdownOpen] = useState(false);
  const [knowledgeFiles, setKnowledgeFiles] = useState<Array<{
    id: string;
    fileName: string;
    mimeType: string;
    size: number;
    attachmentId?: string;
    status: 'uploading' | 'done' | 'error';
  }>>([]);
  const knowledgeFileInputRef = useRef<HTMLInputElement>(null);
  const wfDropdownRef = useRef<HTMLDivElement>(null);

  // 当启用工作流能力时加载工作流列表
  const isWorkflowEnabled = form.enabledTools.includes('workflowTrigger');
  useEffect(() => {
    if (isWorkflowEnabled && workflows.length === 0) {
      setWorkflowsLoading(true);
      listWorkflows({ pageSize: 200 })
        .then((res) => {
          if (res.success && res.data) {
            setWorkflows(res.data.items);
          }
        })
        .finally(() => setWorkflowsLoading(false));
    }
  }, [isWorkflowEnabled]);

  // 点击外部关闭工作流下拉
  useEffect(() => {
    if (!wfDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (wfDropdownRef.current && !wfDropdownRef.current.contains(e.target as Node)) {
        setWfDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [wfDropdownOpen]);

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
    const knowledgeBaseIds = knowledgeFiles
      .filter(f => f.status === 'done' && f.attachmentId)
      .map(f => f.attachmentId!);
    // If editing and no new files were added, keep existing knowledgeBaseIds
    const finalKnowledgeBaseIds = knowledgeBaseIds.length > 0
      ? knowledgeBaseIds
      : (isEditing ? form.knowledgeBase : []);

    const success = await saveItem({
      ...(editingItem?.id ? { id: editingItem.id } : {}),
      name: form.name.trim(),
      description: form.description.trim(),
      icon: form.icon,
      prompt: form.prompt.trim(),
      tags: parsedTags,
      enabledTools: form.enabledTools,
      workflowId: form.enabledTools.includes('workflowTrigger') ? form.workflowId : undefined,
      welcomeMessage: form.welcomeMessage.trim() || undefined,
      conversationStarters: form.conversationStarters.filter(Boolean),
      temperature: form.temperature,
      enableMemory: form.enableMemory,
      knowledgeBaseIds: finalKnowledgeBaseIds,
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

  const handleKnowledgeFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    e.target.value = '';

    for (const file of Array.from(files)) {
      const tempId = Math.random().toString(36).slice(2, 11);
      const entry = {
        id: tempId,
        fileName: file.name,
        mimeType: file.type,
        size: file.size,
        status: 'uploading' as const,
      };
      setKnowledgeFiles(prev => [...prev, entry]);

      try {
        const result = await uploadAttachment(file);
        if (result.success && result.data?.attachmentId) {
          setKnowledgeFiles(prev => prev.map(f =>
            f.id === tempId ? { ...f, attachmentId: result.data!.attachmentId, status: 'done' as const } : f
          ));
        } else {
          setKnowledgeFiles(prev => prev.map(f =>
            f.id === tempId ? { ...f, status: 'error' as const } : f
          ));
        }
      } catch {
        setKnowledgeFiles(prev => prev.map(f =>
          f.id === tempId ? { ...f, status: 'error' as const } : f
        ));
      }
    }
  };

  const removeKnowledgeFile = (id: string) => {
    setKnowledgeFiles(prev => prev.filter(f => f.id !== id));
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
      {/* 系统提示词 - 最重要的部分，突出显示 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="surface-inset w-6 h-6 rounded-lg flex items-center justify-center">
              <Brain size={12} className="text-token-accent" />
            </div>
            <label className="text-[12px] font-semibold text-token-primary">
              系统提示词 <span className="text-[color:var(--status-error)]">*</span>
            </label>
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-[11px] gap-1.5 px-2.5">
            <Sparkles size={11} />
            AI 优化
          </Button>
        </div>
        <div className="surface-inset text-token-secondary text-[11px] mb-2 px-3 py-2 rounded-lg flex items-start gap-2">
          <Info size={12} className="text-token-accent flex-shrink-0 mt-0.5" />
          <span>
            使用结构化格式（# 角色、## 技能、## 限制）可以让 AI 更好地理解
          </span>
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
          className="prd-field w-full h-44 p-3 rounded-xl text-[12px] resize-none outline-none font-mono"
        />
      </div>
    </div>
  );

  // 渲染能力增强标签页
  const renderCapabilitiesTab = () => (
    <div className="space-y-4">
      {/* 能力工具 */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <div className="surface-inset w-6 h-6 rounded-lg flex items-center justify-center">
            <Wrench size={12} className="text-token-warning" />
          </div>
          <label className="text-[12px] font-semibold text-token-primary">
            能力工具
          </label>
          <span className="bg-token-nested text-token-muted text-[10px] px-1.5 py-0.5 rounded">
            {form.enabledTools.length} 已选
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {CAPABILITY_TOOLS.map((tool) => {
            const ToolIcon = getIconComponent(tool.icon);
            const isEnabled = form.enabledTools.includes(tool.key);
            return (
              <button
                key={tool.key}
                onClick={() => toggleTool(tool.key)}
                className={cn(
                  'p-3 rounded-xl text-left transition-all group',
                  isEnabled ? 'surface-inset' : 'surface-row'
                )}
                style={{
                  background: isEnabled
                    ? `linear-gradient(135deg, hsla(${tool.hue}, 70%, 50%, 0.12) 0%, hsla(${tool.hue}, 70%, 30%, 0.06) 100%)`
                    : undefined,
                  border: isEnabled
                    ? `1px solid hsla(${tool.hue}, 60%, 55%, 0.35)`
                    : undefined,
                  boxShadow: isEnabled
                    ? `0 2px 8px -2px hsla(${tool.hue}, 70%, 50%, 0.2)`
                    : undefined,
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center"
                    style={{
                      background: isEnabled
                        ? `linear-gradient(135deg, hsla(${tool.hue}, 70%, 60%, 0.25) 0%, hsla(${tool.hue}, 70%, 40%, 0.15) 100%)`
                        : undefined,
                      border: isEnabled
                        ? `1px solid hsla(${tool.hue}, 60%, 60%, 0.3)`
                        : undefined,
                    }}
                  >
                    <ToolIcon
                      size={14}
                      style={{
                        color: isEnabled
                          ? `hsla(${tool.hue}, 70%, 70%, 1)`
                          : 'var(--text-muted)',
                      }}
                    />
                  </div>
                  <span
                    className="text-[12px] font-medium"
                    style={{
                      color: isEnabled
                        ? `hsla(${tool.hue}, 70%, 75%, 1)`
                        : 'var(--text-secondary)',
                    }}
                  >
                    {tool.label}
                  </span>
                </div>
                <div className="text-token-muted-faint text-[10px] pl-9">
                  {tool.description}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 工作流绑定 — 仅在启用 workflowTrigger 时显示 */}
      {isWorkflowEnabled && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="surface-inset w-6 h-6 rounded-lg flex items-center justify-center">
              <WorkflowIcon size={12} className="text-token-accent" />
            </div>
            <label className="text-[12px] font-semibold text-token-primary">
              绑定工作流 <span className="text-[color:var(--status-error)]">*</span>
            </label>
          </div>
          <div className="surface-inset text-token-secondary text-[11px] mb-2 px-3 py-2 rounded-lg flex items-start gap-2">
            <Info size={12} className="text-token-accent flex-shrink-0 mt-0.5" />
            <span>
              选择一个工作流，对话时可将消息发送到该工作流执行
            </span>
          </div>
          {workflowsLoading ? (
            <div className="flex items-center gap-2 p-3 text-token-muted">
              <MapSpinner size={14} />
              <span className="text-[12px]">加载工作流列表...</span>
            </div>
          ) : (
            <div ref={wfDropdownRef} className="relative">
              {/* 触发按钮 */}
              <button
                type="button"
                onClick={() => setWfDropdownOpen(!wfDropdownOpen)}
                className={cn(
                  'surface-inset w-full px-3 py-2.5 rounded-xl text-left flex items-center gap-2.5 outline-none transition-all',
                  wfDropdownOpen && 'ring-2 ring-[var(--accent-primary)]/10 border-[var(--accent-primary)]/30'
                )}
              >
                {(() => {
                  const selected = workflows.find(w => w.id === form.workflowId);
                  if (!selected) return (
                    <span className="text-token-muted text-[13px] flex-1">
                      请选择工作流...
                    </span>
                  );
                  return (
                    <>
                      <div
                        className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 overflow-hidden text-[13px]"
                        style={{
                          background: selected.avatarUrl ? 'transparent' : 'rgba(99,102,241,0.1)',
                          border: `1px solid ${selected.avatarUrl ? 'rgba(255,255,255,0.08)' : 'rgba(99,102,241,0.15)'}`,
                        }}
                      >
                        {selected.avatarUrl
                          ? <img src={selected.avatarUrl} alt="" className="w-full h-full object-cover" />
                          : (selected.icon || '⚡')
                        }
                      </div>
                      <span className="text-token-primary text-[13px] flex-1 truncate">
                        {selected.name}
                      </span>
                    </>
                  );
                })()}
                <ChevronDown
                  size={14}
                  className={cn('text-token-muted flex-shrink-0 transition-transform', wfDropdownOpen && 'rotate-180')}
                />
              </button>

              {/* 下拉菜单 */}
              {wfDropdownOpen && (
                <Surface
                  variant="raised"
                  className="absolute z-50 left-0 right-0 mt-1.5 rounded-xl overflow-hidden py-1"
                  style={{
                    maxHeight: 260,
                    overflowY: 'auto',
                    animation: 'wfDropIn 0.15s ease-out',
                  }}
                >
                  {workflows.length === 0 ? (
                    <div className="text-token-muted px-3 py-4 text-center text-[12px]">
                      暂无可用工作流
                    </div>
                  ) : workflows.map((wf) => (
                    <button
                      key={wf.id}
                      type="button"
                      onClick={() => {
                        setForm({ ...form, workflowId: wf.id });
                        setWfDropdownOpen(false);
                      }}
                      className={cn(
                        'w-full px-3 py-2 flex items-center gap-2.5 text-left transition-colors',
                        wf.id === form.workflowId ? 'bg-token-nested' : 'hover:bg-token-nested'
                      )}
                    >
                      <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden text-[14px]"
                        style={{
                          background: wf.avatarUrl ? 'transparent' : 'rgba(99,102,241,0.08)',
                          border: `1px solid ${wf.avatarUrl ? 'rgba(255,255,255,0.08)' : 'rgba(99,102,241,0.12)'}`,
                        }}
                      >
                        {wf.avatarUrl
                          ? <img src={wf.avatarUrl} alt="" className="w-full h-full object-cover" />
                          : (wf.icon || '⚡')
                        }
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-token-primary text-[12px] font-medium truncate">
                          {wf.name}
                        </div>
                        {wf.description && (
                          <div className="text-token-muted text-[10px] truncate mt-0.5">
                            {wf.description}
                          </div>
                        )}
                      </div>
                      {wf.id === form.workflowId && (
                        <div className="bg-[var(--accent-primary)] w-1.5 h-1.5 rounded-full flex-shrink-0" />
                      )}
                    </button>
                  ))}
                </Surface>
              )}
              <style>{`
                @keyframes wfDropIn {
                  from { opacity: 0; transform: translateY(-4px); }
                  to { opacity: 1; transform: translateY(0); }
                }
              `}</style>
            </div>
          )}
        </div>
      )}

      {/* 知识库 */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <div className="surface-inset w-6 h-6 rounded-lg flex items-center justify-center">
            <BookOpen size={12} className="text-token-success" />
          </div>
          <label className="text-[12px] font-semibold text-token-primary">
            知识库
          </label>
          {knowledgeFiles.length > 0 && (
            <span
              className="surface-state-success text-[10px] px-1.5 py-0.5 rounded"
            >
              {knowledgeFiles.filter(f => f.status === 'done').length} 个文件
            </span>
          )}
        </div>

        {/* 已上传的文件列表 */}
        {knowledgeFiles.length > 0 && (
          <div className="space-y-1.5 mb-3">
            {knowledgeFiles.map((file) => (
              <Surface
                variant="inset"
                key={file.id}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded-lg',
                  file.status === 'error' && 'border-[var(--status-error)]'
                )}
              >
                <File size={14} style={{
                  color: file.status === 'error' ? 'rgb(239, 68, 68)'
                    : file.status === 'uploading' ? 'var(--text-muted)'
                    : 'rgb(74, 222, 128)',
                }} />
                <span className="text-token-secondary flex-1 text-[11px] truncate">
                  {file.fileName}
                </span>
                <span className="text-token-muted text-[10px] flex-shrink-0">
                  {(file.size / 1024).toFixed(0)} KB
                </span>
                {file.status === 'uploading' && (
                  <MapSpinner size={12} className="flex-shrink-0" />
                )}
                {file.status === 'error' && (
                  <span className="text-token-error text-[10px] flex-shrink-0">失败</span>
                )}
                <button
                  onClick={() => removeKnowledgeFile(file.id)}
                  className="p-1 rounded hover:bg-white/10 transition-colors flex-shrink-0"
                >
                  <X size={12} className="text-token-muted" />
                </button>
              </Surface>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => knowledgeFileInputRef.current?.click()}
          className="surface-inset w-full p-4 rounded-xl text-center cursor-pointer transition-all border-dashed hover:border-[var(--status-done)] group"
        >
          <div
            className="surface-inset w-10 h-10 rounded-xl flex items-center justify-center mx-auto mb-2 transition-transform group-hover:scale-110"
          >
            <Plus size={18} className="text-token-success" />
          </div>
          <div className="text-token-secondary text-[11px] font-medium">
            上传文档或连接知识库
          </div>
          <div className="text-token-muted text-[10px] mt-1">
            支持 PDF、Word、Excel、PPT、TXT 等格式
          </div>
        </button>
        <input
          ref={knowledgeFileInputRef}
          type="file"
          multiple
          className="hidden"
          accept=".pdf,.doc,.docx,.txt,.md,.json,.csv,.xlsx,.xls,.ppt,.pptx"
          onChange={handleKnowledgeFileSelect}
        />
      </div>
    </div>
  );

  // 渲染对话体验标签页
  const renderConversationTab = () => (
    <div className="space-y-4">
      {/* 欢迎语 */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <div className="surface-inset w-6 h-6 rounded-lg flex items-center justify-center">
            <MessageSquare size={12} className="text-token-accent" />
          </div>
          <label className="text-[12px] font-semibold text-token-primary">
            开场白
          </label>
        </div>
        <textarea
          value={form.welcomeMessage}
          onChange={(e) => setForm({ ...form, welcomeMessage: e.target.value })}
          placeholder="智能体发送的第一条消息..."
          className="prd-field w-full h-20 p-3 rounded-xl text-[12px] resize-none outline-none"
        />
      </div>

      {/* 对话开场白 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="surface-inset w-6 h-6 rounded-lg flex items-center justify-center">
              <Lightbulb size={12} className="text-token-accent" />
            </div>
            <label className="text-[12px] font-semibold text-token-primary">
              引导问题
            </label>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px] gap-1.5 px-2.5"
            onClick={addConversationStarter}
          >
            <Plus size={11} />
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
                className="prd-field flex-1 px-3 py-2 rounded-lg text-[12px] outline-none"
              />
              {form.conversationStarters.length > 1 && (
                <button
                  onClick={() => removeConversationStarter(index)}
                  className="p-2 rounded-lg transition-colors hover:bg-red-500/10 text-token-muted"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="text-token-muted text-[10px] mt-2">
          这些问题会显示为快捷按钮，帮助用户快速开始对话
        </div>
      </div>
    </div>
  );

  // 渲染高级设置
  const renderAdvancedSettings = () => (
    <div className="space-y-4 pt-3">
      {/* 模型池说明 */}
      <Surface variant="inset" className="p-3 rounded-xl">
        <div className="flex items-center gap-2 mb-1.5">
          <Cpu size={12} className="text-token-accent" />
          <span className="text-token-accent text-[11px] font-semibold">
            模型调度
          </span>
        </div>
        <div className="text-token-muted text-[11px]">
          智能体使用 <code className="bg-token-nested px-1.5 py-0.5 rounded font-mono text-[10px]">ai-toolbox</code> 应用标识绑定的模型池，由后端自动调度最优模型。
        </div>
      </Surface>

      {/* 温度 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-token-secondary text-[12px] font-medium">
            创造性 (Temperature)
          </label>
          <span className="bg-token-nested text-token-primary text-[12px] font-semibold px-2 py-0.5 rounded">
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
          className="w-full h-2 rounded-full appearance-none cursor-pointer"
          style={{
            background: `linear-gradient(90deg, rgb(59, 130, 246) ${form.temperature * 100}%, rgba(255, 255, 255, 0.1) ${form.temperature * 100}%)`,
          }}
        />
        <div className="text-token-muted flex justify-between text-[10px] mt-1.5">
          <span>精确</span>
          <span>创造</span>
        </div>
      </div>

      {/* 长期记忆 */}
      <Surface variant="inset" className="flex items-center justify-between p-3 rounded-xl">
        <div>
          <div className="text-token-primary text-[12px] font-medium">
            长期记忆
          </div>
          <div className="text-token-muted text-[10px]">
            记住用户偏好和历史对话
          </div>
        </div>
        <button
          onClick={() => setForm({ ...form, enableMemory: !form.enableMemory })}
          className="w-11 h-6 rounded-full transition-all relative"
          style={{
            background: form.enableMemory
              ? 'linear-gradient(90deg, var(--accent-primary) 0%, var(--accent-secondary, var(--accent-primary)) 100%)'
              : 'var(--bg-nested)',
            boxShadow: form.enableMemory
              ? '0 2px 8px -2px rgba(var(--accent-primary-rgb, 99, 102, 241), 0.4)'
              : 'none',
          }}
        >
          <div
            className="w-5 h-5 rounded-full bg-white absolute top-0.5 transition-transform shadow-sm"
            style={{
              transform: form.enableMemory ? 'translateX(22px)' : 'translateX(2px)',
            }}
          />
        </button>
      </Surface>
    </div>
  );

  return (
    <div className={`${pageContainerClassName} h-full min-h-0 flex flex-col gap-3`} style={pageContainerStyle}>
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
                {saving ? <MapSpinner size={13} /> : <Save size={13} />}
                保存
              </Button>
            </div>
          }
        />
      </div>

      {/* Main Content - 双栏布局 */}
      <div className="flex-1 min-h-0 flex gap-4 overflow-hidden px-4 pb-3">
        {/* 左侧：配置区 */}
        <div className="flex-1 min-w-0 overflow-auto pr-1">
          <div className="space-y-4">
            {/* 基础信息 - 突出显示 */}
            <Surface variant="inset" className="rounded-xl overflow-hidden">
              {/* 卡片头部 */}
              <div className="surface-reading-header px-4 py-3 flex items-center gap-2">
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center"
                  style={{
                    background: `linear-gradient(135deg, hsla(${currentIconHue}, 70%, 60%, 0.2) 0%, hsla(${currentIconHue}, 70%, 40%, 0.1) 100%)`,
                    border: `1px solid hsla(${currentIconHue}, 60%, 60%, 0.25)`,
                  }}
                >
                  <Info size={13} style={{ color: `hsla(${currentIconHue}, 70%, 70%, 1)` }} />
                </div>
                <span className="text-token-primary text-[13px] font-semibold">
                  基本信息
                </span>
              </div>

              {/* 卡片内容 */}
              <div className="p-4">
                <div className="flex gap-4">
                  {/* 图标选择器 */}
                  <div className="relative flex-shrink-0">
                    <button
                      onClick={() => setShowIconPicker(!showIconPicker)}
                      className="w-16 h-16 rounded-xl flex items-center justify-center border transition-all hover:scale-105"
                      style={{
                        background: `linear-gradient(135deg, hsla(${currentIconHue}, 70%, 60%, 0.15) 0%, hsla(${currentIconHue}, 70%, 40%, 0.08) 100%)`,
                        borderColor: `hsla(${currentIconHue}, 60%, 60%, 0.3)`,
                        boxShadow: `0 4px 12px -2px hsla(${currentIconHue}, 70%, 50%, 0.2)`,
                      }}
                    >
                      <CurrentIconComponent
                        size={28}
                        style={{ color: `hsla(${currentIconHue}, 70%, 70%, 1)` }}
                      />
                    </button>
                    {showIconPicker && (
                      <div
                        className="absolute top-full left-0 mt-2 p-3 rounded-xl border shadow-xl z-10 grid grid-cols-8 gap-1.5 w-[300px]"
                        style={{
                          background: 'var(--bg-card, rgba(255, 255, 255, 0.03))',
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
                              className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/10 transition-all hover:scale-110"
                              style={{
                                background: form.icon === iconName
                                  ? `hsla(${hue}, 60%, 50%, 0.2)`
                                  : 'transparent',
                                border: form.icon === iconName
                                  ? `1px solid hsla(${hue}, 60%, 60%, 0.3)`
                                  : '1px solid transparent',
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
                  <div className="flex-1 space-y-3">
                    {/* 名称 */}
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-token-secondary text-[11px] font-medium">
                          名称 <span className="text-[color:var(--status-error)]">*</span>
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
                        className="prd-field w-full px-3 py-2.5 rounded-xl text-[13px] outline-none"
                      />
                    </div>

                    {/* 描述 */}
                    <div>
                      <label className="text-token-secondary block text-[11px] font-medium mb-1.5">
                        描述
                      </label>
                      <input
                        type="text"
                        value={form.description}
                        onChange={(e) => setForm({ ...form, description: e.target.value })}
                        placeholder="简单描述这个智能体能做什么"
                        className="prd-field w-full px-3 py-2.5 rounded-xl text-[13px] outline-none"
                      />
                    </div>
                  </div>
                </div>

                {/* 标签 */}
                <div className="mt-4">
                  <label className="text-token-secondary block text-[11px] font-medium mb-1.5">
                    标签（用逗号分隔）
                  </label>
                  <input
                    type="text"
                    value={form.tags}
                    onChange={(e) => setForm({ ...form, tags: e.target.value })}
                    placeholder="例如：写作, 文案, 创意"
                    className="prd-field w-full px-3 py-2.5 rounded-xl text-[13px] outline-none"
                  />
                  {parsedTags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {parsedTags.map((tag) => (
                        <span
                          key={tag}
                          className="text-[10px] px-2 py-1 rounded-lg font-medium"
                          style={{
                            background: `hsla(${currentIconHue}, 70%, 50%, 0.15)`,
                            color: `hsla(${currentIconHue}, 70%, 70%, 1)`,
                            border: `1px solid hsla(${currentIconHue}, 60%, 60%, 0.25)`,
                          }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </Surface>

            {/* 核心配置标签页 */}
            <Surface variant="inset" className="rounded-xl overflow-hidden">
              {/* Tab 头部 */}
              <div className="bg-token-nested border-b border-token-subtle flex items-center gap-1 p-1.5">
                {CONFIG_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className="flex-1 px-3 py-2 rounded-lg text-[11px] font-medium transition-all flex items-center justify-center gap-1.5"
                    style={{
                      background: activeTab === tab.key
                        ? `linear-gradient(135deg, hsla(${tab.hue}, 70%, 50%, 0.15) 0%, hsla(${tab.hue}, 70%, 30%, 0.08) 100%)`
                        : 'transparent',
                      color: activeTab === tab.key
                        ? `hsla(${tab.hue}, 70%, 75%, 1)`
                        : 'rgba(255, 255, 255, 0.5)',
                      border: activeTab === tab.key
                        ? `1px solid hsla(${tab.hue}, 60%, 55%, 0.3)`
                        : '1px solid transparent',
                      boxShadow: activeTab === tab.key
                        ? `0 2px 8px -2px hsla(${tab.hue}, 70%, 50%, 0.2)`
                        : 'none',
                    }}
                  >
                    {tab.icon}
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Tab 内容 */}
              <div className="p-4">
                {activeTab === 'persona' && renderPersonaTab()}
                {activeTab === 'capabilities' && renderCapabilitiesTab()}
                {activeTab === 'conversation' && renderConversationTab()}
              </div>
            </Surface>

            {/* 高级设置（可折叠） */}
            <Surface variant="inset" className="rounded-xl overflow-hidden">
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="surface-row w-full px-4 py-3 flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <div
                    className="w-6 h-6 rounded-lg flex items-center justify-center"
                    style={{
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                    }}
                  >
                    <Settings size={12} style={{ color: 'rgba(255, 255, 255, 0.5)' }} />
                  </div>
                  <span className="text-token-primary text-[13px] font-semibold">
                    高级设置
                  </span>
                </div>
                <div
                  className="w-6 h-6 rounded-lg flex items-center justify-center transition-transform"
                  style={{
                    background: 'rgba(255, 255, 255, 0.03)',
                    transform: showAdvanced ? 'rotate(180deg)' : 'rotate(0deg)',
                  }}
                >
                  <ChevronDown size={14} style={{ color: 'rgba(255, 255, 255, 0.5)' }} />
                </div>
              </button>
              {showAdvanced && (
                <div className="px-4 pb-4">
                  {renderAdvancedSettings()}
                </div>
              )}
            </Surface>
          </div>
        </div>

        {/* 右侧：实时预览 */}
        <div className="w-80 flex-shrink-0">
          <Surface variant="inset" className="h-full flex flex-col rounded-xl overflow-hidden">
            {/* 预览头部 */}
            <div className="surface-reading-header px-4 py-3 flex items-center gap-2">
              <div
                className="w-6 h-6 rounded-lg flex items-center justify-center"
                style={{
                  background: `linear-gradient(135deg, hsla(${currentIconHue}, 70%, 60%, 0.2) 0%, hsla(${currentIconHue}, 70%, 40%, 0.1) 100%)`,
                  border: `1px solid hsla(${currentIconHue}, 60%, 60%, 0.25)`,
                }}
              >
                <Target size={12} style={{ color: `hsla(${currentIconHue}, 70%, 70%, 1)` }} />
              </div>
              <span className="text-token-primary text-[12px] font-semibold">
                实时预览
              </span>
            </div>

            {/* 预览内容 */}
            <div className="flex-1 overflow-auto p-4">
              {/* Agent 信息卡片 */}
              <div className="text-center mb-5">
                <div
                  className="w-14 h-14 rounded-xl flex items-center justify-center mx-auto mb-3"
                  style={{
                    background: `linear-gradient(135deg, hsla(${currentIconHue}, 70%, 60%, 0.18) 0%, hsla(${currentIconHue}, 70%, 40%, 0.08) 100%)`,
                    border: `1px solid hsla(${currentIconHue}, 60%, 60%, 0.3)`,
                    boxShadow: `0 4px 16px -4px hsla(${currentIconHue}, 70%, 50%, 0.25)`,
                  }}
                >
                  <CurrentIconComponent
                    size={24}
                    style={{ color: `hsla(${currentIconHue}, 70%, 70%, 1)` }}
                  />
                </div>
                <div className="text-token-primary font-semibold text-[14px]">
                  {form.name || '未命名智能体'}
                </div>
                <div className="text-token-muted text-[11px] mt-1">
                  {form.description || '暂无描述'}
                </div>
              </div>

              {/* 欢迎消息 */}
              <div className="space-y-3">
                <Surface variant="inset" className="p-3 rounded-xl rounded-tl-sm text-[12px] leading-relaxed text-token-secondary">
                  {form.welcomeMessage || '你好！有什么可以帮你的吗？'}
                </Surface>

                {/* 引导问题 */}
                {form.conversationStarters.filter(Boolean).length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {form.conversationStarters.filter(Boolean).map((starter, i) => (
                      <button
                        key={i}
                        className="px-3 py-1.5 rounded-full text-[11px] transition-all hover:scale-105"
                        style={{
                          background: `linear-gradient(135deg, hsla(${currentIconHue}, 70%, 50%, 0.12) 0%, hsla(${currentIconHue}, 70%, 30%, 0.08) 100%)`,
                          color: `hsla(${currentIconHue}, 70%, 75%, 1)`,
                          border: `1px solid hsla(${currentIconHue}, 60%, 60%, 0.25)`,
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
            <div className="bg-token-nested border-t border-token-subtle p-3">
              <div className="surface-inset flex items-center gap-2 px-3 py-2.5 rounded-xl">
                <input
                  type="text"
                  value={previewInput}
                  onChange={(e) => setPreviewInput(e.target.value)}
                  placeholder="输入消息..."
                  className="text-token-primary flex-1 bg-transparent text-[12px] outline-none"
                />
                <button
                  className="p-1.5 rounded-lg transition-all hover:bg-white/10"
                  style={{ color: 'var(--accent-primary)' }}
                >
                  <Send size={14} />
                </button>
              </div>
            </div>
          </Surface>
        </div>
      </div>
    </div>
  );
}
