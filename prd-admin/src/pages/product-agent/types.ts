/**
 * 产品管理智能体 — 前端类型定义（对齐后端 Model）。
 * 后端：prd-api/src/PrdAgent.Core/Models/{Product,ProductVersion,Requirement,Feature,Customer,
 * ProductFormTemplate,ProductWorkflowDefinition}.cs
 */

/** 产品管理对象类型 */
export type ProductEntityType =
  | 'product'
  | 'version'
  | 'requirement'
  | 'feature'
  | 'customer'
  | 'upgrade-request';

/** 通用分级（P0 最高） */
export type ItemGrade = 'p0' | 'p1' | 'p2' | 'p3';

/** 产品类型 Id（内置 core/important/normal/experimental，亦可为自定义类型 Guid） */
export type ProductGrade = string;

/** 产品类型（可增删改查管理，替代写死枚举；内置 4 项不可删除） */
export interface ProductCategory {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  isBuiltin: boolean;
}

/** 详情描述模板（按对象类型，富文本骨架，方便一键套用） */
export interface DescTemplate {
  id: string;
  entityType: ProductEntityType;
  name: string;
  content: string;
  sortOrder: number;
}

/** 版本生命周期 */
export type VersionLifecycle = 'planning' | 'developing' | 'testing' | 'released' | 'deprecated';

/** 功能版本变更类型 */
export type FeatureChangeType = 'added' | 'modified' | 'deprecated';
export type FeatureBusinessType = 'basic' | 'core' | 'value_added';

export interface Product {
  id: string;
  productNo: string;
  name: string;
  code?: string | null;
  description?: string | null;
  grade: ProductGrade;
  currentState?: string | null;
  templateId?: string | null;
  workflowDefId?: string | null;
  formData: Record<string, string>;
  knowledgeStoreId?: string | null;
  ownerId: string;
  ownerName?: string | null;
  memberIds: string[];
  adminIds: string[];
  versionCount: number;
  requirementCount: number;
  featureCount: number;
  defectCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ProductMemberRole = 'owner' | 'admin' | 'member';

export interface ProductMember {
  userId: string;
  displayName: string;
  role: ProductMemberRole;
}

export interface ProductMembersResult {
  members: ProductMember[];
  canManageMembers: boolean;
  canManageAdmins: boolean;
}

export interface ProductVersion {
  id: string;
  productId: string;
  versionName: string;
  description?: string | null;
  isMajor: boolean;
  parentVersionId?: string | null;
  lifecycle: VersionLifecycle;
  currentState?: string | null;
  plannedReleaseAt?: string | null;
  releasedAt?: string | null;
  requirementIds: string[];
  featureVersionIds: string[];
  knowledgeStoreId?: string | null;
  templateId?: string | null;
  workflowDefId?: string | null;
  formData: Record<string, string>;
  ownerId: string;
  sourceSystem?: string | null;
  externalId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type VersionScale = 'major' | 'medium' | 'minor';

export interface ProductInitiation {
  id: string;
  productId: string;
  tCode?: string | null;
  systemName?: string | null;
  appName?: string | null;
  projectType: 'standard' | 'custom';
  customerSource?: string | null;
  planName: string;
  requirementDescription?: string | null;
  departmentName?: string | null;
  planUrl?: string | null;
  versionType: VersionScale;
  requirementIds: string[];
  status: string;
  reviewSubmissionId?: string | null;
  reviewScore?: number | null;
  reviewPassed?: boolean | null;
  reviewMeetingRequired?: boolean | null;
  expectedMeetingAt?: string | null;
  firstDraftMeetingAt?: string | null;
  secondDraftMeetingAt?: string | null;
  thirdDraftMeetingAt?: string | null;
  projectAt?: string | null;
  plannedProjectAt?: string | null;
  needUiDesign?: boolean | null;
  isAiPoc?: boolean | null;
  developmentStatus: string;
  remark?: string | null;
  primaryOwnerId?: string | null;
  approvalComment?: string | null;
  createdBy: string;
  sourceType: 'system' | 'import';
  createdAt: string;
  updatedAt: string;
}

export interface ProductRelease {
  id: string;
  productId: string;
  initiationId?: string | null;
  tCode?: string | null;
  vCode: string;
  systemName?: string | null;
  appName?: string | null;
  isTemporaryOptimization: boolean;
  projectType: 'standard' | 'custom';
  planName: string;
  versionType: VersionScale;
  planUrl?: string | null;
  departmentName?: string | null;
  ownerId?: string | null;
  openBrandScope: string;
  requirementIds: string[];
  teamMemberIds: string[];
  plannedReleaseAt?: string | null;
  releasedAt?: string | null;
  announcementUrl?: string | null;
  status: string;
  createdBy: string;
  sourceType: 'system' | 'import';
  createdAt: string;
  updatedAt: string;
}

export interface Requirement {
  id: string;
  productId: string;
  requirementNo: string;
  title: string;
  description?: string | null;
  grade: ItemGrade;
  parentId?: string | null;
  customerIds: string[];
  versionIds: string[];
  currentState?: string | null;
  templateId?: string | null;
  workflowDefId?: string | null;
  formData: Record<string, string>;
  ownerId: string;
  assigneeId?: string | null;
  sourceDefectId?: string | null;
  sourceSystem?: string | null;
  externalId?: string | null;
  sourceUrl?: string | null;
  sourceSnapshot?: RequirementSourceSnapshot | null;
  stateEnteredAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequirementSourceSnapshot {
  status: string;
  priority: string;
  fields: Record<string, string>;
  handlerNames: string[];
  developerNames: string[];
  creatorNames: string[];
  ccNames: string[];
  comments: {
    author: string;
    title: string;
    content: string;
    createdAt?: string | null;
  }[];
  attachmentIds: string[];
  sourceCreatedAt?: string | null;
  sourceModifiedAt?: string | null;
  sourceCompletedAt?: string | null;
  importedFileName: string;
  importBatchId: string;
  importedAt: string;
}

export interface Feature {
  id: string;
  productId: string;
  featureNo: string;
  title: string;
  description?: string | null;
  moduleName: string;
  featureType: FeatureBusinessType;
  mainRequirementId: string;
  plannedVersionId: string;
  officialReleaseId?: string | null;
  keyRules: string;
  acceptanceCriteria: string;
  remark?: string | null;
  grade: ItemGrade;
  parentId?: string | null;
  requirementIds: string[];
  currentState?: string | null;
  templateId?: string | null;
  workflowDefId?: string | null;
  formData: Record<string, string>;
  ownerId: string;
  assigneeId?: string | null;
  sourceSystem?: string | null;
  externalId?: string | null;
  stateEnteredAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureVersion {
  id: string;
  productId: string;
  featureId: string;
  versionId: string;
  featureVersionLabel?: string | null;
  changeType: FeatureChangeType;
  changeNote?: string | null;
  currentState?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Customer {
  id: string;
  /** 遗留字段：客户已全局化，新建客户为空 */
  productId?: string | null;
  name: string;
  code?: string | null;
  company?: string | null;
  contact?: string | null;
  description?: string | null;
  tags: string[];
  templateId?: string | null;
  formData: Record<string, string>;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

/** 表单字段类型 */
export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'radio'
  | 'checkbox'
  | 'date'
  | 'datetime'
  | 'user'
  | 'relation'
  | 'richtext'
  | 'file';

export interface FormFieldOption {
  value: string;
  label: string;
  color?: string | null;
}

export interface FormField {
  key: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  options?: FormFieldOption[] | null;
  placeholder?: string | null;
  helpText?: string | null;
  defaultValue?: string | null;
  relationEntityType?: string | null;
  min?: string | null;
  max?: string | null;
  sortOrder: number;
}

export interface FormTemplate {
  id: string;
  name: string;
  description?: string | null;
  entityType: ProductEntityType;
  fields: FormField[];
  isDefault: boolean;
  productId?: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowState {
  key: string;
  label: string;
  color?: string | null;
  isInitial: boolean;
  isFinal: boolean;
  category?: string | null;
  sortOrder: number;
  /** SLA 时效（小时）：停留超过即超时；空表示不限 */
  slaHours?: number | null;
  /** 看板 WIP 上限：在制超过即告警；空表示不限 */
  wipLimit?: number | null;
}

export interface WorkflowTransition {
  key: string;
  label: string;
  fromState?: string | null;
  toState: string;
  allowedRoles?: string[] | null;
  requireComment: boolean;
  /** 自动化：触发时把处理人自动指派给操作人本人 */
  autoAssignToActor?: boolean;
  /** 流转前必须已填写的字段（title / assigneeId / grade / comment） */
  requiredFieldKeys?: string[] | null;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string | null;
  entityType: ProductEntityType;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  isDefault: boolean;
  productId?: string | null;
  /** 内置种子版本；用户保存流程模板后不再被种子覆盖 */
  seedRevision?: number;
  isUserCustomized?: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 分级中文标签（前端展示用，注册表模式） */
export const ITEM_GRADE_LABEL: Record<ItemGrade, string> = {
  p0: 'P0 最高',
  p1: 'P1 高',
  p2: 'P2 中',
  p3: 'P3 低',
};

/** 缺陷状态英文值 → 中文标签（与后端 DefectStatus 同口径，工作台/列表/图表统一展示用）。 */
export const DEFECT_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  reviewing: '评审中',
  awaiting: '待处理',
  submitted: '已提交',
  assigned: '已分配',
  processing: '处理中',
  verifying: '待验收',
  resolved: '已解决',
  rejected: '已拒绝',
  closed: '已关闭',
};

/** 取缺陷状态中文标签，未知值回退原文。 */
export function defectStatusLabel(status?: string | null): string {
  const s = (status ?? '').trim();
  if (!s) return '—';
  return DEFECT_STATUS_LABEL[s] ?? DEFECT_STATUS_LABEL[s.toLowerCase()] ?? s;
}

/** 旧缺陷「严重度」→ 统一「等级」兜底映射（与后端 ProductAgentController.SeverityToGrade 同口径）。 */
export function severityToItemGrade(severity?: string | null): ItemGrade {
  switch (severity) {
    case 'blocker':
    case 'critical':
      return 'p0';
    case 'major':
      return 'p1';
    case 'minor':
      return 'p2';
    case 'trivial':
    case 'suggestion':
      return 'p3';
    default:
      return 'p2';
  }
}

/** 取缺陷有效等级：优先 grade，旧数据为空时由 severity 兜底。 */
export function effectiveDefectGrade(d: { grade?: string | null; severity?: string | null }): ItemGrade {
  const g = d.grade;
  if (g === 'p0' || g === 'p1' || g === 'p2' || g === 'p3') return g;
  return severityToItemGrade(d.severity);
}

export const PRODUCT_GRADE_LABEL: Record<ProductGrade, string> = {
  core: '核心',
  important: '重要',
  normal: '普通',
  experimental: '实验',
};

/** 产品/版本知识库首次进入时种子化的预置分类名（分类为后端一等字段 DocumentStore.Categories，后续可在「分类管理」里增删改）。 */
export const KNOWLEDGE_CATEGORY_NAMES: string[] = ['MRD', 'SRS', 'PRD', '设计稿', '会议纪要', '测试用例'];

export const VERSION_LIFECYCLE_LABEL: Record<VersionLifecycle, string> = {
  planning: '规划',
  developing: '开发',
  testing: '测试',
  released: '已发布',
  deprecated: '已废弃',
};
