/**
 * 站点卡与站点上下文栏共用的两个显示口径：文件大小、相对时间。
 *
 * 抽出来是因为这两份实现原本在 `SiteCard.tsx` 与 `SiteContextPanel.tsx` 里逐字重复了一遍——
 * 同一个判据分裂成两份，改一处忘一处只是时间问题
 * （`.claude/rules/predicate-and-wiring-discipline.md` 形状 3）。
 *
 * 注意 `SharesWorkspace.tsx` 里那份 `relTime` **刻意不并进来**：它的空值文案是「从未」
 * （说的是「从未被访问」）、且把 1 天说成「昨天」，与这里「—」/「1 天前」的语义不同。
 * 合并会悄悄改掉分享档的文案，属于另一件事。
 */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const diff = now - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}
