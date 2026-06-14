/** RTF 批量导入写入的 sourceSystem 值（历史数据可能仍为 tapd，读取时一并识别）。 */
export const REQUIREMENT_SOURCE_RTF = 'rtf';

export function isRtfImportedSource(source?: string | null): boolean {
  return source === REQUIREMENT_SOURCE_RTF || source === 'tapd';
}

export function requirementSourceLabel(source?: string | null): string {
  if (!source) return '手动创建';
  if (isRtfImportedSource(source)) return '文件导入';
  if (source === 'csv') return 'CSV 导入';
  if (source === 'defect') return '缺陷转化';
  return source;
}
