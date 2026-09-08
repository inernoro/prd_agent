/**
 * 事件行左侧那一列的时间。
 *
 * 这一列原来恒定只写 `HH:mm`，而它所在的列表是「最近 N 次调用」——按时间倒序取最近若干条，
 * 不按自然日切。所以列表天然会跨天，而跨天之后 `06:28` 到底是今天早上还是三天前的早上，
 * 行上看不出来。它正下方就是「今天一次都还没调过」那句判断，两者放在一起读起来像自相矛盾
 * （实际不矛盾：判断句按 UTC 自然日算，列表按条数取）。
 *
 * 所以：今天的只写时刻，不是今天的把日期一起写上。判据是「跟现在是不是同一个自然日」，
 * 按浏览器本地时区算 —— 因为这一列的时刻本来就是用本地时区渲染给人看的，
 * 拿 UTC 去判会在时区偏移的那几个小时里给出跟眼睛看到的时刻对不上的结论。
 */
export function eventClock(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return hm;
  return `${d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${hm}`;
}
