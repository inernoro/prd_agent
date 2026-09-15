/**
 * 「什么时候」的唯一算法 —— 三个页面共用一份。
 *
 * 上一版三个页面各写了一份，已经漂移：一份超过 7 天回落成日期，另一份永远是「108 天前」。
 * 同一个判断分裂成几份、各自漂移，是本仓库 predicate-and-wiring-discipline 的形状 3。
 *
 * 基准时间一律用后端下发的 serverNow，不用浏览器时钟 —— 用户的电脑可能慢半天。
 */

function baseNow(serverNow?: string | null): number {
  if (!serverNow) return Date.now();
  const t = new Date(serverNow).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

/** 「今天 / 昨天 / 3 天前 / 9月2日」 */
export function whenLabel(iso?: string | null, serverNow?: string | null): string {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const days = Math.floor((baseNow(serverNow) - then.getTime()) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return then.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
