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
  stateEnteredAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Feature {
  id: string;
  productId: string;
  featureNo: string;
  title: string;
  description?: string | null;
  grade: ItemGrade;
  parentId?: string | null;
  requirementIds: string[];
  currentState?: string | null;
  templateId?: string | null;
  workflowDefId?: string | null;
  formData: Record<string, string>;
  ownerId: string;
  assigneeId?: string | null;
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
  productId: string;
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

export const PRODUCT_GRADE_LABEL: Record<ProductGrade, string> = {
  core: '核心',
  important: '重要',
  normal: '普通',
  experimental: '实验',
};

/** 产品/版本知识库的预置文档分类（以文档标签实现，无需后端 schema 改动）。 */
export const KNOWLEDGE_CATEGORIES: { key: string; label: string }[] = [
  { key: 'mrd', label: 'MRD' },
  { key: 'srs', label: 'SRS' },
  { key: 'prd', label: 'PRD' },
  { key: 'design', label: '设计稿' },
  { key: 'meeting', label: '会议纪要' },
  { key: 'testcase', label: '测试用例' },
];

export const VERSION_LIFECYCLE_LABEL: Record<VersionLifecycle, string> = {
  planning: '规划',
  developing: '开发',
  testing: '测试',
  released: '已发布',
  deprecated: '已废弃',
};
