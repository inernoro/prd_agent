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
  ProductCategory,
  RequirementType,
  DescTemplate,
  ProductMembersResult,
  ProductInitiation,
  ProductRelease,
  ReleaseFeatureItem,
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

// ── 产品团队成员 ──
export function listProductMembers(productId: string): Promise<ApiResponse<ProductMembersResult>> {
  return apiRequest<ProductMembersResult>(`/api/product/products/${productId}/members`);
}
export function addProductMembers(productId: string, userIds: string[]) {
  return apiRequest<{ added: number }>(`/api/product/products/${productId}/members`, { method: 'POST', body: { userIds } });
}
export function removeProductMember(productId: string, userId: string) {
  return apiRequest<{ removed: boolean }>(`/api/product/products/${productId}/members/${userId}`, { method: 'DELETE' });
}
export function setProductMemberRole(productId: string, userId: string, role: 'admin' | 'member') {
  return apiRequest<{ role: string }>(`/api/product/products/${productId}/members/${userId}/role`, { method: 'PUT', body: { role } });
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

export function listInitiations(productId: string, scope: 'mine' | 'all' = 'mine') {
  return apiRequest<ListWrap<ProductInitiation>>(`/api/product/products/${productId}/initiations?scope=${scope}`);
}
export function createInitiation(productId: string, body: {
  projectType: 'standard' | 'custom';
  systemName?: string;
  appName?: string;
  customerSource?: string;
  planName: string;
  requirementDescription?: string;
  departmentName?: string;
  planUrl?: string;
  versionType: 'major' | 'medium' | 'minor';
  requirementIds: string[];
}) {
  return apiRequest<ProductInitiation>(`/api/product/products/${productId}/initiations`, { method: 'POST', body });
}
export function syncInitiationReview(id: string, submissionId: string) {
  return apiRequest<ProductInitiation>(`/api/product/initiations/${id}/review`, { method: 'POST', body: { submissionId } });
}
export function decideInitiation(id: string, body: {
  reviewMeetingRequired: boolean;
  expectedMeetingAt?: string;
  primaryOwnerId?: string;
}) {
  return apiRequest<ProductInitiation>(`/api/product/initiations/${id}/decision`, { method: 'POST', body });
}
export function approveInitiation(id: string, comment?: string) {
  return apiRequest<ProductInitiation>(`/api/product/initiations/${id}/approve`, { method: 'POST', body: { comment } });
}
export function listReleases(productId: string, scope: 'mine' | 'all' = 'mine', ownerId?: string) {
  const q = new URLSearchParams({ scope });
  if (ownerId) q.set('ownerId', ownerId);
  return apiRequest<ListWrap<ProductRelease>>(`/api/product/products/${productId}/releases?${q.toString()}`);
}
export function createRelease(productId: string, body: {
  initiationId?: string;
  isTemporaryOptimization: boolean;
  planName?: string;
  ownerId: string;
  openBrandScope?: string;
  additionalRequirementIds?: string[];
  teamMemberIds: string[];
  plannedReleaseAt: string;
  previousReleaseId?: string;
  featureManifest?: ReleaseFeatureItem[];
}) {
  return apiRequest<ProductRelease>(`/api/product/products/${productId}/releases`, { method: 'POST', body });
}
export function getRelease(id: string) {
  return apiRequest<ProductRelease>(`/api/product/releases/${id}`);
}
export function getInheritReleaseManifest(productId: string) {
  return apiRequest<{ previousReleaseId: string | null; previousVCode?: string | null; items: ReleaseFeatureItem[] }>(
    `/api/product/products/${productId}/releases/inherit-manifest`,
  );
}
export function updateReleaseFeatureManifest(id: string, body: {
  previousReleaseId?: string;
  featureManifest: ReleaseFeatureItem[];
}) {
  return apiRequest<ProductRelease>(`/api/product/releases/${id}/feature-manifest`, { method: 'PUT', body });
}
export function completeRelease(id: string, announcementUrl: string) {
  return apiRequest<ProductRelease>(`/api/product/releases/${id}/complete`, { method: 'POST', body: { announcementUrl } });
}
export function importVersionWorkflow(productId: string, body: {
  kind: 'initiation' | 'release';
  rows: Array<Record<string, unknown>>;
}) {
  return apiRequest<{ created: number; errors: { row: number; message: string }[] }>(
    `/api/product/products/${productId}/version-workflow/import`,
    { method: 'POST', body },
  );
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

// ── 客户（全局，跨产品共享）──
export function listCustomers(params?: { keyword?: string }) {
  const q = new URLSearchParams();
  if (params?.keyword) q.set('keyword', params.keyword);
  const qs = q.toString();
  return apiRequest<ListWrap<Customer>>(`/api/product/customers${qs ? `?${qs}` : ''}`);
}
export function createCustomer(body: Partial<Customer>) {
  return apiRequest<Customer>('/api/product/customers', { method: 'POST', body });
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

// ── 产品类型（可增删改查管理）──
export function listProductCategories() {
  return apiRequest<ListWrap<ProductCategory>>('/api/product/categories');
}
export function upsertProductCategory(body: Partial<ProductCategory> & { id?: string }) {
  return apiRequest<ProductCategory>('/api/product/categories', { method: 'POST', body });
}
export function deleteProductCategory(categoryId: string) {
  return apiRequest<{ deleted: boolean }>(`/api/product/categories/${categoryId}`, { method: 'DELETE' });
}

// ── 需求类型（AI 分类 + 新建表单）──
export function listRequirementTypes() {
  return apiRequest<ListWrap<RequirementType>>('/api/product/requirement-types');
}
export function upsertRequirementType(body: Partial<RequirementType> & { id?: string }) {
  return apiRequest<RequirementType>('/api/product/requirement-types', { method: 'POST', body });
}
export function deleteRequirementType(typeId: string) {
  return apiRequest<{ deleted: boolean }>(`/api/product/requirement-types/${typeId}`, { method: 'DELETE' });
}

// ── 详情描述模板 ──
export function listDescTemplates(entityType?: ProductEntityType) {
  const qs = entityType ? `?entityType=${encodeURIComponent(entityType)}` : '';
  return apiRequest<ListWrap<DescTemplate>>(`/api/product/desc-templates${qs}`);
}
export function upsertDescTemplate(body: Partial<DescTemplate> & { id?: string }) {
  return apiRequest<DescTemplate>('/api/product/desc-templates', { method: 'POST', body });
}
export function deleteDescTemplate(templateId: string) {
  return apiRequest<{ deleted: boolean }>(`/api/product/desc-templates/${templateId}`, { method: 'DELETE' });
}

// ── 批量导入 ──
export interface ImportRequirementRow {
  title: string;
  grade?: string;
  description?: string;
  sourceSystem?: string;
  externalId?: string;
  sourceUrl?: string;
  sourceStatus?: string;
  sourcePriority?: string;
  sourceFields?: Record<string, string>;
  handlerNames?: string[];
  developerNames?: string[];
  creatorNames?: string[];
  ccNames?: string[];
  comments?: { author: string; title: string; content: string; createdAt?: string }[];
  attachmentIds?: string[];
  sourceCreatedAt?: string;
  sourceModifiedAt?: string;
  sourceCompletedAt?: string;
  importedFileName?: string;
  importBatchId?: string;
}

export function importRequirements(productId: string, rows: ImportRequirementRow[]) {
  return apiRequest<{ created: number; updated: number }>(`/api/product/products/${productId}/requirements/import`, { method: 'POST', body: { rows } });
}

export interface ImportSimpleItemRow {
  title: string;
  description?: string;
  grade?: string;
  status?: string;
  sourceSystem?: string;
  externalId?: string;
  plannedAt?: string;
  completedAt?: string;
}

export function importFeatures(productId: string, rows: ImportSimpleItemRow[]) {
  return apiRequest<{ created: number; updated: number }>(`/api/product/products/${productId}/features/import`, { method: 'POST', body: { rows } });
}
export function importDefects(productId: string, rows: ImportSimpleItemRow[]) {
  return apiRequest<{ created: number; updated: number }>(`/api/product/products/${productId}/defects/import`, { method: 'POST', body: { rows } });
}
export function importVersions(productId: string, rows: ImportSimpleItemRow[]) {
  return apiRequest<{ created: number; updated: number }>(`/api/product/products/${productId}/versions/import`, { method: 'POST', body: { rows } });
}

// ── 报表 / 统计分析 ──
export interface ProductAnalytics {
  releaseProgress: { versionId: string; versionName: string; total: number; done: number; doing: number; todo: number }[];
  overall: { total: number; done: number; doing: number; todo: number };
  velocity: { week: string; requirements: number; features: number }[];
  /** 规模统计（原工作台数据展示区迁入报表） */
  counts: { versions: number; requirements: number; features: number; defects: number };
  /** 需求分级分布（key: p0-p3） */
  requirementsByGrade: Record<string, number>;
  /** 追溯缺陷状态分布（key: DefectStatus 原始值） */
  defectsByStatus: Record<string, number>;
  /** 版本生命周期分布（key: lifecycle） */
  versionsByLifecycle: Record<string, number>;
}
export function getProductAnalytics(productId: string) {
  return apiRequest<ProductAnalytics>(`/api/product/products/${productId}/analytics`);
}

// ── 用户偏好（工作台快捷操作，用户级跨产品共用） ──
export interface ProductAgentPrefs {
  /** null = 从未配置（前端走默认）；空数组 = 用户主动清空 */
  quickActionIds: string[] | null;
}
export function getProductAgentPreferences() {
  return apiRequest<ProductAgentPrefs>('/api/product/preferences');
}
export function updateProductAgentQuickActions(quickActionIds: string[]) {
  return apiRequest<ProductAgentPrefs>('/api/product/preferences/quick-actions', { method: 'PUT', body: { quickActionIds } });
}

// ── 批量操作 ──
export function batchUpdateItems(body: { entityType: 'requirement' | 'feature'; ids: string[]; op: 'delete' | 'assign' | 'grade'; assigneeId?: string | null; grade?: string }) {
  return apiRequest<{ affected: number }>('/api/product/items/batch', { method: 'POST', body });
}

// ── 全局搜索 ──
export interface GlobalSearchResult {
  products: { id: string; no: string; name: string }[];
  requirements: { id: string; productId: string; no: string; title: string }[];
  features: { id: string; productId: string; no: string; title: string }[];
  customers: { id: string; productId: string; name: string }[];
  defects: { id: string; productId: string; no: string; title?: string | null }[];
}
export function globalSearch(keyword: string) {
  return apiRequest<GlobalSearchResult>(`/api/product/search?keyword=${encodeURIComponent(keyword)}`);
}

// ── AI 摘要（图谱抽屉，服务端缓存：首个打开者生成，其他人读缓存，重新摘要 force=true 覆盖）──
export function summarizeItem(entityType: string, entityId: string, force = false) {
  const qs = force ? '?force=true' : '';
  return apiRequest<{ summary: string | null; message?: string; generatedByName?: string | null; generatedAt?: string; cached?: boolean }>(
    `/api/product/items/${entityType}/${entityId}/summary${qs}`,
  );
}

// ── RTM 需求可追溯矩阵 ──
export interface RtmRow {
  id: string;
  requirementNo: string;
  title: string;
  grade: string;
  currentState?: string | null;
  versions: { id: string; name: string }[];
  customers: { id: string; name: string }[];
  features: { id: string; featureNo: string; title: string }[];
  defects: { id: string; defectNo: string; title?: string | null; status: string }[];
}
export interface RtmData {
  rows: RtmRow[];
  orphanFeatures: { id: string; featureNo: string; title: string }[];
  stats: { total: number; withoutFeature: number; withoutVersion: number; orphanFeatures: number };
}
export function getRtm(productId: string) {
  return apiRequest<RtmData>(`/api/product/products/${productId}/rtm`);
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
export function transition(body: {
  entityType: ProductEntityType;
  entityId: string;
  transitionKey: string;
  comment?: string;
  assigneeId?: string | null;
  title?: string;
  grade?: string;
  versionIds?: string[];
  initiationId?: string;
  releaseId?: string;
}) {
  return apiRequest<{ entityId: string; newState: string }>('/api/product/transition', { method: 'POST', body });
}

// ── 知识库挂载（复用 DocumentStore，P1）──
/** 知识库精简类型（DocumentStore 的子集，足够 product-agent 展示与嵌入 DocumentStoreBrowser） */
export interface KnowledgeStore {
  id: string;
  name: string;
  documentCount: number;
  productKnowledgeRef?: string | null;
}
export function getProductKnowledgeStore(productId: string) {
  return apiRequest<KnowledgeStore>(`/api/product/products/${productId}/knowledge/store`);
}
export function getVersionKnowledgeStore(versionId: string) {
  return apiRequest<KnowledgeStore>(`/api/product/versions/${versionId}/knowledge/store`);
}

/** 总览聚合知识行：条目 + 所属产品 */
export interface OverviewKnowledgeEntryRow {
  entry: import('@/services/contracts/documentStore').DocumentEntry;
  productId: string | null;
  productName: string | null;
}
/** 管理层总览：跨产品聚合知识列表（分页 + 关键词/产品过滤） */
export function getOverviewKnowledgeEntries(q: { page?: number; pageSize?: number; keyword?: string; productId?: string } = {}) {
  const params = new URLSearchParams({ page: String(q.page ?? 1), pageSize: String(q.pageSize ?? 20) });
  if (q.keyword) params.set('keyword', q.keyword);
  if (q.productId) params.set('productId', q.productId);
  return apiRequest<{ items: OverviewKnowledgeEntryRow[]; total: number; page: number; pageSize: number }>(
    `/api/product/overview/knowledge/entries?${params.toString()}`);
}

// ── 缺陷追溯（复用 defect-agent，P1）──
/** 追溯缺陷精简类型（DefectReport 子集） */
export interface TracedDefect {
  id: string;
  defectNo: string;
  title?: string | null;
  status: string;
  /** 统一等级 p0/p1/p2/p3（取代严重度）。severity 仍保留用于旧数据兜底。 */
  grade?: string | null;
  severity?: string | null;
  priority?: string | null;
  tracedRequirementId?: string | null;
  tracedVersionId?: string | null;
  tracedFeatureId?: string | null;
  /** 以下字段由 list/detail 接口返回的完整 DefectReport 提供，用于产品内缺陷详情编辑 */
  rawContent?: string | null;
  assigneeId?: string | null;
  assigneeName?: string | null;
  reporterId?: string | null;
  reporterName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  workflowDefId?: string | null;
  /** 缺陷 / 非产品缺陷 */
  productDefectClassification?: string | null;
}
export function listTracedDefects(productId: string, params?: { requirementId?: string; versionId?: string; featureId?: string }) {
  const q = new URLSearchParams();
  if (params?.requirementId) q.set('requirementId', params.requirementId);
  if (params?.versionId) q.set('versionId', params.versionId);
  if (params?.featureId) q.set('featureId', params.featureId);
  const qs = q.toString();
  return apiRequest<ListWrap<TracedDefect>>(`/api/product/products/${productId}/defects${qs ? `?${qs}` : ''}`);
}
export function listLinkableDefects(productId: string, params?: { keyword?: string }) {
  const q = new URLSearchParams();
  if (params?.keyword) q.set('keyword', params.keyword);
  const qs = q.toString();
  return apiRequest<ListWrap<TracedDefect>>(`/api/product/products/${productId}/defects/linkable${qs ? `?${qs}` : ''}`);
}
export function traceDefect(body: { defectId: string; productId: string; requirementId?: string; versionId?: string; featureId?: string }) {
  return apiRequest<{ traced: boolean }>('/api/product/trace-defect', { method: 'POST', body });
}
export function untraceDefect(defectId: string) {
  return apiRequest<{ untraced: boolean }>('/api/product/untrace-defect', { method: 'POST', body: { defectId } });
}
/** 缺陷转需求：在缺陷所追溯的产品下生成一条需求并建立溯源追溯，返回新需求。 */
export function convertDefectToRequirement(defectId: string) {
  return apiRequest<Requirement>(`/api/product/defects/${defectId}/convert-to-requirement`, { method: 'POST' });
}

/** 工作台「我的待办」一条：需求/功能/缺陷统一结构（后端已按"需我处理"过滤好）。 */
export interface MyTodoItem {
  kind: 'requirement' | 'feature' | 'defect';
  id: string;
  no: string;
  title: string;
  /** 原始状态值（需求/功能为工作流状态 Key，缺陷为 DefectStatus）。 */
  state?: string | null;
  /** 已解析的状态中文标签（需求/功能由后端工作流解析；缺陷为空，前端用 defectStatusLabel 兜底）。 */
  stateLabel?: string | null;
}
/** 工作台「我的待办」：只返回当前用户现在需要处理的项（后端按状态责任人 + 未到终态/未完成过滤）。 */
export function getMyTodos(productId: string) {
  return apiRequest<ListWrap<MyTodoItem>>(`/api/product/products/${productId}/my-todos`);
}

// ── 动态/讨论时间线（P2）──
export interface ProductActivity {
  id: string;
  entityType: string;
  entityId: string;
  productId: string;
  type: 'comment' | 'transition' | 'assign' | 'created' | 'convert';
  actorId: string;
  actorName?: string | null;
  content?: string | null;
  fromValue?: string | null;
  toValue?: string | null;
  mentions: string[];
  createdAt: string;
}
export function listActivities(entityType: string, entityId: string) {
  return apiRequest<ListWrap<ProductActivity>>(`/api/product/items/${entityType}/${entityId}/activities`);
}
export function addComment(entityType: string, entityId: string, body: { content: string; mentions?: string[] }) {
  return apiRequest<ProductActivity>(`/api/product/items/${entityType}/${entityId}/comments`, { method: 'POST', body });
}

// ── 知识图谱（P2）──
export interface GraphNode {
  id: string;
  type: 'product' | 'version' | 'requirement' | 'feature' | 'customer' | 'defect';
  label: string;
  sub?: string | null;
  grade?: string | null;
  state?: string | null;
  productId?: string | null;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
}
export function getProductGraph(productId: string) {
  return apiRequest<{ nodes: GraphNode[]; edges: GraphEdge[] }>(`/api/product/products/${productId}/graph`);
}

// ── 大版本升级申请（P2）──
export interface UpgradeRequest {
  id: string;
  productId: string;
  upgradeNo: string;
  title: string;
  reason?: string | null;
  fromVersionId?: string | null;
  targetVersionId?: string | null;
  targetVersionName?: string | null;
  requirementIds: string[];
  featureIds: string[];
  knowledgeEntryIds: string[];
  status: string;
  currentState?: string | null;
  formData: Record<string, string>;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}
export function listUpgradeRequests(productId: string) {
  return apiRequest<ListWrap<UpgradeRequest>>(`/api/product/products/${productId}/upgrade-requests`);
}
export function createUpgradeRequest(productId: string, body: Partial<UpgradeRequest>) {
  return apiRequest<UpgradeRequest>(`/api/product/products/${productId}/upgrade-requests`, { method: 'POST', body });
}
export function updateUpgradeRequest(upgradeId: string, body: Partial<UpgradeRequest>) {
  return apiRequest<UpgradeRequest>(`/api/product/upgrade-requests/${upgradeId}`, { method: 'PUT', body });
}
export function deleteUpgradeRequest(upgradeId: string) {
  return apiRequest<{ deleted: boolean }>(`/api/product/upgrade-requests/${upgradeId}`, { method: 'DELETE' });
}

// ── 管理层总览（跨产品聚合，P1）──
export interface OverviewStats {
  isAdmin: boolean;
  counts: { products: number; versions: number; requirements: number; features: number; defects: number; customers: number };
  requirementsByGrade: Record<string, number>;
  featuresByGrade: Record<string, number>;
  defectsByStatus: Record<string, number>;
  versionsByLifecycle: Record<string, number>;
  recent: { type: string; id: string; productId: string; productName: string; title: string; no: string; at: string }[];
}
export function getOverviewStats() {
  return apiRequest<OverviewStats>('/api/product/overview/stats');
}
export interface OverviewRequirementRow {
  id: string; productId: string; productName: string; requirementNo: string; title: string;
  grade: string; currentState?: string | null; stateLabel?: string | null; versionCount: number; customerCount: number; assigneeId?: string | null; assigneeName?: string | null; updatedAt: string;
}
export function getOverviewRequirements(params?: { grade?: string; keyword?: string; mine?: boolean }) {
  const q = new URLSearchParams();
  if (params?.grade) q.set('grade', params.grade);
  if (params?.keyword) q.set('keyword', params.keyword);
  if (params?.mine) q.set('mine', 'true');
  const qs = q.toString();
  return apiRequest<ListWrap<OverviewRequirementRow>>(`/api/product/overview/requirements${qs ? `?${qs}` : ''}`);
}
export interface OverviewVersionRow {
  id: string; productId: string; productName: string; versionName: string; lifecycle: string;
  isMajor: boolean; requirementCount: number; featureCount: number; externalId?: string | null;
  plannedReleaseAt?: string | null; releasedAt?: string | null; updatedAt: string;
}
export function getOverviewVersions(params?: { lifecycle?: string; keyword?: string }) {
  const q = new URLSearchParams();
  if (params?.lifecycle) q.set('lifecycle', params.lifecycle);
  if (params?.keyword) q.set('keyword', params.keyword);
  const qs = q.toString();
  return apiRequest<ListWrap<OverviewVersionRow>>(`/api/product/overview/versions${qs ? `?${qs}` : ''}`);
}
export interface OverviewFeatureRow {
  id: string; productId: string; productName: string; featureNo: string; title: string;
  grade: string; currentState?: string | null; requirementCount: number; assigneeId?: string | null; assigneeName?: string | null; updatedAt: string;
}
export function getOverviewFeatures(params?: { grade?: string; keyword?: string; mine?: boolean }) {
  const q = new URLSearchParams();
  if (params?.grade) q.set('grade', params.grade);
  if (params?.keyword) q.set('keyword', params.keyword);
  if (params?.mine) q.set('mine', 'true');
  const qs = q.toString();
  return apiRequest<ListWrap<OverviewFeatureRow>>(`/api/product/overview/features${qs ? `?${qs}` : ''}`);
}
export interface OverviewDefectRow {
  id: string; productId: string; productName: string; defectNo: string; title?: string | null;
  status: string; grade?: string | null; tracedRequirementId?: string | null; tracedVersionId?: string | null; updatedAt: string;
}
export function getOverviewDefects(params?: { status?: string; keyword?: string }) {
  const q = new URLSearchParams();
  if (params?.status) q.set('status', params.status);
  if (params?.keyword) q.set('keyword', params.keyword);
  const qs = q.toString();
  return apiRequest<ListWrap<OverviewDefectRow>>(`/api/product/overview/defects${qs ? `?${qs}` : ''}`);
}
export interface OverviewKnowledgeRow {
  productId: string; productName: string; storeId: string; name: string; documentCount: number; updatedAt: string;
}
export function getOverviewKnowledge() {
  return apiRequest<ListWrap<OverviewKnowledgeRow>>('/api/product/overview/knowledge');
}
export function getOverviewGraph() {
  return apiRequest<{ nodes: GraphNode[]; edges: GraphEdge[] }>('/api/product/overview/graph');
}

export interface ProductApplicationAdmin {
  userId: string;
  displayName: string;
  username: string;
}
export function listProductApplicationAdmins() {
  return apiRequest<{ items: ProductApplicationAdmin[]; canManage: boolean }>('/api/product/settings/admins');
}
export function addProductApplicationAdmin(userId: string) {
  return apiRequest<{ items: ProductApplicationAdmin[]; canManage: boolean }>('/api/product/settings/admins', { method: 'POST', body: { userId } });
}
export function removeProductApplicationAdmin(userId: string) {
  return apiRequest<{ removed: boolean }>(`/api/product/settings/admins/${userId}`, { method: 'DELETE' });
}
export function createProductDefect(productId: string, body: { title: string; description?: string; grade?: string; assigneeId?: string | null; featureId?: string; versionId?: string }) {
  return apiRequest<TracedDefect>(`/api/product/products/${productId}/defects`, { method: 'POST', body });
}
export function updateProductDefect(productId: string, defectId: string, body: { title: string; description?: string; grade?: string; status?: string; assigneeId?: string | null; featureId?: string; versionId?: string; productDefectClassification?: string }) {
  return apiRequest<TracedDefect>(`/api/product/products/${productId}/defects/${defectId}`, { method: 'PUT', body });
}
