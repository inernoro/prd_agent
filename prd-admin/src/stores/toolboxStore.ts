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
  ToolboxArtifact,
  AgentInfo,
} from '@/services';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/lib/toast';

export type ToolboxView = 'grid' | 'detail' | 'create' | 'edit' | 'running' | 'quick-create';
/**
 * 首页三类筛选卡片：
 * - 'all'    : 全部（BUILTIN + 我的 + 别人公开的，去重后合并）
 * - 'mine'   : 我的（BUILTIN + 我自己创建/Fork 的，含私有与已公开）
 * - 'others' : 别人的（仅别人创建并公开的；不含 BUILTIN）
 * - 'favorite': 收藏（保留独立 chip，兼容原有行为）
 */
export type ToolboxCategory = 'all' | 'mine' | 'others' | 'favorite';
export type ToolboxPageTab = 'toolbox' | 'capabilities';

/** NEW 徽章的窗口期：别人公开 ≤ 7 天内的条目会在卡片上亮红色 NEW 徽章 */
export const NEW_BADGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const FAVORITES_STORAGE_KEY = 'toolbox-favorites';
/** 新创建但未公开的智能体 ID 集合 — 用来给「公开发布」按钮加脉动高亮，解决用户"发布入口找不到"的问题 */
const NEW_UNPUBLISHED_STORAGE_KEY = 'toolbox-new-unpublished';
const RECENTLY_USED_KEY = 'toolbox-recently-used';
const MAX_RECENT = 6;

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

function loadRecentlyUsedFromStorage(): string[] {
  try {
    const raw = sessionStorage.getItem(RECENTLY_USED_KEY);
    if (raw) return JSON.parse(raw) as string[];
  } catch { /* ignore */ }
  return [];
}

function saveRecentlyUsedToStorage(ids: string[]) {
  try {
    sessionStorage.setItem(RECENTLY_USED_KEY, JSON.stringify(ids));
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
  runArtifacts: ToolboxArtifact[];
  runError: string | null;
  unsubscribe: (() => void) | null;

  // Create/Edit form
  editingItem: Partial<ToolboxItem> | null;

  /** 按工具类型过滤：all / agent / tool */
  funcKindFilter: 'all' | 'agent' | 'tool';
  /** 点击卡片 Tag 后激活的标签过滤，再次点击同一 Tag 取消 */
  activeTagFilter: string | null;
  /** 最近使用的工具 ID（最多 MAX_RECENT 条，sessionStorage 持久化） */
  recentlyUsedIds: string[];

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

  setFuncKindFilter: (kind: 'all' | 'agent' | 'tool') => void;
  setActiveTagFilter: (tag: string | null) => void;
  /** 记录用户使用了某个工具（点击即记录，不区分是否真正执行） */
  trackRecentlyUsed: (itemId: string) => void;

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
  // 注：PRD 解读智能体 Web 端已下线，统一改为下载桌面端体验，不再注册到百宝箱
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
    permission: 'visual-agent.use',
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
    permission: 'literary-agent.use',
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
    permission: 'defect-agent.use',
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
    permission: 'video-agent.use',
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
    permission: 'report-agent.use',
    tags: ['周报', '日报', '团队管理'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-task-tree',
    name: '个人任务树',
    description: '分层任务管理，对话摘取任务、卡点上报，一眼看清推进进度',
    icon: 'ListTree',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'task-tree-agent',
    routePath: '/task-tree',
    permission: 'task-tree.use',
    tags: ['任务', '任务树', '卡点', '进度', '智能体'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    wip: true,
  },
  {
    id: 'builtin-speech-agent',
    name: '演讲智能体',
    description: '把长文本/文档转成可上台讲的思维导图（首期 mindmap 模式）',
    icon: 'Mic',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'speech-agent',
    routePath: '/speech-agent',
    permission: 'speech-agent.use',
    tags: ['演讲', '导图', 'PPT', '思维导图', '智能体'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    wip: true,
  },
  {
    id: 'builtin-pm-agent',
    name: '项目管理智能体',
    description: '项目立项、任务看板、甘特图，AI 自动拆解需求为任务（对齐 PMO 方法论）',
    icon: 'FolderKanban',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'pm-agent',
    routePath: '/pm-agent',
    permission: 'pm-agent.use',
    tags: ['项目管理', 'PMO', '看板', '甘特图', '任务拆解'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    wip: true,
  },
  {
    id: 'builtin-product-agent',
    name: '产品管理智能体',
    description: '产品-版本-需求-功能-缺陷-客户全链路串联，版本化管理、分级追溯与知识图谱（参考 TAPD）',
    icon: 'Boxes',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'product-agent',
    routePath: '/product-agent',
    permission: 'product-agent.use',
    tags: ['产品管理', '版本', '需求', '功能', '缺陷追溯', '知识图谱', 'RTM'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    wip: true,
  },
  {
    id: 'builtin-pa-agent',
    name: '毒舌秘书',
    description: '把模糊想法转成 MECE 执行清单的 MBB 级私人助理',
    icon: 'PaSecretary',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'pa-agent',
    routePath: '/pa-agent',
    permission: 'pa-agent.use',
    tags: ['秘书', '任务管理', 'MBB', '执行'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    wip: true,
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
    // 注意：路由 perm 是 arena-agent.use，不是 arena.use（agentKey 与权限键不同名）
    permission: 'arena-agent.use',
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
    permission: 'review-agent.use',
    tags: ['评审', '产品', 'PRD'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-project-route-agent',
    name: '项目路由智能体',
    description: '上传方案 md，AI 识别应用 / 业务模块，对照公共站点说明定位仓库 routemap 项目路径',
    icon: 'Route',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'project-route-agent',
    routePath: '/project-route-agent',
    permission: 'project-route-agent.use',
    tags: ['路由', 'routemap', '项目定位', '仓库'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    wip: true,
  },
  {
    id: 'builtin-ccas-agent',
    name: '赋码采集关联智能体',
    description: '产线赋码业务三件套：PRD 文档生成 + 设备素材库 + 流程示意图',
    icon: 'Factory',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'ccas-agent',
    routePath: '/ccas-agent',
    permission: 'ccas-agent.use',
    tags: ['赋码', '采集', '产线', 'PRD', '流程图'],
    wip: true,
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
    permission: 'pr-review.use',
    tags: ['PR', 'GitHub', '审查', 'OAuth'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-cds-agent',
    name: 'CDS Agent',
    description: '远程运行 Claude Code / Codex 类 sandbox 任务，支持流式对话、工具审批、日志和产物回看',
    icon: 'Terminal',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'cds-agent',
    routePath: '/cds-agent',
    permission: 'access',
    tags: ['CDS', '远程开发', '代码巡检', 'Sandbox'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    wip: true,
  },
  // (海报工坊不再注册到百宝箱,改挂到资源管理 → 海报设计 tab 下 — 用户视角它是"资源产物"而非"智能体")
  // ========== 工具（缺 AI / 生命周期 / 存储 三要素之一）==========
  {
    id: 'builtin-skill-marketplace-openapi',
    name: '技能市场开放接口',
    description: '给外部 AI / Agent 生成长效 API Key（默认 1 年可续期），让它们授权式浏览、下载、上传海鲜市场的技能',
    icon: 'Zap',
    category: 'builtin',
    type: 'builtin',
    kind: 'tool',
    agentKey: 'marketplace-openapi',
    routePath: '/marketplace',
    // /marketplace 路由 perm = access（基础准入），不是 marketplace-openapi.use
    permission: 'access',
    tags: ['开放接口', 'API Key', 'AI 接入', '海鲜市场'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    wip: true,
  },
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
    // /shortcuts-agent 路由 perm = access（无单独 use 权限）
    permission: 'access',
    tags: ['快捷', '效率', '指令'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'builtin-my-shares',
    name: '我的分享',
    description: '跨网页托管 / 周报 / 知识库 / 工作流的所有分享统一管理 — 按类型分类、查看访问次数、复制 3 种 URL 形态、识别已撤销/过期',
    icon: 'Share2',
    category: 'builtin',
    type: 'builtin',
    kind: 'tool',
    agentKey: 'my-shares',
    routePath: '/my/shares',
    permission: 'access',
    tags: ['分享', '管理', '总览'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    createdByName: '官方',
  },
  {
    id: 'builtin-learning-center',
    name: '学习中心',
    description: '一处看全部官方教程与你的掌握进度，随时点「跟我做」跟着高亮走一遍',
    icon: 'GraduationCap',
    category: 'builtin',
    type: 'builtin',
    kind: 'tool',
    agentKey: 'learning-center',
    routePath: '/learning-center',
    permission: 'access',
    tags: ['教程', '新手引导', '学习进度', '帮助'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    createdByName: '官方',
  },
  {
    id: 'builtin-tech-doc-format-agent',
    name: '技术分析文档格式校验 Agent',
    description: '按 PM2502 模板生成技术分析文档，并检查上传文档的标题、表格和微格式',
    icon: 'FileText',
    category: 'builtin',
    type: 'builtin',
    kind: 'agent',
    agentKey: 'tech-doc-format-agent',
    routePath: '/tech-doc-format-agent',
    permission: 'access',
    tags: ['技术分析', '文档格式', 'PM2502', '模板校验'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    createdByName: '官方',
    wip: true,
  },
  {
    id: 'builtin-share-link-tester',
    name: '分享链接体检',
    description: '粘贴任意分享 slug（数字 seq 或字母 token），看后端解析出的资源类型，并对比 3 种 URL 形态（统一长链 / 超短链 / 旧版前缀链）的打开效果',
    icon: 'Link2',
    category: 'builtin',
    type: 'builtin',
    kind: 'tool',
    agentKey: 'share-link-tester',
    routePath: '/labs/share-link-tester',
    permission: 'access',
    tags: ['分享', '调试', '链接', '实验室'],
    usageCount: 0,
    createdAt: new Date().toISOString(),
    createdByName: '官方',
    wip: true,
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
    permission: 'transcript-agent.use',
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
  runArtifacts: [],
  runError: null,
  unsubscribe: null,

  editingItem: null,

  funcKindFilter: 'all',
  activeTagFilter: null,
  recentlyUsedIds: loadRecentlyUsedFromStorage(),

  // Load all items (BUILTIN + 我的 + 别人公开的，一次性合并供首页三卡片筛选)
  //
  // 先前设计把"别人公开的"藏在独立的「公开市场」Tab 里，首页只显示 BUILTIN + 自己的，
  // 导致用户反映"我公开发布了别人却看不到"。现在直接把两路数据合并进 items，
  // 由 ownership 字段区分归属：
  //   BUILTIN      → ownership 留空（只显示在"全部"）
  //   我的自建/Fork → ownership = 'mine'
  //   别人公开的    → ownership = 'others'
  loadItems: async () => {
    if (get().itemsLoading) return; // 防止并发重复加载
    set({ itemsLoading: true });
    try {
      const currentUserId = useAuthStore.getState().user?.userId ?? null;

      // /items → 自己创建（含公开和未公开）；/marketplace → 所有公开项（含自己和别人的）
      const [minesRes, publicRes] = await Promise.all([
        listToolboxItems().catch(() => null),
        listMarketplaceItems({ page: 1, pageSize: 100 }).catch(() => null),
      ]);

      const minesRaw = minesRes?.success && minesRes.data ? minesRes.data.items : [];
      const publicRaw = publicRes?.success && publicRes.data ? publicRes.data.items : [];

      // 后端 ToolboxItem 没有 type/category 字段，前端归一化，避免被 ToolCard 误判为"系统内置"
      const mineItems: ToolboxItem[] = minesRaw.map((it) => ({
        ...it,
        type: 'custom' as const,
        category: 'custom' as const,
        ownership: 'mine' as const,
      }));

      // 从 /marketplace 里剔除自己的（已经在 mineItems 里了），剩下的标为 'others'
      const mineIds = new Set(mineItems.map((it) => it.id));
      const othersItems: ToolboxItem[] = publicRaw
        .filter((it) => !mineIds.has(it.id))
        .filter((it) => !currentUserId || it.createdByUserId !== currentUserId)
        .map((it) => ({
          ...it,
          type: 'custom' as const,
          category: 'custom' as const,
          ownership: 'others' as const,
        }));

      set({
        items: [...BUILTIN_TOOLS, ...mineItems, ...othersItems],
        // marketplaceItems 保留以兼容旧调用方，但首页不再单独用它过滤
        marketplaceItems: othersItems,
      });
    } catch {
      // 即使 API 失败，也显示内置工具
      set({ items: BUILTIN_TOOLS });
    } finally {
      set({ itemsLoading: false });
    }
  },

  // 独立加载公开市场（遗留入口：旧「公开市场」Tab / 外部搜索场景仍可用）
  loadMarketplaceItems: async (keyword?: string) => {
    if (get().marketplaceLoading) return;
    set({ marketplaceLoading: true });
    try {
      const res = await listMarketplaceItems({ keyword, page: 1, pageSize: 50 });
      const items = res.success && res.data ? res.data.items : [];
      const currentUserId = useAuthStore.getState().user?.userId ?? null;
      const normalized = items.map((it) => ({
        ...it,
        type: 'custom' as const,
        category: 'custom' as const,
        ownership:
          currentUserId && it.createdByUserId === currentUserId
            ? ('mine' as const)
            : ('others' as const),
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
      runArtifacts: [],
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

  setFuncKindFilter: (kind) => set({ funcKindFilter: kind }),

  setActiveTagFilter: (tag) =>
    set((state) => ({
      activeTagFilter: !tag || state.activeTagFilter?.toLowerCase() === tag.toLowerCase() ? null : tag,
    })),

  trackRecentlyUsed: (itemId) => {
    const current = get().recentlyUsedIds;
    const updated = [itemId, ...current.filter((id) => id !== itemId)].slice(0, MAX_RECENT);
    saveRecentlyUsedToStorage(updated);
    set({ recentlyUsedIds: updated });
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
          '要让同事也能使用，请在卡片右上角点击「公开发布」（按钮正在闪烁）',
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
      runArtifacts: [],
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
      runArtifacts: [],
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
      runArtifacts: [],
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

      case 'step_artifact':
        if (event.artifact) {
          set((state) => ({
            runArtifacts: [
              ...state.runArtifacts.filter((item) => item.id !== event.artifact?.id),
              event.artifact!,
            ],
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
