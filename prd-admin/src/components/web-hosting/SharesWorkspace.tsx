import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Copy, Lock, RefreshCw, Search, Share2, X } from 'lucide-react';
import type { HostedSite, ShareLinkItem } from '@/services/real/webPages';
import { listSiteShares, renewSiteShare, revokeSiteShare } from '@/services';
import { toast } from '@/lib/toast';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { buildLedgerConclusion, buildShareLedger, filterShareLinks, type ShareTier } from './shareLedger';
import { daysUntil } from './siteConclusion';

const VISIBILITY_LABELS: Record<string, string> = {
  'owner-only': '仅我可见',
  'logged-in': '登录可见',
  public: '公开',
};

/**
 * 三层的表头分隔说明。设计稿在每个分段的右侧写一句「这一层还能做什么」——
 * 这正是三层要分开的理由，写在这里比让用户自己从按钮推断要直接。
 */
const TIER_META: Record<ShareTier, { label: string; hint: string }> = {
  active: { label: '有效', hint: '' },
  expired: { label: '已过期', hint: '内容仍在，续期即可复活' },
  revoked: { label: '已撤销', hint: '不可续期，只能重新分享' },
};

function relTime(iso?: string): string {
  if (!iso) return '从未';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '从未';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '昨天';
  return `${day} 天前`;
}

function dateLabel(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/**
 * 分享档主屏（设计稿屏 6）—— 后台第二档，回答「谁在看」。
 *
 * 三层同屏而不是 tab 切换：三者能做的事不同（有效可续可撤 / 过期续期即复活 /
 * 撤销不可逆只能重发），但用户需要**一眼看到全景**再决定先处理哪条。
 * 做成 tab 的话每次只看得到一层，"我到底还有几条链接在外面"这个问题要点三次才答得上。
 * 右上角那组按钮因此是**筛选**（点了只看某一层），不是导航。
 *
 * 续期与撤销都在链接行内就地完成，不跳页。
 */
export function SharesWorkspace({
  sites,
  links,
  onLinksChange,
  onOpenAnalytics,
  onCreateShare,
}: {
  sites: HostedSite[];
  links: ShareLinkItem[];
  onLinksChange: (next: ShareLinkItem[]) => void;
  onOpenAnalytics: () => void;
  /** 没有任何链接时的引导按钮：回资产库挑一个站点分享 */
  onCreateShare: () => void;
}) {
  const [loading, setLoading] = useState(links.length === 0);
  /** null = 三层全看（默认）；选中某层 = 只看那一层 */
  const [only, setOnly] = useState<ShareTier | null>(null);
  const [keyword, setKeyword] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const fetchIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const myId = ++fetchIdRef.current;
    setLoading(true);
    try {
      // includeRevoked：已撤销那一层的数据源。不传的话后端直接过滤掉，
      // 这一层会永远是空的——判据在、数据不在。
      const res = await listSiteShares(true);
      if (myId !== fetchIdRef.current) return; // 慢响应不覆盖新结果
      if (res.success) onLinksChange(res.data.items);
    } finally {
      if (myId === fetchIdRef.current) setLoading(false);
    }
  }, [onLinksChange]);

  useEffect(() => { void refresh(); }, [refresh]);

  const ledger = useMemo(() => buildShareLedger(links), [links]);
  const conclusion = useMemo(() => buildLedgerConclusion(links), [links]);

  /**
   * 「指向的站点」这一列。优先用后端下发的 siteTitles（列表接口批量查好的），
   * 拿不到才回退到本页已加载的 sites —— 分享档可能显示的是资产库当前页没加载的站点。
   */
  const siteLabel = useCallback(
    (l: ShareLinkItem) => {
      if (l.shareType === 'collection') return `合集 · ${l.siteIds?.length ?? 0} 个站点`;
      if (l.siteTitles?.length) return l.siteTitles[0];
      const sid = l.siteId ?? l.siteIds?.[0];
      return sites.find((s) => s.id === sid)?.title ?? '站点已删除';
    },
    [sites],
  );

  const handleRenew = async (link: ShareLinkItem) => {
    setBusyId(link.id);
    try {
      const res = await renewSiteShare(link.id, 7);
      if (res.success) {
        onLinksChange(links.map((l) => (l.id === link.id
          ? { ...l, expiresAt: res.data.newExpiresAt, isExpired: false, inGracePeriod: false, renewalCount: (l.renewalCount ?? 0) + 1 }
          : l)));
        toast.success('已续期 7 天');
      } else {
        toast.error(res.error?.message ?? '续期失败');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleRevoke = async (link: ShareLinkItem) => {
    // 撤销不可逆，走二级确认
    if (!confirm(`撤销「${link.title || '未命名链接'}」？撤销后任何人都打不开，且不可恢复，只能重新分享。`)) return;
    setBusyId(link.id);
    try {
      const res = await revokeSiteShare(link.id);
      if (res.success) {
        onLinksChange(links.map((l) => (l.id === link.id
          ? { ...l, isRevoked: true, revokedAt: new Date().toISOString() }
          : l)));
        toast.success('已撤销');
      } else {
        toast.error(res.error?.message ?? '撤销失败');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleCopy = async (link: ShareLinkItem) => {
    const url = `${window.location.origin}${sharePath(link)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('链接已复制');
    } catch {
      toast.error('复制失败，请手动复制：' + url);
    }
  };

  const tiers: ShareTier[] = only ? [only] : ['active', 'expired', 'revoked'];
  const visible = (t: ShareTier) => filterShareLinks(ledger[t], keyword);
  const totalVisible = tiers.reduce((n, t) => n + visible(t).length, 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-tour-id="webpages-shares-workspace">
      {/* 标题 + 口径 + 三层筛选 + 搜索 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>我创建的分享</div>
          <div className="mt-0.5 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
            口径：有效 = 未过期且未撤销
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg p-0.5" style={{ background: 'var(--bg-tertiary)' }}>
            {(['active', 'expired', 'revoked'] as ShareTier[]).map((t) => {
              const on = only === t;
              return (
                <button
                  key={t}
                  type="button"
                  // 再点一次取消筛选回到全景——这组是筛选不是导航，必须能退出
                  onClick={() => setOnly(on ? null : t)}
                  className="rounded-md px-2.5 py-1 text-xs"
                  style={{
                    background: on ? 'var(--accent-primary)' : 'transparent',
                    color: on ? 'var(--accent-on-solid)' : 'var(--text-secondary)',
                    fontWeight: on ? 600 : 400,
                  }}
                >
                  {TIER_META[t].label} {ledger[t].length}
                </button>
              );
            })}
          </div>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索链接或站点"
              className="rounded-lg py-1.5 pl-8 pr-3 text-xs outline-none"
              style={{ width: 200, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
            />
          </div>
        </div>
      </div>

      {/* 结论先行：数字可点，点了筛到对应层 */}
      <div
        className="rounded-xl px-4 py-3 text-[13px] leading-relaxed"
        style={{ background: 'var(--semantic-warning-soft)', border: '1px solid var(--semantic-warning-border)', color: 'var(--text-secondary)' }}
      >
        {conclusion.map((seg, i) =>
          seg.drillTo ? (
            <button
              key={i}
              type="button"
              onClick={() => setOnly(seg.drillTo as ShareTier)}
              className="underline decoration-dotted underline-offset-2"
              style={{ color: seg.tone === 'warn' ? 'var(--semantic-warning-text)' : 'var(--text-primary)', fontWeight: 600 }}
            >
              {seg.text}
            </button>
          ) : (
            <span key={i} style={seg.tone === 'strong' ? { color: 'var(--text-primary)', fontWeight: 600 } : undefined}>
              {seg.text}
            </span>
          ),
        )}
      </div>

      {loading && links.length === 0 ? (
        <MapSectionLoader text="正在读取分享链接…" />
      ) : links.length === 0 ? (
        <EmptyState onCreateShare={onCreateShare} />
      ) : totalVisible === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
          {keyword.trim() ? `没有匹配「${keyword.trim()}」的链接` : '这一层是空的'}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          <table className="w-full" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['标题 / 链接', '指向的站点', '可见性', '密码', '浏览', '过期 / 最后访问', '操作'].map((h, i) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-[11px] font-normal"
                    style={{
                      textAlign: i >= 4 && i <= 5 ? 'right' : i === 6 ? 'right' : 'left',
                      color: 'var(--text-muted)',
                      borderBottom: '1px solid var(--border-subtle)',
                      position: 'sticky',
                      top: 0,
                      background: 'var(--bg-base)',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => {
                const rows = visible(t);
                if (rows.length === 0) return null;
                return (
                  <TierSection
                    key={t}
                    tier={t}
                    rows={rows}
                    // 全景时才画分段标题；只看一层时上面的筛选按钮已经说明是哪一层了
                    showHeading={only === null && t !== 'active'}
                    siteLabel={siteLabel}
                    busyId={busyId}
                    onRenew={handleRenew}
                    onRevoke={handleRevoke}
                    onCopy={handleCopy}
                    onAnalytics={onOpenAnalytics}
                    onReshare={onCreateShare}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 脚注：把两个不可逆/留痕的语义说清楚，省得用户点之前来问 */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 text-[11px]" style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
        <span>续期会写入续期历史（谁在什么时候续了多久），撤销不可逆——两者都在链接行内就地完成，不跳页。</span>
        <span>共 {links.length} 条 · 按最后访问排序</span>
      </div>
    </div>
  );
}

/** 长链地址：短链号存在时优先用它（更短、可口述） */
function sharePath(l: ShareLinkItem): string {
  if (l.shareType === 'collection') return `/s/wp/c/${l.token}`;
  return l.shortSeq ? `/s/wp/${l.shortSeq}` : `/s/wp/${l.token}`;
}

function TierSection({
  tier, rows, showHeading, siteLabel, busyId, onRenew, onRevoke, onCopy, onAnalytics, onReshare,
}: {
  tier: ShareTier;
  rows: ShareLinkItem[];
  showHeading: boolean;
  siteLabel: (l: ShareLinkItem) => string;
  busyId: string | null;
  onRenew: (l: ShareLinkItem) => void;
  onRevoke: (l: ShareLinkItem) => void;
  onCopy: (l: ShareLinkItem) => void;
  onAnalytics: () => void;
  onReshare: () => void;
}) {
  const meta = TIER_META[tier];
  const dim = tier !== 'active';

  return (
    <>
      {showHeading && (
        <tr>
          <td colSpan={7} className="px-3 pb-1.5 pt-5">
            <div className="flex items-center justify-between gap-3">
              <span
                className="text-[12px] font-semibold"
                style={{ color: tier === 'revoked' ? 'var(--accent-fg-danger)' : 'var(--text-secondary)' }}
              >
                {meta.label} · {rows.length}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{meta.hint}</span>
            </div>
            <div className="mt-1.5" style={{ borderTop: '1px dashed var(--border-default)' }} />
          </td>
        </tr>
      )}
      {rows.map((l) => {
        const days = daysUntil(l.expiresAt, Date.now());
        const busy = busyId === l.id;
        return (
          <tr key={l.id} style={{ opacity: dim ? 0.62 : 1 }}>
            <td className="px-3 py-2.5" style={{ borderBottom: '1px solid var(--border-faint)' }}>
              <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)', maxWidth: 240 }}>
                {l.title || '未命名链接'}
              </div>
              <div className="mt-0.5 font-mono text-[11px] truncate" style={{ color: 'var(--text-muted)', maxWidth: 240 }}>
                {sharePath(l)}
              </div>
            </td>
            <td className="px-3 py-2.5 text-[12px]" style={{ borderBottom: '1px solid var(--border-faint)', color: 'var(--text-secondary)' }}>
              <span className="truncate inline-block align-bottom" style={{ maxWidth: 180 }}>{siteLabel(l)}</span>
            </td>
            <td className="px-3 py-2.5" style={{ borderBottom: '1px solid var(--border-faint)' }}>
              <span
                className="rounded px-1.5 py-0.5 text-[11px]"
                style={{
                  background: l.visibility === 'public' ? 'var(--semantic-warning-soft)' : 'var(--bg-tertiary)',
                  color: l.visibility === 'public' ? 'var(--semantic-warning-text)' : 'var(--text-secondary)',
                }}
              >
                {VISIBILITY_LABELS[l.visibility ?? 'public'] ?? '公开'}
              </span>
            </td>
            <td className="px-3 py-2.5" style={{ borderBottom: '1px solid var(--border-faint)' }}>
              {l.accessLevel === 'password'
                ? <Lock size={13} style={{ color: 'var(--accent-fg-emerald)' }} />
                : <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>无</span>}
            </td>
            <td className="px-3 py-2.5 text-right" style={{ borderBottom: '1px solid var(--border-faint)' }}>
              <span className="text-[15px] font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>{l.viewCount ?? 0}</span>
            </td>
            <td className="px-3 py-2.5 text-right" style={{ borderBottom: '1px solid var(--border-faint)' }}>
              {tier === 'revoked' ? (
                <>
                  <div className="text-[12px]" style={{ color: 'var(--accent-fg-danger)' }}>
                    {l.revokedAt ? `${dateLabel(l.revokedAt)}撤销` : '已撤销'}
                  </div>
                  {l.revokedReason && (
                    <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>{l.revokedReason}</div>
                  )}
                </>
              ) : (
                <>
                  <div
                    className="text-[12px]"
                    style={{ color: days !== null && days <= 7 ? 'var(--semantic-warning-text)' : 'var(--text-secondary)' }}
                  >
                    {tier === 'expired'
                      ? `${dateLabel(l.expiresAt)}过期`
                      : days === null ? '永久有效' : `剩 ${days} 天`}
                  </div>
                  <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    最后访问 {relTime(l.lastViewedAt)}
                  </div>
                </>
              )}
            </td>
            <td className="px-3 py-2.5" style={{ borderBottom: '1px solid var(--border-faint)' }}>
              <div className="flex items-center justify-end gap-1.5">
                {tier === 'revoked' ? (
                  <RowButton onClick={onReshare}><Share2 size={11} className="mr-1" />重新分享</RowButton>
                ) : (
                  <>
                    <RowButton onClick={() => onRenew(l)} disabled={busy} accent={days !== null && days <= 7}>
                      {busy ? <RefreshCw size={11} className="animate-spin" /> : '续期'}
                    </RowButton>
                    {tier === 'expired' && (l.renewalCount ?? 0) > 0 && (
                      <span className="text-[11px] whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                        续期历史 {l.renewalCount} 次
                      </span>
                    )}
                    {tier === 'active' && (
                      <>
                        <RowButton onClick={onAnalytics}><BarChart3 size={11} className="mr-1" />数据</RowButton>
                        <RowButton onClick={() => onCopy(l)}><Copy size={11} className="mr-1" />复制</RowButton>
                        <RowButton onClick={() => onRevoke(l)} disabled={busy} danger aria-label="撤销">
                          <X size={12} />
                        </RowButton>
                      </>
                    )}
                  </>
                )}
              </div>
            </td>
          </tr>
        );
      })}
    </>
  );
}

function RowButton({
  children, onClick, disabled, danger, accent, ...rest
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** 快到期那条的续期按钮走强调色——这一屏最该先点的就是它 */
  accent?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center rounded-md px-2 py-1 text-[11.5px] whitespace-nowrap"
      style={{
        border: `1px solid ${danger ? 'var(--semantic-danger-border)' : accent ? 'var(--semantic-warning-border)' : 'var(--border-default)'}`,
        background: accent ? 'var(--semantic-warning-soft)' : 'transparent',
        color: danger ? 'var(--accent-fg-danger)' : accent ? 'var(--semantic-warning-text)' : 'var(--text-secondary)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

function EmptyState({ onCreateShare }: { onCreateShare: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <Share2 size={28} style={{ color: 'var(--text-muted)' }} />
      <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
        你还没有创建过任何分享链接
      </div>
      <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
        想让别人打开某个站点，从站点卡片上的「分享」开始
      </div>
      <button
        type="button"
        onClick={onCreateShare}
        className="mt-1 rounded-lg px-4 py-2 text-[12.5px]"
        style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-solid)' }}
      >
        去资产库挑一个站点
      </button>
    </div>
  );
}
