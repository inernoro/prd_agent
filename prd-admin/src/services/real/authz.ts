import { apiRequest } from '@/services/real/apiClient';
import type {
  GetAdminAuthzMeContract,
  GetAdminPermissionCatalogContract,
  GetSystemRolesContract,
  CreateSystemRoleContract,
  UpdateSystemRoleContract,
  DeleteSystemRoleContract,
  GetUserAuthzContract,
  UpdateUserAuthzContract,
  AdminAuthzMe,
  AdminPermissionDef,
  SystemRoleDto,
  AdminUserAuthzSnapshot,
} from '@/services/contracts/authz';

export const getAdminAuthzMeReal: GetAdminAuthzMeContract = async () => {
  return await apiRequest<AdminAuthzMe>('/api/v1/admin/authz/me', { method: 'GET' });
};

export const getAdminPermissionCatalogReal: GetAdminPermissionCatalogContract = async () => {
  return await apiRequest<{ items: AdminPermissionDef[] }>('/api/v1/admin/authz/catalog', { method: 'GET' });
};

export const getSystemRolesReal: GetSystemRolesContract = async () => {
  return await apiRequest<SystemRoleDto[]>('/api/v1/admin/system-roles', { method: 'GET' });
};

export const createSystemRoleReal: CreateSystemRoleContract = async (req) => {
  return await apiRequest<SystemRoleDto>('/api/v1/admin/system-roles', { method: 'POST', body: req });
};

export const updateSystemRoleReal: UpdateSystemRoleContract = async (key, req) => {
  const k = String(key || '').trim();
  return await apiRequest<SystemRoleDto>(`/api/v1/admin/system-roles/${encodeURIComponent(k)}`, { method: 'PUT', body: req });
};

export const deleteSystemRoleReal: DeleteSystemRoleContract = async (key) => {
  const k = String(key || '').trim();
  return await apiRequest<{ deleted: boolean }>(`/api/v1/admin/system-roles/${encodeURIComponent(k)}`, { method: 'DELETE' });
};

export const getUserAuthzReal: GetUserAuthzContract = async (userId) => {
  const uid = String(userId || '').trim();
  return await apiRequest<AdminUserAuthzSnapshot>(`/api/v1/admin/users/${encodeURIComponent(uid)}/authz`, { method: 'GET' });
};

export const updateUserAuthzReal: UpdateUserAuthzContract = async (userId, req) => {
  const uid = String(userId || '').trim();
  return await apiRequest<AdminUserAuthzSnapshot>(`/api/v1/admin/users/${encodeURIComponent(uid)}/authz`, { method: 'PUT', body: req });
};

