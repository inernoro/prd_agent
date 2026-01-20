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

/** 菜单项定义 */
export type AdminMenuItem = {
  /** 应用标识，对应后端 Controller 路由前缀 */
  appKey: string;
  /** 前端路由路径 */
  path: string;
  /** 菜单显示名称 */
  label: string;
  /** 菜单描述 */
  description?: string | null;
  /** 图标名称（Lucide icon name） */
  icon: string;
  /** 进入该菜单所需的最低权限 */
  requiredPermission: string;
  /** 排序权重 */
  sortOrder: number;
};

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
export type GetAdminMenuCatalogContract = () => Promise<ApiResponse<{ items: AdminMenuItem[] }>>;
export type GetSystemRolesContract = () => Promise<ApiResponse<SystemRoleDto[]>>;
export type CreateSystemRoleContract = (req: UpsertSystemRoleRequest) => Promise<ApiResponse<SystemRoleDto>>;
export type UpdateSystemRoleContract = (key: string, req: UpsertSystemRoleRequest) => Promise<ApiResponse<SystemRoleDto>>;
export type DeleteSystemRoleContract = (key: string) => Promise<ApiResponse<{ deleted: boolean }>>;
export type ResetBuiltInSystemRolesContract = () => Promise<ApiResponse<SystemRoleDto[]>>;
export type GetUserAuthzContract = (userId: string) => Promise<ApiResponse<AdminUserAuthzSnapshot>>;
export type UpdateUserAuthzContract = (userId: string, req: UpdateUserAuthzRequest) => Promise<ApiResponse<AdminUserAuthzSnapshot>>;

