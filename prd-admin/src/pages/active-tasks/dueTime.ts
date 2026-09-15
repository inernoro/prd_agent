/**
 * 「今天要」到底指哪一刻 —— DuePicker 与 dueParse 共用一份，避免两处各写各的。
 *
 * 默认是当天 18:00（「今天要」指今天下班前，不是此刻）。
 * 但如果现在已经过了 18:00，落到 18:00 等于当场生成一个过去的时间，
 * 任务刚建出来就被判逾期 —— 这种情况退到当天 23:59。
 */
export function endOfDay(d: Date, now: Date = new Date()): Date {
  const x = new Date(d);
  x.setHours(18, 0, 0, 0);
  if (x.getTime() <= now.getTime() && isSameDay(x, now)) x.setHours(23, 59, 0, 0);
  return x;
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** ISO → yyyy-MM-dd（按本地时区，不是 UTC 切片） */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
