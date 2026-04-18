/**
 * 首页资源槽位注册表（共享给设置页上传 UI 和 LandingPage 渲染层使用）。
 *
 * - 卡片背景 slot：`card.{id}` → 覆盖 LandingPage 顶部 4 张快捷卡的背景
 * - Agent 图片 slot：`agent.{agentKey}.image` → 覆盖 Agent 卡封面静态图
 * - Agent 视频 slot：`agent.{agentKey}.video` → 覆盖 Agent 卡 hover 播放视频
 */

export type HomepageCardSlot = {
  /** LandingPage 里 QUICK_LINKS_BASE 的 id，一一对应 */
  id: 'marketplace' | 'library' | 'showcase' | 'updates';
  /** 后端 slot 字符串 */
  slot: string;
  /** UI 展示用标签 */
  label: string;
  /** UI 次级说明 */
  hint: string;
};

export const HOMEPAGE_CARD_SLOTS: HomepageCardSlot[] = [
  { id: 'marketplace', slot: 'card.marketplace', label: '海鲜市场', hint: '发现和 Fork 优质提示词与配置' },
  { id: 'library', slot: 'card.library', label: '智识殿堂', hint: '探索社区共享的知识库' },
  { id: 'showcase', slot: 'card.showcase', label: '作品广场', hint: '探索 AI 驱动的创意作品与灵感' },
  { id: 'updates', slot: 'card.updates', label: '更新中心', hint: '代码级周报 · 本周仓库变更速览' },
];

export type HomepageAgentSlot = {
  /** agentKey，与 toolboxStore.BUILTIN_TOOLS 里的 agentKey 对齐 */
  agentKey: string;
  /** 展示名 */
  label: string;
  /** 描述（可选） */
  description?: string;
};

/**
 * Agent 槽位清单（image + video 自动派生，不在此表里显式列出）。
 * 与 `prd-admin/src/stores/toolboxStore.ts` BUILTIN_TOOLS 保持一致。
 */
export const HOMEPAGE_AGENT_SLOTS: HomepageAgentSlot[] = [
  { agentKey: 'prd-agent', label: 'PRD 分析师', description: '智能解读 PRD 文档' },
  { agentKey: 'visual-agent', label: '视觉设计师', description: '高级视觉创作' },
  { agentKey: 'literary-agent', label: '文学创作者', description: '文学创作与配图' },
  { agentKey: 'defect-agent', label: '缺陷管理员', description: '缺陷提交与跟踪' },
  { agentKey: 'video-agent', label: '视频创作者', description: '文章转视频教程' },
  { agentKey: 'report-agent', label: '周报管理员', description: '周报创建/审阅' },
  { agentKey: 'arena', label: 'AI 竞技场', description: '多模型盲测对战' },
  { agentKey: 'workflow-agent', label: '工作流引擎', description: '可视化工作流编排' },
  { agentKey: 'shortcuts-agent', label: '快捷指令', description: '一键执行常用操作' },
  { agentKey: 'transcript-agent', label: '转录工作台', description: '音视频智能转录' },
  { agentKey: 'review-agent', label: '产品评审员', description: '方案多维度评审' },
  { agentKey: 'pr-review', label: 'PR 审查工作台', description: 'GitHub PR 审查' },
  { agentKey: 'changelog', label: '更新中心', description: '代码级周报' },
  { agentKey: 'code-reviewer', label: '代码审查员', description: '代码质量审查' },
  { agentKey: 'translator', label: '多语言翻译', description: '中英日韩翻译' },
  { agentKey: 'summarizer', label: '内容摘要师', description: '长文本摘要' },
  { agentKey: 'data-analyst', label: '数据分析师', description: '数据分析建议' },
];

export function agentImageSlot(agentKey: string): string {
  return `agent.${agentKey}.image`;
}

export function agentVideoSlot(agentKey: string): string {
  return `agent.${agentKey}.video`;
}

export function cardSlot(id: HomepageCardSlot['id']): string {
  return `card.${id}`;
}

/**
 * 老系统 Agent 封面/视频的默认 CDN 路径表（与 `AgentLauncherPage` 内同名常量对齐）。
 * 存放在共享文件里，让设置页和首页共用同一份「默认素材地图」。
 *
 * 后端上传 `agent.{key}.image/video` 时会直接覆盖这张表指向的 COS 对象
 * （`icon/backups/agent/{key}.{ext}`），因此上传即替换，不产生二份拷贝。
 */
export const AGENT_COVER_DEFAULTS: Record<string, string> = {
  'prd-agent': 'icon/backups/agent/prd-agent.png',
  'visual-agent': 'icon/backups/agent/visual-agent.png',
  'literary-agent': 'icon/backups/agent/literary-agent.png',
  'defect-agent': 'icon/backups/agent/defect-agent.png',
  'video-agent': 'icon/backups/agent/video-agent.png',
  'report-agent': 'icon/backups/agent/report-agent.png',
  'arena': 'icon/backups/agent/arena.png',
  'shortcuts-agent': 'icon/backups/agent/shortcuts-agent.png',
  'workflow-agent': 'icon/backups/agent/workflow-agent.png',
};

export const AGENT_VIDEO_DEFAULTS: Record<string, string> = {
  'prd-agent': 'icon/backups/agent/prd-agent.mp4',
  'visual-agent': 'icon/backups/agent/visual-agent.mp4',
  'literary-agent': 'icon/backups/agent/literary-agent.mp4',
  'defect-agent': 'icon/backups/agent/defect-agent.mp4',
  'video-agent': 'icon/backups/agent/video-agent.mp4',
  'report-agent': 'icon/backups/agent/report-agent.mp4',
  'arena': 'icon/backups/agent/arena.mp4',
  'shortcuts-agent': 'icon/backups/agent/shortcuts-agent.mp4',
  'workflow-agent': 'icon/backups/agent/workflow-agent.mp4',
};

export function buildDefaultCoverUrl(cdnBase: string, agentKey?: string): string | null {
  if (!agentKey) return null;
  const path = AGENT_COVER_DEFAULTS[agentKey];
  if (!path) return null;
  const base = (cdnBase ?? '').replace(/\/+$/, '');
  return base ? `${base}/${path}` : `/${path}`;
}

export function buildDefaultVideoUrl(cdnBase: string, agentKey?: string): string | null {
  if (!agentKey) return null;
  const path = AGENT_VIDEO_DEFAULTS[agentKey];
  if (!path) return null;
  const base = (cdnBase ?? '').replace(/\/+$/, '');
  return base ? `${base}/${path}` : `/${path}`;
}
