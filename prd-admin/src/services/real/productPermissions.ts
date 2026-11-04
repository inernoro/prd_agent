import { apiRequest } from './apiClient';

export interface ProductPermissionMenu { key: string; label: string; functions: string[] }
export interface ProductPermissionPerson { userId: string; username: string; displayName: string; systemRoleKey?: string; isMapAdmin: boolean; menus: string[]; permissions: string[] }
export interface ProductPermissionSnapshot { schemaVersion: number; revision: string; enabled: boolean; menus: ProductPermissionMenu[]; functions: Record<string, string>; users: ProductPermissionPerson[] }
export interface ProductPermissionWorkbookRow { userId: string; username: string; displayName: string; visible: boolean; functions: Record<string, boolean> }
export interface ProductPermissionWorkbook { schemaVersion: number; expectedRevision: string; sheets: { menu: string; rows: ProductPermissionWorkbookRow[] }[] }
export interface ProductPermissionPreview { revision: string; people: number; omittedCount: number; administratorCount: number; notice: string; changes: { userId: string; username: string; displayName: string; before: string[]; after: string[]; omitted: boolean }[] }
export const getProductPermissionMe = (signal?: AbortSignal) => apiRequest<{ enabled: boolean; revision: string; isMapAdmin: boolean; permissions: string[] }>('/api/product-permissions/me', { signal });
export const getProductPermissions = () => apiRequest<ProductPermissionSnapshot>('/api/product-permissions');
export const previewProductPermissions = (body: ProductPermissionWorkbook) => apiRequest<ProductPermissionPreview>('/api/product-permissions/preview', { method: 'POST', body });
export const importProductPermissions = (body: ProductPermissionWorkbook) => apiRequest<{ revision: string; people: number }>('/api/product-permissions/import', { method: 'POST', body });
