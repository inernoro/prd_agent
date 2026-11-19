import { useEffect, useMemo, useRef } from 'react';
import type { AdminNotificationItem } from '@/services/contracts/notifications';
import { notificationToastKey } from '@/lib/notificationPresentation';

type Options = {
  notifications: AdminNotificationItem[];
  dismissed: Set<string>;
  paused: boolean;
  snoozed: boolean;
  collapsed: boolean;
  onDismiss: (key: string) => void;
  onCollapsedChange: (collapsed: boolean) => void;
};

/** 自动收起只消费看过的当前项；其余保留在铃铛，避免逐条接力弹窗。 */
export function useNotificationToast({ notifications, dismissed, paused, snoozed, collapsed, onDismiss, onCollapsedChange }: Options) {
  const observed = useRef(new Set<string>());
  const pendingWake = useRef(false);
  const attention = useMemo(() => notifications.filter(item => item.source !== 'gateway-alert'
    || item.incidentState !== 'recovered' && (item.level === 'error' || item.level === 'warning')), [notifications]);
  const current = useMemo(() => {
    const pending = attention.filter(item => !dismissed.has(notificationToastKey(item)));
    return pending.find(item => item.level === 'error') ?? pending.find(item => item.level === 'warning') ?? pending[0];
  }, [attention, dismissed]);
  const currentKey = current ? notificationToastKey(current) : undefined;

  useEffect(() => {
    for (const item of attention) {
      const key = notificationToastKey(item);
      if (observed.current.has(key)) continue;
      observed.current.add(key);
      if (!dismissed.has(key)) pendingWake.current = true;
    }
    if (!snoozed && pendingWake.current) {
      pendingWake.current = false;
      onCollapsedChange(false);
    }
  }, [attention, dismissed, snoozed, onCollapsedChange]);

  useEffect(() => {
    if (!currentKey || paused || snoozed || collapsed) return;
    const timer = window.setTimeout(() => {
      onDismiss(currentKey);
      onCollapsedChange(true);
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [currentKey, paused, snoozed, collapsed, onDismiss, onCollapsedChange]);

  return current;
}
