import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Copy, Eye, Globe, Loader2, Lock, QrCode, Settings2, Share2, Timer, Trash2, Users } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { AnchoredMenu } from '@/components/ui/AnchoredMenu';
import { toast } from '@/lib/toast';
import { createSiteShareLink, listSiteShares, revokeSiteShare, updateSiteShareSettings } from '@/services';
import type { ShareLinkItem } from '@/services/real/webPages';
import {
  EXPIRY_OPTIONS,
  QUICK_SHARE_DEFAULTS,
  VISIBILITY_HINT,
  VISIBILITY_LABEL,
  describeQuickShare,
  expiryLabel,
  pickQuickShareLink,
  quickShareUrl,
  resolveVisibility,
  type ShareVisibility,
} from './quickShare';

/**
 * 分享下拉面板 —— 从站点卡片的「分享」按钮就地垂直展开，一步拿到链接。
 *
 * 交互契约（2026-08-25 用户指定「垂直一个下拉框即可分享，点击高级才弹窗」）：
 *   还没链接 → 一句话说清会生成什么 + 一个按钮，点完链接就在手里（并已复制）
 *   已有链接 → 链接框在最上，下面几行是当前设置，点开哪行就地改哪行
 *   要密码 / 数字短链 / 开场问题这些低频项 → 「高级设置」才开原来那个配置弹窗
 *
 * 版式照抄知识库的 ShareLinkPanel（用户点名说那个好）：状态一句话 → 链接框高亮 →
 * 设置行平时只显示当前值 → 底部红字撤销。
 */
export function QuickSharePopover({
  anchorEl,
  site,
  links,
  onClose,
  onLinksChanged,
  onOpenAdvanced,
}: {
  anchorEl: HTMLElement | null;
  site: { id: string; title: string };
  /** 已加载的全部分享链接（本页 loadShares 的结果），面板自己从里面挑这个站点的那条 */
  links: ShareLinkItem[];
  onClose: () => void;
  /** 生成 / 改设置 / 撤销之后通知外层重拉，让卡片上的「已分享」标记跟着变 */
  onLinksChanged: () => void;
  /** 「高级设置」：交给原来的完整配置弹窗 */
  onOpenAdvanced: () => void;
}) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  // 本地那份链接：生成/改完之后先在面板里就地生效，不等外层列表重拉回来
  // （外层要打一次网络往返，中间那一两秒面板会退回「还没有链接」，看起来像没生效）
  const [localLink, setLocalLink] = useState<ShareLinkItem | null>(null);
  const [busy, setBusy] = useState<null | 'create' | 'visibility' | 'expiry' | 'revoke'>(null);
  const [openRow, setOpenRow] = useState<null | 'visibility' | 'expiry'>(null);
  const [showQr, setShowQr] = useState(false);

  const fromList = useMemo(() => pickQuickShareLink(links, site.id), [links, site.id]);
  const link = localLink ?? fromList;

  // 外层重拉回来之后就以列表为准：本地那份是过渡态，留着会盖住别处（如分享档）做的改动
  useEffect(() => {
    if (localLink && fromList && fromList.id === localLink.id) setLocalLink(null);
    // localLink 变化不该触发这条比较（只在列表刷新时对账）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromList]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('链接已复制');
    } catch {
      toast.error('复制失败', '请手动复制地址栏里的链接');
    }
  };

  const handleCreate = async () => {
    setBusy('create');
    try {
      // 建之前按站点再问一次服务端。外层那份 links 是全局最近 100 条，这个站点的链接
      // 落在窗口外时它是空的，直接 forceNew 就会给一个其实已经分享过的站点再建一条，
      // 而卡片上还一直显示未分享。带 siteId 的查询不受那个窗口影响。
      const scoped = await listSiteShares(false, site.id);
      if (!scoped.success) {
        // 查不通就停手，不要往下走 forceNew。这次点击的前提是「这个站点还没有链接」，
        // 而这个前提刚刚没能确认——照建就会给一个其实已经分享过的站点再建一条，
        // 正是这道前置检查要防的那件事。让他重试一次，比默默留下一条重复链接好。
        toast.error('没能确认这个站点有没有链接', scoped.error?.message ?? '请稍后重试');
        return;
      }
      const existing = pickQuickShareLink(scoped.data?.items ?? [], site.id);
      if (existing) {
        setLocalLink(existing);
        onLinksChanged();
        return;
      }

      const res = await createSiteShareLink({
        siteId: site.id,
        shareType: 'single',
        expiresInDays: QUICK_SHARE_DEFAULTS.expiresInDays,
        visibility: QUICK_SHARE_DEFAULTS.visibility,
        forceNew: true,
      });
      if (!res.success) {
        toast.error('生成失败', res.error?.message ?? '请稍后重试');
        return;
      }
      // 后端只回这条链接的核心字段，其余按本次请求补齐成一个完整的 ShareLinkItem
      // 供面板就地渲染；外层 onLinksChanged 重拉后会被真实记录替换。
      setLocalLink({
        id: res.data.id,
        token: res.data.token,
        shortSeq: res.data.shortSeq,
        siteId: site.id,
        siteIds: [site.id],
        shareType: 'single',
        title: site.title,
        accessLevel: res.data.accessLevel,
        viewCount: 0,
        createdBy: '',
        createdAt: new Date().toISOString(),
        expiresAt: res.data.expiresAt,
        isRevoked: false,
        visibility: QUICK_SHARE_DEFAULTS.visibility,
      });
      await copy(`${origin}${res.data.shareUrl}`);
      onLinksChanged();
    } finally {
      setBusy(null);
    }
  };

  const patch = async (kind: 'visibility' | 'expiry', body: { visibility?: ShareVisibility; expiresInDays?: number }) => {
    if (!link) return;
    setBusy(kind);
    try {
      const res = await updateSiteShareSettings(link.id, body);
      if (!res.success) {
        toast.error('修改失败', res.error?.message ?? '请稍后重试');
        return;
      }
      // 用**服务端回来的值**更新，不用请求参数：服务端会规范化，拿参数更新等于显示一个没存进去的值
      setLocalLink({
        ...link,
        visibility: res.data.visibility as ShareVisibility,
        expiresAt: res.data.expiresAt ?? undefined,
      });
      setOpenRow(null);
      onLinksChanged();
    } finally {
      setBusy(null);
    }
  };

  const handleRevoke = async () => {
    if (!link) return;
    if (!confirm('撤销这条链接？撤销后拿到链接的人立即打不开，且不可恢复，只能重新分享。')) return;
    setBusy('revoke');
    try {
      const res = await revokeSiteShare(link.id);
      if (!res.success) {
        toast.error('撤销失败', res.error?.message ?? '请稍后重试');
        return;
      }
      setLocalLink({ ...link, isRevoked: true });
      toast.success('已撤销');
      onLinksChanged();
      onClose();
    } finally {
      setBusy(null);
    }
  };

  const url = link ? quickShareUrl(origin, link) : '';
  // 存量链接没有这个字段，按后端读路径的口径当 public——不是当 owner-only（见 resolveVisibility）
  const visibility: ShareVisibility = link ? resolveVisibility(link) : 'public';

  return (
    <AnchoredMenu
      open
      onClose={onClose}
      anchorEl={anchorEl}
      align="left"
      minWidth={330}
      style={{ padding: 12, maxWidth: 'min(360px, calc(100vw - 24px))' }}
    >
      <div className="flex items-center gap-2 pb-2.5">
        <Share2 size={13} style={{ color: 'var(--text-secondary)' }} />
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>分享</span>
        <span className="ml-auto truncate text-[11px]" style={{ color: 'var(--text-muted)', maxWidth: 170 }}>{site.title}</span>
      </div>

      {link ? (
        <>
          {/* 这条链接的对外语义，一句话说完 */}
          <p className="mb-2.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {describeQuickShare(link)}
          </p>

          <div className="rounded-[10px] p-2.5" style={{ background: 'var(--selection-bg)', border: '1px solid var(--selection-border)' }}>
            <div className="flex items-center gap-1.5">
              <input
                value={url}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
                className="h-8 min-w-0 flex-1 rounded-[8px] px-2 font-mono text-[11px] outline-none"
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
              />
              <button
                type="button"
                onClick={() => copy(url)}
                className="flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-[8px] px-2.5 text-[11.5px] font-semibold"
                style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-solid)' }}
              >
                <Copy size={11} /> 复制
              </button>
              <button
                type="button"
                onClick={() => setShowQr((v) => !v)}
                title="二维码 — 手机扫一扫直接打开"
                className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[8px]"
                style={{
                  background: showQr ? 'var(--accent-primary)' : 'var(--bg-tertiary)',
                  color: showQr ? 'var(--accent-on-solid)' : 'var(--text-secondary)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <QrCode size={13} />
              </button>
            </div>
            {showQr && (
              <div className="mt-2.5 flex justify-center rounded-[8px] bg-white p-2.5">
                <QRCodeSVG value={url} size={132} level="M" />
              </div>
            )}
          </div>

          <div className="mt-2.5 overflow-hidden rounded-[10px]" style={{ border: '1px solid var(--border-subtle)' }}>
            <SettingRow
              icon={visibility === 'public' ? <Globe size={12} /> : visibility === 'logged-in' ? <Users size={12} /> : <Lock size={12} />}
              label="谁能打开"
              value={VISIBILITY_LABEL[visibility]}
              open={openRow === 'visibility'}
              busy={busy === 'visibility'}
              onToggle={() => setOpenRow((v) => (v === 'visibility' ? null : 'visibility'))}
            />
            {openRow === 'visibility' && (
              <div className="px-2.5 pb-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                {(['owner-only', 'logged-in', 'public'] as ShareVisibility[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => patch('visibility', { visibility: v })}
                    className="hover-bg-soft flex w-full cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 text-left"
                  >
                    <span className="text-[11.5px] font-medium" style={{ color: 'var(--text-primary)' }}>{VISIBILITY_LABEL[v]}</span>
                    <span className="truncate text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{VISIBILITY_HINT[v]}</span>
                    {visibility === v && <Check size={11} className="ml-auto shrink-0" style={{ color: 'var(--accent-primary)' }} />}
                  </button>
                ))}
              </div>
            )}

            <SettingRow
              icon={<Timer size={12} />}
              label="有效期"
              value={expiryLabel(link.expiresAt)}
              open={openRow === 'expiry'}
              busy={busy === 'expiry'}
              onToggle={() => setOpenRow((v) => (v === 'expiry' ? null : 'expiry'))}
              topBorder
            />
            {openRow === 'expiry' && (
              <div className="flex flex-wrap gap-1.5 px-2.5 pb-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                {EXPIRY_OPTIONS.map((o) => (
                  <button
                    key={o.days}
                    type="button"
                    onClick={() => patch('expiry', { expiresInDays: o.days })}
                    className="cursor-pointer rounded-[7px] px-2.5 py-1 text-[11.5px]"
                    style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}

            <div className="flex h-9 items-center gap-2 px-2.5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <Eye size={12} style={{ color: 'var(--text-muted)' }} />
              <span className="text-[11.5px] font-medium" style={{ color: 'var(--text-primary)' }}>已被打开</span>
              <span className="ml-auto text-[11.5px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{link.viewCount ?? 0} 次</span>
            </div>

            <button
              type="button"
              onClick={onOpenAdvanced}
              className="hover-bg-soft flex h-9 w-full cursor-pointer items-center gap-2 px-2.5 text-left"
              style={{ borderTop: '1px solid var(--border-subtle)' }}
              title="配置弹窗是「新建」不是「编辑」：它会给这个站点再建一条链接，上面那条不受影响"
            >
              <Settings2 size={12} style={{ color: 'var(--text-muted)' }} />
              {/* 写「高级设置」会让人以为是在改上面那条链接，其实那个弹窗只会新建一条。
                  预期管理：按钮上写清点下去会发生什么，别让用户点完才发现多了一条链接。 */}
              <span className="text-[11.5px] font-medium" style={{ color: 'var(--text-primary)' }}>再建一条（可设密码）</span>
              <span className="ml-auto text-[11px]" style={{ color: 'var(--text-muted)' }}>
                密码 · 短链 · 开场问题
              </span>
              <ChevronRight size={12} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
            </button>

            <button
              type="button"
              onClick={handleRevoke}
              disabled={busy === 'revoke'}
              className="hover-bg-soft flex h-9 w-full cursor-pointer items-center gap-2 px-2.5 text-left disabled:opacity-60"
              style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--semantic-danger-text)' }}
            >
              {busy === 'revoke' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              <span className="text-[11.5px] font-medium">撤销这条链接</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mb-2.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            还没有链接。生成一条{VISIBILITY_LABEL[QUICK_SHARE_DEFAULTS.visibility]}都能打开、
            {QUICK_SHARE_DEFAULTS.expiresInDays} 天有效的链接，生成后会直接复制到剪贴板。
            这两项之后都能在这里改。
          </p>
          <button
            type="button"
            onClick={handleCreate}
            disabled={busy === 'create'}
            className="flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-[9px] text-[12.5px] font-semibold disabled:opacity-70"
            style={{ background: 'var(--accent-primary)', color: 'var(--accent-on-solid)' }}
          >
            {busy === 'create' ? <Loader2 size={13} className="animate-spin" /> : <Share2 size={13} />}
            {busy === 'create' ? '正在生成…' : '生成链接并复制'}
          </button>
          <button
            type="button"
            onClick={onOpenAdvanced}
            className="hover-bg-soft mt-1.5 flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-[9px] text-[11.5px]"
            style={{ color: 'var(--text-secondary)' }}
          >
            <Settings2 size={12} /> 想先设密码 / 短链 / 开场问题？走完整配置
          </button>
        </>
      )}
    </AnchoredMenu>
  );
}

/** 设置行：平时只显示当前值，点开才展开选项（与知识库分享面板同一版式） */
function SettingRow({
  icon, label, value, open, busy, onToggle, topBorder,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  topBorder?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="hover-bg-soft flex h-9 w-full cursor-pointer items-center gap-2 px-2.5 text-left transition-colors"
      style={topBorder ? { borderTop: '1px solid var(--border-subtle)' } : undefined}
    >
      <span className="inline-flex shrink-0" style={{ color: 'var(--text-muted)' }}>{icon}</span>
      <span className="text-[11.5px] font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
      <span className="ml-auto truncate text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
        {busy ? '正在改…' : value}
      </span>
      {busy
        ? <Loader2 size={11} className="shrink-0 animate-spin" style={{ color: 'var(--text-muted)' }} />
        : <ChevronRight size={12} className="shrink-0 transition-transform" style={{ color: 'var(--text-muted)', transform: open ? 'rotate(90deg)' : undefined }} />}
    </button>
  );
}
