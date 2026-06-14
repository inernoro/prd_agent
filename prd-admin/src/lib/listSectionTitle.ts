/** 列表区块标题：名称后附当前可见条数（真实筛选结果，非 mock）。 */
export function formatListSectionTitle(label: string, count: number): string {
  return `${label}（${count}）`;
}
