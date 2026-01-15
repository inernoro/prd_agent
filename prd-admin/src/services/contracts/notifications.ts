import type { ApiResponse } from '@/types/api';

export type AdminNotificationItem = {
  id: string;
  key?: string | null;
  title: string;
  message?: string | null;
  level: 'info' | 'warning' | 'error' | 'success' | (string & {});
  status: 'open' | 'handled' | (string & {});
  actionLabel?: string | null;
  actionUrl?: string | null;
  actionKind?: string | null;
  source?: string | null;
  createdAt: string;
  updatedAt: string;
  handledAt?: string | null;
  expiresAt?: string | null;
};

export type GetAdminNotificationsResponse = {
  items: AdminNotificationItem[];
};

export type GetAdminNotificationsContract = (args?: { includeHandled?: boolean }) => Promise<ApiResponse<GetAdminNotificationsResponse>>;
export type HandleAdminNotificationContract = (id: string) => Promise<ApiResponse<{ handled: boolean }>>;
export type HandleAllAdminNotificationsContract = () => Promise<ApiResponse<{ handled: boolean }>>;
