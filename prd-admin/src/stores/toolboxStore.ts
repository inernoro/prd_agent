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

export type ToolboxView = 'grid' | 'detail' | 'create' | 'edit' | 'running';
export type ToolboxCategory = 'all' | 'builtin' | 'custom' | 'favorite';

interface ToolboxState {
  // View state
  view: ToolboxView;
  category: ToolboxCategory;
  searchQuery: string;

  // Items
  items: ToolboxItem[];
  itemsLoading: boolean;
  selectedItem: ToolboxItem | null;

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
  setCategory: (category: ToolboxCategory) => void;
  setSearchQuery: (query: string) => void;
  startCreate: () => void;
  startEdit: (item: ToolboxItem) => void;
  saveItem: (item: Partial<ToolboxItem>) => Promise<boolean>;
  deleteItem: (id: string) => Promise<boolean>;
  runItem: (itemId: string, input: string) => Promise<void>;
  backToGrid: () => void;
  reset: () => void;

  // Internal
  _handleRunEvent: (event: ToolboxRunEvent & { eventType: string }) => void;
  _stopSubscription: () => void;
}

// 内置工具定义
const BUILTIN_TOOLS: ToolboxItem[] = [
  {
    id: 'builtin-prd-agent',
    name: 'PRD 分析师',
    description: '智能解读PRD文档，识别需求缺口，回答产品问题',
    icon: '📋',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'prd-agent',
    tags: ['PRD', '需求分析', '产品'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-visual-agent',
    name: '视觉设计师',
    description: '高级视觉创作，支持文生图、图生图、多图组合',
    icon: '🎨',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'visual-agent',
    tags: ['图片生成', '设计', 'AI绘画'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-literary-agent',
    name: '文学创作者',
    description: '文学创作与配图，支持写作、润色、生成插图',
    icon: '✍️',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'literary-agent',
    tags: ['写作', '文案', '创作'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-defect-agent',
    name: '缺陷管理员',
    description: '缺陷提交与跟踪，支持信息提取、分类、生成报告',
    icon: '🐛',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'defect-agent',
    tags: ['Bug', '缺陷', '测试'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-code-reviewer',
    name: '代码审查员',
    description: '代码质量审查，发现潜在问题，提供改进建议',
    icon: '🔍',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'code-reviewer',
    tags: ['代码', '审查', '质量'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-translator',
    name: '多语言翻译',
    description: '专业级多语言翻译，支持中英日韩等主流语言',
    icon: '🌐',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'translator',
    tags: ['翻译', '多语言', '国际化'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-summarizer',
    name: '内容摘要师',
    description: '长文本智能摘要，快速提取关键信息和要点',
    icon: '📝',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'summarizer',
    tags: ['摘要', '总结', '阅读'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-data-analyst',
    name: '数据分析师',
    description: '数据分析与可视化建议，帮助理解数据洞察',
    icon: '📊',
    category: 'builtin',
    type: 'builtin',
    agentKey: 'data-analyst',
    tags: ['数据', '分析', '图表'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
];

export const useToolboxStore = create<ToolboxState>((set, get) => ({
  // Initial state
  view: 'grid',
  category: 'all',
  searchQuery: '',

  items: [],
  itemsLoading: false,
  selectedItem: null,

  builtinAgents: [],

  currentRun: null,
  runStatus: 'idle',
  runOutput: '',
  runError: null,
  unsubscribe: null,

  editingItem: null,

  // Load all items (builtin + custom)
  loadItems: async () => {
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

  // Set category filter
  setCategory: (category: ToolboxCategory) => {
    set({ category });
  },

  // Set search query
  setSearchQuery: (query: string) => {
    set({ searchQuery: query });
  },

  // Start creating a new item
  startCreate: () => {
    set({
      view: 'create',
      editingItem: {
        name: '',
        description: '',
        icon: '🤖',
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
