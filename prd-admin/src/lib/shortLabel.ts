/**
 * 侧边栏短标签规则 — AppShell 与设置页"我的导航"共享同一份短名映射，
 * 保证折叠态侧栏与设置页芯片上的文字一致。
 */

/** 折叠态短标签映射（2-4 字） */
export const SHORT_LABEL_MAP: Record<string, string> = {
  'ai-toolbox': '百宝箱',
  'report-agent': '周报',
  'workflow-agent': '工作流',
  'marketplace': '市场',
  'my-resources': '我的资源',
  'my-assets': '我的资源',
  'model-center': '模型',
  'mds': '模型',
  'authz': '用户权限',
  'users': '用户',
  'data-ops': '自定义',
  'settings': '自定义',
  'visual-agent': '视觉',
  'literary-agent': '文学',
  'video-agent': '视频',
  'defect-agent': '缺陷',
  'arena-agent': '竞技场',
  'shortcuts-agent': '快捷指令',
  'data-migration-agent': '迁移',
  'review-agent': '产品评审',
  'pr-review': 'PR 审查',
  'transcript-agent': '转录',
  'skill-agent': '技能助手',
  'emergence-agent': '涌现',
  'emergence': '涌现',
  'document-store': '知识库',
  'web-pages': '网页',
  'changelog': '更新',
  'executive': '团队',
  'tutorial-email': '邮件',
  'lab': '实验室',
  'automations': '自动化',
  'skills': '技能',
  'dashboard': '仪表盘',
  'groups': '群组',
  'prompts': '提示词',
  'assets': '资源',
  'logs': '日志',
  'data': '数据',
  'open-platform': '开放平台',
};

/**
 * 获取短标签：
 *   1) 优先用 appKey 直接查表
 *   2) 命中失败时剥掉 launcherCatalog 前缀（utility:/agent:/toolbox:/infra:）再查一次
 *      —— 否则像 "utility:automations" 这种 id 永远查不到，会被切断为"自动化规"
 *   3) 仍未命中则对原 label 清洗后取前 4 字
 */
export function getShortLabel(appKey: string, label: string): string {
  if (SHORT_LABEL_MAP[appKey]) return SHORT_LABEL_MAP[appKey];
  const stripped = appKey.replace(/^(utility|agent|toolbox|infra|builtin):/, '');
  if (stripped !== appKey && SHORT_LABEL_MAP[stripped]) return SHORT_LABEL_MAP[stripped];
  const clean = label.replace(/\s*(Agent|管理|引擎|智能体)\s*/g, '').trim();
  return clean.length <= 4 ? clean : clean.slice(0, 4);
}
