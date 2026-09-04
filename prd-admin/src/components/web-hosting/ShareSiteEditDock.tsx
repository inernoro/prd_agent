import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { WandSparkles, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { getSite, type HostedSite } from '@/services/real/webPages';
import SiteEditPanel from './SiteEditPanel';

interface Props {
  siteId: string;
  isMobile?: boolean;
  hidden?: boolean;
  adjacentToAsk?: boolean;
  onPublished: (site: HostedSite) => void;
}

/**
 * 分享预览页上的所有者修改入口。
 *
 * 分享接口只下发公开预览字段，修改面板需要完整站点对象。因此入口先用登录态读取完整站点，
 * 但编辑、版本、发布和回退仍全部复用 SiteEditPanel，避免形成第二套修改协议。
 */
export default function ShareSiteEditDock({ siteId, isMobile = false, hidden = false, adjacentToAsk = false, onPublished }: Props) {
  const [site, setSite] = useState<HostedSite | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const loadSite = useCallback(async (notifyFailure = false) => {
    setLoading(true);
    const result = await getSite(siteId);
    setLoading(false);
    if (!result.success) {
      if (notifyFailure) toast.error('修改工具准备失败', result.error?.message || '请稍后重试');
      return null;
    }
    setSite(result.data);
    return result.data;
  }, [siteId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void getSite(siteId).then((result) => {
      if (!active) return;
      setLoading(false);
      if (result.success) setSite(result.data);
    });
    return () => { active = false; };
  }, [siteId]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  const openEditor = async () => {
    const ready = site ?? await loadSite(true);
    if (ready) setOpen(true);
  };

  const handlePublished = (updated: HostedSite) => {
    setSite(updated);
    onPublished(updated);
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      {!hidden && !open && (
        <button
          type="button"
          className="border border-token-subtle"
          onClick={() => void openEditor()}
          title={site ? '修改当前网页并发布新版本' : loading ? '正在准备修改工具' : '重试加载修改工具'}
          aria-label="帮我修改"
          style={{
            position: 'fixed',
            right: adjacentToAsk ? (isMobile ? 156 : 160) : (isMobile ? 14 : 18),
            bottom: 'calc(18px + env(safe-area-inset-bottom, 0px))',
            zIndex: 60,
            height: 40,
            minWidth: 116,
            padding: '0 15px',
            borderRadius: 999,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            boxShadow: '0 10px 28px rgba(0,0,0,0.22)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {loading ? <MapSpinner size={15} /> : <WandSparkles size={15} />}
          帮我修改
        </button>
      )}

      {open && site && (
        <>
          <div
            onClick={() => setOpen(false)}
            className="surface-backdrop"
            style={{ position: 'fixed', inset: 0, zIndex: 68 }}
          />
          <aside
            className="surface-tone-dark border-l border-l-token-subtle"
            aria-label="网页修改面板"
            style={{
              position: 'fixed',
              top: 0,
              right: 0,
              bottom: 0,
              zIndex: 69,
              width: 'min(440px, 100vw)',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bg-primary)',
              boxShadow: '-16px 0 48px rgba(0,0,0,0.38)',
            }}
          >
            <div
              className="border-b border-b-token-subtle"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, padding: '10px 12px 10px 16px' }}
            >
              <span style={{ color: 'var(--text-primary)', fontSize: 14, fontWeight: 600 }}>网页修改</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="关闭修改面板"
                aria-label="关闭修改面板"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  border: 'none',
                  background: 'var(--nested-block-bg)',
                  color: 'var(--text-secondary)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                <X size={16} />
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <SiteEditPanel site={site} onPublished={handlePublished} />
            </div>
          </aside>
        </>
      )}
    </>,
    document.body,
  );
}
