import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ModelTypePicker } from '@/components/model/ModelTypePicker';
import { GlassCard } from '@/components/design/GlassCard';
import { PageHeader } from '@/components/design/PageHeader';
import { Badge } from '@/components/design/Badge';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { Dialog } from '@/components/ui/Dialog';
import { readSseStream } from '@/lib/sse';
import { useAuthStore } from '@/stores/authStore';
import { SystemPromptsPanel } from '@/components/skills/SystemPromptsPanel';
import { Sparkles, Square, Copy, Save } from 'lucide-react';
import {
  listAdminSkills,
  createAdminSkill,
  updateAdminSkill,
  deleteAdminSkill,
  type AdminSkill,
  type AdminCreateSkillRequest,
  type SkillExecutionConfig,
  type SkillInputConfig,
  type SkillOutputConfig,
} from '@/services/real/skills';

// ━━━ 技能模板 ━━━━━━━━

interface SkillTemplate {
  title: string;
  description: string;
  icon: string;
  category: string;
  tags: string[];
  roles: string[];
  contextScope: string;
  acceptsUserInput: boolean;
  promptTemplate: string;
  outputMode: string;
  color: { bg: string; text: string; border: string };
}

const SKILL_TEMPLATES: SkillTemplate[] = [
  {
    title: 'PRD 需求审查',
    description: '对 PRD 文档进行全面审查，检查需求完整性、一致性和可行性',
    icon: '🔍',
    category: 'analysis',
    tags: ['审查', '需求', 'PRD'],
    roles: ['PM'],
    contextScope: 'prd',
    acceptsUserInput: false,
    promptTemplate: '请对当前 PRD 文档进行全面审查，包括：\n1. 需求完整性检查\n2. 逻辑一致性验证\n3. 技术可行性评估\n4. 边界条件分析\n5. 改进建议',
    outputMode: 'chat',
    color: { bg: 'rgba(99, 102, 241, 0.12)', text: 'rgba(99, 102, 241, 0.95)', border: 'rgba(99, 102, 241, 0.25)' },
  },
  {
    title: '测试用例生成',
    description: '根据 PRD 自动生成测试用例，覆盖功能测试、边界测试和异常场景',
    icon: '🧪',
    category: 'testing',
    tags: ['测试', 'QA', '用例'],
    roles: ['QA'],
    contextScope: 'prd',
    acceptsUserInput: true,
    promptTemplate: '根据当前 PRD 内容，生成完整的测试用例，包括：\n1. 正向功能测试\n2. 边界值测试\n3. 异常场景测试\n4. 兼容性测试\n5. 性能测试建议\n\n输出格式：表格（编号/模块/测试点/步骤/预期结果/优先级）',
    outputMode: 'chat',
    color: { bg: 'rgba(34, 197, 94, 0.12)', text: 'rgba(34, 197, 94, 0.95)', border: 'rgba(34, 197, 94, 0.25)' },
  },
  {
    title: '技术方案评估',
    description: '从开发角度分析 PRD，评估技术复杂度并给出架构建议',
    icon: '💻',
    category: 'development',
    tags: ['技术', '架构', '评估'],
    roles: ['DEV'],
    contextScope: 'prd',
    acceptsUserInput: true,
    promptTemplate: '请从技术角度分析当前 PRD，包括：\n1. 技术复杂度评估（高/中/低）\n2. 推荐技术架构方案\n3. 数据模型设计建议\n4. API 接口设计\n5. 潜在技术风险\n6. 工作量估算（人天）',
    outputMode: 'chat',
    color: { bg: 'rgba(59, 130, 246, 0.12)', text: 'rgba(59, 130, 246, 0.95)', border: 'rgba(59, 130, 246, 0.25)' },
  },
  {
    title: '用户故事拆分',
    description: '将 PRD 拆分为用户故事，按优先级排序并估算故事点',
    icon: '📖',
    category: 'analysis',
    tags: ['用户故事', '拆分', '敏捷'],
    roles: ['PM'],
    contextScope: 'prd',
    acceptsUserInput: false,
    promptTemplate: '将当前 PRD 拆分为用户故事：\n1. 按功能模块分组\n2. 每个故事包含：标题、As a/I want/So that 描述、验收标准\n3. 标注优先级（P0/P1/P2）\n4. 估算故事点\n5. 标注依赖关系',
    outputMode: 'chat',
    color: { bg: 'rgba(168, 85, 247, 0.12)', text: 'rgba(168, 85, 247, 0.95)', border: 'rgba(168, 85, 247, 0.25)' },
  },
  {
    title: 'API 文档生成',
    description: '根据 PRD 中的功能描述，自动生成 RESTful API 接口文档',
    icon: '📡',
    category: 'development',
    tags: ['API', '文档', '接口'],
    roles: ['DEV'],
    contextScope: 'prd',
    acceptsUserInput: true,
    promptTemplate: '根据 PRD 生成 RESTful API 文档：\n1. 接口列表（路径/方法/描述）\n2. 请求参数（Query/Body/Path）\n3. 响应结构（JSON Schema）\n4. 错误码定义\n5. 认证方式说明\n\n格式：Markdown，每个接口一个章节',
    outputMode: 'chat',
    color: { bg: 'rgba(236, 72, 153, 0.12)', text: 'rgba(236, 72, 153, 0.95)', border: 'rgba(236, 72, 153, 0.25)' },
  },
  {
    title: '竞品对比分析',
    description: '将 PRD 功能与市场竞品对比，找出差异化优势和改进空间',
    icon: '📊',
    category: 'analysis',
    tags: ['竞品', '分析', '市场'],
    roles: [],
    contextScope: 'prd',
    acceptsUserInput: true,
    promptTemplate: '基于当前 PRD 进行竞品分析：\n1. 核心功能对比矩阵\n2. 差异化优势识别\n3. 功能缺口分析\n4. 用户体验对比\n5. 改进建议（优先级排序）\n\n{{userInput}}',
    outputMode: 'chat',
    color: { bg: 'rgba(245, 158, 11, 0.12)', text: 'rgba(245, 158, 11, 0.95)', border: 'rgba(245, 158, 11, 0.25)' },
  },
  {
    title: '数据库设计',
    description: '从 PRD 中提取数据实体，生成数据库表结构设计',
    icon: '🗃️',
    category: 'development',
    tags: ['数据库', '设计', '建模'],
    roles: ['DEV'],
    contextScope: 'prd',
    acceptsUserInput: false,
    promptTemplate: '根据 PRD 设计数据库结构：\n1. 实体识别与关系分析（ER 图描述）\n2. 集合/表结构设计（字段名/类型/说明/索引）\n3. 数据关联关系\n4. 索引设计建议\n5. 数据迁移注意事项',
    outputMode: 'chat',
    color: { bg: 'rgba(20, 184, 166, 0.12)', text: 'rgba(20, 184, 166, 0.95)', border: 'rgba(20, 184, 166, 0.25)' },
  },
  {
    title: '风险评估报告',
    description: '识别项目中的风险点，评估影响程度并制定应对策略',
    icon: '⚠️',
    category: 'analysis',
    tags: ['风险', '评估', '项目管理'],
    roles: ['PM'],
    contextScope: 'prd',
    acceptsUserInput: false,
    promptTemplate: '对当前 PRD 进行风险评估：\n1. 风险识别（技术/业务/资源/时间）\n2. 风险矩阵（概率 × 影响程度）\n3. 每个风险的应对策略\n4. 关键里程碑风险预警\n5. 风险监控建议',
    outputMode: 'chat',
    color: { bg: 'rgba(239, 68, 68, 0.12)', text: 'rgba(239, 68, 68, 0.95)', border: 'rgba(239, 68, 68, 0.25)' },
  },
  {
    title: '验收标准生成',
    description: '为 PRD 中每个功能点生成可量化的验收标准',
    icon: '✅',
    category: 'testing',
    tags: ['验收', '标准', 'DoD'],
    roles: ['QA', 'PM'],
    contextScope: 'prd',
    acceptsUserInput: false,
    promptTemplate: '为 PRD 中每个功能模块生成验收标准（Definition of Done）：\n1. 功能验收标准（可测试的条目）\n2. 性能验收标准（响应时间/吞吐量）\n3. 安全验收标准\n4. 兼容性验收标准\n5. 文档验收标准\n\n格式：复选框列表，每个条目可直接用于验收',
    outputMode: 'chat',
    color: { bg: 'rgba(16, 185, 129, 0.12)', text: 'rgba(16, 185, 129, 0.95)', border: 'rgba(16, 185, 129, 0.25)' },
  },
];

const CATEGORY_MAP: Record<string, { label: string; icon: string }> = {
  analysis: { label: '分析', icon: '📋' },
  testing: { label: '测试', icon: '🧪' },
  development: { label: '开发', icon: '💻' },
  general: { label: '通用', icon: '⚡' },
};

// ━━━ 默认配置 ━━━━━━━━

const defaultInput: SkillInputConfig = {
  contextScope: 'prd',
  acceptsUserInput: false,
  acceptsAttachments: false,
  parameters: [],
};

const defaultExecution: SkillExecutionConfig = {
  promptTemplate: '',
  modelType: 'chat',
  toolChain: [],
};

const defaultOutput: SkillOutputConfig = {
  mode: 'chat',
  echoToChat: false,
};

const ROLE_OPTIONS = ['PM', 'DEV', 'QA'] as const;
const CONTEXT_OPTIONS = [
  { value: 'prd', label: 'PRD 文档' },
  { value: 'all', label: '全部消息' },
  { value: 'current', label: '当前对话' },
  { value: 'none', label: '无上下文' },
];
const OUTPUT_MODES = [
  { value: 'chat', label: '对话输出' },
  { value: 'download', label: '文件下载' },
  { value: 'clipboard', label: '复制到剪贴板' },
];
const VISIBILITY_OPTIONS = [
  { value: 'system', label: '系统' },
  { value: 'public', label: '公共' },
];

// ━━━ Helpers ━━━━━━━━

function getApiBaseUrl() {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
  return raw.trim().replace(/\/+$/, '');
}

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

type PromptOptimizeStreamEvent = {
  type: 'start' | 'delta' | 'done' | 'error';
  content?: string;
  errorCode?: string;
  errorMessage?: string;
};

// ━━━ Tabs ━━━━━━━━

type TabKey = 'skills' | 'system' | 'templates';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'skills', label: '技能管理' },
  { key: 'system', label: '系统指令' },
  { key: 'templates', label: '模板市场' },
];

// ━━━ 主组件 ━━━━━━━━

export default function SkillsPage() {
  const { isMobile } = useBreakpoint();
  const [skills, setSkills] = useState<AdminSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<AdminSkill | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('skills');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [listCollapsed, setListCollapsed] = useState(false);

  // ━━━ 表单状态 ━━━

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [skillKey, setSkillKey] = useState('');
  const [icon, setIcon] = useState('');
  const [category, setCategory] = useState('general');
  const [tags, setTags] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [visibility, setVisibility] = useState('system');
  const [order, setOrder] = useState(1);
  const [isEnabled, setIsEnabled] = useState(true);
  const [isBuiltIn, setIsBuiltIn] = useState(false);
  const [contextScope, setContextScope] = useState('prd');
  const [acceptsUserInput, setAcceptsUserInput] = useState(false);
  const [acceptsAttachments, setAcceptsAttachments] = useState(false);
  const [promptTemplate, setPromptTemplate] = useState('');
  const [systemPromptOverride, setSystemPromptOverride] = useState('');
  const [modelType, setModelType] = useState('chat');
  const [outputMode, setOutputMode] = useState('chat');
  const [echoToChat, setEchoToChat] = useState(false);

  // ━━━ 魔法棒（提示词优化）━━━

  const token = useAuthStore((s) => s.token);
  const [optOpen, setOptOpen] = useState(false);
  const [optBusy, setOptBusy] = useState(false);
  const [optError, setOptError] = useState<string | null>(null);
  const [optText, setOptText] = useState('');
  const [optOriginal, setOptOriginal] = useState('');
  const optAbortRef = useRef<AbortController | null>(null);

  // ━━━ 拖拽排序 ━━━

  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  // ━━━ 加载 ━━━

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    const res = await listAdminSkills();
    if (res.success && res.data) {
      setSkills(res.data.skills);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchSkills(); }, [fetchSkills]);

  // ━━━ 统计 ━━━

  const stats = useMemo(() => {
    const total = skills.length;
    const enabled = skills.filter(s => s.isEnabled).length;
    const system = skills.filter(s => s.visibility === 'system').length;
    const categories = [...new Set(skills.map(s => s.category))].length;
    return { total, enabled, system, categories };
  }, [skills]);

  // ━━━ 填充表单 ━━━

  const fillForm = useCallback((s: AdminSkill | null) => {
    if (!s) {
      setTitle(''); setDescription(''); setSkillKey(''); setIcon('');
      setCategory('general'); setTags(''); setRoles([]); setVisibility('system');
      setOrder(1); setIsEnabled(true); setIsBuiltIn(false);
      setContextScope('prd'); setAcceptsUserInput(false); setAcceptsAttachments(false);
      setPromptTemplate(''); setSystemPromptOverride(''); setModelType('chat');
      setOutputMode('chat'); setEchoToChat(false);
      return;
    }
    setTitle(s.title);
    setDescription(s.description);
    setSkillKey(s.skillKey);
    setIcon(s.icon ?? '');
    setCategory(s.category);
    setTags(s.tags.join(', '));
    setRoles(s.roles);
    setVisibility(s.visibility);
    setOrder(s.order);
    setIsEnabled(s.isEnabled);
    setIsBuiltIn(s.isBuiltIn);
    setContextScope(s.input?.contextScope ?? 'prd');
    setAcceptsUserInput(s.input?.acceptsUserInput ?? false);
    setAcceptsAttachments(s.input?.acceptsAttachments ?? false);
    setPromptTemplate(s.execution?.promptTemplate ?? '');
    setSystemPromptOverride(s.execution?.systemPromptOverride ?? '');
    setModelType(s.execution?.modelType ?? 'chat');
    setOutputMode(s.output?.mode ?? 'chat');
    setEchoToChat(s.output?.echoToChat ?? false);
  }, []);

  const handleSelect = useCallback((s: AdminSkill) => {
    setSelected(s); setIsCreating(false); fillForm(s); setMsg(null);
  }, [fillForm]);

  const handleNew = useCallback(() => {
    setSelected(null); setIsCreating(true); fillForm(null); setMsg(null);
    setActiveTab('skills');
  }, [fillForm]);

  // ━━━ 从模板创建 ━━━

  const handleCreateFromTemplate = useCallback((tpl: SkillTemplate) => {
    setSelected(null);
    setIsCreating(true);
    setMsg(null);
    setActiveTab('skills');

    setTitle(tpl.title);
    setDescription(tpl.description);
    setSkillKey('');
    setIcon(tpl.icon);
    setCategory(tpl.category);
    setTags(tpl.tags.join(', '));
    setRoles(tpl.roles);
    setVisibility('system');
    setOrder(skills.length + 1);
    setIsEnabled(true);
    setIsBuiltIn(false);
    setContextScope(tpl.contextScope);
    setAcceptsUserInput(tpl.acceptsUserInput);
    setAcceptsAttachments(false);
    setPromptTemplate(tpl.promptTemplate);
    setSystemPromptOverride('');
    setModelType('chat');
    setOutputMode(tpl.outputMode);
    setEchoToChat(false);
  }, [skills.length]);

  // ━━━ 构建请求体 ━━━

  const buildRequest = useCallback((): AdminCreateSkillRequest => ({
    skillKey: skillKey || undefined,
    title,
    description,
    icon: icon || undefined,
    category,
    tags: tags.split(',').map(t => t.trim()).filter(Boolean),
    roles,
    visibility,
    order,
    isEnabled,
    isBuiltIn,
    input: {
      ...defaultInput,
      contextScope,
      acceptsUserInput,
      acceptsAttachments,
    },
    execution: {
      ...defaultExecution,
      promptTemplate,
      systemPromptOverride: systemPromptOverride || undefined,
      modelType,
    },
    output: {
      ...defaultOutput,
      mode: outputMode,
      echoToChat,
    },
  }), [title, description, skillKey, icon, category, tags, roles, visibility, order,
       isEnabled, isBuiltIn, contextScope, acceptsUserInput, acceptsAttachments,
       promptTemplate, systemPromptOverride, modelType, outputMode, echoToChat]);

  // ━━━ 保存 ━━━

  const handleSave = useCallback(async () => {
    if (!title.trim()) { setMsg({ type: 'err', text: '名称不能为空' }); return; }
    setSaving(true);
    const req = buildRequest();
    const res = isCreating
      ? await createAdminSkill(req)
      : selected
        ? await updateAdminSkill(selected.skillKey, req)
        : null;

    if (res?.success) {
      setMsg({ type: 'ok', text: isCreating ? '创建成功' : '保存成功' });
      setIsCreating(false);
      await fetchSkills();
      if (isCreating && res.data && 'skillKey' in res.data) {
        const newKey = (res.data as { skillKey: string }).skillKey;
        const updated = await listAdminSkills();
        if (updated.success && updated.data) {
          setSkills(updated.data.skills);
          const found = updated.data.skills.find(s => s.skillKey === newKey);
          if (found) { setSelected(found); fillForm(found); }
        }
      }
    } else {
      setMsg({ type: 'err', text: res?.error?.message ?? '操作失败' });
    }
    setSaving(false);
  }, [title, buildRequest, isCreating, selected, fetchSkills, fillForm]);

  // ━━━ 删除 ━━━

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(`确定删除技能「${selected.title}」？`)) return;
    const res = await deleteAdminSkill(selected.skillKey);
    if (res?.success) {
      setMsg({ type: 'ok', text: '已删除' });
      setSelected(null); fillForm(null);
      fetchSkills();
    } else {
      setMsg({ type: 'err', text: res?.error?.message ?? '删除失败' });
    }
  }, [selected, fetchSkills, fillForm]);

  // ━━━ 魔法棒函数 ━━━

  const cancelOptimize = useCallback(() => {
    try { optAbortRef.current?.abort(); } catch { /* ignore */ }
    optAbortRef.current = null;
    setOptBusy(false);
  }, []);

  const startOptimize = useCallback(async () => {
    if (!token) { setOptError('未登录或 Token 缺失'); return; }
    const pt = promptTemplate.trim();
    if (!pt) { setOptError('当前提示词为空，无法优化'); return; }

    cancelOptimize();
    const ac = new AbortController();
    optAbortRef.current = ac;
    setOptBusy(true);
    setOptError(null);
    setOptText('');
    setOptOriginal(pt);

    let res: Response;
    try {
      const url = joinUrl(getApiBaseUrl(), '/api/prompts/optimize/stream');
      res = await fetch(url, {
        method: 'POST',
        headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ promptTemplate: pt, title, mode: 'strict' }),
        signal: ac.signal,
      });
    } catch (e) {
      setOptBusy(false);
      optAbortRef.current = null;
      setOptError(`请求失败：${e instanceof Error ? e.message : '网络错误'}`);
      return;
    }

    if (!res.ok) {
      setOptBusy(false);
      optAbortRef.current = null;
      const t = await res.text().catch(() => '');
      setOptError(t || `HTTP ${res.status} ${res.statusText}`);
      return;
    }

    try {
      await readSseStream(res, (evt) => {
        if (!evt.data) return;
        try {
          const obj = JSON.parse(evt.data) as PromptOptimizeStreamEvent;
          if (obj.type === 'delta' && obj.content) setOptText((prev) => prev + obj.content);
          else if (obj.type === 'error') { setOptError(obj.errorMessage || '优化失败'); setOptBusy(false); optAbortRef.current = null; }
          else if (obj.type === 'done') { setOptBusy(false); optAbortRef.current = null; }
        } catch { /* ignore */ }
      }, ac.signal);
    } finally {
      if (ac.signal.aborted) { setOptBusy(false); optAbortRef.current = null; }
    }
  }, [token, promptTemplate, title, cancelOptimize]);

  const applyOptimized = useCallback(() => {
    const next = optText.trim();
    if (!next) return;
    setPromptTemplate(next);
    setOptOpen(false);
    setMsg({ type: 'ok', text: '已替换为优化后的提示词（别忘了点保存）' });
  }, [optText]);

  // ━━━ 拖拽排序处理 ━━━

  const handleDragStart = useCallback((e: React.DragEvent, skillKey: string) => {
    e.dataTransfer.setData('text/plain', skillKey);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, skillKey: string) => {
    e.preventDefault();
    setDragOverKey(skillKey);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverKey(null);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent, toKey: string) => {
    e.preventDefault();
    setDragOverKey(null);
    const fromKey = e.dataTransfer.getData('text/plain');
    if (!fromKey || fromKey === toKey) return;

    // Find skills and swap order
    const fromSkill = skills.find(s => s.skillKey === fromKey);
    const toSkill = skills.find(s => s.skillKey === toKey);
    if (!fromSkill || !toSkill) return;

    // Get list in same visibility group, sorted by order
    const group = skills.filter(s => s.visibility === fromSkill.visibility).sort((a, b) => a.order - b.order);
    const fromIdx = group.findIndex(s => s.skillKey === fromKey);
    const toIdx = group.findIndex(s => s.skillKey === toKey);
    if (fromIdx < 0 || toIdx < 0) return;

    // Reorder
    const reordered = [...group];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);

    // Update local state with new orders
    const orderUpdates = new Map<string, number>();
    reordered.forEach((s, i) => { orderUpdates.set(s.skillKey, i + 1); });

    setSkills(prev => prev.map(s => {
      const newOrder = orderUpdates.get(s.skillKey);
      return newOrder !== undefined ? { ...s, order: newOrder } : s;
    }));

    // Persist changed skills silently
    const changedSkills = reordered.filter((s, i) => s.order !== i + 1);
    for (const s of changedSkills) {
      const newOrder = orderUpdates.get(s.skillKey)!;
      await updateAdminSkill(s.skillKey, {
        title: s.title, description: s.description, icon: s.icon, category: s.category,
        tags: s.tags, roles: s.roles, visibility: s.visibility, order: newOrder,
        isEnabled: s.isEnabled, isBuiltIn: s.isBuiltIn, input: s.input, execution: s.execution, output: s.output,
      });
    }

    // Update selected skill's order in form if needed
    if (selected && orderUpdates.has(selected.skillKey)) {
      setOrder(orderUpdates.get(selected.skillKey)!);
    }
  }, [skills, selected]);

  // ━━━ 角色切换 ━━━

  const toggleRole = useCallback((r: string) => {
    setRoles(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r]);
  }, []);

  // ━━━ 分组显示 ━━━

  const grouped = useMemo(() => {
    const system = skills.filter(s => s.visibility === 'system');
    const pub = skills.filter(s => s.visibility === 'public');
    return { system, public: pub };
  }, [skills]);

  // ━━━ 模板过滤 ━━━

  const filteredTemplates = useMemo(() => {
    let result = SKILL_TEMPLATES;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(t =>
        t.title.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.tags.some(tag => tag.toLowerCase().includes(q))
      );
    }
    if (categoryFilter !== 'all') {
      result = result.filter(t => t.category === categoryFilter);
    }
    return result;
  }, [searchQuery, categoryFilter]);

  // ━━━ 模板中已创建检查 ━━━

  const isTemplateCreated = useCallback((tpl: SkillTemplate) => {
    return skills.some(s => s.title === tpl.title);
  }, [skills]);

  // ━━━ 渲染 ━━━

  const showEditor = selected || isCreating;
  const mobileShowEditor = isMobile && showEditor;

  const handleMobileBack = useCallback(() => {
    setSelected(null);
    setIsCreating(false);
    setMsg(null);
  }, []);

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-6rem)]">
      {/* ━━━ 顶部 Header ━━━ */}
      <PageHeader
        title="技能管理"
        tabs={TABS}
        activeTab={activeTab}
        onTabChange={(k) => { setActiveTab(k as TabKey); setSelected(null); setIsCreating(false); }}
        actions={
          activeTab === 'skills' ? (
            <button
              onClick={handleNew}
              className="text-xs px-3 py-1.5 rounded-lg transition"
              style={{
                background: 'var(--gold-gradient)',
                color: '#fff',
                boxShadow: '0 2px 8px -1px rgba(99, 102, 241, 0.35)',
              }}
            >
              + 新建技能
            </button>
          ) : undefined
        }
      />

      {/* ━━━ 统计卡片 ━━━ */}
      {activeTab === 'skills' && !mobileShowEditor && (
        <div className={`grid gap-3 ${isMobile ? 'grid-cols-2' : 'grid-cols-4'}`}>
          <StatCard label="总技能数" value={stats.total} icon="⚡" color="rgba(99, 102, 241, 0.9)" />
          <StatCard label="已启用" value={stats.enabled} icon="✅" color="rgba(34, 197, 94, 0.9)" />
          <StatCard label="系统技能" value={stats.system} icon="🔒" color="rgba(245, 158, 11, 0.9)" />
          <StatCard label="分类数" value={stats.categories} icon="📂" color="rgba(168, 85, 247, 0.9)" />
        </div>
      )}

      {/* ━━━ Tab: 技能管理 ━━━ */}
      {activeTab === 'skills' && (
        <div className={`flex gap-0 flex-1 min-h-0 ${isMobile ? 'flex-col' : ''}`}>
          {/* 左侧列表 - 可折叠 */}
          {(!isMobile || !mobileShowEditor) && (
            <div
              className="shrink-0 flex flex-col transition-all duration-300 ease-in-out overflow-hidden"
              style={{ width: isMobile ? '100%' : listCollapsed ? '48px' : '280px' }}
            >
              <GlassCard animated className="flex-1 flex flex-col overflow-hidden h-full" padding="none"
                style={{ borderRadius: listCollapsed ? '14px' : undefined }}
              >
                {/* 折叠态 - 只显示图标条 */}
                {listCollapsed && !isMobile ? (
                  <div className="flex flex-col items-center py-3 gap-1 flex-1">
                    <button
                      onClick={() => setListCollapsed(false)}
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white/70 hover:bg-white/10 transition"
                      title="展开列表"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
                    </button>
                    <div className="w-6 border-t border-white/10 my-1" />
                    {skills.slice(0, 8).map(s => (
                      <button
                        key={s.skillKey}
                        onClick={() => { handleSelect(s); setListCollapsed(false); }}
                        className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm transition ${
                          selected?.skillKey === s.skillKey ? 'bg-white/15' : 'hover:bg-white/8'
                        }`}
                        title={s.title}
                      >
                        {s.icon || '⚡'}
                      </button>
                    ))}
                    {skills.length > 8 && (
                      <span className="text-[9px] text-white/20 mt-1">+{skills.length - 8}</span>
                    )}
                  </div>
                ) : (
                  <>
                    {/* 展开态 - 搜索 + 列表 */}
                    <div className="p-3 border-b border-white/10 flex items-center gap-2">
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="搜索技能..."
                        className="field-input text-xs flex-1"
                        style={{ marginBottom: 0 }}
                      />
                      {!isMobile && (
                        <button
                          onClick={() => setListCollapsed(true)}
                          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/30 hover:text-white/60 hover:bg-white/10 transition shrink-0"
                          title="折叠列表"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6"/></svg>
                        </button>
                      )}
                    </div>

                    <div className="flex-1 overflow-y-auto p-2 space-y-3">
                      {loading && <div className="text-center text-xs opacity-50 py-8">加载中...</div>}

                      {!loading && grouped.system.length > 0 && (
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-white/30 px-2 mb-1 flex items-center gap-1.5">
                            <span style={{ color: 'rgba(245, 158, 11, 0.7)' }}>●</span> 系统技能
                          </div>
                          {grouped.system
                            .filter(s => !searchQuery || s.title.toLowerCase().includes(searchQuery.toLowerCase()) || s.skillKey.toLowerCase().includes(searchQuery.toLowerCase()))
                            .map(s => (
                              <SkillListItem
                                key={s.skillKey} skill={s}
                                active={selected?.skillKey === s.skillKey}
                                onClick={() => handleSelect(s)}
                                dragOver={dragOverKey === s.skillKey}
                                onDragStart={(e) => handleDragStart(e, s.skillKey)}
                                onDragOver={(e) => handleDragOver(e, s.skillKey)}
                                onDragLeave={handleDragLeave}
                                onDrop={(e) => handleDrop(e, s.skillKey)}
                              />
                            ))}
                        </div>
                      )}

                      {!loading && grouped.public.length > 0 && (
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-white/30 px-2 mb-1 flex items-center gap-1.5">
                            <span style={{ color: 'rgba(34, 197, 94, 0.7)' }}>●</span> 公共技能
                          </div>
                          {grouped.public
                            .filter(s => !searchQuery || s.title.toLowerCase().includes(searchQuery.toLowerCase()) || s.skillKey.toLowerCase().includes(searchQuery.toLowerCase()))
                            .map(s => (
                              <SkillListItem
                                key={s.skillKey} skill={s}
                                active={selected?.skillKey === s.skillKey}
                                onClick={() => handleSelect(s)}
                                dragOver={dragOverKey === s.skillKey}
                                onDragStart={(e) => handleDragStart(e, s.skillKey)}
                                onDragOver={(e) => handleDragOver(e, s.skillKey)}
                                onDragLeave={handleDragLeave}
                                onDrop={(e) => handleDrop(e, s.skillKey)}
                              />
                            ))}
                        </div>
                      )}

                      {!loading && skills.length === 0 && (
                        <div className="text-center py-12 px-4">
                          <div className="text-3xl mb-3">🎯</div>
                          <div className="text-sm text-white/50 mb-1">还没有技能</div>
                          <div className="text-xs text-white/30 mb-4">从模板市场一键创建，或手动新建</div>
                          <button
                            onClick={() => setActiveTab('templates')}
                            className="text-xs px-4 py-2 rounded-lg transition"
                            style={{
                              background: 'rgba(99, 102, 241, 0.15)',
                              border: '1px solid rgba(99, 102, 241, 0.3)',
                              color: 'rgba(99, 102, 241, 0.95)',
                            }}
                          >
                            浏览模板市场 →
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </GlassCard>
            </div>
          )}

          {/* 间距 */}
          {(!isMobile || !mobileShowEditor) && <div className="w-3 shrink-0" />}

          {/* 右侧编辑器 - 占满剩余空间 */}
          {(!isMobile || mobileShowEditor) && (
            <div className="flex-1 min-w-0 flex flex-col min-h-0">
            <GlassCard animated className="flex-1 flex flex-col h-full" overflow="hidden" padding="none">
              {!showEditor ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
                  <div className="text-5xl mb-4">⚡</div>
                  <div className="text-sm text-white/60 mb-2">选择左侧技能编辑</div>
                  <div className="text-xs text-white/30 mb-6">或从模板市场一键创建新技能</div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleNew}
                      className="text-xs px-4 py-2 rounded-lg transition"
                      style={{
                        background: 'rgba(255, 255, 255, 0.06)',
                        border: '1px solid rgba(255, 255, 255, 0.14)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      空白新建
                    </button>
                    <button
                      onClick={() => setActiveTab('templates')}
                      className="text-xs px-4 py-2 rounded-lg transition"
                      style={{
                        background: 'var(--gold-gradient)',
                        color: '#fff',
                        boxShadow: '0 2px 8px -1px rgba(99, 102, 241, 0.35)',
                      }}
                    >
                      从模板创建
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {/* 顶栏 */}
                  <div className="p-4 border-b border-white/10 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {isMobile && (
                        <button
                          onClick={handleMobileBack}
                          className="text-xs px-2 py-1.5 rounded-lg bg-white/10 text-white/60 hover:bg-white/15 transition"
                        >
                          &larr; 返回
                        </button>
                      )}
                      {!isMobile && listCollapsed && (
                        <button
                          onClick={() => setListCollapsed(false)}
                          className="text-xs px-2 py-1.5 rounded-lg bg-white/6 text-white/40 hover:text-white/60 hover:bg-white/10 transition"
                          title="展开技能列表"
                        >
                          ☰
                        </button>
                      )}
                      <span className="text-lg">{icon || '⚡'}</span>
                      <h2 className="text-sm font-semibold">
                        {isCreating ? '新增技能' : `编辑：${selected?.title ?? ''}`}
                      </h2>
                      {selected && (
                        <Badge variant={selected.isEnabled ? 'success' : 'danger'} size="sm">
                          {selected.isEnabled ? '已启用' : '已禁用'}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {msg && (
                        <span className={`text-xs ${msg.type === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
                          {msg.text}
                        </span>
                      )}
                      <button
                        onClick={handleSave} disabled={saving}
                        className="text-xs px-3 py-1.5 rounded-lg transition disabled:opacity-40"
                        style={{
                          background: 'var(--gold-gradient)',
                          color: '#fff',
                          boxShadow: '0 2px 8px -1px rgba(99, 102, 241, 0.35)',
                        }}
                      >
                        {saving ? '保存中...' : '保存'}
                      </button>
                      {selected && !isCreating && (
                        <button
                          onClick={handleDelete}
                          className="text-xs px-3 py-1.5 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30 transition"
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 编辑表单 */}
                  <div className="flex-1 overflow-y-auto p-4 space-y-5">
                    {/* 基本信息 */}
                    <Section title="基本信息">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field label="名称 *">
                          <input value={title} onChange={e => setTitle(e.target.value)}
                            className="field-input" placeholder="技能名称" />
                        </Field>
                        <Field label="SkillKey">
                          <input value={skillKey} onChange={e => setSkillKey(e.target.value)}
                            className="field-input" placeholder="自动生成" disabled={!isCreating} />
                        </Field>
                        <Field label="图标">
                          <input value={icon} onChange={e => setIcon(e.target.value)}
                            className="field-input" placeholder="emoji 如: ⚡🔍🧪" />
                        </Field>
                        <Field label="分类">
                          <select value={category} onChange={e => setCategory(e.target.value)} className="field-input">
                            {Object.entries(CATEGORY_MAP).map(([k, v]) => (
                              <option key={k} value={k}>{v.icon} {v.label}</option>
                            ))}
                          </select>
                        </Field>
                        <Field label="排序">
                          <input type="number" value={order} onChange={e => setOrder(Number(e.target.value))}
                            className="field-input" />
                        </Field>
                        <Field label="可见性">
                          <select value={visibility} onChange={e => setVisibility(e.target.value)} className="field-input">
                            {VISIBILITY_OPTIONS.map(o => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <Field label="描述" className="mt-3">
                        <input value={description} onChange={e => setDescription(e.target.value)}
                          className="field-input" placeholder="简要描述技能的功能和用途" />
                      </Field>
                      <Field label="标签" className="mt-3">
                        <input value={tags} onChange={e => setTags(e.target.value)}
                          className="field-input" placeholder="逗号分隔，如: 分析, PRD, 审查" />
                      </Field>

                      {/* 角色 */}
                      <div className="mt-3">
                        <label className="text-xs text-white/50 mb-1.5 block">适用角色（空 = 全部）</label>
                        <div className="flex flex-wrap gap-2">
                          {ROLE_OPTIONS.map(r => (
                            <button key={r} onClick={() => toggleRole(r)}
                              className={`text-xs px-3 py-1 rounded-full border transition ${
                                roles.includes(r)
                                  ? 'border-amber-400/60 bg-amber-500/20 text-amber-300'
                                  : 'border-white/10 bg-white/5 text-white/40 hover:border-white/20'
                              }`}
                            >{r}</button>
                          ))}
                        </div>
                      </div>

                      {/* 开关 */}
                      <div className="mt-3 flex flex-wrap gap-4">
                        <label className="flex items-center gap-1.5 text-xs text-white/60">
                          <input type="checkbox" checked={isEnabled} onChange={e => setIsEnabled(e.target.checked)} />
                          启用
                        </label>
                        <label className="flex items-center gap-1.5 text-xs text-white/60">
                          <input type="checkbox" checked={isBuiltIn} onChange={e => setIsBuiltIn(e.target.checked)} />
                          内置（不可被用户删除）
                        </label>
                      </div>
                    </Section>

                    {/* 输入配置 */}
                    <Section title="输入配置">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field label="上下文范围">
                          <select value={contextScope} onChange={e => setContextScope(e.target.value)} className="field-input">
                            {CONTEXT_OPTIONS.map(o => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </Field>
                        <div className="flex flex-wrap items-end gap-4 pb-1">
                          <label className="flex items-center gap-1.5 text-xs text-white/60">
                            <input type="checkbox" checked={acceptsUserInput} onChange={e => setAcceptsUserInput(e.target.checked)} />
                            接受用户输入
                          </label>
                          <label className="flex items-center gap-1.5 text-xs text-white/60">
                            <input type="checkbox" checked={acceptsAttachments} onChange={e => setAcceptsAttachments(e.target.checked)} />
                            接受附件
                          </label>
                        </div>
                      </div>
                    </Section>

                    {/* 执行配置 */}
                    <Section title="执行配置">
                      <Field label="提示词模板 (promptTemplate)">
                        <div className="relative">
                          <textarea value={promptTemplate} onChange={e => setPromptTemplate(e.target.value)}
                            className="field-input min-h-[120px] font-mono text-xs pr-12" placeholder="支持 {{变量}} 占位符" />
                          <button
                            type="button"
                            onClick={() => {
                              if (optBusy) { cancelOptimize(); return; }
                              setOptOriginal(promptTemplate.trim());
                              setOptText('');
                              setOptError(null);
                              setOptOpen(true);
                              void startOptimize();
                            }}
                            className="absolute bottom-2 right-2 h-8 w-8 inline-flex items-center justify-center rounded-[10px] transition-colors"
                            style={{
                              background: optBusy ? 'rgba(239,68,68,0.12)' : 'rgba(255,255,255,0.06)',
                              border: optBusy ? '1px solid rgba(239,68,68,0.28)' : '1px solid rgba(255,255,255,0.14)',
                              color: optBusy ? 'rgba(239,68,68,0.95)' : 'rgba(255,255,255,0.5)',
                            }}
                            title={optBusy ? '停止优化' : '魔法棒：优化提示词（大模型）'}
                          >
                            {optBusy ? <Square size={14} /> : <Sparkles size={14} />}
                          </button>
                        </div>
                      </Field>
                      <Field label="系统提示词覆盖 (可选)" className="mt-3">
                        <textarea value={systemPromptOverride} onChange={e => setSystemPromptOverride(e.target.value)}
                          className="field-input min-h-[80px] font-mono text-xs" placeholder="留空使用默认角色系统提示词" />
                      </Field>
                      <Field label="模型类型" className="mt-3">
                        <ModelTypePicker
                          value={modelType}
                          onChange={setModelType}
                          compact
                        />
                      </Field>
                    </Section>

                    {/* 输出配置 */}
                    <Section title="输出配置">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <Field label="输出模式">
                          <select value={outputMode} onChange={e => setOutputMode(e.target.value)} className="field-input">
                            {OUTPUT_MODES.map(o => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </Field>
                        <div className="flex items-end pb-1">
                          <label className="flex items-center gap-1.5 text-xs text-white/60">
                            <input type="checkbox" checked={echoToChat} onChange={e => setEchoToChat(e.target.checked)} />
                            同时回显到对话
                          </label>
                        </div>
                      </div>
                    </Section>
                  </div>
                </>
              )}
            </GlassCard>
            </div>
          )}
        </div>
      )}

      {/* ━━━ Tab: 模板市场 ━━━ */}
      {activeTab === 'templates' && (
        <div className="flex flex-col gap-4 flex-1 min-h-0">
          {/* 搜索 + 过滤 */}
          <div className={`flex gap-3 ${isMobile ? 'flex-col' : 'items-center'}`}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索模板名称、描述、标签..."
              className="field-input flex-1"
              style={{ maxWidth: isMobile ? '100%' : '320px', marginBottom: 0 }}
            />
            <div className="flex gap-1.5 flex-wrap">
              <FilterChip label="全部" active={categoryFilter === 'all'} onClick={() => setCategoryFilter('all')} />
              {Object.entries(CATEGORY_MAP).map(([k, v]) => (
                <FilterChip
                  key={k}
                  label={`${v.icon} ${v.label}`}
                  active={categoryFilter === k}
                  onClick={() => setCategoryFilter(k)}
                />
              ))}
            </div>
          </div>

          {/* 模板网格 */}
          <div className="flex-1 overflow-y-auto">
            <div className={`grid gap-4 pb-4 ${isMobile ? 'grid-cols-1' : 'grid-cols-2 xl:grid-cols-3'}`}>
              {filteredTemplates.map((tpl, i) => {
                const created = isTemplateCreated(tpl);
                return (
                  <TemplateCard
                    key={i}
                    template={tpl}
                    created={created}
                    onUse={() => handleCreateFromTemplate(tpl)}
                    delay={i * 60}
                  />
                );
              })}
            </div>
            {filteredTemplates.length === 0 && (
              <div className="text-center py-16">
                <div className="text-3xl mb-3">🔍</div>
                <div className="text-sm text-white/50">没有找到匹配的模板</div>
                <div className="text-xs text-white/30 mt-1">试试其他关键词或分类</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ━━━ Tab: 系统指令 ━━━ */}
      {activeTab === 'system' && <SystemPromptsPanel />}

      {/* ━━━ 魔法棒对话框 ━━━ */}
      <Dialog
        open={optOpen}
        onOpenChange={(o) => { if (!o) cancelOptimize(); setOptOpen(o); }}
        title="提示词优化（魔法棒）"
        description="大模型会在不改变意图的前提下，让提示词更清晰、更可执行。先预览再替换。"
        maxWidth={1040}
        content={
          <div className="min-h-0 flex flex-col gap-4">
            {optError && (
              <div className="rounded-[14px] px-4 py-3 text-sm"
                style={{ border: '1px solid var(--border-default)', background: 'var(--nested-block-bg)', color: 'rgba(255,120,120,0.95)' }}>
                {optError}
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                技能：{title || '—'}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => void startOptimize()} disabled={optBusy}
                  className="text-xs px-3 py-1.5 rounded-lg transition disabled:opacity-40 inline-flex items-center gap-1.5"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)', color: 'var(--text-secondary)' }}>
                  <Sparkles size={14} /> 重新优化
                </button>
                <button onClick={cancelOptimize} disabled={!optBusy}
                  className="text-xs px-3 py-1.5 rounded-lg transition disabled:opacity-40 inline-flex items-center gap-1.5 bg-red-500/20 text-red-300">
                  <Square size={14} /> 停止
                </button>
                <button onClick={applyOptimized} disabled={optBusy || !optText.trim()}
                  className="text-xs px-3 py-1.5 rounded-lg transition disabled:opacity-40 inline-flex items-center gap-1.5"
                  style={{ background: 'var(--gold-gradient)', color: '#fff', boxShadow: '0 2px 8px -1px rgba(99, 102, 241, 0.35)' }}>
                  <Save size={14} /> 替换到编辑器
                </button>
                <button onClick={async () => {
                    const t = optText.trim();
                    if (!t) return;
                    try { await navigator.clipboard.writeText(t); setMsg({ type: 'ok', text: '已复制优化结果' }); } catch { /* ignore */ }
                  }} disabled={optBusy || !optText.trim()}
                  className="text-xs px-3 py-1.5 rounded-lg transition disabled:opacity-40 inline-flex items-center gap-1.5"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)', color: 'var(--text-secondary)' }}>
                  <Copy size={14} /> 复制
                </button>
              </div>
            </div>
            <div className="grid gap-4 min-h-0" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <GlassCard animated className="p-4 min-h-0 flex flex-col">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>原文</div>
                <textarea value={optOriginal} readOnly
                  className="mt-3 flex-1 min-h-[360px] w-full rounded-[14px] px-3 py-3 text-sm outline-none resize-none"
                  style={{ border: '1px solid var(--border-subtle)', background: 'var(--nested-block-bg)', color: 'var(--text-primary)', lineHeight: 1.6,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }} />
              </GlassCard>
              <GlassCard animated className="p-4 min-h-0 flex flex-col">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>优化结果（流式）</div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>字符：{optText.length.toLocaleString()}</div>
                </div>
                <textarea value={optText} readOnly
                  className="mt-3 flex-1 min-h-[360px] w-full rounded-[14px] px-3 py-3 text-sm outline-none resize-none"
                  style={{ border: '1px solid var(--border-subtle)', background: 'var(--nested-block-bg)', color: 'var(--text-primary)', lineHeight: 1.6,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace' }} />
              </GlassCard>
            </div>
          </div>
        }
      />

      <style>{`
        .field-input {
          width: 100%;
          padding: 6px 10px;
          border-radius: 8px;
          border: 1px solid var(--border-default);
          background: var(--bg-card, rgba(255, 255, 255, 0.03));
          color: rgba(255,255,255,0.9);
          font-size: 13px;
          outline: none;
          transition: border-color 0.15s;
        }
        .field-input:focus {
          border-color: rgba(255,255,255,0.3);
        }
        .field-input:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        select.field-input {
          cursor: pointer;
        }
        select.field-input option {
          background: var(--bg-card, rgba(255, 255, 255, 0.03));
          color: #fff;
        }
        textarea.field-input {
          resize: vertical;
        }
      `}</style>
    </div>
  );
}

// ━━━ 子组件 ━━━━━━━━

function StatCard({ label, value, icon, color }: { label: string; value: number; icon: string; color: string }) {
  return (
    <GlassCard animated padding="sm" className="flex items-center gap-3">
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center text-base shrink-0"
        style={{ background: `${color}15`, border: `1px solid ${color}30` }}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-lg font-bold" style={{ color }}>{value}</div>
        <div className="text-[10px] text-white/40 truncate">{label}</div>
      </div>
    </GlassCard>
  );
}

function TemplateCard({
  template,
  created,
  onUse,
  delay,
}: {
  template: SkillTemplate;
  created: boolean;
  onUse: () => void;
  delay: number;
}) {
  const catInfo = CATEGORY_MAP[template.category] || CATEGORY_MAP.general;

  return (
    <GlassCard animated animationDelay={delay} interactive padding="none" className="flex flex-col">
      {/* 头部 */}
      <div className="p-4 pb-3">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2.5">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0"
              style={{
                background: template.color.bg,
                border: `1px solid ${template.color.border}`,
              }}
            >
              {template.icon}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white/90 truncate">{template.title}</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <Badge variant="subtle" size="sm">{catInfo.icon} {catInfo.label}</Badge>
                {template.roles.length > 0 && (
                  <Badge variant="featured" size="sm">{template.roles.join('/')}</Badge>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="text-xs text-white/45 leading-relaxed line-clamp-2">
          {template.description}
        </div>
      </div>

      {/* 标签区 */}
      <div className="px-4 pb-3 flex flex-wrap gap-1.5">
        {template.tags.map(tag => (
          <span
            key={tag}
            className="text-[10px] px-2 py-0.5 rounded-full"
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: 'rgba(255,255,255,0.45)',
            }}
          >
            {tag}
          </span>
        ))}
        {template.acceptsUserInput && (
          <span
            className="text-[10px] px-2 py-0.5 rounded-full"
            style={{
              background: 'rgba(59, 130, 246, 0.1)',
              border: '1px solid rgba(59, 130, 246, 0.2)',
              color: 'rgba(59, 130, 246, 0.8)',
            }}
          >
            支持输入
          </span>
        )}
      </div>

      {/* 预览提示词（摘要） */}
      <div className="px-4 pb-3 flex-1">
        <div
          className="text-[11px] leading-relaxed rounded-lg p-2.5 font-mono line-clamp-3"
          style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.06)',
            color: 'rgba(255,255,255,0.35)',
          }}
        >
          {template.promptTemplate.slice(0, 120)}...
        </div>
      </div>

      {/* 底部操作 */}
      <div className="px-4 pb-4 pt-1 border-t border-white/5">
        <button
          onClick={created ? undefined : onUse}
          disabled={created}
          className="w-full text-xs py-2 rounded-lg font-medium transition"
          style={
            created
              ? {
                  background: 'rgba(255,255,255,0.04)',
                  color: 'rgba(255,255,255,0.25)',
                  cursor: 'default',
                }
              : {
                  background: template.color.bg,
                  border: `1px solid ${template.color.border}`,
                  color: template.color.text,
                }
          }
        >
          {created ? '✓ 已创建' : '使用此模板'}
        </button>
      </div>
    </GlassCard>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-xs px-3 py-1.5 rounded-lg transition"
      style={
        active
          ? {
              background: 'var(--gold-gradient)',
              color: '#fff',
              boxShadow: '0 2px 8px -1px rgba(99, 102, 241, 0.35)',
            }
          : {
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'rgba(255,255,255,0.5)',
            }
      }
    >
      {label}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-2 border-b border-white/5 pb-1">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={className}>
      <label className="text-xs text-white/50 mb-1 block">{label}</label>
      {children}
    </div>
  );
}

function SkillListItem({ skill, active, onClick, dragOver, onDragStart, onDragOver, onDragLeave, onDrop }: {
  skill: AdminSkill; active: boolean; onClick: () => void;
  dragOver?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent) => void;
}) {
  const catInfo = CATEGORY_MAP[skill.category] || CATEGORY_MAP.general;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg text-xs transition cursor-pointer ${
        active
          ? 'bg-white/10 border border-white/20'
          : dragOver
            ? 'bg-white/8 border border-amber-400/40'
            : 'hover:bg-white/5 border border-transparent'
      }`}
      style={{ cursor: 'grab' }}
    >
      <div className="flex items-center gap-2.5">
        <span className="text-base">{skill.icon || '⚡'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-medium truncate">{skill.title}</span>
            {!skill.isEnabled && (
              <span className="w-1.5 h-1.5 rounded-full bg-red-400/60 shrink-0" />
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[10px] text-white/25">{catInfo.icon} {catInfo.label}</span>
            {skill.roles.length > 0 && (
              <span className="text-[10px] text-white/25">· {skill.roles.join('/')}</span>
            )}
            {skill.usageCount > 0 && (
              <span className="text-[10px] text-white/20">· {skill.usageCount} 次</span>
            )}
          </div>
        </div>
        <span className="text-[10px] text-white/15 shrink-0">#{skill.order}</span>
      </div>
    </div>
  );
}
