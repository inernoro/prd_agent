import { Dialog } from '@/components/ui/Dialog';
import { fmtSize } from './siteFormat';
import { resolveSiteForm, SITE_FORM_REGISTRY, siteSourceLabel } from './siteFormRegistry';
import type { SiteCardProps } from './SiteCard';

function timestamp(value?: string) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '暂无记录' : date.toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' });
}

/** 三种卡片共用完整信息视图；只读、全部展开，不改变访问或编辑记录。 */
export function SiteDetailsDialog({ site, activity, visitorCount, shareStats, shared, ownerCard, onClose }: Pick<SiteCardProps,
  'site' | 'activity' | 'visitorCount' | 'shareStats' | 'shared' | 'ownerCard'> & { onClose: () => void }) {
  const rows = [
    ['格式', SITE_FORM_REGISTRY[resolveSiteForm(site)].label],
    ['来源', siteSourceLabel(site.sourceType)],
    ['文件大小', `${fmtSize(site.totalSize)}（${site.totalSize.toLocaleString('zh-CN')} 字节）`],
    ['浏览次数', `${site.viewCount} 次`],
    ['独立访客', visitorCount === undefined ? '统计暂不可用' : `${visitorCount} 人`],
    ['已发布的内容修改', activity === undefined ? '统计暂不可用' : `${activity.editCount} 次`],
    ['分享状态', shared === undefined ? '统计暂不可用' : shared ? '已分享' : '未分享'],
    ['有效分享链接', shareStats === undefined ? '统计暂不可用' : `${shareStats.activeLinks} 条`],
    ['分享链接最近访问', shareStats === undefined ? '统计暂不可用' : timestamp(shareStats.lastViewedAt)],
    ['创建时间', timestamp(site.createdAt)],
    ['更新时间', timestamp(site.updatedAt)],
    ['公开页展示', site.visibility === 'public' ? '已公开' : '未公开'],
    ['团队共享', site.sharedTeamIds?.length ? `已共享到 ${site.sharedTeamIds.length} 个团队` : '未共享到团队'],
    ...(ownerCard ? [['作者', ownerCard.displayName]] : []),
    ['分组', site.folder || '未分组'],
    ['入口文件', site.entryFile],
  ];
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title="网页详情" maxWidth={520}
    contentStyle={{ maxHeight: 'calc(100dvh - 48px)' }}
    content={<div data-site-details data-no-drag className="space-y-4 text-xs text-token-secondary" style={{ overflowWrap: 'anywhere' }}>
      <div>
        <h2 className="whitespace-pre-wrap text-sm font-semibold text-token-primary">{site.title}</h2>
        <p className="mt-2 whitespace-pre-wrap">{site.description || '暂无描述'}</p>
      </div>
      <div aria-label="全部标签" className="flex flex-wrap gap-1.5">
        {site.tags.length ? site.tags.map((tag) => <span key={tag} className="rounded px-2 py-1" style={{ background: 'var(--bg-secondary)' }}>{tag}</span>) : <span>暂无标签</span>}
      </div>
      <dl className="divide-y divide-token-default rounded-lg border border-token-default px-3">
        {rows.map(([label, value]) => <div key={label} className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 py-2">
          <dt className="text-token-muted">{label}</dt><dd className="whitespace-pre-wrap text-token-primary">{value}</dd>
        </div>)}
      </dl>
      <p className="text-token-muted">编辑次数仅统计成功发布的内容修改和版本回退，不含草稿、重传、标题或设置修改。</p>
      <section aria-label="完整文件列表">
        <h3 className="mb-2 font-medium text-token-primary">文件 · {site.files.length}</h3>
        <ul className="space-y-2">
          {site.files.map((file) => <li key={file.path} className="rounded border border-token-default px-3 py-2">
            <div className="whitespace-pre-wrap text-token-primary">{file.path}</div>
            <div className="mt-1 text-token-muted">{file.size.toLocaleString('zh-CN')} 字节 · {file.mimeType}</div>
          </li>)}
        </ul>
      </section>
    </div>} />;
}
