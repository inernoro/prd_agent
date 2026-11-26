import type { AccessRequest, AgentKey, GlobalAgentKey, NotificationKeyRef, UserCredential } from '../types.js';
import type { StateService } from './state.js';

export type NotificationKey = AgentKey | GlobalAgentKey | UserCredential;
export const ACCOUNT_NOTIFICATION_SCOPE = 'account-notifications';

export function findNotificationKey(state: StateService, ref: NotificationKeyRef): NotificationKey | undefined {
  if (ref.kind === 'project') return state.getAgentKeys(ref.projectId).find(key => key.id === ref.id);
  if (ref.kind === 'global') return state.getGlobalAgentKeys().find(key => key.id === ref.id);
  return state.getUserCredentials().find(key => key.id === ref.id);
}

export function keyNotificationRecipient(key: NotificationKey): string | null | undefined {
  return key.notificationHandoff?.accountId ?? key.issuedByAccountId;
}

export function accessRequestNotificationRecipient(item: AccessRequest, state?: StateService): string | null | undefined {
  const key = state && item.notificationKey ? findNotificationKey(state, item.notificationKey) : undefined;
  return key ? keyNotificationRecipient(key) : item.notificationAccountId;
}
