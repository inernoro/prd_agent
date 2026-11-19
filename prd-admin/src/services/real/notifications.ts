import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type {
  GetAdminNotificationsContract,
  AssignNotificationIncidentContract,
  HandleBatchAdminNotificationsContract,
  NotificationBatchResult,
  HandleAdminNotificationContract,
  HandleAllAdminNotificationsContract,
  GetAdminNotificationsResponse,
  AdminPushDeliveryLog,
  AdminPushProfile,
  AdminPushSubscription,
  GetAdminPushSubscriptionsContract,
  GetAdminPushSubscriptionsResponse,
  TestAdminPushSubscriptionContract,
  UpdateAdminPushProfileContract,
  UpdateAdminPushSubscriptionContract,
} from '@/services/contracts/notifications';

export const getAdminNotificationsReal: GetAdminNotificationsContract = async (args) => {
  const params = new URLSearchParams();
  if (args?.includeHandled) params.set('includeHandled', 'true');
  if (args?.includeIncidentFollowUp) params.set('includeIncidentFollowUp', 'true');
  if (args?.priority) params.set('priority', args.priority);
  if (args?.state) params.set('state', args.state);
  if (args?.cursor) params.set('cursor', args.cursor);
  const qs = params.size ? `?${params}` : '';
  return await apiRequest<GetAdminNotificationsResponse>(`${api.dashboard.notifications.list()}${qs}`, { method: 'GET' });
};

export const handleAdminNotificationReal: HandleAdminNotificationContract = async (id) => {
  const nid = encodeURIComponent(String(id || '').trim());
  return await apiRequest<{ handled: boolean }>(api.dashboard.notifications.handle(nid), { method: 'POST', body: {} });
};

export const assignNotificationIncidentReal: AssignNotificationIncidentContract = (id, episode, claim) =>
  apiRequest(api.dashboard.notifications.incidentAssignment(id), { method: 'PUT', body: { episode, claim } });

export const handleAllAdminNotificationsReal: HandleAllAdminNotificationsContract = async () => {
  return await apiRequest<{ handled: boolean }>(api.dashboard.notifications.handleAll(), { method: 'POST', body: {} });
};

export const getAdminPushSubscriptionsReal: GetAdminPushSubscriptionsContract = async () => {
  return await apiRequest<GetAdminPushSubscriptionsResponse>(api.dashboard.notifications.subscriptions(), { method: 'GET' });
};

export const updateAdminPushSubscriptionReal: UpdateAdminPushSubscriptionContract = async (topicKey, request) => {
  return await apiRequest<{ subscription: AdminPushSubscription }>(api.dashboard.notifications.subscription(topicKey), { method: 'PUT', body: request });
};

export const updateAdminPushProfileReal: UpdateAdminPushProfileContract = async (request) => {
  return await apiRequest<{ defaultProfile: AdminPushProfile }>(api.dashboard.notifications.subscriptionDefaultProfile(), { method: 'PUT', body: request });
};

export const testAdminPushSubscriptionReal: TestAdminPushSubscriptionContract = async (topicKey, request) => {
  return await apiRequest<{ delivery: AdminPushDeliveryLog }>(api.dashboard.notifications.testSubscription(topicKey), { method: 'POST', body: request });
};

export const handleBatchAdminNotificationsReal: HandleBatchAdminNotificationsContract = async (request) => apiRequest<NotificationBatchResult>(api.dashboard.notifications.handleBatch(), { method: 'POST', body: request });
