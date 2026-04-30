import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/design/Button';
import { Surface } from '@/components/design/Surface';
import { useToolboxStore } from '@/stores/toolboxStore';
import { cn } from '@/lib/cn';
import { streamDirectChat, getModelGroups, listWorkflows } from '@/services';
import type { DirectChatMessage } from '@/services';
import type { ModelGroup } from '@/types/modelGroup';
import type { Workflow } from '@/services/contracts/workflowAgent';
import type { LucideIcon } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  ArrowLeft,
  ArrowRight,
  Save,
  Sparkles,
  ChevronRight,
  Settings2,
  Mail,
  FileText,
  ClipboardList,
  PenTool,
  Code2,
  Bot,
  Send,
  Check,
  Plus,
  Lightbulb,
  Brain,
  Target,
  MessageSquare,
  BarChart3,
  Briefcase,
  GraduationCap,
  Heart,
  Maximize2,
  Minimize2,
  X,
  RotateCcw,
  Upload,
  BookOpen,
  Cpu,
  ChevronDown,
  Play,
  PenLine,
  Square,
  Workflow as WorkflowIcon,
  Info,
} from 'lucide-react';

// ============ 图标映射 ============

const ICON_MAP: Record<string, LucideIcon> = {
  Mail, FileText, ClipboardList, PenTool, Code2, Bot,
  Sparkles, Brain, Target, MessageSquare, BarChart3, Briefcase,
  GraduationCap, Heart, Lightbulb,
};

const ICON_HUE_MAP: Record<string, number> = {
  Mail: 210, FileText: 210, ClipboardList: 30, PenTool: 45,
  Code2: 180, Bot: 210, Sparkles: 280,
  Brain: 270, Target: 0, MessageSquare: 180, BarChart3: 270,
  Briefcase: 30, GraduationCap: 220, Heart: 350, Lightbulb: 45,
};

function getIconComponent(iconName: string): LucideIcon {
  return ICON_MAP[iconName] || Bot;
}

function getAccentHue(iconName: string): number {
  return ICON_HUE_MAP[iconName] ?? 210;
}

// ============ 模板定义 ============

export interface AgentTemplate {
  key: string;
  name: string;
  description: string;
  icon: string;
  prompt: string;
  welcomeMessage: string;
  conversationStarters: string[];
  tags: string[];
  temperature: number;
}

const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    key: 'email-writer',
    name: '邮件写手',
    description: '快速撰写各类邮件，支持商务、通知、感谢等场景',
    icon: 'Mail',
    prompt: `# 角色
你是一位专业的邮件撰写助手，帮助用户快速写出得体、专业的邮件。

## 技能
- 根据用户描述的场景和关键信息，生成完整的邮件
- 支持商务邮件、通知邮件、感谢邮件、请假邮件等多种类型
- 自动调整语气（正式/半正式/轻松）
- 提供邮件主题建议

## 输出格式
**主题**：[邮件主题]

---

[邮件正文]

## 限制
- 邮件简洁清晰，避免冗余
- 保持专业礼貌的语气
- 除非用户指定，默认使用正式语气`,
    welcomeMessage: '你好！我是邮件写手，告诉我你想写什么邮件，我来帮你快速搞定！',
    conversationStarters: ['帮我写一封请假邮件', '写一封项目进度汇报邮件', '帮我写一封感谢客户的邮件', '写一封会议邀请邮件'],
    tags: ['邮件', '写作', '商务'],
    temperature: 0.7,
  },
  {
    key: 'weekly-report',
    name: '周报助手',
    description: '根据工作要点自动生成结构化周报',
    icon: 'FileText',
    prompt: `# 角色
你是一位周报撰写助手，帮助用户将零散的工作要点整理为结构清晰的工作周报。

## 技能
- 将用户输入的工作要点分类整理
- 自动归纳为"本周完成"、"进行中"、"下周计划"三个板块
- 提炼关键成果和数据
- 语言简练，突出重点

## 输出格式
### 本周工作总结
**一、已完成事项**
1. ...

**二、进行中事项**
1. ...

**三、下周计划**
1. ...

**四、需要协调/风险项**（如有）

## 限制
- 保持客观、专业的语气
- 每条内容控制在 1-2 句话
- 突出成果和数据`,
    welcomeMessage: '你好！告诉我你这周做了什么，我来帮你整理成一份漂亮的周报！',
    conversationStarters: ['这周做了需求评审、修复了3个Bug、还开了项目启动会', '帮我写一份研发周报', '整理一下这些工作内容为周报格式'],
    tags: ['周报', '工作汇报', '效率'],
    temperature: 0.5,
  },
  {
    key: 'meeting-notes',
    name: '会议纪要',
    description: '从会议内容中提取关键信息，生成结构化纪要',
    icon: 'ClipboardList',
    prompt: `# 角色
你是一位会议纪要助手，帮助用户从会议内容中提取关键信息并整理成结构化纪要。

## 技能
- 从用户提供的会议描述中提取关键决议
- 识别待办事项（Action Items）及责任人
- 归纳讨论要点和结论
- 标注需要跟进的事项

## 输出格式
### 会议纪要
- **会议主题**：
- **日期**：
- **参会人**：

**一、讨论要点**
1. ...

**二、关键决议**
1. ...

**三、待办事项**
| 序号 | 事项 | 负责人 | 截止日期 |
|------|------|--------|---------|
| 1 | ... | ... | ... |

## 限制
- 信息准确，不添加会议中未提及的内容
- 待办事项必须明确责任人`,
    welcomeMessage: '你好！把会议中讨论的内容告诉我，我来帮你整理成清晰的会议纪要。',
    conversationStarters: ['帮我整理今天的项目进度会纪要', '把这段对话整理成会议纪要', '今天开会讨论了新功能方案，需要整理纪要'],
    tags: ['会议', '纪要', '效率'],
    temperature: 0.4,
  },
  {
    key: 'copywriter',
    name: '文案创作',
    description: '撰写营销文案、社交媒体内容、产品描述等',
    icon: 'PenTool',
    prompt: `# 角色
你是一位创意文案专家，擅长撰写有吸引力的营销文案和内容。

## 技能
- 撰写社交媒体文案（小红书、微博、朋友圈等）
- 产品描述和卖点提炼
- 营销推广文案
- 品牌故事和 Slogan 创作

## 风格
- 语言生动有感染力
- 善用修辞和金句
- 根据平台调整风格
- 配合 emoji 提升阅读体验

## 限制
- 避免虚假宣传和夸大描述
- 尊重原创，不抄袭
- 适当使用 emoji，不过度`,
    welcomeMessage: '你好！我是文案创作助手，无论是小红书种草文、朋友圈文案还是产品描述，都能帮你搞定！',
    conversationStarters: ['帮我写一条小红书种草文案', '为新产品写一段卖点描述', '帮我想几个品牌 Slogan', '写一段朋友圈营销文案'],
    tags: ['文案', '创意', '营销'],
    temperature: 0.8,
  },
  {
    key: 'knowledge-qa',
    name: '知识问答',
    description: '专业知识解答，支持概念解释、对比分析等',
    icon: 'GraduationCap',
    prompt: `# 角色
你是一位博学的知识顾问，擅长用通俗易懂的方式解释复杂概念。

## 技能
- 对专业概念进行深入浅出的解释
- 提供对比分析和优劣势比较
- 用案例和类比帮助理解
- 推荐进一步学习的方向

## 回答结构
1. **一句话概括**：简明扼要的答案
2. **详细解释**：展开说明
3. **举例说明**：用实际案例辅助理解
4. **延伸阅读**：相关知识点

## 限制
- 确保信息准确可靠
- 对不确定的内容明确标注
- 避免过于学术化的表达`,
    welcomeMessage: '你好！我是知识问答助手，有任何问题都可以问我，我会用最通俗的方式帮你理解！',
    conversationStarters: ['什么是微服务架构？和单体架构有什么区别？', '用通俗的语言解释一下区块链', 'TCP 和 UDP 的区别是什么？'],
    tags: ['学习', '问答', '知识'],
    temperature: 0.6,
  },
  {
    key: 'code-helper',
    name: '代码助手',
    description: '写代码、Debug、代码解释和优化建议',
    icon: 'Code2',
    prompt: `# 角色
你是一位编程专家，帮助用户编写代码、调试问题和优化代码。

## 技能
- 根据需求编写代码片段
- 分析和解释现有代码
- 定位和修复 Bug
- 提供代码优化建议和最佳实践
- 支持 Python、JavaScript、TypeScript、Java、C#、Go 等主流语言

## 输出格式
- 代码用 markdown 代码块包裹，标注语言
- 关键逻辑添加注释
- Bug 修复时说明问题原因和修改方案

## 限制
- 代码要考虑边界情况和错误处理
- 遵循语言社区的编码规范
- 避免引入安全漏洞`,
    welcomeMessage: '你好！我是代码助手，写代码、Debug、代码解释都可以找我。直接把你的需求或代码贴过来吧！',
    conversationStarters: ['帮我写一个防抖函数', '这段代码有 Bug，帮我看看', '帮我优化这段 SQL 查询'],
    tags: ['编程', '代码', '开发'],
    temperature: 0.4,
  },
];

// ============ AI 润色元提示词 ============

const POLISH_META_PROMPT = `你是一位 AI Prompt 工程专家。用户会给你一段系统提示词（System Prompt），请你对其进行结构化润色优化。

要求：
1. 使用 Markdown 结构化格式（# 角色、## 技能、## 输出格式、## 限制 等）
2. 保持原意不变，但让描述更精确、更专业
3. 如果原文缺少"限制"或"输出格式"部分，请合理补充
4. 语言简练，每条要点控制在一句话
5. 直接输出优化后的提示词，不要加额外解释`;

// ============ 步骤定义 ============

const STEPS = [
  { key: 'template', label: '选择场景', description: '从模板开始或自定义' },
  { key: 'configure', label: '配置信息', description: '命名并调整提示词' },
  { key: 'test', label: '测试调优', description: '试聊并微调配置' },
];

// ============ 子组件：全屏提示词编辑器 ============

function PromptExpandModal({
  value,
  onChange,
  onClose,
  onPolish,
  polishing,
}: {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  onPolish: () => void;
  polishing: boolean;
}) {
  return (
    <div
      className="surface-backdrop fixed inset-0 z-50 flex items-center justify-center p-6"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <Surface
        variant="raised"
        className="w-full max-w-4xl h-[80vh] flex flex-col rounded-2xl overflow-hidden"
      >
        {/* 头部 */}
        <div className="surface-reading-header px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain size={15} className="text-token-accent" />
            <span className="text-[13px] font-semibold text-token-primary">
              系统提示词编辑器
            </span>
            <span className="bg-token-nested text-token-muted text-[10px] px-2 py-0.5 rounded-full">
              {value.length} 字
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onPolish} disabled={polishing || !value.trim()}>
              {polishing ? <MapSpinner size={12} /> : <Sparkles size={12} />}
              AI 润色
            </Button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg transition-colors hover:bg-white/10 text-token-muted"
            >
              <Minimize2 size={16} />
            </button>
          </div>
        </div>

        {/* 编辑器 */}
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`# 角色\n你是一位...\n\n## 技能\n- ...\n\n## 输出格式\n...\n\n## 限制\n- ...`}
          className="bg-token-nested text-token-primary flex-1 p-5 text-[13px] resize-none outline-none font-mono leading-relaxed"
          autoFocus
        />

        {/* 底部 */}
        <div className="bg-token-nested border-t border-token-subtle px-5 py-3 flex items-center justify-between">
          <div className="text-token-muted text-[11px]">
            使用 # 角色、## 技能、## 限制 等 Markdown 格式可以让 AI 更好地理解
          </div>
          <Button variant="primary" size="sm" onClick={onClose}>
            <Check size={13} />
            完成编辑
          </Button>
        </div>
      </Surface>
    </div>
  );
}

// ============ 子组件：测试对话面板 ============

function TestChatPanel({
  systemPrompt,
  conversationStarters,
  iconHue,
  welcomeMessage,
}: {
  systemPrompt: string;
  conversationStarters: string[];
  iconHue: number;
  welcomeMessage: string;
}) {
  const [messages, setMessages] = useState<DirectChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const abortRef = useRef<(() => void) | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingText, scrollToBottom]);

  const handleSend = (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || streaming) return;

    const userMsg: DirectChatMessage = { role: 'user', content: msg };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setStreaming(true);
    setStreamingText('');

    // 构建历史，将 systemPrompt 通过 history 传入上下文
    const history: DirectChatMessage[] = [
      { role: 'user', content: `[系统指令] 请严格按照以下系统提示词扮演角色：\n\n${systemPrompt}` },
      { role: 'assistant', content: '好的，我已理解系统指令，将严格按照角色设定回答。' },
      ...newMessages.slice(0, -1), // 除了最后一条 user
    ];

    const unsubscribe = streamDirectChat({
      message: msg,
      history,
      onText: (content) => {
        setStreamingText((prev) => prev + content);
      },
      onError: (error) => {
        setStreamingText((prev) => prev || `[错误] ${error}`);
        setStreaming(false);
      },
      onDone: () => {
        setStreaming(false);
        setStreamingText((prev) => {
          if (prev) {
            setMessages((msgs) => [...msgs, { role: 'assistant', content: prev }]);
          }
          return '';
        });
      },
    });

    abortRef.current = unsubscribe;
  };

  const handleStop = () => {
    abortRef.current?.();
    setStreaming(false);
    if (streamingText) {
      setMessages((msgs) => [...msgs, { role: 'assistant', content: streamingText }]);
      setStreamingText('');
    }
  };

  const handleReset = () => {
    abortRef.current?.();
    setMessages([]);
    setStreamingText('');
    setStreaming(false);
    setInput('');
  };

  return (
    <div className="flex flex-col h-full">
      {/* 对话区域 */}
      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
        {/* 欢迎消息 */}
        <Surface variant="inset" className="p-3 rounded-xl rounded-tl-sm text-[12px] leading-relaxed text-token-secondary">
          {welcomeMessage || '你好！有什么可以帮你的吗？'}
        </Surface>

        {/* 快速开始按钮（仅在无消息时显示） */}
        {messages.length === 0 && conversationStarters.filter(Boolean).length > 0 && (
          <div className="flex flex-wrap gap-2">
            {conversationStarters.filter(Boolean).slice(0, 4).map((starter, i) => (
              <button
                key={i}
                onClick={() => handleSend(starter)}
                className="px-3 py-1.5 rounded-full text-[11px] transition-all hover:scale-105"
                style={{
                  background: `linear-gradient(135deg, hsla(${iconHue}, 70%, 50%, 0.12) 0%, hsla(${iconHue}, 70%, 30%, 0.08) 100%)`,
                  color: `hsla(${iconHue}, 70%, 75%, 1)`,
                  border: `1px solid hsla(${iconHue}, 60%, 60%, 0.25)`,
                }}
              >
                {starter}
              </button>
            ))}
          </div>
        )}

        {/* 消息列表 */}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={cn(
                'max-w-[85%] p-3 rounded-xl text-[12px] leading-relaxed whitespace-pre-wrap',
                msg.role === 'user'
                  ? 'rounded-tr-sm text-white'
                  : 'surface-inset rounded-tl-sm text-token-secondary'
              )}
              style={msg.role === 'user'
                ? { background: 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary, var(--accent-primary)) 100%)' }
                : undefined}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {/* 流式输出中 */}
        {streaming && (
          <div className="flex justify-start">
            <Surface
              variant="inset"
              className="max-w-[85%] p-3 rounded-xl rounded-tl-sm text-[12px] leading-relaxed whitespace-pre-wrap text-token-secondary"
            >
              {streamingText || (
                <span className="flex items-center gap-2 text-token-muted">
                  <MapSpinner size={12} /> 思考中...
                </span>
              )}
            </Surface>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 输入区域 */}
      <div className="bg-token-nested border-t border-token-subtle p-3">
        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            className="p-2 rounded-lg transition-colors hover:bg-white/10 flex-shrink-0 text-token-muted"
            title="清空对话"
          >
            <RotateCcw size={14} />
          </button>
          <div className="surface-inset flex-1 flex items-center gap-2 px-3 py-2 rounded-xl">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
              placeholder="输入消息测试智能体..."
              disabled={streaming}
              className="flex-1 bg-transparent text-token-primary text-[12px] outline-none"
            />
            {streaming ? (
              <button onClick={handleStop} className="p-1 rounded-lg hover:bg-white/10 text-token-error">
                <Square size={14} />
              </button>
            ) : (
              <button
                onClick={() => handleSend()}
                disabled={!input.trim()}
                className={cn('p-1 rounded-lg hover:bg-white/10 transition-colors', input.trim() ? 'text-token-accent' : 'text-token-muted-faint')}
              >
                <Send size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============ 快速创建向导组件 ============

export function QuickCreateWizard() {
  const { saveItem, backToGrid, setView, setEditingItem } = useToolboxStore();

  const [step, setStep] = useState(0);
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplate | null>(null);
  const [saving, setSaving] = useState(false);

  // AI 润色状态
  const [polishing, setPolishing] = useState(false);
  const [polishedPrompt, setPolishedPrompt] = useState('');
  const [showPolishResult, setShowPolishResult] = useState(false);
  const polishAbortRef = useRef<(() => void) | null>(null);

  // 全屏编辑器
  const [showExpandEditor, setShowExpandEditor] = useState(false);

  // 模型选择
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]);
  const [selectedModelGroupId, setSelectedModelGroupId] = useState<string>('');
  const [showModelDropdown, setShowModelDropdown] = useState(false);

  // Step 3 侧边面板
  const [showPromptEdit, setShowPromptEdit] = useState(false);

  // 可编辑的表单状态
  const [form, setForm] = useState({
    name: '',
    description: '',
    icon: 'Bot',
    prompt: '',
    welcomeMessage: '',
    conversationStarters: [''],
    tags: '',
    temperature: 0.7,
    enabledTools: [] as string[],
    workflowId: '',
  });

  // 工作流列表
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
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

  // ── 工作流选择器（内联组件，两处复用） ──
  function WorkflowPicker() {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      if (!open) return;
      const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
      document.addEventListener('mousedown', h);
      return () => document.removeEventListener('mousedown', h);
    }, [open]);

    if (workflowsLoading) {
      return (
        <div className="flex items-center gap-2 py-2 text-token-muted">
          <MapSpinner size={12} />
          <span className="text-[10px]">加载工作流...</span>
        </div>
      );
    }

    const selected = workflows.find(w => w.id === form.workflowId);

    return (
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className={cn(
            'surface-inset w-full px-2.5 py-2 rounded-lg text-left flex items-center gap-2 outline-none transition-all',
            open && 'ring-2 ring-[var(--accent-primary)]/10 border-[var(--accent-primary)]/30'
          )}
        >
          {selected ? (
            <>
              <div
                className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 overflow-hidden text-[11px]"
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
              <span className="text-token-secondary text-[11px] flex-1 truncate">
                {selected.name}
              </span>
            </>
          ) : (
            <span className="text-token-muted-faint text-[11px] flex-1">
              请选择工作流...
            </span>
          )}
          <ChevronDown
            size={12}
            className={cn('text-token-muted-faint flex-shrink-0 transition-transform', open && 'rotate-180')}
          />
        </button>

        {open && (
          <Surface
            variant="raised"
            className="absolute z-50 left-0 right-0 mt-1 rounded-xl overflow-hidden py-1"
            style={{
              maxHeight: 220,
              overflowY: 'auto',
              animation: 'wfPickerIn 0.15s ease-out',
            }}
          >
            {workflows.length === 0 ? (
              <div className="text-token-muted-faint px-3 py-3 text-center text-[11px]">
                暂无可用工作流
              </div>
            ) : workflows.map((wf) => {
              const isActive = wf.id === form.workflowId;
              return (
                <button
                  key={wf.id}
                  type="button"
                  onClick={() => { setForm({ ...form, workflowId: wf.id }); setOpen(false); }}
                  className={cn(
                    'w-full px-2.5 py-1.5 flex items-center gap-2 text-left transition-colors',
                    isActive ? 'bg-token-nested' : 'hover:bg-token-nested'
                  )}
                >
                  <div
                    className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 overflow-hidden text-[12px]"
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
                    <div className="text-token-secondary text-[11px] font-medium truncate">
                      {wf.name}
                    </div>
                    {wf.description && (
                      <div className="text-token-muted-faint text-[9px] truncate mt-0.5">
                        {wf.description}
                      </div>
                    )}
                  </div>
                  {isActive && (
                    <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'rgb(168, 85, 247)' }} />
                  )}
                </button>
              );
            })}
          </Surface>
        )}
        <style>{`
          @keyframes wfPickerIn {
            from { opacity: 0; transform: translateY(-4px); }
            to { opacity: 1; transform: translateY(0); }
          }
        `}</style>
      </div>
    );
  }

  const currentIconHue = getAccentHue(form.icon);
  const CurrentIcon = getIconComponent(form.icon);

  // 加载模型池
  useEffect(() => {
    getModelGroups()
      .then((groups) => {
        const chatGroups = groups.filter((g) => g.modelType === 'chat');
        setModelGroups(chatGroups);
      })
      .catch(() => { /* silent */ });
  }, []);

  // 解析标签
  const parsedTags = useMemo(() => {
    return form.tags.split(',').map((t) => t.trim()).filter(Boolean);
  }, [form.tags]);

  // ======== AI 润色 ========

  const handlePolish = () => {
    if (!form.prompt.trim() || polishing) return;

    setPolishing(true);
    setPolishedPrompt('');
    setShowPolishResult(true);

    const unsubscribe = streamDirectChat({
      message: `请润色优化以下系统提示词：\n\n${form.prompt}`,
      history: [
        { role: 'user', content: POLISH_META_PROMPT },
        { role: 'assistant', content: '好的，请将需要润色的系统提示词发给我。' },
      ],
      onText: (content) => {
        setPolishedPrompt((prev) => prev + content);
      },
      onError: () => {
        setPolishing(false);
      },
      onDone: () => {
        setPolishing(false);
      },
    });

    polishAbortRef.current = unsubscribe;
  };

  const handleApplyPolish = () => {
    if (polishedPrompt.trim()) {
      setForm({ ...form, prompt: polishedPrompt.trim() });
    }
    setShowPolishResult(false);
    setPolishedPrompt('');
  };

  const handleCancelPolish = () => {
    polishAbortRef.current?.();
    setPolishing(false);
    setShowPolishResult(false);
    setPolishedPrompt('');
  };

  // ======== 步骤操作 ========

  const handleSelectTemplate = (template: AgentTemplate) => {
    setSelectedTemplate(template);
    setForm((prev) => ({
      ...prev,
      name: template.name,
      description: template.description,
      icon: template.icon,
      prompt: template.prompt,
      welcomeMessage: template.welcomeMessage,
      conversationStarters: [...template.conversationStarters],
      tags: template.tags.join(', '),
      temperature: template.temperature,
    }));
    setStep(1);
  };

  const handleBlankCreate = () => {
    setSelectedTemplate(null);
    setForm((prev) => ({
      ...prev,
      name: '',
      description: '',
      icon: 'Bot',
      prompt: '',
      welcomeMessage: '你好！有什么可以帮你的吗？',
      conversationStarters: [''],
      tags: '',
      temperature: 0.7,
    }));
    setStep(1);
  };

  const handleSwitchToFullMode = () => {
    setEditingItem({
      name: form.name,
      description: form.description,
      icon: form.icon,
      prompt: form.prompt,
      tags: parsedTags,
      type: 'custom',
      category: 'custom',
    });
    setView('create');
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.prompt.trim()) return;
    setSaving(true);
    const success = await saveItem({
      name: form.name.trim(),
      description: form.description.trim(),
      icon: form.icon,
      prompt: form.prompt.trim(),
      tags: parsedTags,
      enabledTools: form.enabledTools,
      workflowId: isWorkflowEnabled ? form.workflowId : undefined,
      type: 'custom',
      category: 'custom',
    });
    setSaving(false);
    if (!success) alert('保存失败，请重试');
  };

  const canProceedToPreview = form.name.trim().length > 0 && form.prompt.trim().length > 0;

  // ======== 渲染步骤 1: 选择场景 ========

  const renderStepTemplate = () => (
    <div className="flex-1 min-h-0 overflow-auto px-6 pb-6">
      {/* 顶部引导 — 淡入 */}
      <div
        className="text-center mb-8"
        style={{ animation: 'wizardFadeIn 0.5s ease-out both' }}
      >
        <div className="surface-inset text-token-accent inline-flex items-center gap-2.5 px-5 py-2.5 rounded-full text-[12px] mb-3">
          <Sparkles size={13} style={{ animation: 'wizardPulse 2s ease-in-out infinite' }} />
          选择一个场景模板，3 步快速创建智能体
        </div>
        <div className="text-token-muted-faint text-[11px]">
          模板会预填名称、提示词等信息，你可以在下一步自由修改
        </div>
      </div>

      {/* 模板网格 — 交错入场 */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-5">
        {AGENT_TEMPLATES.map((template, idx) => {
          const TemplateIcon = getIconComponent(template.icon);
          const hue = getAccentHue(template.icon);
          return (
            <button
              key={template.key}
              onClick={() => handleSelectTemplate(template)}
              className="relative p-5 rounded-2xl text-left group overflow-hidden"
              style={{
                background: `linear-gradient(160deg, hsla(${hue}, 50%, 50%, 0.06) 0%, rgba(255,255,255,0.015) 60%)`,
                border: `1px solid hsla(${hue}, 40%, 55%, 0.1)`,
                animation: `wizardSlideUp 0.45s cubic-bezier(0.16, 1, 0.3, 1) ${idx * 0.06}s both`,
                transition: 'border-color 0.3s, box-shadow 0.3s, transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget;
                el.style.borderColor = `hsla(${hue}, 55%, 60%, 0.3)`;
                el.style.boxShadow = `0 8px 32px -8px hsla(${hue}, 70%, 40%, 0.2), inset 0 1px 0 hsla(${hue}, 60%, 80%, 0.06)`;
                el.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget;
                el.style.borderColor = `hsla(${hue}, 40%, 55%, 0.1)`;
                el.style.boxShadow = 'none';
                el.style.transform = 'translateY(0)';
              }}
            >
              {/* 悬浮光晕 */}
              <div
                className="absolute inset-0 opacity-0 group-hover:opacity-100 pointer-events-none"
                style={{
                  background: `radial-gradient(ellipse 120% 80% at 50% 0%, hsla(${hue}, 70%, 60%, 0.08) 0%, transparent 70%)`,
                  transition: 'opacity 0.4s ease',
                }}
              />

              {/* 内容 */}
              <div className="relative">
                {/* 图标 + 标题行 */}
                <div className="flex items-start gap-3.5 mb-3">
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{
                      background: `linear-gradient(135deg, hsla(${hue}, 65%, 55%, 0.18) 0%, hsla(${hue}, 65%, 40%, 0.08) 100%)`,
                      border: `1px solid hsla(${hue}, 55%, 60%, 0.2)`,
                      boxShadow: `0 2px 8px -2px hsla(${hue}, 70%, 45%, 0.15)`,
                      transition: 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s',
                    }}
                  >
                    <TemplateIcon
                      size={20}
                      style={{
                        color: `hsla(${hue}, 65%, 72%, 1)`,
                        transition: 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
                      }}
                      className="group-hover:scale-110"
                    />
                  </div>
                  <div className="flex-1 min-w-0 pt-0.5">
                    <div className="text-token-primary text-[13px] font-semibold mb-0.5 truncate">
                      {template.name}
                    </div>
                    <div className="text-token-muted-faint text-[11px] leading-relaxed line-clamp-2">
                      {template.description}
                    </div>
                  </div>
                </div>

                {/* 标签 + 箭头 */}
                <div className="flex items-center justify-between mt-1">
                  <div className="flex flex-wrap gap-1.5">
                    {template.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] px-2 py-0.5 rounded-md"
                        style={{
                          background: `hsla(${hue}, 60%, 50%, 0.08)`,
                          color: `hsla(${hue}, 60%, 72%, 0.85)`,
                          border: `1px solid hsla(${hue}, 50%, 60%, 0.1)`,
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div
                    className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 opacity-0 group-hover:opacity-100"
                    style={{
                      background: `hsla(${hue}, 60%, 55%, 0.12)`,
                      transition: 'opacity 0.25s, transform 0.25s',
                      transform: 'translateX(-4px)',
                    }}
                  >
                    <ChevronRight
                      size={13}
                      style={{ color: `hsla(${hue}, 60%, 72%, 0.9)` }}
                      className="group-hover:translate-x-0.5 transition-transform"
                    />
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* 空白创建 — 最后入场 */}
      <button
        onClick={handleBlankCreate}
        className="surface surface-interactive w-full p-4 rounded-2xl flex items-center gap-4 group relative overflow-hidden"
        style={{
          animation: `wizardSlideUp 0.45s cubic-bezier(0.16, 1, 0.3, 1) ${AGENT_TEMPLATES.length * 0.06}s both`,
        }}
      >
        <div className="surface-inset w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0">
          <Plus
            size={18}
            className="text-token-muted-faint transition-transform duration-300 group-hover:scale-110 group-hover:rotate-90"
          />
        </div>
        <div className="text-left flex-1">
          <div className="text-token-secondary text-[13px] font-medium">空白创建</div>
          <div className="text-token-muted-faint text-[11px]">从零开始，完全自定义你的智能体</div>
        </div>
        <div className="bg-token-nested w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <ChevronRight size={13} className="text-token-muted" />
        </div>
      </button>

      {/* 动画关键帧 */}
      <style>{`
        @keyframes wizardSlideUp {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes wizardFadeIn {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes wizardPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
    </div>
  );

  // ======== 渲染步骤 2: 配置信息（含 AI 润色 + 放大编辑） ========

  const renderStepConfigure = () => (
    <div className="flex-1 min-h-0 overflow-hidden px-6 pb-4">
      <div className="flex gap-5 h-full">
        {/* 左侧：核心配置 */}
        <div className="flex-1 min-w-0 overflow-auto space-y-4">
          {/* 名称 + 描述 */}
          <Surface variant="inset" className="p-5 rounded-xl">
            <div className="flex gap-4 items-start">
              <div className="w-14 h-14 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `linear-gradient(135deg, hsla(${currentIconHue}, 70%, 60%, 0.15) 0%, hsla(${currentIconHue}, 70%, 40%, 0.08) 100%)`, border: `1px solid hsla(${currentIconHue}, 60%, 60%, 0.3)`, boxShadow: `0 4px 12px -2px hsla(${currentIconHue}, 70%, 50%, 0.2)` }}>
                <CurrentIcon size={24} style={{ color: `hsla(${currentIconHue}, 70%, 70%, 1)` }} />
              </div>
              <div className="flex-1 space-y-3">
                <div>
                  <label className="text-token-secondary block text-[11px] font-medium mb-1.5">
                    智能体名称 <span className="text-token-error">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value.slice(0, 20) })}
                    placeholder="给你的智能体起个名字"
                    className="prd-field w-full px-3 py-2.5 rounded-xl text-[13px]"
                  />
                  <div className="text-token-muted-faint text-right text-[10px] mt-1">{form.name.length}/20</div>
                </div>
                <div>
                  <label className="text-token-secondary block text-[11px] font-medium mb-1.5">简短描述</label>
                  <input
                    type="text"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="简单描述这个智能体能做什么"
                    className="prd-field w-full px-3 py-2.5 rounded-xl text-[13px]"
                  />
                </div>
              </div>
            </div>
          </Surface>

          {/* 系统提示词 — 撑满剩余空间 */}
          <Surface variant="inset" className="p-5 rounded-xl flex flex-col min-h-[320px]">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="surface-inset w-6 h-6 rounded-lg flex items-center justify-center">
                  <Brain size={12} className="text-token-accent" />
                </div>
                <label className="text-token-primary text-[12px] font-semibold">
                  系统提示词 <span className="text-token-error">*</span>
                </label>
                {selectedTemplate && (
                  <span className="bg-token-nested border border-token-subtle text-token-success text-[10px] px-2 py-0.5 rounded-full">
                    已从模板填充
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" className="h-7 text-[11px] gap-1" onClick={handlePolish} disabled={polishing || !form.prompt.trim()}>
                  {polishing ? <MapSpinner size={11} /> : <Sparkles size={11} />}
                  AI 润色
                </Button>
                <button
                  onClick={() => setShowExpandEditor(true)}
                  className="p-1.5 rounded-lg transition-colors hover:bg-white/10 text-token-muted-faint"
                  title="全屏编辑"
                >
                  <Maximize2 size={14} />
                </button>
              </div>
            </div>
            <textarea
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              placeholder={`# 角色\n你是一位...\n\n## 技能\n- ...\n\n## 限制\n- ...`}
              className="prd-field flex-1 w-full p-3 rounded-xl text-[12px] resize-none font-mono"
              style={{ minHeight: '240px' }}
            />
          </Surface>
        </div>

        {/* 右侧：辅助配置 */}
        <div className="w-72 flex-shrink-0 overflow-auto space-y-3">
          {/* 图标选择 */}
          <Surface variant="inset" className="p-3 rounded-xl">
            <div className="flex items-center gap-2 mb-2.5">
              <CurrentIcon size={13} style={{ color: `hsla(${currentIconHue}, 70%, 70%, 1)` }} />
              <span className="text-token-primary text-[12px] font-semibold">图标</span>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {Object.entries(ICON_MAP).map(([name, Icon]) => {
                const hue = ICON_HUE_MAP[name] ?? 210;
                const isSelected = form.icon === name;
                return (
                  <button
                    key={name}
                    onClick={() => setForm({ ...form, icon: name })}
                    className="w-full aspect-square rounded-lg flex items-center justify-center transition-all hover:scale-110"
                    style={{
                      background: isSelected
                        ? `linear-gradient(135deg, hsla(${hue}, 70%, 60%, 0.25) 0%, hsla(${hue}, 70%, 40%, 0.12) 100%)`
                        : 'rgba(255, 255, 255, 0.03)',
                      border: isSelected
                        ? `1.5px solid hsla(${hue}, 60%, 60%, 0.5)`
                        : '1px solid rgba(255, 255, 255, 0.06)',
                      boxShadow: isSelected ? `0 2px 8px -2px hsla(${hue}, 70%, 50%, 0.3)` : 'none',
                    }}
                  >
                    <Icon size={16} style={{ color: isSelected ? `hsla(${hue}, 70%, 70%, 1)` : 'rgba(255, 255, 255, 0.4)' }} />
                  </button>
                );
              })}
            </div>
          </Surface>

          {/* 标签 */}
          <Surface variant="inset" className="p-3 rounded-xl">
            <label className="text-token-muted block text-[11px] font-medium mb-1.5">标签（可选，逗号分隔）</label>
            <input
              type="text"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
              placeholder="例如：写作, 文案, 创意"
              className="prd-field w-full px-3 py-2 rounded-lg text-[12px]"
            />
            {parsedTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {parsedTags.map((tag) => (
                  <span key={tag} className="text-[10px] px-2 py-0.5 rounded-md font-medium" style={{ background: `hsla(${currentIconHue}, 70%, 50%, 0.15)`, color: `hsla(${currentIconHue}, 70%, 70%, 1)`, border: `1px solid hsla(${currentIconHue}, 60%, 60%, 0.25)` }}>
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </Surface>

          {/* 发送到工作流 */}
          <Surface variant="inset" className="p-3 rounded-xl">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <WorkflowIcon size={13} className="text-token-accent" />
                <span className="text-token-primary text-[12px] font-semibold">发送到工作流</span>
              </div>
              <button
                onClick={() => {
                  const next = isWorkflowEnabled
                    ? form.enabledTools.filter((t) => t !== 'workflowTrigger')
                    : [...form.enabledTools, 'workflowTrigger'];
                  setForm({ ...form, enabledTools: next });
                }}
                className="w-8 h-4.5 rounded-full relative transition-all duration-200 cursor-pointer"
                style={{
                  background: isWorkflowEnabled
                    ? 'linear-gradient(90deg, rgb(168, 85, 247), rgb(139, 92, 246))'
                    : 'rgba(255, 255, 255, 0.1)',
                }}
              >
                <div
                  className="absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all duration-200"
                  style={{
                    background: 'white',
                    left: isWorkflowEnabled ? '17px' : '2px',
                  }}
                />
              </button>
            </div>
            {isWorkflowEnabled && (
              <div className="space-y-2">
                <div
                  className="bg-token-nested border border-token-subtle text-token-muted text-[10px] px-2.5 py-1.5 rounded-lg flex items-start gap-1.5"
                >
                  <Info size={10} className="text-token-accent flex-shrink-0 mt-0.5" />
                  <span>对话时可将消息发送到工作流执行</span>
                </div>
                <WorkflowPicker />
              </div>
            )}
          </Surface>

          {/* 创造性 */}
          <Surface variant="inset" className="p-3 rounded-xl">
            <div className="flex items-center justify-between mb-2">
              <span className="text-token-secondary text-[12px] font-medium">创造性</span>
              <span className="bg-token-nested text-token-primary text-[11px] font-semibold px-1.5 py-0.5 rounded">
                {form.temperature.toFixed(1)}
              </span>
            </div>
            <input
              type="range" min="0" max="1" step="0.1"
              value={form.temperature}
              onChange={(e) => setForm({ ...form, temperature: parseFloat(e.target.value) })}
              className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
              style={{ background: `linear-gradient(90deg, rgb(59, 130, 246) ${form.temperature * 100}%, rgba(255,255,255,0.1) ${form.temperature * 100}%)` }}
            />
            <div className="text-token-muted-faint flex justify-between text-[10px] mt-1">
              <span>精确</span>
              <span>创造</span>
            </div>
          </Surface>

          {/* 配置摘要 */}
          <Surface variant="inset" className="p-3 rounded-xl text-[11px] space-y-1.5">
            <div className={cn('flex items-center gap-2', form.name.trim() ? 'text-token-muted' : 'text-token-muted-faint')}>
              <Check size={11} className={form.name.trim() ? 'text-token-success' : 'text-token-muted-faint'} />
              <span>{form.name || '未命名'}</span>
            </div>
            <div className={cn('flex items-center gap-2', form.prompt.trim() ? 'text-token-muted' : 'text-token-muted-faint')}>
              <Check size={11} className={form.prompt.trim() ? 'text-token-success' : 'text-token-muted-faint'} />
              <span>提示词 {form.prompt.length} 字</span>
            </div>
            {parsedTags.length > 0 && (
              <div className="text-token-muted flex items-center gap-2">
                <Check size={11} className="text-token-success" />
                <span>{parsedTags.join('、')}</span>
              </div>
            )}
            {isWorkflowEnabled && (
              <div className="text-token-muted flex items-center gap-2">
                <Check size={11} className="text-token-success" />
                <span>已绑定工作流</span>
              </div>
            )}
          </Surface>
        </div>
      </div>

      {/* AI 润色结果弹窗 */}
      {showPolishResult && (
        <div
          className="surface-backdrop fixed inset-0 z-50 flex items-center justify-center p-6"
          onClick={(e) => e.target === e.currentTarget && !polishing && handleCancelPolish()}
        >
          <Surface
            variant="raised"
            className="w-full max-w-2xl max-h-[70vh] flex flex-col rounded-2xl overflow-hidden"
          >
            <div className="surface-reading-header px-5 py-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles size={14} className="text-token-accent" />
                <span className="text-[13px] font-semibold text-token-primary">AI 润色结果</span>
                {polishing && <MapSpinner size={13} color="rgb(192, 132, 252)" />}
              </div>
              <button onClick={handleCancelPolish} className="p-1.5 rounded-lg hover:bg-white/10 text-token-muted">
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-5">
              <pre className="text-token-secondary text-[12px] font-mono leading-relaxed whitespace-pre-wrap">
                {polishedPrompt || '正在生成...'}
              </pre>
            </div>
            <div className="bg-token-nested border-t border-token-subtle px-5 py-3 flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={handleCancelPolish}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleApplyPolish} disabled={polishing || !polishedPrompt.trim()}>
                <Check size={13} />
                应用润色结果
              </Button>
            </div>
          </Surface>
        </div>
      )}
    </div>
  );

  // ======== 渲染步骤 3: 测试调优（双栏：左测试 / 右设置） ========

  const renderStepTest = () => (
    <div className="flex-1 min-h-0 flex gap-4 overflow-hidden px-6 pb-4">
      {/* 左侧：测试对话 */}
      <Surface variant="inset" className="flex-1 min-w-0 flex flex-col rounded-xl overflow-hidden">
        <div className="surface-reading-header px-4 py-2.5 flex items-center gap-2">
          <Play size={12} style={{ color: `hsla(${currentIconHue}, 70%, 70%, 1)` }} />
          <span className="text-[12px] font-semibold text-token-primary">测试对话</span>
          <span className="surface-state-success text-[10px] px-1.5 py-0.5 rounded">实时</span>
        </div>
        <TestChatPanel
          systemPrompt={form.prompt}
          conversationStarters={form.conversationStarters}
          iconHue={currentIconHue}
          welcomeMessage={form.welcomeMessage}
        />
      </Surface>

      {/* 右侧：调优设置 */}
      <div className="w-72 flex-shrink-0 overflow-auto space-y-3">
        {/* 快捷编辑提示词 */}
        <Surface variant="inset" className="rounded-xl overflow-hidden">
          <button
            onClick={() => setShowPromptEdit(!showPromptEdit)}
            className="w-full px-3 py-2.5 flex items-center justify-between transition-colors hover:bg-white/[0.02]"
          >
            <div className="flex items-center gap-2">
              <PenLine size={13} className="text-token-accent" />
              <span className="text-token-primary text-[12px] font-semibold">编辑提示词</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-token-muted text-[10px]">{form.prompt.length}字</span>
              <ChevronDown size={13} className={cn('text-token-muted transition-transform', showPromptEdit && 'rotate-180')} />
            </div>
          </button>
          {showPromptEdit && (
            <div className="px-3 pb-3">
              <div className="flex items-center justify-end gap-1 mb-2">
                <Button variant="ghost" size="sm" className="h-6 text-[10px] gap-1 px-2" onClick={handlePolish} disabled={polishing || !form.prompt.trim()}>
                  {polishing ? <MapSpinner size={10} /> : <Sparkles size={10} />}
                  润色
                </Button>
                <button onClick={() => setShowExpandEditor(true)} className="p-1 rounded hover:bg-white/10 text-token-muted" title="全屏编辑">
                  <Maximize2 size={12} />
                </button>
              </div>
              <textarea
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                className="prd-field w-full h-32 p-2 rounded-lg text-[11px] resize-none outline-none font-mono"
              />
            </div>
          )}
        </Surface>

        {/* 模型选择 */}
        <Surface variant="inset" className="p-3 rounded-xl">
          <div className="flex items-center gap-2 mb-2">
            <Cpu size={13} className="text-token-accent" />
            <span className="text-token-primary text-[12px] font-semibold">模型选择</span>
          </div>
          <div className="relative">
            <button
              onClick={() => setShowModelDropdown(!showModelDropdown)}
              className="surface-inset text-token-secondary w-full px-3 py-2 rounded-lg text-[11px] text-left flex items-center justify-between transition-all hover:border-[var(--accent-primary)]/30"
            >
              <span>{selectedModelGroupId ? modelGroups.find((g) => g.id === selectedModelGroupId)?.name || '已选模型' : '自动调度（默认）'}</span>
              <ChevronDown size={12} className="text-token-muted" />
            </button>
            {showModelDropdown && (
              <Surface variant="raised" className="absolute top-full left-0 right-0 mt-1 rounded-lg z-10 max-h-48 overflow-auto">
                <button
                  onClick={() => { setSelectedModelGroupId(''); setShowModelDropdown(false); }}
                  className={cn('w-full px-3 py-2 text-[11px] text-left hover:bg-token-nested transition-colors flex items-center gap-2', !selectedModelGroupId ? 'text-token-accent' : 'text-token-secondary')}
                >
                  <Cpu size={11} /> 自动调度（默认）
                </button>
                {modelGroups.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => { setSelectedModelGroupId(g.id); setShowModelDropdown(false); }}
                    className={cn('w-full px-3 py-2 text-[11px] text-left hover:bg-token-nested transition-colors', selectedModelGroupId === g.id ? 'text-token-accent' : 'text-token-secondary')}
                  >
                    <div className="font-medium">{g.name}</div>
                    {g.description && <div className="text-token-muted text-[10px] mt-0.5">{g.description}</div>}
                  </button>
                ))}
                {modelGroups.length === 0 && (
                  <div className="text-token-muted px-3 py-2 text-[11px]">暂无可用模型池</div>
                )}
              </Surface>
            )}
          </div>
          <div className="text-token-muted text-[10px] mt-1.5">
            默认由后端根据 ai-toolbox 应用标识自动调度
          </div>
        </Surface>

        {/* 发送到工作流 */}
        <Surface variant="inset" className="p-3 rounded-xl">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <WorkflowIcon size={13} className="text-token-accent" />
              <span className="text-token-primary text-[12px] font-semibold">发送到工作流</span>
            </div>
            <button
              onClick={() => {
                const next = isWorkflowEnabled
                  ? form.enabledTools.filter((t) => t !== 'workflowTrigger')
                  : [...form.enabledTools, 'workflowTrigger'];
                setForm({ ...form, enabledTools: next });
              }}
              className="w-8 h-4.5 rounded-full relative transition-all duration-200 cursor-pointer"
              style={{
                background: isWorkflowEnabled
                  ? 'linear-gradient(90deg, rgb(168, 85, 247), rgb(139, 92, 246))'
                  : 'rgba(255, 255, 255, 0.1)',
              }}
            >
              <div
                className="absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all duration-200"
                style={{
                  background: 'white',
                  left: isWorkflowEnabled ? '17px' : '2px',
                }}
              />
            </button>
          </div>
          {isWorkflowEnabled && (
            <div className="space-y-2">
              <div
                className="bg-token-nested border border-token-subtle text-token-muted text-[10px] px-2.5 py-1.5 rounded-lg flex items-start gap-1.5"
              >
                <Info size={10} className="text-token-accent flex-shrink-0 mt-0.5" />
                <span>对话时可将消息发送到工作流执行</span>
              </div>
              <WorkflowPicker />
            </div>
          )}
        </Surface>

        {/* 知识库上传 */}
        <Surface variant="inset" className="p-3 rounded-xl">
          <div className="flex items-center gap-2 mb-2">
            <BookOpen size={13} className="text-token-success" />
            <span className="text-token-primary text-[12px] font-semibold">知识库</span>
            <span className="surface-state-warning text-[9px] px-1.5 py-0.5 rounded">即将上线</span>
          </div>
          <div className="surface-inset p-3 rounded-lg text-center cursor-not-allowed opacity-60 border-dashed">
            <Upload size={16} className="text-token-success mx-auto mb-1.5" />
            <div className="text-token-muted text-[10px]">上传文档作为知识库</div>
            <div className="text-token-muted-faint text-[9px] mt-0.5">支持 PDF、Word、TXT</div>
          </div>
        </Surface>

        {/* 温度调节 */}
        <Surface variant="inset" className="p-3 rounded-xl">
          <div className="flex items-center justify-between mb-2">
            <span className="text-token-secondary text-[12px] font-medium">创造性</span>
            <span className="bg-token-nested text-token-primary text-[11px] font-semibold px-1.5 py-0.5 rounded">
              {form.temperature.toFixed(1)}
            </span>
          </div>
          <input
            type="range" min="0" max="1" step="0.1"
            value={form.temperature}
            onChange={(e) => setForm({ ...form, temperature: parseFloat(e.target.value) })}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
            style={{ background: `linear-gradient(90deg, rgb(59, 130, 246) ${form.temperature * 100}%, rgba(255,255,255,0.1) ${form.temperature * 100}%)` }}
          />
          <div className="text-token-muted flex justify-between text-[10px] mt-1">
            <span>精确</span>
            <span>创造</span>
          </div>
        </Surface>

        {/* 配置摘要 */}
        <Surface variant="inset" className="text-token-muted p-3 rounded-xl text-[11px] space-y-1.5">
          <div className="flex items-center gap-2">
            <Check size={11} className="text-token-success" />
            <span>{form.name || '未命名'}</span>
          </div>
          <div className="flex items-center gap-2">
            <Check size={11} className="text-token-success" />
            <span>提示词 {form.prompt.length} 字</span>
          </div>
          {parsedTags.length > 0 && (
            <div className="flex items-center gap-2">
              <Check size={11} className="text-token-success" />
              <span>{parsedTags.join('、')}</span>
            </div>
          )}
        </Surface>
      </div>
    </div>
  );

  // ======== 主渲染 ========

  return (
    <Surface className="h-full min-h-0 flex flex-col rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-4 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={step === 0 ? backToGrid : () => setStep(step - 1)}>
            <ArrowLeft size={13} />
            {step === 0 ? '返回' : '上一步'}
          </Button>
          <div className="flex items-center gap-1.5">
            <Sparkles size={15} className="text-token-accent" />
            <span className="text-[14px] font-semibold text-token-primary">快速创建智能体</span>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={handleSwitchToFullMode} className="text-[11px] gap-1.5">
          <Settings2 size={12} />
          完整模式
        </Button>
      </div>

      {/* 步骤指示器 */}
      <div className="px-6 pb-4">
        <div className="flex items-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex items-center gap-2 flex-1">
              <div className="flex items-center gap-2 flex-1">
                <div
                  className={cn(
                    'w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 transition-all',
                    i <= step
                      ? 'surface-action-primary border-0'
                      : 'surface-inset text-token-muted-faint'
                  )}
                >
                  {i < step ? <Check size={13} /> : i + 1}
                </div>
                <div>
                  <div className={cn('text-[11px] font-semibold leading-tight', i <= step ? 'text-token-primary' : 'text-token-muted')}>
                    {s.label}
                  </div>
                  <div className="text-token-muted-faint text-[10px] leading-tight">{s.description}</div>
                </div>
              </div>
              {i < STEPS.length - 1 && (
                <div className={cn('flex-1 h-[1px] mx-2', i < step ? 'bg-[var(--accent-primary)]' : 'bg-token-nested')} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 步骤内容 */}
      {step === 0 && renderStepTemplate()}
      {step === 1 && renderStepConfigure()}
      {step === 2 && renderStepTest()}

      {/* 底部操作按钮 */}
      {step > 0 && (
        <div className="bg-token-nested border-t border-token-subtle px-6 py-3 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => setStep(step - 1)}>
            <ArrowLeft size={13} /> 上一步
          </Button>
          <div className="flex items-center gap-2">
            {step === 1 && (
              <Button variant="primary" size="sm" onClick={() => setStep(2)} disabled={!canProceedToPreview}>
                下一步：测试 <ArrowRight size={13} />
              </Button>
            )}
            {step === 2 && (
              <Button variant="primary" size="sm" onClick={handleSave} disabled={saving || !form.name.trim() || !form.prompt.trim()}>
                {saving ? <MapSpinner size={13} /> : <Save size={13} />}
                创建智能体
              </Button>
            )}
          </div>
        </div>
      )}

      {/* 全屏提示词编辑器 */}
      {showExpandEditor && (
        <PromptExpandModal
          value={form.prompt}
          onChange={(v) => setForm({ ...form, prompt: v })}
          onClose={() => setShowExpandEditor(false)}
          onPolish={handlePolish}
          polishing={polishing}
        />
      )}
    </Surface>
  );
}
