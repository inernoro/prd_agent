import type { ApiResponse } from '@/types/api';

export type AdminAuthzMe = {
  userId: string;
  username: string;
  displayName: string;
  role: 'PM' | 'DEV' | 'QA' | 'ADMIN' | string;
  isRoot: boolean;
  systemRoleKey: string;
  effectivePermissions: string[];
};

export type AdminPermissionDef = { key: string; name: string; description?: string | null };

export type SystemRoleDto = {
  id: string;
  key: string;
  name: string;
  permissions: string[];
  isBuiltIn: boolean;
  updatedAt: string;
  updatedBy?: string | null;
};

export type AdminUserAuthzSnapshot = {
  userId: string;
  username: string;
  displayName: string;
  role: 'PM' | 'DEV' | 'QA' | 'ADMIN' | string;
  effectiveSystemRoleKey: string;
  systemRoleKey?: string | null;
  permAllow: string[];
  permDeny: string[];
};

export type UpsertSystemRoleRequest = { key: string; name: string; permissions?: string[] };
export type UpdateUserAuthzRequest = { systemRoleKey?: string | null; permAllow?: string[]; permDeny?: string[] };

export type GetAdminAuthzMeContract = () => Promise<ApiResponse<AdminAuthzMe>>;
export type GetAdminPermissionCatalogContract = () => Promise<ApiResponse<{ items: AdminPermissionDef[] }>>;
export type GetSystemRolesContract = () => Promise<ApiResponse<SystemRoleDto[]>>;
export type CreateSystemRoleContract = (req: UpsertSystemRoleRequest) => Promise<ApiResponse<SystemRoleDto>>;
export type UpdateSystemRoleContract = (key: string, req: UpsertSystemRoleRequest) => Promise<ApiResponse<SystemRoleDto>>;
export type DeleteSystemRoleContract = (key: string) => Promise<ApiResponse<{ deleted: boolean }>>;
export type GetUserAuthzContract = (userId: string) => Promise<ApiResponse<AdminUserAuthzSnapshot>>;
export type UpdateUserAuthzContract = (userId: string, req: UpdateUserAuthzRequest) => Promise<ApiResponse<AdminUserAuthzSnapshot>>;

