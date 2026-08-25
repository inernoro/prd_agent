import { Link2 } from 'lucide-react';
import type { HostedSite, ShareLinkItem } from '@/services/real/webPages';
import { SitePreview } from '@/components/SitePreview';
import { PdfThumbnail, isPdfSite } from '@/components/PdfThumbnail';
import { buildSiteConclusion, daysUntil, linksOfSite } from './siteConclusion';
import { fmtSize, relativeTime } from './siteFormat';
import type { PulseItem } from './weeklyPulse';

const VISIBILITY_LABELS: Record<string, string> = {
  'owner-only': '仅我可见',
  'logged-in': '登录可见',
  public: '公开',
};

const PULSE_DOT: Record<PulseItem['tone'], string> = {
  success: 'var(--accent-fg-success)',
  violet: 'var(--accent-fg-violet)',
  warn: 'var(--accent-fg-warning)',
};

/** 分节眉标：mono 10px + 0.12em 字距，设计稿全篇同一档 */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: 'var(--font-code)',
      fontSize: 10,
      letterSpacing: 'var(--tracking-eyebrow)',
      color: 'var(--text-tertiary)',
    }}>
      {children}
    </div>
  );
}

function PulseList({ items }: { items: PulseItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col" style={{ gap: 6 }}>
      <Eyebrow>本周分享动态</Eyebrow>
      <div>
        {items.map((p) => (
          <div key={p.key} className="flex items-baseline" style={{ gap: 7, fontSize: 12, lineHeight: '20px', color: 'var(--text-secondary)' }}>
            <span aria-hidden style={{ color: PULSE_DOT[p.tone] }}>·</span>
            <span>{p.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const RAIL_STYLE: React.CSSProperties = {
  width: 300,
  padding: 14,
  background: 'var(--bg-rail)',
  borderLeft: '1px solid var(--border-subtle)',
  overscrollBehavior: 'contain',
};

/**
 * 右栏「站点上下文」—— 主控台里回答「这个站点现在对外是什么样」的那一块（设计稿屏 1·右栏）。
 *
 * 自上而下：眉标 → 站点卡（缩略图 + 标题 + 大小/更新时间）→ 结论块 → 链接清单 →
 * 再建一条 → 本周分享动态。
 *
 * 第一行永远是一句挂着可点数字的判断，不是一排让人自己算的指标（conclusion-before-numbers）。
 * 「访客视角」不在这一栏 —— 顶栏的「以访客身份预览」作用于同一个 contextSite，
 * 摆两个入口只是重复（设计稿此处也没有）。
 */
export function SiteContextPanel({
  site,
  links,
  visitorCount,
  pulse,
  onCreateShare,
  onManageShares,
  onAnalytics,
  onRenew,
}: {
  site: HostedSite | null;
  /** 当前用户的全部分享链接；面板内部按站点筛 */
  links: ShareLinkItem[];
  /** 该站点的去重访客数（列表接口的 visitors 映射）；拿不到就不写「N 位访客」那半句 */
  visitorCount?: number;
  /** 本周分享动态（页面按真实数据算好传进来） */
  pulse: PulseItem[];
  onCreateShare: (site: HostedSite) => void;
  onManageShares: (site: HostedSite) => void;
  onAnalytics: () => void;
  onRenew: (link: ShareLinkItem) => void;
}) {
  if (!site) {
    return (
      <aside className="hidden shrink-0 flex-col gap-3 overflow-y-auto xl:flex" style={RAIL_STYLE}>
        <Eyebrow>站点上下文</Eyebrow>
        <p style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
          选中一张卡片，这里会告诉你它对外是什么样：还有几条链接活着、快过期了没、有没有人在看。
        </p>
        <PulseList items={pulse} />
      </aside>
    );
  }

  const siteLinks = linksOfSite(links, site.id);
  const now = Date.now();
  const conclusion = buildSiteConclusion(siteLinks, now, visitorCount);
  const activeLinks = siteLinks.filter((l) => !l.isRevoked && !l.isExpired);

  return (
    <aside className="hidden shrink-0 flex-col overflow-y-auto xl:flex" style={{ ...RAIL_STYLE, gap: 12 }}>
      <Eyebrow>站点上下文 · 最近动过</Eyebrow>

      {/* 站点卡：缩略图与标题在同一张卡里，不是一张裸图加两行字 */}
      <div style={{
        background: 'var(--bg-site-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-card)',
        overflow: 'hidden',
      }}>
        <div style={{ aspectRatio: '16 / 10', background: 'var(--bg-tertiary)' }}>
          {isPdfSite(site) ? (
            <PdfThumbnail
              sizeBytes={site.files.find((f) => f.path?.toLowerCase().endsWith('.pdf'))?.size ?? site.totalSize}
              className="h-full w-full"
            />
          ) : (
            <SitePreview site={site} url={site.siteUrl} className="h-full w-full" />
          )}
        </div>
        <div style={{ padding: 10 }}>
          <div
            className="line-clamp-2"
            style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: 'var(--tracking-title)', color: 'var(--text-primary)' }}
          >
            {site.title}
          </div>
          <div style={{
            marginTop: 3,
            fontFamily: 'var(--font-code)',
            fontSize: 10,
            letterSpacing: 'var(--tracking-meta)',
            color: 'var(--text-tertiary)',
          }}>
            {fmtSize(site.totalSize)} · 更新于 {relativeTime(site.updatedAt, now)}
          </div>
        </div>
      </div>

      {/* 结论先行：一句挂着可点数字的判断。数字放大一档走 display 字族，
          「快过期」用警告色行内强调 —— 两者是不同的语义层，不能都做成加粗。 */}
      <div style={{
        background: 'var(--info-callout-bg)',
        border: '1px solid var(--info-callout-border)',
        borderRadius: 'var(--radius-field)',
        padding: 10,
        fontSize: 12.5,
        lineHeight: 1.75,
        color: 'var(--text-secondary)',
      }}>
        {conclusion.segments.map((seg, i) => {
          if (!seg.drillTo) return <span key={i}>{seg.text}</span>;
          const numeric = seg.numeric === true;
          return (
            <button
              key={i}
              type="button"
              onClick={() => (seg.drillTo === 'analytics' ? onAnalytics() : onManageShares(site))}
              className="underline decoration-dotted underline-offset-2"
              style={numeric
                ? {
                    fontFamily: 'var(--font-display)',
                    fontSize: 16,
                    letterSpacing: 'var(--tracking-number)',
                    // 链接条数那一档跟 callout 同族的蓝（两个主题分别是 #93c5fd / #1d4ed8），
                    // 访问与访客数走正文主色 —— 量自设计稿深浅两块画板，不是随手挑的强调色
                    color: seg.tone === 'info' ? 'var(--accent-fg-blue)' : 'var(--text-primary)',
                  }
                : { color: 'var(--accent-fg-warning)' }}
            >
              {seg.text}
            </button>
          );
        })}
      </div>

      {activeLinks.length > 0 && (
        <div className="flex flex-col" style={{ gap: 6 }}>
          <Eyebrow>这条站点的链接</Eyebrow>
          {activeLinks.map((l) => {
            const days = daysUntil(l.expiresAt, now);
            const hasPassword = l.accessLevel === 'password' || Boolean(l.password);
            const expiringSoon = days !== null && days <= 3;
            return (
              <div
                key={l.id}
                className="flex items-center"
                style={{
                  gap: 8,
                  padding: '8px 9px',
                  background: 'var(--bg-site-card)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-control)',
                }}
              >
                <Link2 size={13} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate" style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                    {(l.title || '未命名链接')} · {VISIBILITY_LABELS[l.visibility ?? 'owner-only'] ?? l.visibility}
                  </div>
                  <div style={{
                    fontFamily: 'var(--font-code)',
                    fontSize: 9.5,
                    color: 'var(--text-tertiary)',
                  }}>
                    {l.viewCount} 次 · {days === null ? '永久' : `剩 ${days} 天`} · {hasPassword ? '有密码' : '无密码'}
                  </div>
                </div>
                {/* 快过期的那条给「续期」，其余给「数据」——同一个位置按当下最该做的事换动作 */}
                <button
                  type="button"
                  onClick={() => (expiringSoon ? onRenew(l) : onAnalytics())}
                  className="shrink-0"
                  style={{ fontSize: 11, color: expiringSoon ? 'var(--accent-fg-warning)' : 'var(--text-muted)' }}
                  title={expiringSoon ? `「${l.title || '未命名链接'}」${days} 天后过期，点这里续期` : '看这条链接的访问数据'}
                >
                  {expiringSoon ? '续期' : '数据'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={() => onCreateShare(site)}
        className="inline-flex items-center justify-center transition-colors"
        style={{
          height: 32,
          fontSize: 12,
          borderRadius: 'var(--radius-control)',
          border: '1px solid var(--border-strong)',
          color: 'var(--text-secondary)',
          background: 'transparent',
        }}
      >
        {conclusion.empty ? '创建分享链接' : '再建一条链接'}
      </button>

      <PulseList items={pulse} />
    </aside>
  );
}
