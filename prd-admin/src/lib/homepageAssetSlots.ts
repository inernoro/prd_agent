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
  { agentKey: 'prd-agent', label: 'PRD 解读智能体', description: '智能解读 PRD 文档' },
  { agentKey: 'visual-agent', label: '视觉创作智能体', description: '高级视觉创作' },
  { agentKey: 'literary-agent', label: '文学创作智能体', description: '文学创作与配图' },
  { agentKey: 'defect-agent', label: '缺陷管理智能体', description: '缺陷提交与跟踪' },
  { agentKey: 'video-agent', label: '视频创作智能体', description: '文章转视频教程' },
  { agentKey: 'report-agent', label: '周报智能体', description: '周报创建/审阅' },
  { agentKey: 'arena', label: 'AI 竞技场智能体', description: '多模型盲测对战' },
  { agentKey: 'workflow-agent', label: '工作流引擎', description: '可视化工作流编排' },
  { agentKey: 'shortcuts-agent', label: '快捷指令', description: '一键执行常用操作' },
  { agentKey: 'transcript-agent', label: '转录工作台', description: '音视频智能转录' },
  { agentKey: 'review-agent', label: '产品评审智能体', description: '方案多维度评审' },
  { agentKey: 'pr-review', label: 'PR 审查智能体', description: 'GitHub PR 审查' },
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
 * 首页顶部 Hero banner（登录后首页最上方那条大图）。
 *
 * 和 Agent 封面一样，上传直接覆盖老 CDN 文件 `icon/title/{id}.{ext}`，
 * 不产生两份拷贝，老逻辑 `getHeroBgUrl()` 自然读取新图。
 */
export type HomepageHeroSlot = {
  id: 'home';
  slot: string;
  label: string;
  hint: string;
};

export const HOMEPAGE_HERO_SLOTS: HomepageHeroSlot[] = [
  { id: 'home', slot: 'hero.home', label: '顶部 Banner', hint: '登录后首页最上方的大图，建议宽屏 1920×640 左右' },
];

/**
 * 海鲜市场海报背景（整页背景，当前只用一张"大气海洋主题"全局海报）。
 *
 * 未来若要拆成每个 Tab 一张背景（提示词/风格图/水印/技能），只需扩展这个数组，
 * 消费方（MarketplacePage）按 `activeTab` 查 slot 即可，无需改后端。
 */
export type MarketplaceBgSlot = {
  /** slot id（稳定 key，前端消费时用此字段匹配） */
  id: 'hero';
  /** 后端 slot 字符串 */
  slot: string;
  /** UI 展示用标签 */
  label: string;
  /** UI 次级说明 */
  hint: string;
};

export const MARKETPLACE_BG_SLOTS: MarketplaceBgSlot[] = [
  {
    id: 'hero',
    slot: 'marketplace.bg.hero',
    label: '海鲜市场海报背景',
    hint: '整个海鲜市场页的背景图；推荐 1920×1080 的大气海洋主题图。未上传时使用内置深海蓝渐变。',
  },
];

export function marketplaceBgSlot(id: MarketplaceBgSlot['id']): string {
  return `marketplace.bg.${id}`;
}

/**
 * 演示视频槽位 —— 通用基础设施，用于在 UI 的关键步骤上方嵌入一段
 * 管理员上传的实拍/录屏演示视频（比如"粘贴 API Key 给智能体"的流程）。
 *
 * 设计原则：
 *   - slot 格式：`demo.{demo-key}.video`，语义命名而非功能命名
 *   - 未上传时消费方回退到静态 placeholder，不阻断业务
 *   - 任何模块都可以声明一个 `DemoVideoSlot`，在 AssetsManagePage 自动出现上传卡
 *   - 不建立独立的 collection —— 复用 HomepageAsset 这一通用 slot 系统，
 *     管理员一套上传 UI 即可搞定所有演示视频
 *
 * 随着功能增加，往 DEMO_VIDEO_SLOTS 追加新条目即可。
 */
export type DemoVideoSlot = {
  /** 稳定 key，前端消费时用此字段匹配（比如 'skill-openapi.agent-paste'） */
  id: string;
  /** 后端 slot 字符串（自动等于 `demo.{id}.video`） */
  slot: string;
  /** 管理后台展示用标签（中文） */
  label: string;
  /** 解释这个演示视频在哪里会被用到、建议怎么拍 */
  hint: string;
};

export const DEMO_VIDEO_SLOTS: DemoVideoSlot[] = [
  {
    id: 'skill-openapi.agent-paste',
    slot: 'demo.skill-openapi.agent-paste.video',
    label: '接入 AI · 粘贴密钥给智能体',
    hint:
      '录一段 10-30 秒的流程：在海鲜市场创建 Key → 点「复制给智能体使用」→ 切到 Claude Code / Cursor 粘贴 → AI 自动 export 环境变量 + 下载 findmapskills 技能的全过程。建议 16:9、MP4 或 WebM、≤ 20 MB。未上传时前端会显示静态占位卡。',
  },
];

export function demoVideoSlot(id: string): string {
  return `demo.${id}.video`;
}

export const HERO_DEFAULTS: Record<string, string> = {
  home: 'icon/title/home.png',
};

export function buildDefaultHeroUrl(cdnBase: string, id: HomepageHeroSlot['id']): string | null {
  const path = HERO_DEFAULTS[id];
  if (!path) return null;
  const base = (cdnBase ?? '').replace(/\/+$/, '');
  return base ? `${base}/${path}` : `/${path}`;
}

export function heroSlot(id: HomepageHeroSlot['id']): string {
  return `hero.${id}`;
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
