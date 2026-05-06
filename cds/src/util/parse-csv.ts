/**
 * parseCsv — 把逗号分隔的字符串拆成 string[]。`undefined`/空串返回 undefined,
 * 让调用方走默认值分支(`?? defaults`)而不是覆盖成空数组。
 *
 * 之前 cds/src/config.ts + cds/src/index.ts 各有一份完全相同的实现,
 * Bugbot 2026-05-06 66483e29 指出维护风险 → 抽到本文件作 SSOT。
 */
export function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(',').map(v => v.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}
