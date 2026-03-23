import { create } from 'zustand';
import {
  listToolboxAgents,
  listToolboxItems,
  createToolboxItem,
  updateToolboxItem,
  deleteToolboxItem,
  runToolboxItem,
  subscribeToolboxRunEvents,
} from '@/services';
import type {
  ToolboxItem,
  ToolboxItemRun,
  ToolboxRunEvent,
  AgentInfo,
} from '@/services';

export type ToolboxView = 'grid' | 'detail' | 'create' | 'edit' | 'running' | 'quick-create';
export type ToolboxCategory = 'all' | 'builtin' | 'custom' | 'favorite';
export type ToolboxPageTab = 'toolbox' | 'capabilities';

const FAVORITES_STORAGE_KEY = 'toolbox-favorites';

function loadFavoritesFromStorage(): Set<string> {
  try {
    const raw = sessionStorage.getItem(FAVORITES_STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

function saveFavoritesToStorage(ids: Set<string>) {
  try {
    sessionStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...ids]));
  } catch { /* ignore */ }
}

interface ToolboxState {
  // View state
  view: ToolboxView;
  pageTab: ToolboxPageTab;
  category: ToolboxCategory;
  searchQuery: string;

  // Items
  items: ToolboxItem[];
  itemsLoading: boolean;
  selectedItem: ToolboxItem | null;

  // Favorites
  favoriteIds: Set<string>;

  // Built-in agents
  builtinAgents: AgentInfo[];

  // Running state
  currentRun: ToolboxItemRun | null;
  runStatus: 'idle' | 'running' | 'completed' | 'failed';
  runOutput: string;
  runError: string | null;
  unsubscribe: (() => void) | null;

  // Create/Edit form
  editingItem: Partial<ToolboxItem> | null;

  // Actions
  loadItems: () => Promise<void>;
  loadBuiltinAgents: () => Promise<void>;
  selectItem: (item: ToolboxItem) => void;
  setView: (view: ToolboxView) => void;
  setPageTab: (tab: ToolboxPageTab) => void;
  setCategory: (category: ToolboxCategory) => void;
  setSearchQuery: (query: string) => void;
  toggleFavorite: (itemId: string) => void;
  isFavorite: (itemId: string) => boolean;
  startCreate: () => void;
  startEdit: (item: ToolboxItem) => void;
  setEditingItem: (item: Partial<ToolboxItem>) => void;
  saveItem: (item: Partial<ToolboxItem>) => Promise<boolean>;
  deleteItem: (id: string) => Promise<boolean>;
  runItem: (itemId: string, input: string) => Promise<void>;
  backToGrid: () => void;
  reset: () => void;

  // Internal
  _handleRunEvent: (event: ToolboxRunEvent & { eventType: string }) => void;
  _stopSubscription: () => void;
}

// 内置工具定义 - icon 使用 Lucide 图标名称
// routePath 存在则为"定制版"（跳转专门页面），否则为"普通版"（走统一对话）
const BUILTIN_TOOLS: ToolboxItem[] = [
  // ========== 定制版 Agent（有专门页面）==========
  {
    id: 'builtin-prd-agent',
    name: 'PRD 分析师',
    description: '智能解读PRD文档，识别需求缺口，回答产品问题',
    icon: 'FileText',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'prd-agent',
    routePath: '/prd-agent',
    tags: ['PRD', '需求分析', '产品'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-visual-agent',
    name: '视觉设计师',
    description: '高级视觉创作，支持文生图、图生图、多图组合',
    icon: 'Palette',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'visual-agent',
    routePath: '/visual-agent',
    tags: ['图片生成', '设计', 'AI绘画'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-literary-agent',
    name: '文学创作者',
    description: '文学创作与配图，支持写作、润色、生成插图',
    icon: 'PenTool',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'literary-agent',
    routePath: '/literary-agent',
    tags: ['写作', '文案', '创作'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-defect-agent',
    name: '缺陷管理员',
    description: '缺陷提交与跟踪，支持信息提取、分类、生成报告',
    icon: 'Bug',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'defect-agent',
    routePath: '/defect-agent',
    tags: ['Bug', '缺陷', '测试'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-video-agent',
    name: '视频创作者',
    description: '文章转视频教程，AI驱动分镜脚本与预览图生成',
    icon: 'Video',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'video-agent',
    routePath: '/video-agent',
    tags: ['视频', '教程', '分镜'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-report-agent',
    name: '周报管理员',
    description: '周报创建、提交、审阅，支持AI生成、团队汇总、计划比对',
    icon: 'FileBarChart',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'report-agent',
    routePath: '/report-agent',
    tags: ['周报', '日报', '团队管理'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-arena',
    name: 'AI 竞技场',
    description: '多模型盲测对战，匿名PK后揭晓真实身份',
    icon: 'Swords',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'arena',
    routePath: '/arena',
    tags: ['竞技场', '模型对比', '盲测'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  // ========== 定制版 Agent（有专门页面，非对话型）==========
  {
    id: 'builtin-workflow-agent',
    name: '工作流引擎',
    description: '可视化工作流编排，自动化多步骤任务串联',
    icon: 'Workflow',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'workflow-agent',
    routePath: '/workflow-agent',
    tags: ['工作流', '自动化', '编排'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-shortcuts-agent',
    name: '快捷指令',
    description: '一键执行常用操作，支持自定义和分享指令',
    icon: 'Zap',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'shortcuts-agent',
    routePath: '/shortcuts-agent',
    tags: ['快捷', '效率', '指令'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  // ========== 普通版 Agent（统一对话界面）==========
  {
    id: 'builtin-code-reviewer',
    name: '代码审查员',
    description: '代码质量审查，发现潜在问题，提供改进建议',
    icon: 'Code2',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'code-reviewer',
    systemPrompt: '你是一位资深的代码审查专家。你的职责是：\n1. 分析代码的质量、可读性和可维护性\n2. 发现潜在的 Bug、安全漏洞和性能问题\n3. 提供具体的改进建议和最佳实践\n4. 评估代码的架构设计合理性\n请用结构化的方式输出审查结果，包括：问题严重程度（Critical/Warning/Info）、问题描述、建议修改方案。',
    tags: ['代码', '审查', '质量'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-translator',
    name: '多语言翻译',
    description: '专业级多语言翻译，支持中英日韩等主流语言',
    icon: 'Languages',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'translator',
    systemPrompt: '你是一位专业的多语言翻译专家，精通中文、英文、日文、韩文等主要语言。你的翻译原则：\n1. 准确传达原文含义，不添加或遗漏信息\n2. 符合目标语言的表达习惯和文化背景\n3. 专业术语保持一致性\n4. 对于歧义之处，提供多种可能的翻译\n请自动检测源语言，默认翻译为中文（如果源语言是中文则翻译为英文）。',
    tags: ['翻译', '多语言', '国际化'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-summarizer',
    name: '内容摘要师',
    description: '长文本智能摘要，快速提取关键信息和要点',
    icon: 'FileSearch',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'summarizer',
    systemPrompt: '你是一位内容摘要专家，擅长从长文本中提取关键信息。你的工作方式：\n1. 识别文本的核心主题和关键论点\n2. 提取重要数据、事实和结论\n3. 保持摘要的逻辑连贯性\n4. 根据内容长度生成适当比例的摘要\n请按以下格式输出：\n**核心要点**：（3-5 个要点）\n**详细摘要**：（结构化总结）\n**关键数据**：（如有数字或数据）',
    tags: ['摘要', '总结', '阅读'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-data-analyst',
    name: '数据分析师',
    description: '数据分析与可视化建议，帮助理解数据洞察',
    icon: 'BarChart3',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'data-analyst',
    systemPrompt: '你是一位数据分析专家，擅长数据解读和可视化建议。你的能力包括：\n1. 分析数据趋势、异常和模式\n2. 提供统计分析思路和方法建议\n3. 推荐合适的数据可视化图表类型\n4. 给出数据驱动的业务洞察\n请用结构化方式回答，包含：分析思路、关键发现、可视化建议、行动建议。',
    tags: ['数据', '分析', '图表'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
];

export const useToolboxStore = create<ToolboxState>((set, get) => ({
  // Initial state
  view: 'grid',
  pageTab: 'toolbox',
  category: 'all',
  searchQuery: '',

  items: [],
  itemsLoading: false,
  selectedItem: null,

  favoriteIds: loadFavoritesFromStorage(),

  builtinAgents: [],

  currentRun: null,
  runStatus: 'idle',
  runOutput: '',
  runError: null,
  unsubscribe: null,

  editingItem: null,

  // Load all items (builtin + custom)
  loadItems: async () => {
    if (get().itemsLoading) return; // 防止并发重复加载
    set({ itemsLoading: true });
    try {
      const res = await listToolboxItems();
      const customItems = res.success && res.data ? res.data.items : [];
      // 合并内置工具和自定义工具
      set({ items: [...BUILTIN_TOOLS, ...customItems] });
    } catch {
      // 即使API失败，也显示内置工具
      set({ items: BUILTIN_TOOLS });
    } finally {
      set({ itemsLoading: false });
    }
  },

  // Load builtin agents info
  loadBuiltinAgents: async () => {
    try {
      const res = await listToolboxAgents();
      if (res.success && res.data) {
        set({ builtinAgents: res.data.agents });
      }
    } catch {
      // Silent fail
    }
  },

  // Select an item to view/use
  selectItem: (item: ToolboxItem) => {
    set({
      selectedItem: item,
      view: 'detail',
      runStatus: 'idle',
      runOutput: '',
      runError: null,
    });
  },

  // Set view
  setView: (view: ToolboxView) => {
    set({ view });
  },

  // Set page tab
  setPageTab: (pageTab: ToolboxPageTab) => {
    set({ pageTab });
  },

  // Set category filter
  setCategory: (category: ToolboxCategory) => {
    set({ category });
  },

  // Set search query
  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
  },

  // Toggle favorite
  toggleFavorite: (itemId: string) => {
    const next = new Set(get().favoriteIds);
    if (next.has(itemId)) {
      next.delete(itemId);
    } else {
      next.add(itemId);
    }
    saveFavoritesToStorage(next);
    set({ favoriteIds: next });
  },

  // Check if item is favorited
  isFavorite: (itemId: string) => {
    return get().favoriteIds.has(itemId);
  },

  // Start creating a new item (quick wizard)
  startCreate: () => {
    set({
      view: 'quick-create',
      editingItem: {
        name: '',
        description: '',
        icon: 'Bot',
        type: 'custom',
        category: 'custom',
        tags: [],
        prompt: '',
      },
    });
  },

  // Start editing an item
  startEdit: (item: ToolboxItem) => {
    set({
      view: 'edit',
      editingItem: { ...item },
    });
  },

  // Set editing item (used by QuickCreateWizard to pass data to full editor)
  setEditingItem: (item: Partial<ToolboxItem>) => {
    set({ editingItem: item });
  },

  // Save item (create or update)
  saveItem: async (item: Partial<ToolboxItem>) => {
    try {
      if (item.id) {
        const res = await updateToolboxItem(item.id, item);
        if (!res.success) return false;
      } else {
        const res = await createToolboxItem(item);
        if (!res.success) return false;
      }
      await get().loadItems();
      set({ view: 'grid', editingItem: null });
      return true;
    } catch {
      return false;
    }
  },

  // Delete item
  deleteItem: async (id: string) => {
    try {
      const res = await deleteToolboxItem(id);
      if (!res.success) return false;
      await get().loadItems();
      set({ view: 'grid', selectedItem: null });
      return true;
    } catch {
      return false;
    }
  },

  // Run an item
  runItem: async (itemId: string, input: string) => {
    get()._stopSubscription();

    set({
      view: 'running',
      runStatus: 'running',
      runOutput: '',
      runError: null,
    });

    try {
      const res = await runToolboxItem(itemId, input);
      if (!res.success || !res.data) {
        set({
          runStatus: 'failed',
          runError: res.error?.message || '执行失败',
        });
        return;
      }

      const { runId } = res.data;
      set({ currentRun: res.data });

      // Subscribe to events
      const unsub = subscribeToolboxRunEvents(runId, {
        onEvent: get()._handleRunEvent,
        onError: (error) => {
          set({ runStatus: 'failed', runError: error.message });
        },
        onDone: () => {
          // Normal completion
        },
      });

      set({ unsubscribe: unsub });
    } catch (e) {
      set({
        runStatus: 'failed',
        runError: String(e),
      });
    }
  },

  // Back to grid view
  backToGrid: () => {
    get()._stopSubscription();
    set({
      view: 'grid',
      selectedItem: null,
      editingItem: null,
      runStatus: 'idle',
      runOutput: '',
      runError: null,
    });
  },

  // Reset state
  reset: () => {
    get()._stopSubscription();
    set({
      view: 'grid',
      selectedItem: null,
      editingItem: null,
      currentRun: null,
      runStatus: 'idle',
      runOutput: '',
      runError: null,
    });
  },

  // Handle run event
  _handleRunEvent: (event) => {
    const { eventType } = event;

    switch (eventType) {
      case 'step_progress':
        if (event.content) {
          set((state) => ({
            runOutput: state.runOutput + event.content,
          }));
        }
        break;

      case 'run_completed':
        set({
          runStatus: 'completed',
          runOutput: event.content || get().runOutput,
        });
        get()._stopSubscription();
        break;

      case 'run_failed':
        set({
          runStatus: 'failed',
          runError: event.errorMessage || '执行失败',
        });
        get()._stopSubscription();
        break;

      case 'done':
        get()._stopSubscription();
        break;
    }
  },

  // Stop subscription
  _stopSubscription: () => {
    const { unsubscribe } = get();
    if (unsubscribe) {
      unsubscribe();
      set({ unsubscribe: null });
    }
  },
}));
