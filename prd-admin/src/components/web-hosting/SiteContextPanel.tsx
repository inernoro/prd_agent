import { Eye, Link2, Plus, Share2, Trash2 } from 'lucide-react';
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

/** 右栏三态共用的外壳（宽度 / 底色 / 左描边 / 内边距都在这里，不各写一份） */
function RailShell({ gap = 12, children }: { gap?: number; children: React.ReactNode }) {
  return (
    <aside className="hidden shrink-0 flex-col overflow-y-auto xl:flex" style={{ ...RAIL_STYLE, gap }}>
      {children}
    </aside>
  );
}

/** 三态都在底部收口的「取消选择」；描边态，不抢主操作 */
function ClearSelectionButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 32,
        fontSize: 12.5,
        borderRadius: 'var(--radius-control)',
        border: '1px solid var(--border-subtle)',
        background: 'transparent',
        color: 'var(--text-muted)',
      }}
    >
      取消选择
    </button>
  );
}

/**
 * 选中恰好一个站点时的右栏（设计稿屏 1 的 `oneSelected` 态）。
 *
 * 这一态回答的不是「这个站点怎么样」（那是 noSelection 态的事），而是
 * 「我选中它，现在要拿它做什么」—— 所以主操作是以访客身份看一眼，其次是管理它的分享。
 */
export function SiteSelectionPanel({
  site,
  links,
  visitorCount,
  onGuestPreview,
  onManageShares,
  onCreateShare,
  onClearSelection,
}: {
  site: HostedSite;
  links: ShareLinkItem[];
  visitorCount?: number;
  onGuestPreview: (site: HostedSite) => void;
  onManageShares: (site: HostedSite) => void;
  onCreateShare: (site: HostedSite) => void;
  onClearSelection: () => void;
}) {
  const siteLinks = linksOfSite(links, site.id);
  const active = siteLinks.filter((l) => !l.isRevoked && !l.isExpired);
  const views = active.reduce((sum, l) => sum + (l.viewCount ?? 0), 0);
  // 没有任何有效链接时，「以访客身份预览这条链接」指着一条不存在的链接，
  // 「管理分享」也没东西可管 —— 这一屏对用户就是空转。这种时候该做的事只有一件：先建一条。
  const hasLink = active.length > 0;

  return (
    <RailShell gap={11}>
      <div style={{
        fontFamily: 'var(--font-code)',
        fontSize: 10,
        letterSpacing: 'var(--tracking-eyebrow)',
        color: 'var(--accent-gold-2)',
      }}>
        选中的站点
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.45, color: 'var(--text-primary)' }}>{site.title}</div>

      {hasLink ? (
        <>
          <button
            type="button"
            onClick={() => onGuestPreview(site)}
            className="inline-flex items-center justify-center gap-2"
            style={{
              height: 38,
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 'var(--radius-field)',
              border: '1px solid var(--info-action-border)',
              background: 'var(--info-action-bg)',
              color: 'var(--accent-fg-blue)',
            }}
          >
            <Eye size={14} /> 以访客身份预览这条链接
          </button>
          {/* 设计稿这句写的是「可切换未登录 / 已登录 / 密码未输入三种身份」——身份切换器还没做，
              照抄会承诺一个点不出来的能力，所以先写它真正做的事（no-rootless-tree）。 */}
          <div style={{ fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-muted)' }}>
            用它真实的访客链接打开，看到的和访客一样。
          </div>

          <div style={{ height: 1, background: 'var(--border-subtle)' }} />

          <button
            type="button"
            onClick={() => onManageShares(site)}
            className="inline-flex items-center justify-center"
            style={{
              height: 34,
              fontSize: 12.5,
              borderRadius: 'var(--radius-control)',
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-card)',
              color: 'var(--text-primary)',
            }}
          >
            管理分享
          </button>

          <div style={{
            fontFamily: 'var(--font-code)',
            fontSize: 10.5,
            lineHeight: 1.7,
            letterSpacing: 'var(--tracking-meta)',
            color: 'var(--text-tertiary)',
          }}>
            这条站点的链接：{active.length} 条有效
            <br />
            累计 {views} 次访问{typeof visitorCount === 'number' ? ` · ${visitorCount} 位访客` : ''}
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => onCreateShare(site)}
            className="inline-flex items-center justify-center gap-2"
            style={{
              height: 38,
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 'var(--radius-field)',
              border: '1px solid var(--accent-primary-edge)',
              background: 'var(--accent-primary)',
              color: 'var(--accent-on-primary)',
            }}
          >
            <Plus size={14} /> 创建分享链接
          </button>
          <div style={{ fontSize: 11.5, lineHeight: 1.6, color: 'var(--text-muted)' }}>
            它现在只有你自己能打开。建一条链接，才能把它发给别人，也才会开始有访问数据。
          </div>

          <div style={{ height: 1, background: 'var(--border-subtle)' }} />

          <button
            type="button"
            onClick={() => onGuestPreview(site)}
            className="inline-flex items-center justify-center gap-2"
            style={{
              height: 34,
              fontSize: 12.5,
              borderRadius: 'var(--radius-control)',
              border: '1px solid var(--border-subtle)',
              background: 'var(--bg-card)',
              color: 'var(--text-primary)',
            }}
          >
            <Eye size={13} /> 先自己看一眼
          </button>

          <div style={{
            fontFamily: 'var(--font-code)',
            fontSize: 10.5,
            lineHeight: 1.7,
            letterSpacing: 'var(--tracking-meta)',
            color: 'var(--text-tertiary)',
          }}>
            这条站点的链接：还没有
            <br />
            建一条之后，这里会显示访问次数与访客数
          </div>
        </>
      )}

      <div className="flex-1" />
      <ClearSelectionButton onClick={onClearSelection} />
    </RailShell>
  );
}

/**
 * 选中多个站点时的右栏（设计稿屏 1 的 `manySelected` 态）。
 *
 * 批量操作原本摆在列表上方的一条横条里；设计稿把它收进右栏，
 * 因为「选中了什么、能对它们做什么」是同一件事的两半，不该分在屏幕两处。
 */
export function SiteBatchPanel({
  count,
  canShare,
  canDelete,
  groupPicker,
  onBatchShare,
  onBatchDelete,
  onClearSelection,
}: {
  count: number;
  canShare: boolean;
  canDelete: boolean;
  /** 团队空间的「移入分组」选择器（页面传入，个人空间为 null——那边还没有批量移动文件夹的接口） */
  groupPicker?: React.ReactNode;
  onBatchShare: () => void;
  onBatchDelete: () => void;
  onClearSelection: () => void;
}) {
  return (
    <RailShell gap={10}>
      <div style={{
        fontFamily: 'var(--font-code)',
        fontSize: 10,
        letterSpacing: 'var(--tracking-eyebrow)',
        color: 'var(--accent-gold-2)',
      }}>
        批量操作
      </div>
      <div style={{
        fontFamily: 'var(--font-display)',
        fontSize: 30,
        lineHeight: 1,
        letterSpacing: 'var(--tracking-number)',
        color: 'var(--text-primary)',
      }}>
        {count}
        <span style={{ marginLeft: 6, fontFamily: 'var(--font-body)', fontSize: 13, letterSpacing: 0, color: 'var(--text-muted)' }}>
          个站点已选
        </span>
      </div>

      {canShare && (
        <button
          type="button"
          onClick={onBatchShare}
          className="inline-flex items-center justify-center gap-2"
          style={{
            height: 38,
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 'var(--radius-field)',
            border: '1px solid var(--accent-primary-edge)',
            background: 'var(--accent-primary)',
            color: 'var(--accent-on-primary)',
          }}
        >
          <Share2 size={14} /> 分享成一个合集
        </button>
      )}

      {groupPicker}

      {canDelete && (
        <button
          type="button"
          onClick={onBatchDelete}
          className="inline-flex items-center justify-center gap-2"
          style={{
            height: 36,
            fontSize: 13,
            borderRadius: 'var(--radius-field)',
            border: '1px solid var(--semantic-danger-border)',
            background: 'var(--semantic-danger-soft)',
            color: 'var(--accent-fg-danger)',
          }}
        >
          <Trash2 size={14} /> 删除（危险 · 需二次确认）
        </button>
      )}

      <div className="flex-1" />
      <ClearSelectionButton onClick={onClearSelection} />
    </RailShell>
  );
}

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
      <RailShell>
        <Eyebrow>站点上下文</Eyebrow>
        <p style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
          选中一张卡片，这里会告诉你它对外是什么样：还有几条链接活着、快过期了没、有没有人在看。
        </p>
        <PulseList items={pulse} />
      </RailShell>
    );
  }

  const siteLinks = linksOfSite(links, site.id);
  const now = Date.now();
  const conclusion = buildSiteConclusion(siteLinks, now, visitorCount);
  const activeLinks = siteLinks.filter((l) => !l.isRevoked && !l.isExpired);

  return (
    <RailShell>
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
    </RailShell>
  );
}
