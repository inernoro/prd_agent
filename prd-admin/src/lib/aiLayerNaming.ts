/**
 * AI 分层的命名与层数口径。
 *
 * 命名必须与源提示词解耦。早先图层名是 `${源提示词} · AI 图层 01` 再交给 cleanDisplayTitle
 * 显示，而后者在 60 字处截断——源提示词本身就超长时，`· AI 图层 01` 这个用来区分的后缀
 * 整段被切掉，四个图层在面板里退化成同一串文字，完全没法分辨谁是谁
 * （2026-08-07 用户实测截图：四行都是「参考两张图片的…」）。
 *
 * 所以修法不是把 maxLen 调大——那只是把撞墙时间推后——而是让**序号成为主标题**，
 * 源提示词降级为可截断的副标题：截断了也不影响分辨。
 */

/** 层数区间。后端 controller / worker / 网关转换器三处均为 1-10，这里取更保守的可用区间。 */
export const LAYER_COUNT_MIN = 2;
export const LAYER_COUNT_MAX = 8;
export const LAYER_COUNT_DEFAULT = 4;

export function clampLayerCount(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return LAYER_COUNT_DEFAULT;
  return Math.min(LAYER_COUNT_MAX, Math.max(LAYER_COUNT_MIN, n));
}

/**
 * 图层主标题：只由序号决定，任何情况下都能相互区分。
 * index 从 0 起，展示从 01 起。
 */
export function aiLayerDisplayName(index: number): string {
  const seq = Number.isFinite(index) && index >= 0 ? Math.round(index) + 1 : 1;
  return `图层 ${String(seq).padStart(2, '0')}`;
}

/** 整图参考层在面板里的固定名字，不占用普通图层的序号语义。 */
export const SOURCE_REFERENCE_LAYER_NAME = '原图参考层';

/**
 * 图层副标题：源提示词，截断无所谓（主标题已经能区分）。
 * 空字符串表示没有可展示的来源信息，调用方应当整行不渲染而不是渲染一个空行。
 */
export function aiLayerSubtitle(rawPrompt: string | undefined | null, maxLen = 24): string {
  const s = String(rawPrompt ?? '').trim();
  if (!s) return '';
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

/**
 * 导出用文件名 / PSD 图层名：同样以序号为主，可选带一小段来源说明。
 * 文件名里不能出现路径分隔符与 Windows 保留字符，这里一并清掉。
 */
export function aiLayerExportName(index: number, subtitle?: string | null): string {
  const base = aiLayerDisplayName(index);
  const tail = String(subtitle ?? '').trim().replace(/[\\/:*?"<>|]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return tail ? `${base} · ${tail}` : base;
}
