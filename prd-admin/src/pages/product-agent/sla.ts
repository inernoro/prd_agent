/** SLA 时效计算：根据进入状态时间 + 该状态的 SLA 小时数，返回停留文案与是否超时。 */
export function slaInfo(stateEnteredAt?: string | null, slaHours?: number | null): { label: string; overdue: boolean } | null {
  if (!stateEnteredAt) return null;
  const enter = new Date(stateEnteredAt).getTime();
  if (Number.isNaN(enter)) return null;
  const hours = (Date.now() - enter) / 3_600_000;
  const label = hours < 1 ? '刚进入' : hours < 24 ? `${Math.floor(hours)} 小时` : `${Math.floor(hours / 24)} 天`;
  const overdue = slaHours != null && slaHours > 0 && hours > slaHours;
  return { label, overdue };
}
