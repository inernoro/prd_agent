import { useRef, useState } from 'react';
import { createShareLink } from '@/services/real/webPages';
import { toast } from '@/lib/toast';

/** 与资产库“访问”复用同一个服务端便捷链合同，不打开资产列表或裸存储地址。 */
export function useHostedSiteWindow() {
  const pending = useRef(false);
  const [opening, setOpening] = useState(false);
  const open = async (siteId: string) => {
    if (pending.current) return;
    const tab = window.open('about:blank', '_blank');
    if (!tab) { toast.error('未能打开新窗口', '请允许此站点打开新窗口后重试。'); return; }
    tab.opener = null;
    tab.document.title = '正在打开网页';
    tab.document.body.textContent = '正在准备阅读地址，请稍候…';
    pending.current = true; setOpening(true);
    try {
      const result = await createShareLink({ siteId, shareType: 'single', expiresInDays: 0, purpose: 'visit' });
      if (!result.success || !result.data.shareUrl?.startsWith('/s/')) {
        tab.close();
        toast.error('未能打开阅读页', result.error?.message || '阅读地址暂时无法获取，请重试。');
        return;
      }
      tab.location.replace(result.data.shareUrl);
    } catch {
      tab.close();
      toast.error('未能打开阅读页', '请检查网络后重试。');
    } finally { pending.current = false; setOpening(false); }
  };
  return { open, opening };
}
