import { useState } from 'react';
import { Calendar, Check, Copy, Eye, FileText, Library, Link as LinkIcon, QrCode, Trash2, ChevronRight } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { DocumentStoreShareLink } from '@/services/contracts/documentStore';
import { shareLinkUrl, shareShortUrl, type ShareScope } from './shareScope';

/**
 * 分享面板（已有链接时的形态）—— 清单式版式，参照语雀分享面板（2026-07-31 用户指定）：
 * 状态一句话在最上 → 链接框高亮（复制 + 二维码）→ 设置行只显示当前值、点开才展开 → 底部红字撤销。
 *
 * 只做展示与交互回调，不碰网络：这样它能被直接渲染取证（__tests__/ShareLinkPanel.test.tsx），
 * 不必先把整个弹窗的加载流程跑起来。
 */
export function ShareLinkPanel({
  link, activeScope, storeName, entryTitle, canPickEntry, shortLinkBusy,
  onCopy, onSelectScope, onShortLink, onRevoke,
}: {
  link: DocumentStoreShareLink;
  activeScope: ShareScope;
  storeName: string;
  /** 当前可单篇分享的文档标题；canPickEntry=false 时无意义 */
  entryTitle?: string;
  canPickEntry: boolean;
  shortLinkBusy: boolean;
  onCopy: (url: string) => void;
  onSelectScope: (scope: ShareScope) => void;
  onShortLink: () => void;
  onRevoke: () => void;
}) {
  const [scopeOpen, setScopeOpen] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const mainUrl = shareLinkUrl(origin, link);
  const shortUrl = shareShortUrl(origin, link);

  return (
    <>
      {/* 主链高亮：对外发的就是这条不可枚举的长链 */}
      <div className="rounded-[12px] p-3"
        style={{ background: 'var(--selection-bg)', border: '1px solid var(--selection-border)' }}>
        <div className="flex items-center gap-2">
          <input value={mainUrl} readOnly onFocus={(e) => e.currentTarget.select()}
            className="prd-field h-9 min-w-0 flex-1 rounded-[9px] px-3 font-mono text-[12px] outline-none" />
          <button onClick={() => onCopy(mainUrl)}
            className="surface-action-accent flex h-9 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-[9px] px-3.5 text-[12px] font-semibold">
            <Copy size={12} /> 复制链接
          </button>
          <button onClick={() => setShowQr(v => !v)} title="二维码 — 手机扫一扫直接打开"
            className={`flex h-9 w-9 flex-shrink-0 cursor-pointer items-center justify-center rounded-[9px] ${showQr ? 'surface-action-accent' : 'surface-action'}`}>
            <QrCode size={14} />
          </button>
        </div>
        {showQr && (
          <div className="mt-3 flex justify-center rounded-[10px] bg-white p-3">
            <QRCodeSVG value={mainUrl} size={148} level="M" />
          </div>
        )}
      </div>

      {/* 设置行：平时只显示当前值，点开才展开选项 */}
      <div className="mt-3 overflow-hidden rounded-[12px]" style={{ border: '1px solid var(--border-subtle)' }}>
        <button type="button" onClick={() => setScopeOpen(v => !v)}
          className="hover-bg-soft flex h-11 w-full cursor-pointer items-center gap-2 px-3.5 text-left transition-colors">
          {activeScope === 'entry' ? <FileText size={13} className="text-token-muted" /> : <Library size={13} className="text-token-muted" />}
          <span className="text-[12px] font-semibold text-token-primary">分享范围</span>
          <span className="ml-auto truncate text-[12px] text-token-muted">
            {activeScope === 'entry' ? '只分享当前这篇' : '整个知识库'}
          </span>
          <ChevronRight size={13} className={`flex-shrink-0 text-token-muted transition-transform ${scopeOpen ? 'rotate-90' : ''}`} />
        </button>
        {scopeOpen && (
          <div className="px-3.5 pb-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            <button type="button" disabled={!canPickEntry}
              onClick={() => { onSelectScope('entry'); setScopeOpen(false); }}
              title={canPickEntry ? `只分享《${entryTitle ?? ''}》` : '先打开一篇文档，才能单独分享它'}
              className={`flex h-9 w-full items-center gap-2 rounded-[9px] px-2.5 text-[12px] ${!canPickEntry ? 'cursor-not-allowed opacity-45 text-token-muted' : 'hover-bg-soft cursor-pointer text-token-primary'}`}>
              <FileText size={12} />
              <span className="truncate">{canPickEntry ? `只分享当前这篇 · ${entryTitle}` : '只分享一篇（当前没打开文档）'}</span>
              {activeScope === 'entry' && <Check size={12} className="ml-auto text-token-accent" />}
            </button>
            <button type="button" onClick={() => { onSelectScope('store'); setScopeOpen(false); }}
              className="hover-bg-soft flex h-9 w-full cursor-pointer items-center gap-2 rounded-[9px] px-2.5 text-[12px] text-token-primary">
              <Library size={12} />
              <span className="truncate">整个知识库 · {storeName}</span>
              {activeScope === 'store' && <Check size={12} className="ml-auto text-token-accent" />}
            </button>
          </div>
        )}

        <div className="flex h-11 items-center gap-2 px-3.5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <Calendar size={13} className="text-token-muted" />
          <span className="text-[12px] font-semibold text-token-primary">有效期</span>
          <span className="ml-auto text-[12px] text-token-muted">
            {link.expiresAt ? `${new Date(link.expiresAt).toLocaleDateString()} 过期` : '永不过期'}
          </span>
        </div>

        <div className="flex h-11 items-center gap-2 px-3.5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <Eye size={13} className="text-token-muted" />
          <span className="text-[12px] font-semibold text-token-primary">已被打开</span>
          <span className="ml-auto text-[12px] text-token-muted tabular-nums">{link.viewCount} 次</span>
        </div>

        {/* 数字短链：默认不生成，用户主动点才要；文案直说它可被枚举 */}
        <button type="button" disabled={shortLinkBusy}
          onClick={() => (shortUrl ? onCopy(shortUrl) : onShortLink())}
          className="hover-bg-soft flex h-11 w-full cursor-pointer items-center gap-2 px-3.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
          style={{ borderTop: '1px solid var(--border-subtle)' }}
          title="数字短链 /s/123 是全局自增号，别人可以从 1 逐个试出来，只建议自己临时用">
          <LinkIcon size={13} className="text-token-muted" />
          <span className="text-[12px] font-semibold text-token-primary">数字短链</span>
          <span className="ml-auto truncate font-mono text-[12px] text-token-muted">
            {shortLinkBusy ? '生成中…' : shortUrl ? `/s/${link.shortSeq} · 点击复制` : '未生成 · 点击生成'}
          </span>
        </button>

        <button type="button" onClick={onRevoke}
          className="hover-bg-soft flex h-11 w-full cursor-pointer items-center gap-2 px-3.5 text-left transition-colors"
          style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--semantic-danger-text)' }}
          title="撤销后拿到链接的人立即无法打开">
          <Trash2 size={13} />
          <span className="text-[12px] font-semibold">撤销这条链接</span>
        </button>
      </div>
    </>
  );
}
