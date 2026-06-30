import type { ApiResponse } from '@/types/api';

export type NotificationAttachment = {
  name: string;
  url: string;
  sizeBytes: number;
  mimeType?: string | null;
};

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
  attachments?: NotificationAttachment[] | null;
  createdAt: string;
  updatedAt: string;
  handledAt?: string | null;
  expiresAt?: string | null;
};

export type GetAdminNotificationsResponse = {
  items: AdminNotificationItem[];
};

export type AdminPushTopicDefinition = {
  key: string;
  label: string;
  description: string;
  source: string;
  resourceKey: string;
};

export type AdminPushResourceDefinition = {
  key: string;
  appName: string;
  description: string;
  iconUrl: string;
  defaultGroup: string;
  resourcePath: string;
  knowledgeStoreName: string;
  knowledgeTemplateKey?: string | null;
  colorKey: string;
};

export type AdminPushPresetDefinition = {
  key: string;
  label: string;
  channelType: string;
  method: 'GET' | 'POST' | (string & {});
  urlTemplate: string;
  bodyTemplate?: string | null;
  contentType: string;
};

export type AdminPushSubscription = {
  id: string;
  userId: string;
  topicKey: string;
  enabled: boolean;
  useDefaultProfile?: boolean;
  channelType: string;
  method: 'GET' | 'POST' | (string & {});
  urlTemplate: string;
  bodyTemplate?: string | null;
  contentType: string;
  barkKey?: string | null;
  barkServerUrl?: string | null;
  barkGroup?: string | null;
  barkSound?: string | null;
  barkLevel?: string | null;
  barkIcon?: string | null;
  barkImageTemplate?: string | null;
  barkUrlTemplate?: string | null;
  barkCall?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type AdminPushProfile = {
  id?: string;
  userId?: string;
  channelType: string;
  method: 'GET' | 'POST' | (string & {});
  urlTemplate: string;
  bodyTemplate?: string | null;
  contentType: string;
  barkKey?: string | null;
  barkServerUrl?: string | null;
  barkGroup?: string | null;
  barkSound?: string | null;
  barkLevel?: string | null;
  barkIcon?: string | null;
  barkImageTemplate?: string | null;
  barkUrlTemplate?: string | null;
  barkCall?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type AdminPushDeliveryLog = {
  id: string;
  userId: string;
  subscriptionId: string;
  notificationId: string;
  topicKey: string;
  channelType: string;
  method: string;
  requestUrl: string;
  requestBody?: string | null;
  statusCode?: number | null;
  success: boolean;
  errorMessage?: string | null;
  durationMs: number;
  createdAt: string;
};

export type GetAdminPushSubscriptionsResponse = {
  topics: AdminPushTopicDefinition[];
  presets: AdminPushPresetDefinition[];
  resources: AdminPushResourceDefinition[];
  placeholders: string[];
  defaultProfile: AdminPushProfile;
  subscriptions: AdminPushSubscription[];
};

export type UpdateAdminPushSubscriptionRequest = {
  enabled: boolean;
  useDefaultProfile?: boolean;
  channelType: string;
  method: 'GET' | 'POST' | (string & {});
  urlTemplate: string;
  bodyTemplate?: string | null;
  contentType: string;
  barkKey?: string | null;
  barkServerUrl?: string | null;
  barkGroup?: string | null;
  barkSound?: string | null;
  barkLevel?: string | null;
  barkIcon?: string | null;
  barkImageTemplate?: string | null;
  barkUrlTemplate?: string | null;
  barkCall?: boolean;
};

export type UpdateAdminPushProfileRequest = Omit<UpdateAdminPushSubscriptionRequest, 'enabled' | 'useDefaultProfile'>;

export type GetAdminNotificationsContract = (args?: { includeHandled?: boolean }) => Promise<ApiResponse<GetAdminNotificationsResponse>>;
export type HandleAdminNotificationContract = (id: string) => Promise<ApiResponse<{ handled: boolean }>>;
export type HandleAllAdminNotificationsContract = () => Promise<ApiResponse<{ handled: boolean }>>;
export type GetAdminPushSubscriptionsContract = () => Promise<ApiResponse<GetAdminPushSubscriptionsResponse>>;
export type UpdateAdminPushSubscriptionContract = (
  topicKey: string,
  request: UpdateAdminPushSubscriptionRequest
) => Promise<ApiResponse<{ subscription: AdminPushSubscription }>>;
export type UpdateAdminPushProfileContract = (
  request: UpdateAdminPushProfileRequest
) => Promise<ApiResponse<{ defaultProfile: AdminPushProfile }>>;
export type TestAdminPushSubscriptionContract = (
  topicKey: string,
  request: UpdateAdminPushSubscriptionRequest
) => Promise<ApiResponse<{ delivery: AdminPushDeliveryLog }>>;
