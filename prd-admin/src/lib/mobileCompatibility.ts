/**
 * 移动端兼容性注册表。
 *
 * 判定标准：手机竖屏（<768px）上访问时，能达到什么体验。
 *  - `full`    : 完整可用（阅读、文本交互为主的页面）
 *  - `limited` : 基本可用，但部分能力受限（宽表格、多列面板、复杂图表）—— 顶部显示黄色 banner
 *  - `pc-only` : 移动端几乎不可用（大型画布、拖拽编辑器、并排多栏），打开时弹"建议 PC"门槛提示
 *
 * 注册键使用 **路由前缀**（路径最长匹配优先）。未注册的路由默认 `unknown`，
 * MobileCompatGate 会显示一条非常轻量的「未做移动端专项适配」提示。
 *
 * 新增一个 Agent 或页面时，按「移动端实际能用到什么程度」填一行即可。
 */

export type MobileCompatLevel = 'full' | 'limited' | 'pc-only';

export interface MobileCompatEntry {
  level: MobileCompatLevel;
  /** 自定义提示文案；不填使用默认 */
  note?: string;
}

export const MOBILE_COMPAT_REGISTRY: Record<string, MobileCompatEntry> = {
  // ── 完整可用：文本 / 列表型 ──
  '/':                        { level: 'full' },
  '/profile':                 { level: 'full' },
  '/notifications':           { level: 'full' },
  '/my-assets':               { level: 'full' },
  '/ai-toolbox':              { level: 'full' },
  '/prd-agent':               { level: 'full' },
  '/defect-agent':            { level: 'full' },
  '/report-agent':            { level: 'full' },
  '/skills':                  { level: 'full' },
  '/literary-agent':          { level: 'full', note: '阅读/查看正常，深度编辑建议 PC' },
  '/marketplace':             { level: 'full' },
  '/library':                 { level: 'full' },
  '/shortcuts-agent':         { level: 'full' },

  // ── 受限：可以用但体验降级 ──
  '/executive':               { level: 'limited', note: '图表较宽，横屏查看更佳' },
  '/users':                   { level: 'limited', note: '表格较宽，横向滑动查看' },
  '/mds':                     { level: 'limited', note: '模型配置项较多，建议 PC 编辑' },
  '/logs':                    { level: 'limited', note: '日志表格较宽，建议横屏' },
  '/settings':                { level: 'limited' },
  '/prompts':                 { level: 'limited' },
  '/automations':             { level: 'limited' },
  '/assets':                  { level: 'limited' },
  '/open-platform':           { level: 'limited' },
  '/review-agent':            { level: 'limited' },
  '/pr-review':               { level: 'limited', note: 'diff 阅读较挤，建议 PC' },
  '/lab':                     { level: 'limited' },

  // ── PC 专属：画布 / 拖拽 / 大屏复杂交互 ──
  '/visual-agent':            { level: 'pc-only', note: '视觉创作画布需要桌面端鼠标操作' },
  '/visual-agent-fullscreen': { level: 'pc-only' },
  '/workflow-agent':          { level: 'pc-only', note: '工作流画布需要桌面端鼠标操作' },
  '/video-agent':             { level: 'pc-only', note: '视频生成需要大屏预览' },
  '/transcript-agent':        { level: 'pc-only', note: '转录工作台信息密度高' },
  '/showcase':                { level: 'pc-only', note: '瀑布流展示专为宽屏设计' },
};

/**
 * 按最长前缀匹配 —— `/prd-agent/sessions/abc` 也会命中 `/prd-agent`。
 * 入参应为 `location.pathname`。
 */
export function resolveMobileCompat(pathname: string): MobileCompatEntry | null {
  // 完全匹配优先
  if (MOBILE_COMPAT_REGISTRY[pathname]) return MOBILE_COMPAT_REGISTRY[pathname];

  // 前缀匹配：在所有 key 中找最长能匹配 pathname 开头的
  const normalized = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  let best: { key: string; entry: MobileCompatEntry } | null = null;
  for (const [key, entry] of Object.entries(MOBILE_COMPAT_REGISTRY)) {
    if (key === '/') continue; // 根路径只做完全匹配
    if (normalized === key || normalized.startsWith(key + '/')) {
      if (!best || key.length > best.key.length) {
        best = { key, entry };
      }
    }
  }
  return best?.entry ?? null;
}
