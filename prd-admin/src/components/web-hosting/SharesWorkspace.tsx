import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Copy, Lock, RefreshCw, Search, Share2, X } from 'lucide-react';
import type { HostedSite, ShareLinkItem } from '@/services/real/webPages';
import { listSiteShares, renewSiteShare, revokeSiteShare } from '@/services';
import { toast } from '@/lib/toast';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { buildLedgerConclusion, buildShareLedger, filterShareLinks, type ShareTier } from './shareLedger';
import { daysUntil } from './siteConclusion';
import { normalizeVisibility, VISIBILITY_ACCESS_HINT, visibilityLabelOf } from './shareVisibility';

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
  // 传 siteLabel 进去：搜的就是行里显示的那个站点名，显示与搜索不会各自漂
  const visible = (t: ShareTier) => filterShareLinks(ledger[t], keyword, siteLabel);
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
        className="rounded-xl px-5 py-4 text-[14.5px] leading-relaxed"
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
            <span
              key={i}
              style={seg.tone === 'strong'
                // 纯数字段放大一档：这一句的重点就是那几个数
                ? { color: 'var(--text-primary)', fontWeight: 600, fontSize: /^\d+$/.test(seg.text) ? 22 : undefined }
                : undefined}
            >
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
        <div
          className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5"
          style={{ overscrollBehavior: 'contain' }}
        >
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

/**
 * 这条链接对外的地址。列表显示它、「复制」也复制它，所以拼错 = 用户拿到一条 404。
 *
 * 数字短链和字母长链是**两条不同的路由**：
 *   /s/{seq}       —— ShortLinkRouter，按自增号解析
 *   /s/wp/{token}  —— ShareViewPage，按 token 解析
 * 原来这里写的是 `/s/wp/{shortSeq}`：把号码塞进按 token 查的那条路由，后端查不到，
 * 实测 404（2026-08-25 现造一条带 seq 的链接验的：/shares/view/1 → 404、
 * /shares/view/{token} → 200）。
 *
 * 合集也没有单独的路由。原来写的 `/s/wp/c/{token}` 多一段路径，前端路由表里根本没有
 * 这条，直接落到 404 页——合集分享自建出来那天起，列表里给的就是死链。
 * 后端对两种 shareType 返回的都是 `/s/wp/{token}`，以它为准。
 */
export function sharePath(l: Pick<ShareLinkItem, 'token' | 'shortSeq'>): string {
  return l.shortSeq && l.shortSeq > 0 ? `/s/${l.shortSeq}` : `/s/wp/${l.token}`;
}

/**
 * 一层链接的列表。
 *
 * 原来这里是一张七列表格，用 `borderSpacing` + 逐个 `<td>` 画边框、首末格补圆角，
 * 硬拼出「一行看起来像一张卡」。列宽被最长的标题和站点名拖着走，一屏塞七列，
 * 用户扫一眼分不清哪个数字是什么（2026-08-25 用户原话：「分享列表过于丑陋」）。
 *
 * 改成真正的列表：**一条链接一行两句话**——第一句是它是什么（标题 + 指向的站点），
 * 第二句是它的状态（地址 · 谁能看 · 还剩多久 · 上次谁打开）。浏览数单独占右边一格，
 * 那是这一屏唯一值得扫的数字。操作平时不占地方，指针移到这一行才出现。
 */
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
  const now = Date.now();
  // 过期层整体压暗一档、走虚线边框（还在，但已经不生效）；撤销层走淡红
  const dashed = tier === 'expired';
  const borderColor = tier === 'revoked' ? 'var(--semantic-danger-border)' : 'var(--border-subtle)';

  return (
    <>
      {showHeading && (
        <div className="flex items-center justify-between gap-3 px-1 pb-1 pt-4">
          <span
            className="text-[12px] font-semibold"
            style={{ color: tier === 'revoked' ? 'var(--accent-fg-danger)' : 'var(--text-secondary)' }}
          >
            {meta.label} · {rows.length}
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{meta.hint}</span>
        </div>
      )}
      {rows.map((l) => {
        const days = daysUntil(l.expiresAt, now);
        const busy = busyId === l.id;
        const expiringSoon = tier === 'active' && days !== null && days <= 7;
        return (
          <div
            key={l.id}
            className="group flex items-center gap-3 rounded-xl px-3.5 py-2.5 transition-colors"
            style={{
              background: tier === 'revoked' ? 'var(--semantic-danger-soft)' : 'var(--bg-card)',
              border: `1px ${dashed ? 'dashed' : 'solid'} ${borderColor}`,
              opacity: tier === 'active' ? 1 : 0.78,
            }}
          >
            <div className="min-w-0 flex-1">
              {/* 第一句：这是什么 */}
              <div className="flex min-w-0 items-baseline gap-2">
                <span
                  className="truncate text-[13px] font-semibold"
                  style={{
                    color: 'var(--text-primary)',
                    // 撤销的标题划掉：这条链接已经不存在了，视觉上要说清楚
                    textDecoration: tier === 'revoked' ? 'line-through' : undefined,
                  }}
                >
                  {l.title || '未命名链接'}
                </span>
                {/* 链接标题默认取站点标题，两个一样时就别把同一句话写两遍 */}
                {siteLabel(l) !== (l.title || '未命名链接') && (
                  <span className="truncate text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                    {siteLabel(l)}
                  </span>
                )}
              </div>

              {/* 第二句：它现在什么状态。一行说完，不再摊成五列让人自己拼 */}
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                <span className="truncate font-mono" style={{ maxWidth: 190 }}>{sharePath(l)}</span>
                <Dot />
                <span
                  style={{ color: visibilityColor(l.visibility) }}
                  title={VISIBILITY_ACCESS_HINT[normalizeVisibility(l.visibility)]}
                >
                  {visibilityLabelOf(l.visibility)}
                </span>
                {l.accessLevel === 'password' && (
                  <>
                    <Dot />
                    <span className="inline-flex items-center gap-0.5" style={{ color: 'var(--accent-fg-emerald)' }}>
                      <Lock size={10} /> 有密码
                    </span>
                  </>
                )}
                <Dot />
                {tier === 'revoked' ? (
                  <span style={{ color: 'var(--accent-fg-danger)' }}>
                    {l.revokedAt ? `${dateLabel(l.revokedAt)}撤销` : '已撤销'}
                    {l.revokedReason ? ` · ${l.revokedReason}` : ''}
                  </span>
                ) : (
                  <span style={{ color: expiringSoon ? 'var(--semantic-warning-text)' : undefined }}>
                    {tier === 'expired'
                      ? `${dateLabel(l.expiresAt)}过期`
                      : days === null ? '永久有效' : `剩 ${days} 天`}
                  </span>
                )}
                {tier !== 'revoked' && (
                  <>
                    <Dot />
                    <span>最后访问 {relTime(l.lastViewedAt)}</span>
                  </>
                )}
                {(l.renewalCount ?? 0) > 0 && (
                  <>
                    <Dot />
                    <span>续过 {l.renewalCount} 次</span>
                  </>
                )}
              </div>
            </div>

            {/* 浏览数：这一屏唯一值得扫的数字，单独占一格 */}
            <div className="shrink-0 text-right" style={{ minWidth: 46 }}>
              <div className="text-[18px] font-semibold leading-none tabular-nums" style={{ color: 'var(--text-primary)' }}>
                {l.viewCount ?? 0}
              </div>
              <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>次浏览</div>
            </div>

            {/* 操作：平时不占地方，指针移到这一行才出现。
                触屏没有 hover，所以 [@media(hover:hover)] 之外恒显——不能让触屏用户点不到续期。 */}
            <div className="flex shrink-0 items-center gap-1.5 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              {tier === 'revoked' ? (
                <RowButton onClick={onReshare}><Share2 size={11} className="mr-1" />重新分享</RowButton>
              ) : (
                <>
                  <RowButton onClick={() => onRenew(l)} disabled={busy} accent={expiringSoon}>
                    {busy ? <RefreshCw size={11} className="animate-spin" /> : '续期'}
                  </RowButton>
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
          </div>
        );
      })}
    </>
  );
}

/** 状态行里的分隔点。单独抽出来只是为了别在 JSX 里重复六遍同一段样式 */
function Dot() {
  return <span style={{ color: 'var(--border-default)' }}>·</span>;
}

/**
 * 可见性三档三色：公开=橙（要警觉）、登录可见=蓝（有名单）、仅我可见=灰（最安全）。
 * 只分两色的话，用户扫这一列分不出「登录可见」和「仅我可见」。
 */
function visibilityColor(v: string | undefined): string {
  if (v === 'public') return 'var(--semantic-warning-text)';
  if (v === 'logged-in') return 'var(--accent-fg-blue)';
  return 'var(--text-secondary)';
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
