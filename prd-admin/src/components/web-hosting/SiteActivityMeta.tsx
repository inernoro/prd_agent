import type { HostedSiteActivity } from '@/services/real/webPages';

export function SiteNewBadge({ activity }: { activity?: HostedSiteActivity }) {
  return activity?.isNew ? <span className="shrink-0" aria-label="新创建，尚未打开" title="近 7 天创建，您尚未打开"
    style={{ padding: '1px 5px', borderRadius: 4, fontSize: 10, fontWeight: 600, lineHeight: '16px',
      color: 'var(--accent-fg-blue)', background: 'var(--semantic-info-soft)', border: '1px solid var(--semantic-info-border)' }}>新</span> : null;
}

export function SiteEditCount({ activity }: { activity?: HostedSiteActivity }) {
  return typeof activity?.editCount === 'number' ? <span className="shrink-0 whitespace-nowrap"
    aria-label={`已编辑 ${activity.editCount} 次`}
    title="成功发布的内容修改次数，含版本回退；不含重传、标题、设置或未发布草稿">
    编辑 {activity.editCount} 次
  </span> : null;
}
