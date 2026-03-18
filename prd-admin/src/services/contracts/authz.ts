import type { ApiResponse } from '@/types/api';

export type AdminAuthzMe = {
  userId: string;
  username: string;
  displayName: string;
  role: 'PM' | 'DEV' | 'QA' | 'ADMIN' | string;
  isRoot: boolean;
  systemRoleKey: string;
  effectivePermissions: string[];
  /** CDN 基础地址，用于拼接静态资源 URL */
  cdnBaseUrl?: string | null;
  /** 权限指纹（基于权限目录+角色定义的哈希），用于检测部署/角色变更后的前端缓存失效 */
  permissionFingerprint?: string | null;
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
  /** 排序权重 */
  sortOrder: number;
  /** 分组标识：tools=效率工具, personal=个人空间, admin=系统管理, null=头像面板 */
  group?: string | null;
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

