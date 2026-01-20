import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type {
  GetAdminAuthzMeContract,
  GetAdminPermissionCatalogContract,
  GetAdminMenuCatalogContract,
  GetSystemRolesContract,
  CreateSystemRoleContract,
  UpdateSystemRoleContract,
  DeleteSystemRoleContract,
  ResetBuiltInSystemRolesContract,
  GetUserAuthzContract,
  UpdateUserAuthzContract,
  AdminAuthzMe,
  AdminPermissionDef,
  AdminMenuItem,
  SystemRoleDto,
  AdminUserAuthzSnapshot,
} from '@/services/contracts/authz';

export const getAdminAuthzMeReal: GetAdminAuthzMeContract = async () => {
  return await apiRequest<AdminAuthzMe>(api.authz.me(), { method: 'GET' });
};

export const getAdminPermissionCatalogReal: GetAdminPermissionCatalogContract = async () => {
  return await apiRequest<{ items: AdminPermissionDef[] }>(api.authz.catalog(), { method: 'GET' });
};

export const getAdminMenuCatalogReal: GetAdminMenuCatalogContract = async () => {
  return await apiRequest<{ items: AdminMenuItem[] }>(api.authz.menuCatalog(), { method: 'GET' });
};

export const getSystemRolesReal: GetSystemRolesContract = async () => {
  return await apiRequest<SystemRoleDto[]>(api.authz.systemRoles.list(), { method: 'GET' });
};

export const createSystemRoleReal: CreateSystemRoleContract = async (req) => {
  return await apiRequest<SystemRoleDto>(api.authz.systemRoles.list(), { method: 'POST', body: req });
};

export const updateSystemRoleReal: UpdateSystemRoleContract = async (key, req) => {
  const k = String(key || '').trim();
  return await apiRequest<SystemRoleDto>(api.authz.systemRoles.byKey(k), { method: 'PUT', body: req });
};

export const deleteSystemRoleReal: DeleteSystemRoleContract = async (key) => {
  const k = String(key || '').trim();
  return await apiRequest<{ deleted: boolean }>(api.authz.systemRoles.byKey(k), { method: 'DELETE' });
};

export const resetBuiltInSystemRolesReal: ResetBuiltInSystemRolesContract = async () => {
  return await apiRequest<SystemRoleDto[]>(api.authz.systemRoles.resetBuiltins(), { method: 'POST' });
};

export const getUserAuthzReal: GetUserAuthzContract = async (userId) => {
  const uid = String(userId || '').trim();
  return await apiRequest<AdminUserAuthzSnapshot>(api.authz.users.authz(uid), { method: 'GET' });
};

export const updateUserAuthzReal: UpdateUserAuthzContract = async (userId, req) => {
  const uid = String(userId || '').trim();
  return await apiRequest<AdminUserAuthzSnapshot>(api.authz.users.authz(uid), { method: 'PUT', body: req });
};
