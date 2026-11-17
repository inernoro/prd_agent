/** Platform configuration and observed calls share one explicit 24-hour display. */
export function formatPlatformTime(value?: string | null) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
