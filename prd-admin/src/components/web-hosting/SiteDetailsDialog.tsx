import * as TabsPrimitive from '@radix-ui/react-tabs';
import { Dialog } from '@/components/ui/Dialog';
import { fmtSize } from './siteFormat';
import { resolveSiteForm, SITE_FORM_REGISTRY, siteSourceLabel } from './siteFormRegistry';
import type { SiteCardProps } from './SiteCard';

function timestamp(value?: string) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '暂无记录' : date.toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' });
}

/** 三种卡片共用只读详情：保持原弹窗密度，属性与文件切换，访问统计常驻。 */
export function SiteDetailsDialog({ site, activity, traffic, shared, ownerCard, onClose }: Pick<SiteCardProps,
  'site' | 'activity' | 'traffic' | 'shared' | 'ownerCard'> & { onClose: () => void }) {
  const rows = [
    ['格式', SITE_FORM_REGISTRY[resolveSiteForm(site)].label],
    ['来源', siteSourceLabel(site.sourceType)],
    ['文件大小', `${fmtSize(site.totalSize)}（${site.totalSize.toLocaleString('zh-CN')} 字节）`],
    ['原累计浏览', `${site.viewCount} 次（旧口径）`],
    ['已发布的内容修改', activity === undefined ? '统计暂不可用' : `${activity.editCount} 次`],
    ['分享状态', shared === undefined ? '统计暂不可用' : shared ? '已分享' : '未分享'],
    ['有效分享链接', traffic === undefined ? '统计暂不可用' : `${traffic.activeShareLinks} 条`],
    ['创建时间', timestamp(site.createdAt)],
    ['更新时间', timestamp(site.updatedAt)],
    ['公开页展示', site.visibility === 'public' ? '已公开' : '未公开'],
    ['团队共享', site.sharedTeamIds?.length ? `已共享到 ${site.sharedTeamIds.length} 个团队` : '未共享到团队'],
    ...(ownerCard ? [['作者', ownerCard.displayName]] : []),
    ['分组', site.folder || '未分组'],
    ['入口文件', site.entryFile],
  ];
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title="网页详情" maxWidth={840}
    contentStyle={{ maxHeight: 'calc(100dvh - 48px)' }}
    content={<div data-site-details data-no-drag className="space-y-4 text-xs text-token-secondary" style={{ overflowWrap: 'anywhere' }}>
      <div>
        <h2 className="whitespace-pre-wrap text-sm font-semibold text-token-primary">{site.title}</h2>
        <p className="mt-2 whitespace-pre-wrap">{site.description || '暂无描述'}</p>
      </div>
      <div aria-label="全部标签" className="flex flex-wrap gap-1.5">
        {site.tags.length ? site.tags.map((tag) => <span key={tag} className="rounded px-2 py-1" style={{ background: 'var(--bg-secondary)' }}>{tag}</span>) : <span>暂无标签</span>}
      </div>
      <div data-site-details-columns className="grid items-start gap-4 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <TabsPrimitive.Root defaultValue="info" className="min-w-0">
          <TabsPrimitive.List aria-label="网页详情内容" className="mb-3 flex gap-4 border-b border-token-default">
            {[{ value: 'info', label: '基本信息' }, { value: 'files', label: `文件 · ${site.files.length}` }].map((tab) => (
              <TabsPrimitive.Trigger key={tab.value} value={tab.value}
                className="border-b-2 border-transparent pb-2 text-token-muted data-[state=active]:border-current data-[state=active]:font-medium data-[state=active]:text-token-primary">
                {tab.label}
              </TabsPrimitive.Trigger>
            ))}
          </TabsPrimitive.List>
          <TabsPrimitive.Content value="info" className="outline-none">
            <dl className="rounded-lg border border-token-default px-3">
              {rows.map(([label, value]) => <div key={label} className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 border-b py-2 last:border-b-0"
                style={{ borderColor: 'var(--border-subtle)' }}>
                <dt className="text-token-muted">{label}</dt><dd className="whitespace-pre-wrap text-token-primary">{value}</dd>
              </div>)}
            </dl>
            <p className="mt-3 text-token-muted">编辑次数仅统计成功发布的内容修改和版本回退，不含草稿、重传、标题或设置修改。</p>
          </TabsPrimitive.Content>
          <TabsPrimitive.Content value="files" className="outline-none">
            <section aria-label="完整文件列表">
              <ul className="space-y-2">
                {site.files.map((file) => <li key={file.path} className="rounded border border-token-default px-3 py-2">
                  <div className="whitespace-pre-wrap text-token-primary">{file.path}</div>
                  <div className="mt-1 text-token-muted">{file.size.toLocaleString('zh-CN')} 字节 · {file.mimeType}</div>
                </li>)}
              </ul>
            </section>
          </TabsPrimitive.Content>
        </TabsPrimitive.Root>
        <section aria-label="访问统计" className="min-w-0 space-y-3">
          {([['all', '全部访问（含作者）'], ['external', '外部访问（不含已登录作者）']] as const).map(([key, label]) => {
            const value = traffic?.[key];
            return <section key={key} aria-label={label} className="rounded-lg border border-token-default px-3 py-2">
              <h3 className="mb-2 font-medium text-token-primary">{label}</h3>
              <dl className="space-y-2">
                {[
                  ['访问次数', value ? `${value.visits} 次` : '统计暂不可用'],
                  ['独立访客', value ? `${value.visitors} 位` : '统计暂不可用'],
                  ['最近访问', value ? timestamp(value.lastViewedAt ?? undefined) : '统计暂不可用'],
                ].map(([name, text]) => <div key={name} className="grid grid-cols-[64px_minmax(0,1fr)] md:grid-cols-[80px_minmax(0,1fr)] gap-3"><dt className="text-token-muted">{name}</dt><dd className="text-token-primary">{text}</dd></div>)}
              </dl>
            </section>;
          })}
          <p className="text-token-muted">按保留的记录合并站内和分享访问，同一访客每30分钟时段计一次。登录访客按账号、匿名访客按IP去重；匿名访问无法确认是否作者本人。合集访问归属其包含的网页。原累计浏览保留旧口径，不与此处相加。</p>
        </section>
      </div>
    </div>} />;
}
