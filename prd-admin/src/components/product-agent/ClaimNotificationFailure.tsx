export function ClaimNotificationFailure({ notification }: {
  notification?: { status: string; error?: string | null } | null;
}) {
  if (!notification || !['blocked', 'failed', 'unknown'].includes(notification.status)) return null;

  const label = notification.status === 'unknown' ? '通知结果待确认' : '通知未发送';
  return (
    <p className="mt-1 max-w-48 whitespace-normal break-words font-sans text-xs text-token-secondary">
      {label}{notification.error ? `：${notification.error}` : ''}
    </p>
  );
}
