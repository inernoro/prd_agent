import { BarChart3, Eye, Link2, Lock, Plus, RefreshCw } from 'lucide-react';
import type { HostedSite, ShareLinkItem } from '@/services/real/webPages';
import { SitePreview } from '@/components/SitePreview';
import { PdfThumbnail, isPdfSite } from '@/components/PdfThumbnail';
import { buildSiteConclusion, daysUntil, linksOfSite } from './siteConclusion';

const VISIBILITY_LABELS: Record<string, string> = {
  'owner-only': '仅我可见',
  'logged-in': '登录可见',
  public: '公开',
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 右栏「站点上下文」—— 主控台里回答「这个站点现在对外是什么样」的那一块。
 *
 * 第一行永远是一句挂着可点数字的判断，不是一排让人自己算的指标（conclusion-before-numbers）。
 * 下面才是这个站点名下的链接清单与「再建一条」。
 */
export function SiteContextPanel({
  site,
  links,
  onCreateShare,
  onManageShares,
  onAnalytics,
  onGuestPreview,
  onRenew,
}: {
  site: HostedSite | null;
  /** 当前用户的全部分享链接；面板内部按站点筛 */
  links: ShareLinkItem[];
  onCreateShare: (site: HostedSite) => void;
  onManageShares: (site: HostedSite) => void;
  onAnalytics: () => void;
  onGuestPreview: (site: HostedSite) => void;
  onRenew: (link: ShareLinkItem) => void;
}) {
  if (!site) {
    return (
      <aside
        className="hidden w-[280px] shrink-0 flex-col gap-3 rounded-xl p-3 xl:flex"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="text-[11px] font-semibold text-token-muted">站点上下文</div>
        <p className="text-[12px] leading-relaxed text-token-secondary">
          选中一张卡片，这里会告诉你它对外是什么样：还有几条链接活着、快过期了没、有没有人在看。
        </p>
      </aside>
    );
  }

  const siteLinks = linksOfSite(links, site.id);
  const conclusion = buildSiteConclusion(siteLinks);
  const activeLinks = siteLinks.filter((l) => !l.isRevoked && !l.isExpired);
  const now = Date.now();

  return (
    <aside
      className="hidden w-[280px] shrink-0 flex-col gap-3 overflow-y-auto rounded-xl p-3 xl:flex"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', overscrollBehavior: 'contain' }}
    >
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold text-token-muted">站点上下文</div>
        <button
          type="button"
          onClick={() => onGuestPreview(site)}
          className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium"
          style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
          title="以访客身份打开这个站点，看到的和真实访客一样"
        >
          <Eye size={11} /> 访客视角
        </button>
      </div>

      <div className="overflow-hidden rounded-lg" style={{ aspectRatio: '16 / 10', background: 'var(--bg-tertiary)' }}>
        {isPdfSite(site) ? (
          <PdfThumbnail
            sizeBytes={site.files.find((f) => f.path?.toLowerCase().endsWith('.pdf'))?.size ?? site.totalSize}
            className="h-full w-full"
          />
        ) : (
          <SitePreview site={site} url={site.siteUrl} className="h-full w-full" />
        )}
      </div>

      <div>
        <div className="line-clamp-2 text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{site.title}</div>
        <div className="mt-0.5 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {fmtSize(site.totalSize)} · {site.viewCount} 浏览
        </div>
      </div>

      {/* 结论先行：一句挂着可点数字的判断 */}
      <div
        className="rounded-lg p-2.5 text-[12px] leading-relaxed"
        style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
      >
        {conclusion.segments.map((seg, i) =>
          seg.drillTo ? (
            <button
              key={i}
              type="button"
              onClick={() => (seg.drillTo === 'analytics' ? onAnalytics() : onManageShares(site))}
              className="underline decoration-dotted underline-offset-2"
              style={{
                color: seg.tone === 'warn' ? 'var(--semantic-warning-text)' : 'var(--text-primary)',
                fontWeight: 600,
              }}
            >
              {seg.text}
            </button>
          ) : (
            <span key={i}>{seg.text}</span>
          ),
        )}
      </div>

      {activeLinks.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] font-semibold text-token-muted">这个站点的链接</div>
          {activeLinks.map((l) => {
            const days = daysUntil(l.expiresAt, now);
            return (
              <div
                key={l.id}
                className="rounded-lg p-2"
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
              >
                <div className="flex items-center gap-1.5">
                  <Link2 size={11} style={{ color: 'var(--text-muted)' }} />
                  <span className="truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                    {l.title || '未命名链接'}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {VISIBILITY_LABELS[l.visibility ?? 'owner-only'] ?? l.visibility}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  <span>{l.viewCount} 次</span>
                  <span aria-hidden>·</span>
                  <span style={days !== null && days <= 3 ? { color: 'var(--semantic-warning-text)' } : undefined}>
                    {days === null ? '永久' : `剩 ${days} 天`}
                  </span>
                  {(l.accessLevel === 'password' || l.password) && (
                    <>
                      <span aria-hidden>·</span>
                      <Lock size={9} />
                      <span>有密码</span>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => onRenew(l)}
                    className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5"
                    style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}
                  >
                    <RefreshCw size={9} /> 续期
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={() => onCreateShare(site)}
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg text-[12px] font-semibold"
        style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-solid)' }}
      >
        <Plus size={13} /> {conclusion.empty ? '创建分享链接' : '再建一条链接'}
      </button>

      <button
        type="button"
        onClick={onAnalytics}
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg text-[12px]"
        style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
      >
        <BarChart3 size={13} /> 看访问数据
      </button>
    </aside>
  );
}
