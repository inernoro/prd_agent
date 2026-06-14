/**
 * 团队动态模块色彩注册表（页面私有 Registry，遵循 frontend-architecture.md 注册表模式）。
 * key 与后端 ActivityActionRegistry 的模块 key 对齐；未登记模块走 FALLBACK，不崩溃。
 */
export type ModuleMeta = {
  /** 主强调色（点、徽章、能量条段） */
  accent: string;
  /** 低饱和底色（chip / 行内徽章背景） */
  soft: string;
  /** 边框色 */
  border: string;
};

const meta = (accent: string): ModuleMeta => ({
  accent,
  soft: `${accent}1f`,
  border: `${accent}59`,
});

export const MODULE_META: Record<string, ModuleMeta> = {
  'document-store': meta('#34d399'),
  'defect-agent': meta('#fb7185'),
  'report-agent': meta('#fbbf24'),
  'visual-agent': meta('#a78bfa'),
  'literary-agent': meta('#38bdf8'),
  'web-pages': meta('#2dd4bf'),
};

export const FALLBACK_MODULE_META: ModuleMeta = meta('#94a3b8');

export function getModuleMeta(moduleKey: string): ModuleMeta {
  return MODULE_META[moduleKey] ?? FALLBACK_MODULE_META;
}
