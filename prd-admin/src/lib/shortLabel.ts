/**
 * 侧边栏短标签规则 — AppShell / 设置页"我的导航" / Cmd+K 共享同一份短名映射，
 * 保证折叠态侧栏、设置页芯片、命令面板上的文字一致。
 *
 * 规则：所有 shortLabel 必须 ≤ 4 字（中文字符按 1 字计），不允许出现"自动化规"
 * 这种被截断的尾巴。
 */

/** 折叠态短标签映射（2-4 字，全部精校） */
export const SHORT_LABEL_MAP: Record<string, string> = {
  // ── 快捷操作 ─────────────────────────
  'home': '首页',
  'index': '首页',
  'settings': '设置',
  'ai-toolbox': '百宝箱',

  // ── 智能体（与 AGENT_DEFINITIONS / BUILTIN_TOOLS 对齐） ─────────
  'visual-agent': '视觉',
  'literary-agent': '文学',
  'video-agent': '视频',
  'defect-agent': '缺陷',
  'review-agent': '评审',
  'pr-review': 'PR审查',
  'report-agent': '周报',
  'arena-agent': '竞技场',
  'arena': '竞技场',
  'shortcuts-agent': '指令',
  'transcript-agent': '转录',
  'emergence-agent': '涌现',
  'emergence': '涌现',
  'skill-agent': '技能助手',
  'workflow-agent': '工作流',

  // ── 基础设施 ──────────────────────────
  'marketplace': '市场',
  'my-resources': '资源',
  'my-assets': '资源',
  'model-center': '模型',
  'models': '模型',
  'mds': '模型',
  'users': '团队',
  'teams': '团队',
  'document-store': '知识库',
  'web-pages': '网页',
  'changelog': '更新',
  'library': '殿堂',

  // ── 实用工具 ──────────────────────────
  'prompts': '提示词',
  'lab': '实验室',
  'automations': '自动化',
  'logs': '日志',

  // ── 管理 / 其他 ───────────────────────
  'authz': '权限',
  'data-ops': '数据',
  'data': '数据',
  'data-transfers': '迁移',
  'data-migration-agent': '迁移',
  'open-platform': '开放',
  'dashboard': '仪表盘',
  'groups': '群组',
  'assets': '素材',
  'skills': '技能',
  'tutorial-email': '邮件',
  'executive': '执行',
  'weekly-poster': '海报',
};

/**
 * 获取短标签（保证 ≤ 4 字）：
 *   1) 优先用 appKey 直接查表
 *   2) 剥掉前缀 (utility:/agent:/toolbox:/infra:/builtin:/builtin-) 再查一次
 *   3) 仍未命中则对原 label 清洗（去掉「Agent / 管理 / 引擎 / 智能体」等噪声词）
 *   4) 兜底硬切前 4 字（极端情况，正常补全字典后不应触达）
 */
export function getShortLabel(appKey: string, label: string): string {
  if (SHORT_LABEL_MAP[appKey]) return SHORT_LABEL_MAP[appKey];

  const stripped = appKey
    .replace(/^(utility|agent|toolbox|infra|builtin):/, '')
    .replace(/^builtin-/, '');
  if (stripped !== appKey && SHORT_LABEL_MAP[stripped]) return SHORT_LABEL_MAP[stripped];

  const clean = label
    .replace(/\s*(Agent|管理|引擎|智能体|工作台|创作)\s*/g, '')
    .trim();
  return clean.length <= 4 ? clean : clean.slice(0, 4);
}
