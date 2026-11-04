import { Edit3 } from 'lucide-react';
import { formatCompactZh } from '@/lib/formatStats';
import type { HostedSiteActivity } from '@/services/real/webPages';

export function SiteNewBadge({ activity }: { activity?: HostedSiteActivity }) {
  return activity?.isNew ? <span className="shrink-0" aria-label="新创建，尚未打开" title="近 7 天创建，您尚未打开"
    style={{ padding: '1px 5px', borderRadius: 4, fontSize: 10, fontWeight: 600, lineHeight: '16px',
      color: 'var(--accent-fg-blue)', background: 'var(--semantic-info-soft)', border: '1px solid var(--semantic-info-border)' }}>新</span> : null;
}

export function SiteEditCount({ activity, compact = false, badge = false }: { activity?: HostedSiteActivity; compact?: boolean; badge?: boolean }) {
  const count = activity?.editCount;
  if (!badge && typeof count !== 'number') return null;
  return <span
    data-site-edit-badge={badge ? '' : undefined}
    className={badge ? 'inline-flex shrink-0 items-center gap-1 whitespace-nowrap backdrop-blur-md' : 'shrink-0 whitespace-nowrap'}
    style={badge ? { height: 20, padding: '0 6px', borderRadius: 6, fontSize: 10, lineHeight: '16px',
      fontFamily: 'var(--font-code)', color: 'var(--text-secondary)', background: 'var(--bg-elevated)',
      border: '1px solid var(--border-subtle)', boxShadow: 'var(--scrim-badge-shadow)' } : undefined}
    aria-label={count === undefined ? '编辑次数暂不可用' : `已编辑 ${count} 次`}
    title={count === undefined ? '编辑次数暂不可用，可通过网页详情查看统计状态' : `成功发布 ${count} 次内容修改，含版本回退；不含重传、标题、设置或未发布草稿`}>
    {badge ? <><Edit3 size={10} aria-hidden />{count === undefined ? '—' : formatCompactZh(count)}</> : <>编辑 {compact && count !== undefined ? formatCompactZh(count) : count} 次</>}
  </span>;
}
