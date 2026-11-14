import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createLlmGatewaySsoTicket, handleBatchAdminNotifications } from '@/services';
import type { AdminNotificationItem } from '@/services/contracts/notifications';
import { notificationBatchConfirmation } from '@/lib/notificationPresentation';
import { resolveLlmGatewaySso } from '@/lib/llmGatewaySso';
import { toast } from '@/lib/toast';

type Options = { refresh: () => Promise<void>; resolveGatewayHref?: (returnTo?: string) => Promise<string | null> };

export function useNotificationActions({ refresh, resolveGatewayHref }: Options) {
  const navigate = useNavigate();
  const [handlingId, setHandlingId] = useState<string | null>(null);
  const [handlingAll, setHandlingAll] = useState(false);

  const openNotification = useCallback(async (item: AdminNotificationItem) => {
    const url = item.actionUrl;
    if (!url) return;
    if (url.startsWith('//') || (!url.startsWith('/') && !/^https?:\/\//i.test(url))) {
      toast.error('通知入口暂时无法打开', '请刷新通知后重试。');
      return;
    }
    if (item.actionKind !== 'llm-gateway') {
      if (/^https?:\/\//i.test(url)) {
        const opened = window.open(url, '_blank', 'noopener,noreferrer');
        // noopener 下部分浏览器返回 null，并不代表打开失败，不能据此修改通知。
        void opened;
      } else navigate(url);
      return;
    }
    setHandlingId(item.id);
    try {
      let href: string | null;
      if (resolveGatewayHref) href = await resolveGatewayHref(url);
      else {
        const ticket = await createLlmGatewaySsoTicket();
        if (!ticket.success) { toast.error('模型网关暂时无法打开', ticket.error?.message); return; }
        const result = resolveLlmGatewaySso(ticket.data.code, ticket.data.console, url);
        if (!result.ok) { toast.error('模型网关暂时无法打开', result.message); return; }
        href = result.href;
      }
      if (href) window.location.assign(href);
    } catch {
      toast.error('通知入口暂时无法打开', '请稍后重试，通知已保留。');
    } finally { setHandlingId(null); }
  }, [navigate, resolveGatewayHref]);

  const confirmNotifications = useCallback(async (items: AdminNotificationItem[], batch: boolean) => {
    if (!items.length || handlingAll || handlingId) return;
    if (batch && !window.confirm(notificationBatchConfirmation(items))) return;
    if (batch) setHandlingAll(true); else setHandlingId(items[0].id);
    try {
      const result = await handleBatchAdminNotifications({ items: items.map(item => ({ id: item.id, pushEpisode: item.pushEpisode ?? 0, updatedAt: item.updatedAt })) });
      if (!result.success) toast.error('通知确认失败', result.error?.message ?? '通知已保留，请稍后重试。');
      else if (result.data.failed > 0) toast.error(`已确认 ${result.data.handled} 条，${result.data.failed} 条未确认`, result.data.results.filter(item => !item.handled).slice(0, 3).map(item => item.reason || '通知未确认，请刷新后重试').join('；') + '。故障状态没有改变。');
      else toast.success(`已确认 ${result.data.handled} 条通知`, '仅更新通知处理状态，不代表故障已修复。');
    } catch { toast.error('通知确认失败', '请稍后重试，尚未确认的通知会保留。'); }
    finally {
      try { await refresh(); }
      finally { setHandlingAll(false); setHandlingId(null); }
    }
  }, [handlingAll, handlingId, refresh]);

  return { openNotification, confirmNotifications, handlingId, handlingAll };
}
