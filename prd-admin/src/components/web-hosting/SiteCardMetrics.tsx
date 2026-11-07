import { Eye, Link2, Users } from 'lucide-react';
import type { HostedSiteActivity, HostedSiteTraffic } from '@/services/real/webPages';
import { formatCompactZh } from '@/lib/formatStats';
import { SiteEditCount } from './SiteActivityMeta';

export function SiteCardMetrics({ activity, traffic, activeLinks, onViewers }: {
  activity?: HostedSiteActivity; traffic?: HostedSiteTraffic; activeLinks?: number; onViewers?: () => void;
}) {
  const count = (value?: number) => value === undefined ? '—' : formatCompactZh(value);
  const visits = traffic?.all.visits;
  const visitors = traffic?.all.visitors;
  const links = traffic?.activeShareLinks ?? activeLinks;
  const itemClass = 'inline-flex min-w-0 items-center gap-1 whitespace-nowrap';
  return <div data-site-card-stats aria-label="网页统计"
    className="mt-auto grid min-w-0 grid-cols-2 items-center gap-x-2 gap-y-1 @[235px]:grid-cols-4"
    style={{ fontFamily: 'var(--font-code)', fontSize: 10, lineHeight: '16px', color: 'var(--text-tertiary)' }}>
    <SiteEditCount activity={activity} icon />
    <span className={itemClass} aria-label="全部访问（含作者）" title={visits === undefined ? '访问统计暂不可用' : `全部访问 ${visits} 次（含作者；每30分钟时段去重）${traffic?.all.lastViewedAt ? `；最近访问 ${new Date(traffic.all.lastViewedAt).toLocaleString()}` : ''}`}>
      <Eye size={11} aria-hidden /><span className="truncate">{count(visits)}</span>
    </span>
    <button type="button" className={itemClass} aria-label="全部访客" disabled={!onViewers}
      title={visitors === undefined ? '访客统计暂不可用' : `全部访客 ${visitors} 位，点击查看访客`}
      onClick={event => { event.stopPropagation(); onViewers?.(); }}>
      <Users size={11} aria-hidden /><span className="truncate">{count(visitors)}</span>
    </button>
    <span className={itemClass} aria-label="有效分享链接" title={links === undefined ? '分享统计暂不可用' : `有效链接 ${links} 条（分享）`}>
      <Link2 size={11} aria-hidden /><span className="truncate">{count(links)}</span>
    </span>
  </div>;
}
