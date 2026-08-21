import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Copy, Link2, Lock, RefreshCw, Search, Share2, X } from 'lucide-react';
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

const TIER_LABELS: Record<ShareTier, string> = { active: '有效', expired: '已过期', revoked: '已撤销' };

function relTime(iso?: string): string {
  if (!iso) return '从未';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '从未';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

/**
 * 分享档主屏（设计稿屏 6）—— 后台第二档，回答「谁在看」。
 *
 * 三层分明：有效 / 已过期 / 已撤销。三者能做的事不同，混在一个列表里按时间排，
 * 用户根本分不清哪条还活着。顶部一句挂着可点数字的判断，点数字筛到对应层。
 * 续期与撤销都在行内完成，不跳页。
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
  const [tier, setTier] = useState<ShareTier>('active');
  const [keyword, setKeyword] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const fetchIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const myId = ++fetchIdRef.current;
    setLoading(true);
    try {
      const res = await listSiteShares();
      if (myId !== fetchIdRef.current) return; // 慢响应不覆盖新结果
      if (res.success) onLinksChange(res.data.items);
    } finally {
      if (myId === fetchIdRef.current) setLoading(false);
    }
  }, [onLinksChange]);

  useEffect(() => { void refresh(); }, [refresh]);

  const ledger = useMemo(() => buildShareLedger(links), [links]);
  const conclusion = useMemo(() => buildLedgerConclusion(links), [links]);
  const siteTitle = useCallback(
    (l: ShareLinkItem) => {
      if (l.shareType === 'collection') return `合集 · ${l.siteIds?.length ?? 0} 个站点`;
      const sid = l.siteId ?? l.siteIds?.[0];
      return sites.find((s) => s.id === sid)?.title ?? '站点已删除';
    },
    [sites],
  );

  const rows = filterShareLinks(ledger[tier], keyword);

  const handleRenew = async (link: ShareLinkItem) => {
    setBusyId(link.id);
    try {
      const res = await renewSiteShare(link.id, 7);
      if (res.success) {
        onLinksChange(links.map((l) => (l.id === link.id ? { ...l, expiresAt: res.data.newExpiresAt, isExpired: false, inGracePeriod: false } : l)));
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
        onLinksChange(links.map((l) => (l.id === link.id ? { ...l, isRevoked: true } : l)));
        toast.success('已撤销');
      } else {
        toast.error(res.error?.message ?? '撤销失败');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleCopy = async (link: ShareLinkItem) => {
    const url = `${window.location.origin}/s/wp/${link.token}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('链接已复制');
    } catch {
      toast.error('复制失败，请手动复制：' + url);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-tour-id="webpages-shares-workspace">
      {/* 结论先行 */}
      <div
        className="rounded-xl px-4 py-3 text-[13px] leading-relaxed"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
      >
        {conclusion.map((seg, i) =>
          seg.drillTo ? (
            <button
              key={i}
              type="button"
              onClick={() => setTier(seg.drillTo as ShareTier)}
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

      {/* 三层切换 + 搜索 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1 rounded-lg p-1" style={{ background: 'var(--bg-input)' }}>
          {(['active', 'expired', 'revoked'] as ShareTier[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTier(t)}
              className="h-7 rounded-md px-3 text-[12px] font-semibold transition-colors"
              style={
                tier === t
                  ? { background: 'var(--accent-primary)', color: 'var(--accent-on-solid)' }
                  : { color: 'var(--text-muted)' }
              }
            >
              {TIER_LABELS[t]} {ledger[t].length}
            </button>
          ))}
        </div>
        <div className="relative min-w-[200px] flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-token-muted" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索链接标题或短链号"
            className="w-full rounded-lg py-1.5 pl-8 pr-3 text-[13px] outline-none"
            style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-default)' }}
          />
        </div>
        <button
          type="button"
          onClick={onOpenAnalytics}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px]"
          style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          <BarChart3 size={13} /> 全部访问数据
        </button>
        <div className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
          口径：有效 = 未过期且未撤销
        </div>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto" style={{ minHeight: 0, overscrollBehavior: 'contain' }}>
        {loading && links.length === 0 ? (
          <MapSectionLoader text="正在取分享链接…" />
        ) : rows.length === 0 ? (
          <EmptyTier tier={tier} keyword={keyword} onCreateShare={onCreateShare} />
        ) : (
          <div className="flex flex-col gap-1.5">
            {rows.map((l) => {
              const days = daysUntil(l.expiresAt, Date.now());
              const dimmed = tier !== 'active';
              return (
                <div
                  key={l.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg px-3 py-2.5"
                  style={{
                    background: 'var(--bg-card)',
                    border: `1px solid ${tier === 'expired' ? 'var(--border-subtle)' : 'var(--border-subtle)'}`,
                    borderStyle: tier === 'expired' ? 'dashed' : 'solid',
                    opacity: dimmed ? 0.72 : 1,
                  }}
                >
                  <div className="min-w-[200px] flex-1">
                    <div className="flex items-center gap-1.5">
                      <Link2 size={12} style={{ color: 'var(--text-muted)' }} />
                      <span className="truncate text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {l.title || '未命名链接'}
                      </span>
                      <span
                        className="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                        style={{ background: 'var(--bg-input)', color: 'var(--text-muted)' }}
                      >
                        {VISIBILITY_LABELS[l.visibility ?? 'owner-only'] ?? l.visibility}
                      </span>
                      {(l.accessLevel === 'password' || l.password) && (
                        <Lock size={10} style={{ color: 'var(--semantic-success-text)' }} aria-label="有密码" />
                      )}
                    </div>
                    <div className="mt-0.5 font-mono text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                      /s/wp/{l.token} · {siteTitle(l)}
                    </div>
                  </div>

                  <div className="w-[86px] shrink-0">
                    <div className="text-[15px] font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>
                      {l.viewCount}
                    </div>
                    <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>次访问</div>
                  </div>

                  <div className="w-[130px] shrink-0 font-mono text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                    {tier === 'revoked' ? (
                      <span>已撤销 · 不可续期</span>
                    ) : tier === 'expired' ? (
                      <span>已过期 · 内容仍在</span>
                    ) : (
                      <span style={days !== null && days <= 3 ? { color: 'var(--semantic-warning-text)' } : undefined}>
                        {days === null ? '永久有效' : `剩 ${days} 天`}
                      </span>
                    )}
                    <div>最后访问 {relTime(l.lastViewedAt)}</div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {tier !== 'revoked' && (
                      <button
                        type="button"
                        disabled={busyId === l.id}
                        onClick={() => void handleRenew(l)}
                        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium disabled:opacity-50"
                        style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-solid)' }}
                      >
                        <RefreshCw size={11} /> 续期 7 天
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleCopy(l)}
                      className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px]"
                      style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                    >
                      <Copy size={11} /> 复制
                    </button>
                    {tier === 'active' && (
                      <button
                        type="button"
                        disabled={busyId === l.id}
                        onClick={() => void handleRevoke(l)}
                        title="撤销（不可逆）"
                        aria-label="撤销"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md disabled:opacity-50"
                        style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--semantic-danger-text)' }}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="font-mono text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
        续期会写入这条链接的续期历史；撤销不可逆——两者都在行内就地完成，不跳页。
      </div>
    </div>
  );
}

/** 三种空态各自给下一步，不写「暂无数据」 */
function EmptyTier({ tier, keyword, onCreateShare }: { tier: ShareTier; keyword: string; onCreateShare: () => void }) {
  if (keyword.trim()) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>没有匹配「{keyword}」的链接</div>
        <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>换个关键词，或切到别的层看看。</div>
      </div>
    );
  }
  if (tier === 'active') {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <Share2 size={34} strokeWidth={1.2} style={{ color: 'var(--text-muted)' }} />
        <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>还没有生效中的链接</div>
        <div className="max-w-[380px] text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          站点默认只有你自己能看到。回资产库挑一个站点点「分享」，生成链接后别人才能打开它。
        </div>
        <button
          type="button"
          onClick={onCreateShare}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold"
          style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-solid)' }}
        >
          回资产库挑一个站点
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
        {tier === 'expired' ? '没有过期的链接' : '没有撤销过的链接'}
      </div>
      <div className="max-w-[360px] text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        {tier === 'expired' ? '到期的链接会落到这里，内容仍在，续期即可复活。' : '主动收回的链接会落到这里，不可续期，只能重新分享。'}
      </div>
    </div>
  );
}
