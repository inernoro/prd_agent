import type { ImportSimpleItemRow } from '@/services/real/productAgent';
import { normalizeTapdToSeverityLevel } from './defectSeverity';
import { parseRequirementRtfBytes, type RtfImportRequirement } from './requirementRtfImport';

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function stripImportImageMarkers(html: string): string {
  return html
    .replace(/\[\[IMPORT_IMAGE_\d+]]/g, '')
    .replace(/<p data-import-image="\d+"><\/p>/g, '');
}

/** TAPD 缺陷 RTF 块 → 缺陷导入行（复用需求 RTF 表格解析）。 */
export function mapDefectRtfItem(item: RtfImportRequirement): ImportSimpleItemRow {
  const tapdSeverity = item.fields['严重程度']?.trim() || undefined;
  const handlerNames = uniqueNames([
    ...item.handlerNames,
    ...(item.fields['当前处理人'] ?? '').split(/[;；,，]/).map((n) => n.trim()).filter(Boolean),
  ]);
  return {
    title: item.title,
    description: stripImportImageMarkers(item.description),
    externalId: item.externalId,
    status: item.sourceStatus || item.fields['状态']?.trim(),
    tapdSeverityRaw: tapdSeverity,
    severity: tapdSeverity ? normalizeTapdToSeverityLevel(tapdSeverity) : undefined,
    sourceSystem: 'tapd',
    handlerNames,
    reporterNames: uniqueNames(item.creatorNames),
  };
}

export async function parseDefectRtfFile(file: File): Promise<ImportSimpleItemRow[]> {
  const items = parseRequirementRtfBytes(await file.arrayBuffer(), file.name);
  return items.map(mapDefectRtfItem).filter((row) => row.title);
}
