import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { WandSparkles } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { shouldCloseOnEscape } from '@/lib/escapeLayering';
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
      if (shouldCloseOnEscape(event)) setOpen(false);
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
            right: isMobile ? 14 : 18,
            bottom: adjacentToAsk
              ? 'calc(66px + env(safe-area-inset-bottom, 0px))'
              : 'calc(18px + env(safe-area-inset-bottom, 0px))',
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
        <Dialog open={open} onOpenChange={setOpen} title="帮我修改" maxWidth={640}
          content={<div className="h-[min(65dvh,640px)] min-h-0">
            <SiteEditPanel site={site} onPublished={handlePublished} compact />
          </div>} />
      )}
    </>,
    document.body,
  );
}
