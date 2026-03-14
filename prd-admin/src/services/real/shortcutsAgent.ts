import { apiRequest } from './apiClient';
import { api } from '@/services/api';

// ========== Types ==========

export interface ShortcutItem {
  id: string;
  name: string;
  tokenPrefix: string;
  deviceType: string;
  icon: string;
  color: string;
  bindingType: 'collect' | 'workflow' | 'agent';
  bindingTargetId?: string;
  bindingTargetName?: string;
  isActive: boolean;
  lastUsedAt?: string;
  collectCount: number;
  createdAt: string;
}

export interface CreateShortcutInput {
  name?: string;
  deviceType?: string;
  icon?: string;
  color?: string;
  bindingType?: string;
  bindingTargetId?: string;
  bindingTargetName?: string;
  bindingVariables?: Record<string, string>;
  clientBaseUrl?: string;
}

export interface CreateShortcutResult {
  id: string;
  name: string;
  tokenPrefix: string;
  deviceType: string;
  token: string; // 仅此一次
  installPageUrl: string;
  createdAt: string;
}

export interface BindingTarget {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  type: 'workflow' | 'agent';
}

// ========== API ==========

export async function listShortcuts() {
  return apiRequest<{ items: ShortcutItem[] }>(api.shortcuts.list(), {
    method: 'GET',
  });
}

export async function createShortcut(input: CreateShortcutInput) {
  return apiRequest<CreateShortcutResult>(api.shortcuts.create(), {
    method: 'POST',
    body: input,
  });
}

export async function deleteShortcut(id: string) {
  return apiRequest<{ id: string; deleted: boolean }>(api.shortcuts.delete(id), {
    method: 'DELETE',
  });
}

export async function getBindingTargets() {
  return apiRequest<{ workflows: BindingTarget[]; agents: BindingTarget[] }>(
    api.shortcuts.bindingTargets(),
    { method: 'GET' }
  );
}

// ========== Templates ==========

export interface ShortcutTemplateItem {
  id: string;
  name: string;
  description?: string;
  iCloudUrl: string;
  version: string;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
}

export async function listTemplates() {
  return apiRequest<{ items: ShortcutTemplateItem[] }>(api.shortcuts.templates(), {
    method: 'GET',
  });
}

export async function createTemplate(input: { name: string; iCloudUrl: string; description?: string; isDefault?: boolean }) {
  return apiRequest<ShortcutTemplateItem>('/api/shortcuts/admin/templates', {
    method: 'POST',
    body: input,
  });
}

export async function deleteTemplate(id: string) {
  return apiRequest<void>(`/api/shortcuts/admin/templates/${id}`, {
    method: 'DELETE',
  });
}
