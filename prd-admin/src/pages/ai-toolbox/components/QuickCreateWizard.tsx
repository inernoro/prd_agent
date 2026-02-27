import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/design/Button';
import { useToolboxStore } from '@/stores/toolboxStore';
import { streamDirectChat, getModelGroups } from '@/services';
import type { DirectChatMessage } from '@/services';
import type { ModelGroup } from '@/types/modelGroup';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeft,
  ArrowRight,
  Save,
  Loader2,
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
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0, 0, 0, 0.7)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-full max-w-4xl h-[80vh] flex flex-col rounded-2xl overflow-hidden"
        style={{
          background: 'var(--bg-elevated, #1a1f2e)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          boxShadow: '0 24px 48px -12px rgba(0, 0, 0, 0.5)',
        }}
      >
        {/* 头部 */}
        <div
          className="px-5 py-3 flex items-center justify-between"
          style={{
            background: 'linear-gradient(90deg, rgba(168, 85, 247, 0.08) 0%, transparent 50%)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
          }}
        >
          <div className="flex items-center gap-2">
            <Brain size={15} style={{ color: 'rgb(192, 132, 252)' }} />
            <span className="text-[13px] font-semibold" style={{ color: 'rgba(255, 255, 255, 0.95)' }}>
              系统提示词编辑器
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.5)' }}>
              {value.length} 字
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onPolish} disabled={polishing || !value.trim()}>
              {polishing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              AI 润色
            </Button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg transition-colors hover:bg-white/10"
              style={{ color: 'rgba(255, 255, 255, 0.5)' }}
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
          className="flex-1 p-5 text-[13px] resize-none outline-none font-mono leading-relaxed"
          style={{
            background: 'rgba(0, 0, 0, 0.15)',
            color: 'rgba(255, 255, 255, 0.9)',
          }}
          autoFocus
        />

        {/* 底部 */}
        <div
          className="px-5 py-3 flex items-center justify-between"
          style={{ borderTop: '1px solid rgba(255, 255, 255, 0.06)', background: 'rgba(0, 0, 0, 0.1)' }}
        >
          <div className="text-[11px]" style={{ color: 'rgba(255, 255, 255, 0.4)' }}>
            使用 # 角色、## 技能、## 限制 等 Markdown 格式可以让 AI 更好地理解
          </div>
          <Button variant="primary" size="sm" onClick={onClose}>
            <Check size={13} />
            完成编辑
          </Button>
        </div>
      </div>
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
        <div
          className="p-3 rounded-xl rounded-tl-sm text-[12px] leading-relaxed"
          style={{
            background: 'rgba(255, 255, 255, 0.04)',
            border: '1px solid rgba(255, 255, 255, 0.06)',
            color: 'rgba(255, 255, 255, 0.85)',
          }}
        >
          {welcomeMessage || '你好！有什么可以帮你的吗？'}
        </div>

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
              className={`max-w-[85%] p-3 rounded-xl text-[12px] leading-relaxed whitespace-pre-wrap ${
                msg.role === 'user' ? 'rounded-tr-sm' : 'rounded-tl-sm'
              }`}
              style={{
                background: msg.role === 'user'
                  ? 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary, var(--accent-primary)) 100%)'
                  : 'rgba(255, 255, 255, 0.04)',
                color: msg.role === 'user' ? 'white' : 'rgba(255, 255, 255, 0.85)',
                border: msg.role === 'user' ? 'none' : '1px solid rgba(255, 255, 255, 0.06)',
              }}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {/* 流式输出中 */}
        {streaming && (
          <div className="flex justify-start">
            <div
              className="max-w-[85%] p-3 rounded-xl rounded-tl-sm text-[12px] leading-relaxed whitespace-pre-wrap"
              style={{
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                color: 'rgba(255, 255, 255, 0.85)',
              }}
            >
              {streamingText || (
                <span className="flex items-center gap-2" style={{ color: 'rgba(255,255,255,0.4)' }}>
                  <Loader2 size={12} className="animate-spin" /> 思考中...
                </span>
              )}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 输入区域 */}
      <div
        className="p-3"
        style={{ borderTop: '1px solid rgba(255, 255, 255, 0.04)', background: 'rgba(0, 0, 0, 0.1)' }}
      >
        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            className="p-2 rounded-lg transition-colors hover:bg-white/10 flex-shrink-0"
            style={{ color: 'rgba(255, 255, 255, 0.4)' }}
            title="清空对话"
          >
            <RotateCcw size={14} />
          </button>
          <div
            className="flex-1 flex items-center gap-2 px-3 py-2 rounded-xl"
            style={{ background: 'rgba(255, 255, 255, 0.04)', border: '1px solid rgba(255, 255, 255, 0.08)' }}
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
              placeholder="输入消息测试智能体..."
              disabled={streaming}
              className="flex-1 bg-transparent text-[12px] outline-none"
              style={{ color: 'rgba(255, 255, 255, 0.9)' }}
            />
            {streaming ? (
              <button onClick={handleStop} className="p-1 rounded-lg hover:bg-white/10" style={{ color: 'rgb(239, 68, 68)' }}>
                <Square size={14} />
              </button>
            ) : (
              <button
                onClick={() => handleSend()}
                disabled={!input.trim()}
                className="p-1 rounded-lg hover:bg-white/10 transition-colors"
                style={{ color: input.trim() ? 'var(--accent-primary)' : 'rgba(255, 255, 255, 0.2)' }}
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
  });

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
    setForm({
      name: template.name,
      description: template.description,
      icon: template.icon,
      prompt: template.prompt,
      welcomeMessage: template.welcomeMessage,
      conversationStarters: [...template.conversationStarters],
      tags: template.tags.join(', '),
      temperature: template.temperature,
    });
    setStep(1);
  };

  const handleBlankCreate = () => {
    setSelectedTemplate(null);
    setForm({
      name: '',
      description: '',
      icon: 'Bot',
      prompt: '',
      welcomeMessage: '你好！有什么可以帮你的吗？',
      conversationStarters: [''],
      tags: '',
      temperature: 0.7,
    });
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
      <div className="text-center mb-6">
        <div
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[12px] mb-3"
          style={{
            background: 'linear-gradient(90deg, rgba(168, 85, 247, 0.1) 0%, rgba(99, 102, 241, 0.1) 100%)',
            border: '1px solid rgba(168, 85, 247, 0.2)',
            color: 'rgba(192, 132, 252, 0.95)',
          }}
        >
          <Sparkles size={13} />
          选择一个场景模板，3 步快速创建智能体
        </div>
        <div className="text-[11px]" style={{ color: 'rgba(255, 255, 255, 0.45)' }}>
          模板会预填名称、提示词等信息，你可以在下一步自由修改
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
        {AGENT_TEMPLATES.map((template) => {
          const TemplateIcon = getIconComponent(template.icon);
          const hue = getAccentHue(template.icon);
          return (
            <button
              key={template.key}
              onClick={() => handleSelectTemplate(template)}
              className="p-4 rounded-xl text-left transition-all group hover:scale-[1.02] hover:shadow-lg"
              style={{
                background: `linear-gradient(135deg, hsla(${hue}, 70%, 50%, 0.08) 0%, hsla(${hue}, 70%, 30%, 0.03) 100%)`,
                border: `1px solid hsla(${hue}, 60%, 55%, 0.15)`,
              }}
            >
              <div className="flex items-center gap-3 mb-2">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-transform group-hover:scale-110"
                  style={{
                    background: `linear-gradient(135deg, hsla(${hue}, 70%, 60%, 0.2) 0%, hsla(${hue}, 70%, 40%, 0.1) 100%)`,
                    border: `1px solid hsla(${hue}, 60%, 60%, 0.25)`,
                    boxShadow: `0 2px 8px -2px hsla(${hue}, 70%, 50%, 0.2)`,
                  }}
                >
                  <TemplateIcon size={20} style={{ color: `hsla(${hue}, 70%, 70%, 1)` }} />
                </div>
                <div>
                  <div className="text-[13px] font-semibold" style={{ color: 'rgba(255, 255, 255, 0.95)' }}>
                    {template.name}
                  </div>
                  <div className="text-[11px]" style={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                    {template.description}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {template.tags.map((tag) => (
                  <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: `hsla(${hue}, 70%, 50%, 0.1)`, color: `hsla(${hue}, 70%, 70%, 0.8)` }}>
                    {tag}
                  </span>
                ))}
              </div>
              <div className="flex justify-end mt-2">
                <ChevronRight size={16} className="transition-transform group-hover:translate-x-1" style={{ color: `hsla(${hue}, 60%, 60%, 0.5)` }} />
              </div>
            </button>
          );
        })}
      </div>

      <button
        onClick={handleBlankCreate}
        className="w-full p-4 rounded-xl transition-all group hover:bg-white/[0.03] flex items-center gap-3"
        style={{ border: '1px dashed rgba(255, 255, 255, 0.12)' }}
      >
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255, 255, 255, 0.04)', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
          <Plus size={20} style={{ color: 'rgba(255, 255, 255, 0.5)' }} />
        </div>
        <div className="text-left">
          <div className="text-[13px] font-medium" style={{ color: 'rgba(255, 255, 255, 0.8)' }}>空白创建</div>
          <div className="text-[11px]" style={{ color: 'rgba(255, 255, 255, 0.4)' }}>从零开始，完全自定义你的智能体</div>
        </div>
        <ChevronRight size={16} className="ml-auto transition-transform group-hover:translate-x-1" style={{ color: 'rgba(255, 255, 255, 0.3)' }} />
      </button>
    </div>
  );

  // ======== 渲染步骤 2: 配置信息（含 AI 润色 + 放大编辑） ========

  const renderStepConfigure = () => (
    <div className="flex-1 min-h-0 overflow-auto px-6 pb-6">
      <div className="max-w-2xl mx-auto space-y-5">
        {/* 名称 + 图标 */}
        <div className="p-4 rounded-xl" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
          <div className="flex gap-4">
            <div className="w-14 h-14 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `linear-gradient(135deg, hsla(${currentIconHue}, 70%, 60%, 0.15) 0%, hsla(${currentIconHue}, 70%, 40%, 0.08) 100%)`, border: `1px solid hsla(${currentIconHue}, 60%, 60%, 0.3)`, boxShadow: `0 4px 12px -2px hsla(${currentIconHue}, 70%, 50%, 0.2)` }}>
              <CurrentIcon size={24} style={{ color: `hsla(${currentIconHue}, 70%, 70%, 1)` }} />
            </div>
            <div className="flex-1 space-y-3">
              <div>
                <label className="block text-[11px] font-medium mb-1.5" style={{ color: 'rgba(255, 255, 255, 0.7)' }}>
                  智能体名称 <span style={{ color: 'rgb(239, 68, 68)' }}>*</span>
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value.slice(0, 20) })}
                  placeholder="给你的智能体起个名字"
                  className="w-full px-3 py-2.5 rounded-xl border text-[13px] outline-none transition-all focus:ring-2 focus:ring-[var(--accent-primary)]/20"
                  style={{ background: 'rgba(0, 0, 0, 0.2)', borderColor: 'rgba(255, 255, 255, 0.1)', color: 'rgba(255, 255, 255, 0.95)' }}
                />
                <div className="text-right text-[10px] mt-1" style={{ color: 'rgba(255, 255, 255, 0.4)' }}>{form.name.length}/20</div>
              </div>
              <div>
                <label className="block text-[11px] font-medium mb-1.5" style={{ color: 'rgba(255, 255, 255, 0.7)' }}>简短描述</label>
                <input
                  type="text"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="简单描述这个智能体能做什么"
                  className="w-full px-3 py-2.5 rounded-xl border text-[13px] outline-none transition-all focus:ring-2 focus:ring-[var(--accent-primary)]/20"
                  style={{ background: 'rgba(0, 0, 0, 0.2)', borderColor: 'rgba(255, 255, 255, 0.1)', color: 'rgba(255, 255, 255, 0.95)' }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* 系统提示词 + AI 润色 + 放大 */}
        <div className="p-4 rounded-xl" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: 'linear-gradient(135deg, rgba(168, 85, 247, 0.2) 0%, rgba(168, 85, 247, 0.1) 100%)', border: '1px solid rgba(168, 85, 247, 0.25)' }}>
                <Brain size={12} style={{ color: 'rgb(192, 132, 252)' }} />
              </div>
              <label className="text-[12px] font-semibold" style={{ color: 'rgba(255, 255, 255, 0.9)' }}>
                系统提示词 <span style={{ color: 'rgb(239, 68, 68)' }}>*</span>
              </label>
              {selectedTemplate && (
                <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: 'rgba(34, 197, 94, 0.1)', color: 'rgba(74, 222, 128, 0.9)', border: '1px solid rgba(34, 197, 94, 0.2)' }}>
                  已从模板填充
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" className="h-7 text-[11px] gap-1" onClick={handlePolish} disabled={polishing || !form.prompt.trim()}>
                {polishing ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                AI 润色
              </Button>
              <button
                onClick={() => setShowExpandEditor(true)}
                className="p-1.5 rounded-lg transition-colors hover:bg-white/10"
                style={{ color: 'rgba(255, 255, 255, 0.4)' }}
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
            className="w-full h-48 p-3 rounded-xl border text-[12px] resize-none outline-none font-mono transition-all focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500/30"
            style={{ background: 'rgba(0, 0, 0, 0.2)', borderColor: 'rgba(168, 85, 247, 0.15)', color: 'rgba(255, 255, 255, 0.9)' }}
          />
        </div>

        {/* 标签 */}
        <div className="p-4 rounded-xl" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.01) 100%)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
          <label className="block text-[11px] font-medium mb-1.5" style={{ color: 'rgba(255, 255, 255, 0.6)' }}>标签（可选，用逗号分隔）</label>
          <input
            type="text"
            value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
            placeholder="例如：写作, 文案, 创意"
            className="w-full px-3 py-2.5 rounded-xl border text-[13px] outline-none transition-all focus:ring-2 focus:ring-[var(--accent-primary)]/20"
            style={{ background: 'rgba(0, 0, 0, 0.15)', borderColor: 'rgba(255, 255, 255, 0.08)', color: 'rgba(255, 255, 255, 0.9)' }}
          />
          {parsedTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {parsedTags.map((tag) => (
                <span key={tag} className="text-[10px] px-2 py-1 rounded-lg font-medium" style={{ background: `hsla(${currentIconHue}, 70%, 50%, 0.15)`, color: `hsla(${currentIconHue}, 70%, 70%, 1)`, border: `1px solid hsla(${currentIconHue}, 60%, 60%, 0.25)` }}>
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* AI 润色结果弹窗 */}
      {showPolishResult && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          style={{ background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)' }}
          onClick={(e) => e.target === e.currentTarget && !polishing && handleCancelPolish()}
        >
          <div
            className="w-full max-w-2xl max-h-[70vh] flex flex-col rounded-2xl overflow-hidden"
            style={{ background: 'var(--bg-elevated, #1a1f2e)', border: '1px solid rgba(255, 255, 255, 0.1)', boxShadow: '0 24px 48px -12px rgba(0, 0, 0, 0.5)' }}
          >
            <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.06)' }}>
              <div className="flex items-center gap-2">
                <Sparkles size={14} style={{ color: 'rgb(192, 132, 252)' }} />
                <span className="text-[13px] font-semibold" style={{ color: 'rgba(255, 255, 255, 0.95)' }}>AI 润色结果</span>
                {polishing && <Loader2 size={13} className="animate-spin" style={{ color: 'rgb(192, 132, 252)' }} />}
              </div>
              <button onClick={handleCancelPolish} className="p-1.5 rounded-lg hover:bg-white/10" style={{ color: 'rgba(255,255,255,0.4)' }}>
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-5">
              <pre className="text-[12px] font-mono leading-relaxed whitespace-pre-wrap" style={{ color: 'rgba(255, 255, 255, 0.85)' }}>
                {polishedPrompt || '正在生成...'}
              </pre>
            </div>
            <div className="px-5 py-3 flex items-center justify-end gap-2" style={{ borderTop: '1px solid rgba(255, 255, 255, 0.06)', background: 'rgba(0,0,0,0.1)' }}>
              <Button variant="ghost" size="sm" onClick={handleCancelPolish}>取消</Button>
              <Button variant="primary" size="sm" onClick={handleApplyPolish} disabled={polishing || !polishedPrompt.trim()}>
                <Check size={13} />
                应用润色结果
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // ======== 渲染步骤 3: 测试调优（双栏：左测试 / 右设置） ========

  const renderStepTest = () => (
    <div className="flex-1 min-h-0 flex gap-4 overflow-hidden px-6 pb-4">
      {/* 左侧：测试对话 */}
      <div className="flex-1 min-w-0 flex flex-col rounded-xl overflow-hidden" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
        <div className="px-4 py-2.5 flex items-center gap-2" style={{ background: `linear-gradient(90deg, hsla(${currentIconHue}, 60%, 50%, 0.08) 0%, transparent 50%)`, borderBottom: '1px solid rgba(255, 255, 255, 0.04)' }}>
          <Play size={12} style={{ color: `hsla(${currentIconHue}, 70%, 70%, 1)` }} />
          <span className="text-[12px] font-semibold" style={{ color: 'rgba(255, 255, 255, 0.9)' }}>测试对话</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(34, 197, 94, 0.1)', color: 'rgba(74, 222, 128, 0.8)' }}>实时</span>
        </div>
        <TestChatPanel
          systemPrompt={form.prompt}
          conversationStarters={form.conversationStarters}
          iconHue={currentIconHue}
          welcomeMessage={form.welcomeMessage}
        />
      </div>

      {/* 右侧：调优设置 */}
      <div className="w-72 flex-shrink-0 overflow-auto space-y-3">
        {/* 快捷编辑提示词 */}
        <div className="rounded-xl overflow-hidden" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
          <button
            onClick={() => setShowPromptEdit(!showPromptEdit)}
            className="w-full px-3 py-2.5 flex items-center justify-between transition-colors hover:bg-white/[0.02]"
          >
            <div className="flex items-center gap-2">
              <PenLine size={13} style={{ color: 'rgb(192, 132, 252)' }} />
              <span className="text-[12px] font-semibold" style={{ color: 'rgba(255, 255, 255, 0.9)' }}>编辑提示词</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px]" style={{ color: 'rgba(255, 255, 255, 0.4)' }}>{form.prompt.length}字</span>
              <ChevronDown size={13} style={{ color: 'rgba(255,255,255,0.4)', transform: showPromptEdit ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }} />
            </div>
          </button>
          {showPromptEdit && (
            <div className="px-3 pb-3">
              <div className="flex items-center justify-end gap-1 mb-2">
                <Button variant="ghost" size="sm" className="h-6 text-[10px] gap-1 px-2" onClick={handlePolish} disabled={polishing || !form.prompt.trim()}>
                  {polishing ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                  润色
                </Button>
                <button onClick={() => setShowExpandEditor(true)} className="p-1 rounded hover:bg-white/10" style={{ color: 'rgba(255,255,255,0.4)' }} title="全屏编辑">
                  <Maximize2 size={12} />
                </button>
              </div>
              <textarea
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                className="w-full h-32 p-2 rounded-lg border text-[11px] resize-none outline-none font-mono focus:ring-1 focus:ring-purple-500/20"
                style={{ background: 'rgba(0,0,0,0.2)', borderColor: 'rgba(168, 85, 247, 0.15)', color: 'rgba(255,255,255,0.85)' }}
              />
            </div>
          )}
        </div>

        {/* 模型选择 */}
        <div className="p-3 rounded-xl" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
          <div className="flex items-center gap-2 mb-2">
            <Cpu size={13} style={{ color: 'rgba(129, 140, 248, 0.9)' }} />
            <span className="text-[12px] font-semibold" style={{ color: 'rgba(255, 255, 255, 0.9)' }}>模型选择</span>
          </div>
          <div className="relative">
            <button
              onClick={() => setShowModelDropdown(!showModelDropdown)}
              className="w-full px-3 py-2 rounded-lg border text-[11px] text-left flex items-center justify-between transition-all hover:border-indigo-500/30"
              style={{ background: 'rgba(0,0,0,0.15)', borderColor: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.85)' }}
            >
              <span>{selectedModelGroupId ? modelGroups.find((g) => g.id === selectedModelGroupId)?.name || '已选模型' : '自动调度（默认）'}</span>
              <ChevronDown size={12} style={{ color: 'rgba(255,255,255,0.4)' }} />
            </button>
            {showModelDropdown && (
              <div
                className="absolute top-full left-0 right-0 mt-1 rounded-lg border shadow-xl z-10 max-h-48 overflow-auto"
                style={{ background: 'var(--bg-elevated, #1a1f2e)', borderColor: 'rgba(255,255,255,0.1)' }}
              >
                <button
                  onClick={() => { setSelectedModelGroupId(''); setShowModelDropdown(false); }}
                  className="w-full px-3 py-2 text-[11px] text-left hover:bg-white/5 transition-colors flex items-center gap-2"
                  style={{ color: !selectedModelGroupId ? 'var(--accent-primary)' : 'rgba(255,255,255,0.7)' }}
                >
                  <Cpu size={11} /> 自动调度（默认）
                </button>
                {modelGroups.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => { setSelectedModelGroupId(g.id); setShowModelDropdown(false); }}
                    className="w-full px-3 py-2 text-[11px] text-left hover:bg-white/5 transition-colors"
                    style={{ color: selectedModelGroupId === g.id ? 'var(--accent-primary)' : 'rgba(255,255,255,0.7)' }}
                  >
                    <div className="font-medium">{g.name}</div>
                    {g.description && <div className="text-[10px] mt-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>{g.description}</div>}
                  </button>
                ))}
                {modelGroups.length === 0 && (
                  <div className="px-3 py-2 text-[11px]" style={{ color: 'rgba(255,255,255,0.4)' }}>暂无可用模型池</div>
                )}
              </div>
            )}
          </div>
          <div className="text-[10px] mt-1.5" style={{ color: 'rgba(255,255,255,0.4)' }}>
            默认由后端根据 ai-toolbox 应用标识自动调度
          </div>
        </div>

        {/* 知识库上传 */}
        <div className="p-3 rounded-xl" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
          <div className="flex items-center gap-2 mb-2">
            <BookOpen size={13} style={{ color: 'rgb(74, 222, 128)' }} />
            <span className="text-[12px] font-semibold" style={{ color: 'rgba(255, 255, 255, 0.9)' }}>知识库</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(234, 179, 8, 0.1)', color: 'rgba(250, 204, 21, 0.8)' }}>即将上线</span>
          </div>
          <div
            className="p-3 rounded-lg text-center cursor-not-allowed"
            style={{ background: 'rgba(34, 197, 94, 0.03)', border: '1px dashed rgba(34, 197, 94, 0.15)', opacity: 0.6 }}
          >
            <Upload size={16} className="mx-auto mb-1.5" style={{ color: 'rgba(74, 222, 128, 0.5)' }} />
            <div className="text-[10px]" style={{ color: 'rgba(255,255,255,0.5)' }}>上传文档作为知识库</div>
            <div className="text-[9px] mt-0.5" style={{ color: 'rgba(255,255,255,0.3)' }}>支持 PDF、Word、TXT</div>
          </div>
        </div>

        {/* 温度调节 */}
        <div className="p-3 rounded-xl" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-medium" style={{ color: 'rgba(255, 255, 255, 0.8)' }}>创造性</span>
            <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.9)' }}>
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
          <div className="flex justify-between text-[10px] mt-1" style={{ color: 'rgba(255,255,255,0.4)' }}>
            <span>精确</span>
            <span>创造</span>
          </div>
        </div>

        {/* 配置摘要 */}
        <div className="p-3 rounded-xl text-[11px] space-y-1.5" style={{ background: 'rgba(0,0,0,0.15)', border: '1px solid rgba(255,255,255,0.05)' }}>
          <div className="flex items-center gap-2" style={{ color: 'rgba(255,255,255,0.5)' }}>
            <Check size={11} style={{ color: 'rgb(74, 222, 128)' }} />
            <span>{form.name || '未命名'}</span>
          </div>
          <div className="flex items-center gap-2" style={{ color: 'rgba(255,255,255,0.5)' }}>
            <Check size={11} style={{ color: 'rgb(74, 222, 128)' }} />
            <span>提示词 {form.prompt.length} 字</span>
          </div>
          {parsedTags.length > 0 && (
            <div className="flex items-center gap-2" style={{ color: 'rgba(255,255,255,0.5)' }}>
              <Check size={11} style={{ color: 'rgb(74, 222, 128)' }} />
              <span>{parsedTags.join('、')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // ======== 主渲染 ========

  return (
    <div
      className="h-full min-h-0 flex flex-col"
      style={{ background: 'var(--bg-elevated)', borderRadius: '16px', border: '1px solid rgba(255, 255, 255, 0.06)' }}
    >
      {/* Header */}
      <div className="px-6 pt-4 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={step === 0 ? backToGrid : () => setStep(step - 1)}>
            <ArrowLeft size={13} />
            {step === 0 ? '返回' : '上一步'}
          </Button>
          <div className="flex items-center gap-1.5">
            <Sparkles size={15} style={{ color: 'var(--accent-primary)' }} />
            <span className="text-[14px] font-semibold" style={{ color: 'rgba(255, 255, 255, 0.95)' }}>快速创建智能体</span>
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
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 transition-all"
                  style={{
                    background: i <= step ? 'linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary, var(--accent-primary)) 100%)' : 'rgba(255, 255, 255, 0.05)',
                    color: i <= step ? 'white' : 'rgba(255, 255, 255, 0.35)',
                    boxShadow: i <= step ? '0 2px 8px -2px rgba(var(--accent-primary-rgb, 99, 102, 241), 0.4)' : 'none',
                    border: i <= step ? 'none' : '1px solid rgba(255, 255, 255, 0.08)',
                  }}
                >
                  {i < step ? <Check size={13} /> : i + 1}
                </div>
                <div>
                  <div className="text-[11px] font-semibold leading-tight" style={{ color: i <= step ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.4)' }}>
                    {s.label}
                  </div>
                  <div className="text-[10px] leading-tight" style={{ color: 'rgba(255, 255, 255, 0.3)' }}>{s.description}</div>
                </div>
              </div>
              {i < STEPS.length - 1 && (
                <div className="flex-1 h-[1px] mx-2" style={{ background: i < step ? 'var(--accent-primary)' : 'rgba(255, 255, 255, 0.08)' }} />
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
        <div className="px-6 py-3 flex items-center justify-between" style={{ borderTop: '1px solid rgba(255, 255, 255, 0.04)', background: 'rgba(0, 0, 0, 0.15)' }}>
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
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
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
    </div>
  );
}
