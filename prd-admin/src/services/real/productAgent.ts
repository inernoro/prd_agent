/**
 * 产品管理智能体 — 前端 API 服务层。
 * 后端：prd-api/src/PrdAgent.Api/Controllers/Api/ProductAgentController.cs（路由前缀 /api/product）
 *
 * 注意（CLAUDE.md 规则 #7）：apiRequest 内部会自动 JSON.stringify(body)，调用方传原始对象，
 * 禁止再 JSON.stringify；返回 ApiResponse<T>，用 res.success 判断。
 */
import { apiRequest } from './apiClient';
import type { ApiResponse } from '@/types/api';
import type {
  Product,
  ProductVersion,
  Requirement,
  Feature,
  FeatureVersion,
  Customer,
  FormTemplate,
  WorkflowDefinition,
  ProductEntityType,
} from '@/pages/product-agent/types';

interface ListWrap<T> {
  items: T[];
}
interface PagedWrap<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ── 产品 ──
export function listProducts(params?: { page?: number; pageSize?: number; grade?: string; keyword?: string }) {
  const q = new URLSearchParams();
  if (params?.page) q.set('page', String(params.page));
  if (params?.pageSize) q.set('pageSize', String(params.pageSize));
  if (params?.grade) q.set('grade', params.grade);
  if (params?.keyword) q.set('keyword', params.keyword);
  const qs = q.toString();
  return apiRequest<PagedWrap<Product>>(`/api/product/products${qs ? `?${qs}` : ''}`);
}
export function getProduct(id: string): Promise<ApiResponse<Product>> {
  return apiRequest<Product>(`/api/product/products/${id}`);
}
export function createProduct(body: Partial<Product>): Promise<ApiResponse<Product>> {
  return apiRequest<Product>('/api/product/products', { method: 'POST', body });
}
export function updateProduct(id: string, body: Partial<Product>): Promise<ApiResponse<Product>> {
  return apiRequest<Product>(`/api/product/products/${id}`, { method: 'PUT', body });
}
export function deleteProduct(id: string) {
  return apiRequest<{ deleted: boolean }>(`/api/product/products/${id}`, { method: 'DELETE' });
}

// ── 版本 ──
export function listVersions(productId: string) {
  return apiRequest<ListWrap<ProductVersion>>(`/api/product/products/${productId}/versions`);
}
export function createVersion(productId: string, body: Partial<ProductVersion>) {
  return apiRequest<ProductVersion>(`/api/product/products/${productId}/versions`, { method: 'POST', body });
}
export function updateVersion(versionId: string, body: Partial<ProductVersion>) {
  return apiRequest<ProductVersion>(`/api/product/versions/${versionId}`, { method: 'PUT', body });
}
export function deleteVersion(versionId: string) {
  return apiRequest<{ deleted: boolean }>(`/api/product/versions/${versionId}`, { method: 'DELETE' });
}

// ── 需求 ──
export function listRequirements(productId: string, params?: { versionId?: string; customerId?: string; grade?: string }) {
  const q = new URLSearchParams();
  if (params?.versionId) q.set('versionId', params.versionId);
  if (params?.customerId) q.set('customerId', params.customerId);
  if (params?.grade) q.set('grade', params.grade);
  const qs = q.toString();
  return apiRequest<ListWrap<Requirement>>(`/api/product/products/${productId}/requirements${qs ? `?${qs}` : ''}`);
}
export function createRequirement(productId: string, body: Partial<Requirement>) {
  return apiRequest<Requirement>(`/api/product/products/${productId}/requirements`, { method: 'POST', body });
}
export function updateRequirement(requirementId: string, body: Partial<Requirement>) {
  return apiRequest<Requirement>(`/api/product/requirements/${requirementId}`, { method: 'PUT', body });
}
export function deleteRequirement(requirementId: string) {
  return apiRequest<{ deleted: boolean }>(`/api/product/requirements/${requirementId}`, { method: 'DELETE' });
}

// ── 功能 ──
export function listFeatures(productId: string, params?: { grade?: string }) {
  const q = new URLSearchParams();
  if (params?.grade) q.set('grade', params.grade);
  const qs = q.toString();
  return apiRequest<ListWrap<Feature>>(`/api/product/products/${productId}/features${qs ? `?${qs}` : ''}`);
}
export function createFeature(productId: string, body: Partial<Feature>) {
  return apiRequest<Feature>(`/api/product/products/${productId}/features`, { method: 'POST', body });
}
export function updateFeature(featureId: string, body: Partial<Feature>) {
  return apiRequest<Feature>(`/api/product/features/${featureId}`, { method: 'PUT', body });
}
export function deleteFeature(featureId: string) {
  return apiRequest<{ deleted: boolean }>(`/api/product/features/${featureId}`, { method: 'DELETE' });
}

// ── 功能版本化 ──
export function listFeatureVersions(productId: string, params?: { featureId?: string; versionId?: string }) {
  const q = new URLSearchParams();
  if (params?.featureId) q.set('featureId', params.featureId);
  if (params?.versionId) q.set('versionId', params.versionId);
  const qs = q.toString();
  return apiRequest<ListWrap<FeatureVersion>>(`/api/product/products/${productId}/feature-versions${qs ? `?${qs}` : ''}`);
}
export function createFeatureVersion(productId: string, body: Partial<FeatureVersion>) {
  return apiRequest<FeatureVersion>(`/api/product/products/${productId}/feature-versions`, { method: 'POST', body });
}
export function deleteFeatureVersion(featureVersionId: string) {
  return apiRequest<{ deleted: boolean }>(`/api/product/feature-versions/${featureVersionId}`, { method: 'DELETE' });
}

// ── 客户 ──
export function listCustomers(productId: string, params?: { keyword?: string }) {
  const q = new URLSearchParams();
  if (params?.keyword) q.set('keyword', params.keyword);
  const qs = q.toString();
  return apiRequest<ListWrap<Customer>>(`/api/product/products/${productId}/customers${qs ? `?${qs}` : ''}`);
}
export function createCustomer(productId: string, body: Partial<Customer>) {
  return apiRequest<Customer>(`/api/product/products/${productId}/customers`, { method: 'POST', body });
}
export function updateCustomer(customerId: string, body: Partial<Customer>) {
  return apiRequest<Customer>(`/api/product/customers/${customerId}`, { method: 'PUT', body });
}
export function deleteCustomer(customerId: string) {
  return apiRequest<{ deleted: boolean }>(`/api/product/customers/${customerId}`, { method: 'DELETE' });
}

// ── 通用表单模板引擎 ──
export function listFormTemplates(params?: { entityType?: ProductEntityType; productId?: string }) {
  const q = new URLSearchParams();
  if (params?.entityType) q.set('entityType', params.entityType);
  if (params?.productId) q.set('productId', params.productId);
  const qs = q.toString();
  return apiRequest<ListWrap<FormTemplate>>(`/api/product/form-templates${qs ? `?${qs}` : ''}`);
}
export function upsertFormTemplate(body: Partial<FormTemplate> & { id?: string }) {
  return apiRequest<FormTemplate>('/api/product/form-templates', { method: 'POST', body });
}
export function deleteFormTemplate(templateId: string) {
  return apiRequest<{ deleted: boolean }>(`/api/product/form-templates/${templateId}`, { method: 'DELETE' });
}

// ── 通用状态机 / 流程引擎 ──
export function listWorkflowDefinitions(params?: { entityType?: ProductEntityType; productId?: string }) {
  const q = new URLSearchParams();
  if (params?.entityType) q.set('entityType', params.entityType);
  if (params?.productId) q.set('productId', params.productId);
  const qs = q.toString();
  return apiRequest<ListWrap<WorkflowDefinition>>(`/api/product/workflow-definitions${qs ? `?${qs}` : ''}`);
}
export function upsertWorkflowDefinition(body: Partial<WorkflowDefinition> & { id?: string }) {
  return apiRequest<WorkflowDefinition>('/api/product/workflow-definitions', { method: 'POST', body });
}
export function deleteWorkflowDefinition(definitionId: string) {
  return apiRequest<{ deleted: boolean }>(`/api/product/workflow-definitions/${definitionId}`, { method: 'DELETE' });
}

// ── 通用状态流转 ──
export function transition(body: { entityType: ProductEntityType; entityId: string; transitionKey: string; comment?: string }) {
  return apiRequest<{ entityId: string; newState: string }>('/api/product/transition', { method: 'POST', body });
}
