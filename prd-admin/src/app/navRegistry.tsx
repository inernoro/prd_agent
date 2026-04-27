/**
 * 导航注册表（Single Source of Truth）—— v7 全改造
 *
 * 一处声明、三处自动同步：
 *   1. <Route> 路由渲染（App.tsx 遍历 NAV_REGISTRY 生成 <Route>）
 *   2. 「我的导航」可添加池（NavLayoutEditor 通过 launcherCatalog 读取）
 *   3. Cmd+K 命令面板（AgentSwitcher 通过 launcherCatalog 读取）
 *
 * 加新功能：在 NAV_REGISTRY 写一个条目，结束。无需登记 launcherCatalog /
 * AGENT_DEFINITIONS / BUILTIN_TOOLS。
 *
 * 元信息字段对齐 LauncherItem，下游消费方零改动。
 */

import { lazy, type ReactElement } from 'react';
import { RequireAuth, RequirePermission } from '@/app/RouteGuards';

// ── 页面组件（lazy 加载） ─────────────────────────────────
const VisualAgentFullscreenPage = lazy(() => import('@/pages/visual-agent/VisualAgentFullscreenPage'));
const LiteraryAgentWorkspaceListPage = lazy(() => import('@/pages/literary-agent').then(m => ({ default: m.LiteraryAgentWorkspaceListPage })));
const DefectAgentPage = lazy(() => import('@/pages/defect-agent').then(m => ({ default: m.DefectAgentPage })));
const VideoAgentPage = lazy(() => import('@/pages/video-agent').then(m => ({ default: m.VideoAgentPage })));
const ReportAgentPage = lazy(() => import('@/pages/report-agent').then(m => ({ default: m.ReportAgentPage })));
const TranscriptAgentPage = lazy(() => import('@/pages/transcript-agent').then(m => ({ default: m.TranscriptAgentPage })));
const ShortcutsPage = lazy(() => import('@/pages/shortcuts-agent').then(m => ({ default: m.ShortcutsPage })));
const WorkflowListPage = lazy(() => import('@/pages/workflow-agent').then(m => ({ default: m.WorkflowListPage })));
const MarketplacePage = lazy(() => import('@/pages/marketplace').then(m => ({ default: m.MarketplacePage })));
const DocumentStorePage = lazy(() => import('@/pages/document-store').then(m => ({ default: m.DocumentStorePage })));
const LibraryLandingPage = lazy(() => import('@/pages/library/LibraryLandingPage').then(m => ({ default: m.LibraryLandingPage })));
const EmergenceExplorerPage = lazy(() => import('@/pages/emergence').then(m => ({ default: m.EmergenceExplorerPage })));
const ChangelogPage = lazy(() => import('@/pages/changelog/ChangelogPage'));
const SkillAgentPage = lazy(() => import('@/pages/SkillAgentPage'));
const ArenaPage = lazy(() => import('@/pages/arena/ArenaPage').then(m => ({ default: m.ArenaPage })));
const ReviewAgentPage = lazy(() => import('@/pages/review-agent').then(m => ({ default: m.ReviewAgentPage })));
const PrReviewPage = lazy(() => import('@/pages/pr-review').then(m => ({ default: m.PrReviewPage })));
const UsersPage = lazy(() => import('@/pages/UsersPage'));
const ModelManageTabsPage = lazy(() => import('@/pages/ModelManageTabsPage').then(m => ({ default: m.ModelManageTabsPage })));
const LlmLogsPage = lazy(() => import('@/pages/LlmLogsPage'));
const LabPage = lazy(() => import('@/pages/LabPage'));
const AutomationRulesPage = lazy(() => import('@/pages/AutomationRulesPage'));
const WebPagesPage = lazy(() => import('@/pages/WebPagesPage'));
const MyAssetsPage = lazy(() => import('@/pages/MyAssetsPage'));

// ── 类型定义 ──────────────────────────────────────────────
export type NavSection = 'agent' | 'toolbox' | 'utility' | 'infra';

export interface NavMeta {
  /** 完整名（菜单文本 / 命令面板主标题） */
  label: string;
  /** 短标签（≤ 4 字，侧栏折叠态） */
  shortLabel: string;
  /** 描述（命令面板副标题） */
  description: string;
  /** Lucide 图标名 */
  icon: string;
  /** 分组归属 */
  section: NavSection;
  /** 应用标识（与后端 appKey 对齐） */
  appKey?: string;
  /** Agent 主题色文字（用于命令面板高亮） */
  accentColor?: string;
  /** 智能体专用色板（4 个核心 agent，AgentSwitcher 卡片样式用） */
  agentColor?: { bg: string; border: string; iconBg: string; text: string };
  /** 搜索关键字 */
  tags?: string[];
  /** 施工中标记 */
  wip?: boolean;
  /** Agent 卡片副标签（如「画布」「项目」） */
  statLabel?: string;
}

export interface NavRegistryEntry {
  /** 完整路径，含前导 `/` */
  path: string;
  /** 渲染元素（已包裹权限/认证守卫，App.tsx 直接 <Route element={...}>） */
  element: ReactElement;
  /**
   * 渲染位置：
   *   - 'shell'      （默认）渲染在 AppShell 布局内
   *   - 'fullscreen' 独立全屏，跳过 AppShell（visual-agent / library）
   */
  placement?: 'shell' | 'fullscreen';
  /** 权限守卫 key（如 'visual-agent.use'），与 element 中 RequirePermission 1:1 对齐 */
  permission?: string;
  /** 缺省 = 仅注册路由，不进导航/命令面板 */
  nav?: NavMeta;
}

// ── 守卫包装 helper ────────────────────────────────────────
function shellGuarded(perm: string, el: ReactElement): ReactElement {
  return <RequirePermission perm={perm}>{el}</RequirePermission>;
}

function fullscreenGuarded(perm: string, el: ReactElement): ReactElement {
  return (
    <RequireAuth>
      <RequirePermission perm={perm}>{el}</RequirePermission>
    </RequireAuth>
  );
}

// ── 注册表正文 ─────────────────────────────────────────────
//
// 加新功能：在合适的分组下追加一个 entry。下游全部自动同步。
//
export const NAV_REGISTRY: NavRegistryEntry[] = [
  // ╔══════════════ 智能体（5）══════════════════════════════
  {
    path: '/visual-agent',
    placement: 'fullscreen',
    permission: 'visual-agent.use',
    element: fullscreenGuarded('visual-agent.use', <VisualAgentFullscreenPage />),
    nav: {
      label: '视觉创作智能体',
      shortLabel: '视觉',
      description: 'AI 驱动的视觉创作，一键生成精美图像',
      icon: 'Image',
      section: 'agent',
      appKey: 'visual-agent',
      accentColor: '#A78BFA',
      agentColor: {
        bg: 'rgba(139, 92, 246, 0.08)',
        border: 'rgba(139, 92, 246, 0.2)',
        iconBg: 'rgba(139, 92, 246, 0.15)',
        text: '#A78BFA',
      },
      statLabel: '画布',
      tags: ['视觉', '智能体', '图像', '生图', 'AI绘画'],
    },
  },
  {
    path: '/literary-agent',
    permission: 'literary-agent.use',
    element: shellGuarded('literary-agent.use', <LiteraryAgentWorkspaceListPage />),
    nav: {
      label: '文学创作智能体',
      shortLabel: '文学',
      description: '文学创作智能体，为文章配图赋予灵魂',
      icon: 'PenLine',
      section: 'agent',
      appKey: 'literary-agent',
      accentColor: '#4ADE80',
      agentColor: {
        bg: 'rgba(34, 197, 94, 0.08)',
        border: 'rgba(34, 197, 94, 0.2)',
        iconBg: 'rgba(34, 197, 94, 0.15)',
        text: '#4ADE80',
      },
      statLabel: '项目',
      tags: ['文学', '智能体', '写作', '配图'],
    },
  },
  {
    path: '/defect-agent',
    permission: 'defect-agent.use',
    element: shellGuarded('defect-agent.use', <DefectAgentPage />),
    nav: {
      label: '缺陷管理智能体',
      shortLabel: '缺陷',
      description: '缺陷管理专家，高效追踪问题闭环',
      icon: 'Bug',
      section: 'agent',
      appKey: 'defect-agent',
      accentColor: '#FB923C',
      agentColor: {
        bg: 'rgba(249, 115, 22, 0.08)',
        border: 'rgba(249, 115, 22, 0.2)',
        iconBg: 'rgba(249, 115, 22, 0.15)',
        text: '#FB923C',
      },
      statLabel: '缺陷',
      tags: ['缺陷', '智能体', 'bug', '追踪'],
    },
  },
  {
    path: '/video-agent',
    permission: 'video-agent.use',
    element: shellGuarded('video-agent.use', <VideoAgentPage />),
    nav: {
      label: '视频创作智能体',
      shortLabel: '视频',
      description: '文章转视频教程，AI 驱动分镜创作',
      icon: 'Video',
      section: 'agent',
      appKey: 'video-agent',
      accentColor: '#EC4899',
      agentColor: {
        bg: 'rgba(236, 72, 153, 0.08)',
        border: 'rgba(236, 72, 153, 0.2)',
        iconBg: 'rgba(236, 72, 153, 0.15)',
        text: '#EC4899',
      },
      statLabel: '视频',
      tags: ['视频', '智能体', '分镜', '教程'],
    },
  },
  {
    path: '/emergence',
    permission: 'emergence-agent.use',
    element: shellGuarded('emergence-agent.use', <EmergenceExplorerPage />),
    nav: {
      label: '涌现探索智能体',
      shortLabel: '涌现',
      description: '从文档出发，AI 辅助发现功能创意与交叉价值',
      icon: 'Sparkle',
      section: 'agent',
      appKey: 'emergence-agent',
      tags: ['涌现', '探索', 'AI', '创意', '智能体'],
    },
  },

  // ╔══════════════ 百宝箱（7）══════════════════════════════
  {
    path: '/report-agent',
    permission: 'report-agent.use',
    element: shellGuarded('report-agent.use', <ReportAgentPage />),
    nav: {
      label: '周报智能体',
      shortLabel: '周报',
      description: '周报创建、提交、审阅，支持 AI 生成 / 团队汇总 / 计划比对',
      icon: 'FileBarChart',
      section: 'toolbox',
      appKey: 'report-agent',
      tags: ['周报', '日报', '团队管理'],
    },
  },
  {
    path: '/arena',
    permission: 'arena-agent.use',
    element: shellGuarded('arena-agent.use', <ArenaPage />),
    nav: {
      label: 'AI 竞技场智能体',
      shortLabel: '竞技场',
      description: '多模型盲测对战，匿名 PK 后揭晓真实身份',
      icon: 'Swords',
      section: 'toolbox',
      appKey: 'arena',
      tags: ['竞技场', '模型对比', '盲测'],
    },
  },
  {
    path: '/review-agent',
    permission: 'review-agent.use',
    element: shellGuarded('review-agent.use', <ReviewAgentPage />),
    nav: {
      label: '产品评审智能体',
      shortLabel: '评审',
      description: '上传产品方案 (.md)，AI 多维度评审打分',
      icon: 'ClipboardCheck',
      section: 'toolbox',
      appKey: 'review-agent',
      tags: ['评审', '产品', 'PRD'],
    },
  },
  {
    path: '/pr-review',
    permission: 'pr-review.use',
    element: shellGuarded('pr-review.use', <PrReviewPage />),
    nav: {
      label: 'PR 审查智能体',
      shortLabel: 'PR审查',
      description: '用你自己的 GitHub 账号审查任意有权访问的 PR',
      icon: 'GitPullRequest',
      section: 'toolbox',
      appKey: 'pr-review',
      tags: ['PR', 'GitHub', '审查', 'OAuth'],
    },
  },
  {
    path: '/transcript-agent',
    permission: 'transcript-agent.use',
    element: shellGuarded('transcript-agent.use', <TranscriptAgentPage />),
    nav: {
      label: '转录工作台',
      shortLabel: '转录',
      description: '音视频智能转录，多模型 ASR + 时间戳编辑 + 模板转文案',
      icon: 'AudioLines',
      section: 'toolbox',
      appKey: 'transcript-agent',
      tags: ['转录', '语音', 'ASR', '字幕'],
    },
  },
  {
    path: '/shortcuts-agent',
    permission: 'access',
    element: shellGuarded('access', <ShortcutsPage />),
    nav: {
      label: '快捷指令',
      shortLabel: '指令',
      description: '一键执行常用操作，支持自定义和分享指令',
      icon: 'Zap',
      section: 'toolbox',
      appKey: 'shortcuts-agent',
      tags: ['快捷', '效率', '指令'],
    },
  },

  // ╔══════════════ 实用工具（5）═══════════════════════════
  {
    path: '/skill-agent',
    permission: 'access',
    element: shellGuarded('access', <SkillAgentPage />),
    nav: {
      label: '技能创建助手',
      shortLabel: '技能助手',
      description: 'AI 引导你逐步创建可复用的技能模板',
      icon: 'Wand2',
      section: 'utility',
      tags: ['技能', 'skill', 'AI', '创建', '模板'],
    },
  },
  {
    path: '/lab',
    permission: 'lab.read',
    element: shellGuarded('lab.read', <LabPage />),
    nav: {
      label: '实验室',
      shortLabel: '实验室',
      description: 'Model Lab / 桌面实验 / 工具箱',
      icon: 'FlaskConical',
      section: 'utility',
      tags: ['实验室', 'lab', 'beta'],
    },
  },
  {
    path: '/automations',
    permission: 'automations.manage',
    element: shellGuarded('automations.manage', <AutomationRulesPage />),
    nav: {
      label: '自动化规则',
      shortLabel: '自动化',
      description: '创建和管理跨系统的自动化任务',
      icon: 'Zap',
      section: 'utility',
      tags: ['自动化', 'automation', '规则'],
    },
  },
  {
    path: '/logs',
    permission: 'logs.read',
    element: shellGuarded('logs.read', <LlmLogsPage />),
    nav: {
      label: '请求日志',
      shortLabel: '日志',
      description: 'LLM 调用与 API 请求日志审计',
      icon: 'ScrollText',
      section: 'utility',
      tags: ['日志', 'logs', '审计'],
    },
  },

  // ╔══════════════ 基础设施（9）═══════════════════════════
  {
    path: '/document-store',
    permission: 'access',
    element: shellGuarded('access', <DocumentStorePage />),
    nav: {
      label: '知识库',
      shortLabel: '知识库',
      description: '文档存储与知识管理，支持文件夹、GitHub 同步',
      icon: 'Library',
      section: 'infra',
      tags: ['文档', '知识', '知识库', 'docs'],
    },
  },
  {
    path: '/my-assets',
    permission: 'access',
    element: shellGuarded('access', <MyAssetsPage />),
    nav: {
      label: '我的资源',
      shortLabel: '资源',
      description: '图片、附件、素材等个人资源统一管理',
      icon: 'FolderHeart',
      section: 'infra',
      tags: ['资源', '素材', '附件'],
    },
  },
  {
    path: '/marketplace',
    permission: 'access',
    element: shellGuarded('access', <MarketplacePage />),
    nav: {
      label: '海鲜市场',
      shortLabel: '市场',
      description: '社区共享的提示词、水印、参考图、工具',
      icon: 'Store',
      section: 'infra',
      tags: ['市场', 'marketplace', '分享', '社区'],
    },
  },
  {
    path: '/mds',
    permission: 'mds.read',
    element: shellGuarded('mds.read', <ModelManageTabsPage />),
    nav: {
      label: '模型中心',
      shortLabel: '模型',
      description: '大模型与模型池配置、健康监控',
      icon: 'Cpu',
      section: 'infra',
      tags: ['模型', 'LLM', '模型池', '调度', 'mds'],
    },
  },
  {
    path: '/users',
    permission: 'users.read',
    element: shellGuarded('users.read', <UsersPage />),
    nav: {
      label: '团队协作',
      shortLabel: '团队',
      description: '团队成员、用户组、分享与协作',
      icon: 'Users',
      section: 'infra',
      tags: ['团队', '用户', '协作', '权限'],
    },
  },
  {
    path: '/workflow-agent',
    permission: 'workflow-agent.use',
    element: shellGuarded('workflow-agent.use', <WorkflowListPage />),
    nav: {
      label: '工作流引擎',
      shortLabel: '工作流',
      description: '可视化工作流编排，自动化多步骤任务串联',
      icon: 'Workflow',
      section: 'infra',
      tags: ['工作流', '自动化', '编排'],
    },
  },
  {
    path: '/web-pages',
    permission: 'web-pages.read',
    element: shellGuarded('web-pages.read', <WebPagesPage />),
    nav: {
      label: '网页托管',
      shortLabel: '网页',
      description: '上传 HTML 或 ZIP，托管并分享你的网页',
      icon: 'Globe',
      section: 'infra',
      tags: ['托管', '网页', 'hosting'],
    },
  },
  {
    path: '/changelog',
    permission: 'access',
    element: shellGuarded('access', <ChangelogPage />),
    nav: {
      label: '更新中心',
      shortLabel: '更新',
      description: '代码级周报：自动汇总仓库内的变更',
      icon: 'Sparkles',
      section: 'infra',
      tags: ['更新', '周报', 'changelog', 'release'],
    },
  },
  {
    path: '/library',
    placement: 'fullscreen',
    // 智识殿堂是公开的内容发现页，不加 RequireAuth / RequirePermission——
    // refactor 前 App.tsx 也是无守卫直挂的，匿名访客能直接看
    element: <LibraryLandingPage />,
    nav: {
      label: '智识殿堂',
      shortLabel: '殿堂',
      description: '社区共享的知识库与精选文档',
      icon: 'BookOpenText',
      section: 'infra',
      tags: ['智识', '殿堂', '知识', 'library', '社区'],
    },
  },
];

// ── 派生工具函数 ──────────────────────────────────────────

/** 把 path 标准化为 launcherCatalog id（与历史 navOrder 兼容） */
export function navIdFromPath(path: string): string {
  return path.replace(/^\//, '').replace(/[/?].*$/, '');
}
