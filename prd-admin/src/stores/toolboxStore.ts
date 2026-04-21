import { create } from 'zustand';
import {
  listToolboxAgents,
  listToolboxItems,
  createToolboxItem,
  updateToolboxItem,
  deleteToolboxItem,
  runToolboxItem,
  subscribeToolboxRunEvents,
  listMarketplaceItems,
  forkToolboxItem,
  toggleToolboxItemPublish,
} from '@/services';
import type {
  ToolboxItem,
  ToolboxItemRun,
  ToolboxRunEvent,
  AgentInfo,
} from '@/services';
import { toast } from '@/lib/toast';

export type ToolboxView = 'grid' | 'detail' | 'create' | 'edit' | 'running' | 'quick-create';
export type ToolboxCategory = 'all' | 'builtin' | 'custom' | 'favorite' | 'marketplace';
export type ToolboxPageTab = 'toolbox' | 'capabilities';

const FAVORITES_STORAGE_KEY = 'toolbox-favorites';
/** 新创建但未公开的智能体 ID 集合 — 用来给「🌍 公开发布」按钮加脉动高亮，解决用户"发布入口找不到"的问题 */
const NEW_UNPUBLISHED_STORAGE_KEY = 'toolbox-new-unpublished';

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

function loadNewUnpublishedFromStorage(): Set<string> {
  try {
    const raw = sessionStorage.getItem(NEW_UNPUBLISHED_STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

function saveNewUnpublishedToStorage(ids: Set<string>) {
  try {
    sessionStorage.setItem(NEW_UNPUBLISHED_STORAGE_KEY, JSON.stringify([...ids]));
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

  // Marketplace（公开工具市场）
  marketplaceItems: ToolboxItem[];
  marketplaceLoading: boolean;

  // Favorites
  favoriteIds: Set<string>;

  /** 新创建但未公开的 id — UI 用它给「公开发布」按钮加脉动提示 */
  newUnpublishedIds: Set<string>;

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
  loadMarketplaceItems: (keyword?: string) => Promise<void>;
  forkItem: (id: string) => Promise<ToolboxItem | null>;
  togglePublish: (id: string, isPublic: boolean) => Promise<boolean>;
  selectItem: (item: ToolboxItem) => void;
  setView: (view: ToolboxView) => void;
  setPageTab: (tab: ToolboxPageTab) => void;
  setCategory: (category: ToolboxCategory) => void;
  setSearchQuery: (query: string) => void;
  toggleFavorite: (itemId: string) => void;
  isFavorite: (itemId: string) => boolean;
  /** 手动清除某个工具的"新创建"高亮（用户点开详情页或点击公开按钮后调用） */
  dismissNewUnpublished: (itemId: string) => void;
  isNewUnpublished: (itemId: string) => boolean;
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
// 导出供设置页等外部模块直接引用（无需等待 loadItems）
//
// kind 分类标准（严格）：
//   - 'agent' = AI + 完备生命周期 + 存储（三者缺一不可）
//   - 'tool'  = 能力型工具，缺少 agent 三要素中的任何一项
//   - 'infra' = 平台级基础设施（工作流引擎、更新中心、市场、模型、团队等），不进百宝箱
export const BUILTIN_TOOLS: ToolboxItem[] = [
  // ========== 智能体（定制版，有专门页面 + 完备生命周期 + 存储）==========
  {
    id: 'builtin-prd-agent',
    name: 'PRD 解读智能体',
    description: '智能解读PRD文档，识别需求缺口，回答产品问题',
    icon: 'FileText',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'prd-agent',
    routePath: '/prd-agent',
    tags: ['PRD', '需求分析', '产品'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-visual-agent',
    name: '视觉创作智能体',
    description: '高级视觉创作，支持文生图、图生图、多图组合',
    icon: 'Palette',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'visual-agent',
    routePath: '/visual-agent',
    tags: ['图片生成', '设计', 'AI绘画'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-literary-agent',
    name: '文学创作智能体',
    description: '文学创作与配图，支持写作、润色、生成插图',
    icon: 'PenTool',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'literary-agent',
    routePath: '/literary-agent',
    tags: ['写作', '文案', '创作'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-defect-agent',
    name: '缺陷管理智能体',
    description: '缺陷提交与跟踪，支持信息提取、分类、生成报告',
    icon: 'Bug',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'defect-agent',
    routePath: '/defect-agent',
    tags: ['Bug', '缺陷', '测试'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-video-agent',
    name: '视频创作智能体',
    description: '文章转视频教程，AI驱动分镜脚本与预览图生成',
    icon: 'Video',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'video-agent',
    routePath: '/video-agent',
    tags: ['视频', '教程', '分镜'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-report-agent',
    name: '周报智能体',
    description: '周报创建、提交、审阅，支持AI生成、团队汇总、计划比对',
    icon: 'FileBarChart',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'report-agent',
    routePath: '/report-agent',
    tags: ['周报', '日报', '团队管理'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-arena',
    name: 'AI 竞技场智能体',
    description: '多模型盲测对战，匿名PK后揭晓真实身份',
    icon: 'Swords',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'arena',
    routePath: '/arena',
    tags: ['竞技场', '模型对比', '盲测'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-review-agent',
    name: '产品评审智能体',
    description: '上传产品方案(.md)，AI 多维度评审打分，正式评审前发现问题',
    icon: 'ClipboardCheck',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'review-agent',
    routePath: '/review-agent',
    tags: ['评审', '产品', 'PRD'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-pr-review',
    name: 'PR 审查智能体',
    description: '用你自己的 GitHub 账号审查任意有权访问的 PR',
    icon: 'GitPullRequest',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'pr-review',
    routePath: '/pr-review',
    tags: ['PR', 'GitHub', '审查', 'OAuth'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  // ========== 周报海报编辑器 · wip（满足规则 #9 完成标准前保持施工中徽章） ==========
  {
    id: 'builtin-weekly-poster-editor',
    name: '周报海报编辑器',
    description: '把本周更新做成主页弹窗轮播海报,末页 CTA 跳转完整周报',
    icon: 'Sparkles',
    category: 'builtin',
    type: 'builtin',
    kind: 'tool',
    agentKey: 'report-agent',
    routePath: '/weekly-poster',
    tags: ['周报', '海报', '主页', '轮播', 'wip'],
    wip: true,
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  // ========== 工具（缺 AI / 生命周期 / 存储 三要素之一）==========
  {
    id: 'builtin-shortcuts-agent',
    name: '快捷指令',
    description: '一键执行常用操作，支持自定义和分享指令',
    icon: 'Zap',
    category: 'builtin',
    type: 'builtin',
    kind: 'tool',
    agentKey: 'shortcuts-agent',
    routePath: '/shortcuts-agent',
    tags: ['快捷', '效率', '指令'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-transcript-agent',
    name: '转录工作台',
    description: '音视频智能转录，支持多模型ASR转写、时间戳编辑、模板转文案',
    icon: 'AudioLines',
    category: 'builtin',
    type: 'builtin',
    kind: 'tool',
    agentKey: 'transcript-agent',
    routePath: '/transcript-agent',
    tags: ['转录', '语音', 'ASR', '字幕'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  // ========== 普通版工具（统一对话界面，无独立存储与生命周期）==========
  {
    id: 'builtin-code-reviewer',
    name: '代码审查员',
    description: '代码质量审查，发现潜在问题，提供改进建议',
    icon: 'Code2',
    category: 'builtin',
    type: 'builtin',
    kind: 'tool',
    agentKey: 'code-reviewer',
    systemPrompt: '你是一位资深的代码审查专家。你的职责是：\n1. 分析代码的质量、可读性和可维护性\n2. 发现潜在的 Bug、安全漏洞和性能问题\n3. 提供具体的改进建议和最佳实践\n4. 评估代码的架构设计合理性\n请用结构化的方式输出审查结果，包括：问题严重程度（Critical/Warning/Info）、问题描述、建议修改方案。',
    tags: ['代码', '审查', '质量'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    createdByName: '官方',
  },
  {
    id: 'builtin-translator',
    name: '多语言翻译',
    description: '专业级多语言翻译，支持中英日韩等主流语言',
    icon: 'Languages',
    category: 'builtin',
    type: 'builtin',
    kind: 'tool',
    agentKey: 'translator',
    systemPrompt: '你是一位专业的多语言翻译专家，精通中文、英文、日文、韩文等主要语言。你的翻译原则：\n1. 准确传达原文含义，不添加或遗漏信息\n2. 符合目标语言的表达习惯和文化背景\n3. 专业术语保持一致性\n4. 对于歧义之处，提供多种可能的翻译\n请自动检测源语言，默认翻译为中文（如果源语言是中文则翻译为英文）。',
    tags: ['翻译', '多语言', '国际化'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    createdByName: '官方',
  },
  {
    id: 'builtin-summarizer',
    name: '内容摘要师',
    description: '长文本智能摘要，快速提取关键信息和要点',
    icon: 'FileSearch',
    category: 'builtin',
    type: 'builtin',
    kind: 'tool',
    agentKey: 'summarizer',
    systemPrompt: '你是一位内容摘要专家，擅长从长文本中提取关键信息。你的工作方式：\n1. 识别文本的核心主题和关键论点\n2. 提取重要数据、事实和结论\n3. 保持摘要的逻辑连贯性\n4. 根据内容长度生成适当比例的摘要\n请按以下格式输出：\n**核心要点**：（3-5 个要点）\n**详细摘要**：（结构化总结）\n**关键数据**：（如有数字或数据）',
    tags: ['摘要', '总结', '阅读'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    createdByName: '官方',
  },
  {
    id: 'builtin-data-analyst',
    name: '数据分析师',
    description: '数据分析与可视化建议，帮助理解数据洞察',
    icon: 'BarChart3',
    category: 'builtin',
    type: 'builtin',
    kind: 'tool',
    agentKey: 'data-analyst',
    systemPrompt: '你是一位数据分析专家，擅长数据解读和可视化建议。你的能力包括：\n1. 分析数据趋势、异常和模式\n2. 提供统计分析思路和方法建议\n3. 推荐合适的数据可视化图表类型\n4. 给出数据驱动的业务洞察\n请用结构化方式回答，包含：分析思路、关键发现、可视化建议、行动建议。',
    tags: ['数据', '分析', '图表'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    createdByName: '官方',
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

  marketplaceItems: [],
  marketplaceLoading: false,

  favoriteIds: loadFavoritesFromStorage(),
  newUnpublishedIds: loadNewUnpublishedFromStorage(),

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
      const raw = res.success && res.data ? res.data.items : [];
      // 后端 ToolboxItem 模型没有 type/category 字段，前端需要归一化
      // 否则会被误判为"系统内置"，导致作者头像、编辑按钮等 custom-only UI 失效
      const customItems = raw.map((it) => ({
        ...it,
        type: 'custom' as const,
        category: 'custom' as const,
      }));
      set({ items: [...BUILTIN_TOOLS, ...customItems] });
    } catch {
      // 即使API失败，也显示内置工具
      set({ items: BUILTIN_TOOLS });
    } finally {
      set({ itemsLoading: false });
    }
  },

  // Load marketplace (publicly shared) items
  loadMarketplaceItems: async (keyword?: string) => {
    if (get().marketplaceLoading) return;
    set({ marketplaceLoading: true });
    try {
      const res = await listMarketplaceItems({ keyword, page: 1, pageSize: 50 });
      const items = res.success && res.data ? res.data.items : [];
      // 后端返回的字段是裸 ToolboxItem，需要补全 type/category 让 ToolCard 渲染
      const normalized = items.map((it) => ({
        ...it,
        type: 'custom' as const,
        category: 'custom' as const,
      }));
      set({ marketplaceItems: normalized });
    } catch {
      set({ marketplaceItems: [] });
    } finally {
      set({ marketplaceLoading: false });
    }
  },

  // Fork a public item into my own list
  forkItem: async (id: string) => {
    try {
      const res = await forkToolboxItem(id);
      if (!res.success || !res.data) return null;
      // Refresh my own list so the new copy appears under "我创建的"
      await get().loadItems();
      return res.data;
    } catch {
      return null;
    }
  },

  // Toggle publish state of one of my items
  togglePublish: async (id: string, isPublic: boolean) => {
    try {
      const res = await toggleToolboxItemPublish(id, isPublic);
      if (!res.success) return false;
      // Patch in-place so UI reflects without full reload
      const nextNew = new Set(get().newUnpublishedIds);
      if (nextNew.delete(id)) saveNewUnpublishedToStorage(nextNew);
      set((state) => ({
        items: state.items.map((it) => (it.id === id ? { ...it, isPublic } : it)),
        selectedItem:
          state.selectedItem && state.selectedItem.id === id
            ? { ...state.selectedItem, isPublic }
            : state.selectedItem,
        newUnpublishedIds: nextNew,
      }));
      return true;
    } catch {
      return false;
    }
  },

  dismissNewUnpublished: (itemId: string) => {
    const next = new Set(get().newUnpublishedIds);
    if (next.delete(itemId)) {
      saveNewUnpublishedToStorage(next);
      set({ newUnpublishedIds: next });
    }
  },

  isNewUnpublished: (itemId: string) => get().newUnpublishedIds.has(itemId),

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
        toast.success('已保存修改');
      } else {
        const res = await createToolboxItem(item);
        if (!res.success || !res.data) return false;
        // 创建成功后明确告知用户"别人还看不到"，并在卡片上打脉动标记引导发布
        const newId = res.data.id;
        const nextSet = new Set(get().newUnpublishedIds);
        nextSet.add(newId);
        saveNewUnpublishedToStorage(nextSet);
        set({ newUnpublishedIds: nextSet });
        toast.success(
          '创建成功！默认仅你自己可见',
          '要让同事也能使用，请在卡片右上角点 🌍「公开发布」（按钮正在闪烁）',
          8000,
        );
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
      // 如果刚创建又删了，也要清理脉动标记
      const nextNew = new Set(get().newUnpublishedIds);
      if (nextNew.delete(id)) {
        saveNewUnpublishedToStorage(nextNew);
        set({ newUnpublishedIds: nextNew });
      }
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
