/**
 * 知识库星系：文档类型 → 颜色（SSOT）。
 *
 * 数值照抄演示版 doc-tree-3d.html 的 TYPE_COLORS。知识库星系（DocumentGalaxyView）与
 * 首页片花里的「知识星系」一幕都从这里取色——片花演的是真星系，颜色不许另起一份。
 * 单独成文件是为了让首页不必为了几种颜色去引用星系页（那边整包带着 three.js）。
 */
export const DOC_TYPE_COLOR: Record<string, string> = {
  spec: '#4ade80',
  design: '#60a5fa',
  plan: '#fbbf24',
  rule: '#f87171',
  guide: '#a78bfa',
  report: '#22d3ee',
  debt: '#fb923c',
  unknown: '#94a3b8',
};

export function colorForDocType(docType?: string | null): string {
  if (!docType) return DOC_TYPE_COLOR.unknown;
  return DOC_TYPE_COLOR[docType] ?? DOC_TYPE_COLOR.unknown;
}
