import { apiRequest } from '@/services/real/apiClient';
import type {
  GetAdminNotificationsContract,
  HandleAdminNotificationContract,
  HandleAllAdminNotificationsContract,
  GetAdminNotificationsResponse,
} from '@/services/contracts/notifications';

export const getAdminNotificationsReal: GetAdminNotificationsContract = async (args) => {
  const includeHandled = Boolean(args?.includeHandled);
  const qs = includeHandled ? '?includeHandled=true' : '';
  return await apiRequest<GetAdminNotificationsResponse>(`/api/v1/admin/notifications${qs}`, { method: 'GET' });
};

export const handleAdminNotificationReal: HandleAdminNotificationContract = async (id) => {
  const nid = encodeURIComponent(String(id || '').trim());
  return await apiRequest<{ handled: boolean }>(`/api/v1/admin/notifications/${nid}/handle`, { method: 'POST', body: {} });
};

export const handleAllAdminNotificationsReal: HandleAllAdminNotificationsContract = async () => {
  return await apiRequest<{ handled: boolean }>(`/api/v1/admin/notifications/handle-all`, { method: 'POST', body: {} });
};
