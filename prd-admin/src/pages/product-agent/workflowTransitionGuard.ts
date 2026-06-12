import type { Product, WorkflowTransition } from './types';
import { REQUIREMENT_STATE_KEYS } from './requirementWorkflowCatalog';

/** 与后端 ProductWorkflowTransitionRoles 对齐 */
export const WORKFLOW_TRANSITION_ROLES = {
  owner: 'owner',
  creator: 'creator',
  assignee: 'assignee',
  product_admin: 'product_admin',
  member: 'member',
} as const;

export type WorkflowTransitionRole = (typeof WORKFLOW_TRANSITION_ROLES)[keyof typeof WORKFLOW_TRANSITION_ROLES];

export const WORKFLOW_TRANSITION_ROLE_LABELS: Record<WorkflowTransitionRole, string> = {
  owner: '负责人',
  creator: '创建人',
  assignee: '处理人',
  product_admin: '产品管理员',
  member: '产品成员',
};

/** 与后端 ProductWorkflowTransitionFieldKeys 对齐 */
export const WORKFLOW_TRANSITION_FIELD_KEYS = {
  title: 'title',
  assigneeId: 'assigneeId',
  grade: 'grade',
  comment: 'comment',
  versionIds: 'versionIds',
  initiationId: 'initiationId',
  releaseId: 'releaseId',
} as const;

export type WorkflowTransitionFieldKey = (typeof WORKFLOW_TRANSITION_FIELD_KEYS)[keyof typeof WORKFLOW_TRANSITION_FIELD_KEYS];

export type RequirementGateFieldKey = 'versionIds' | 'initiationId' | 'releaseId';

export const WORKFLOW_TRANSITION_FIELD_LABELS: Record<WorkflowTransitionFieldKey, string> = {
  title: '标题',
  assigneeId: '处理人',
  grade: '分级',
  comment: '备注',
  versionIds: '归属版本',
  initiationId: '立项单',
  releaseId: '上线单',
};

export const REQUIREMENT_GATE_FIELD_LABELS: Record<RequirementGateFieldKey, string> = {
  versionIds: '归属版本',
  initiationId: '立项单',
  releaseId: '上线单',
};

export interface WorkflowTransitionEntitySnapshot {
  ownerId?: string;
  assigneeId?: string | null;
  title?: string;
  grade?: string;
  versionIds?: string[];
  hasApprovedInitiation?: boolean;
  hasCompletedRelease?: boolean;
}

export function isGlobalProductAdmin(permissions: string[]): boolean {
  return permissions.includes('super')
    || permissions.includes('product-agent.manage')
    || permissions.includes('product-agent.admin');
}

export function resolveWorkflowActorRoles(
  userId: string,
  product: Pick<Product, 'ownerId' | 'adminIds' | 'memberIds'>,
  isGlobalAdmin: boolean,
  entity: WorkflowTransitionEntitySnapshot,
): Set<WorkflowTransitionRole> {
  const roles = new Set<WorkflowTransitionRole>();
  if (!userId) return roles;

  const ownerId = entity.ownerId ?? '';
  if (ownerId && ownerId === userId) {
    roles.add('owner');
    roles.add('creator');
  }

  const effectiveAssignee = entity.assigneeId?.trim() || ownerId;
  if (effectiveAssignee && effectiveAssignee === userId) roles.add('assignee');

  if (isGlobalAdmin || product.ownerId === userId || product.adminIds.includes(userId)) {
    roles.add('product_admin');
  }

  if (product.ownerId === userId || product.memberIds.includes(userId) || product.adminIds.includes(userId)) {
    roles.add('member');
  }

  return roles;
}

export function canExecuteWorkflowTransition(
  userId: string,
  transition: Pick<WorkflowTransition, 'allowedRoles'>,
  product: Pick<Product, 'ownerId' | 'adminIds' | 'memberIds'>,
  isGlobalAdmin: boolean,
  entity: WorkflowTransitionEntitySnapshot,
): boolean {
  const allowed = transition.allowedRoles?.filter(Boolean) ?? [];
  if (allowed.length === 0) return true;
  const actorRoles = resolveWorkflowActorRoles(userId, product, isGlobalAdmin, entity);
  return allowed.some((role) => actorRoles.has(role as WorkflowTransitionRole));
}

export function missingRequirementGateFields(
  transition: WorkflowTransition,
  entity: WorkflowTransitionEntitySnapshot,
  selectedVersionIds: string[],
  initiationId?: string,
  releaseId?: string,
): RequirementGateFieldKey[] {
  const missing: RequirementGateFieldKey[] = [];
  const versionIds = selectedVersionIds.length > 0 ? selectedVersionIds : (entity.versionIds ?? []);
  if (transition.toState === REQUIREMENT_STATE_KEYS.approved && !entity.hasApprovedInitiation && !initiationId?.trim()) {
    missing.push('initiationId');
  }
  if (transition.toState === REQUIREMENT_STATE_KEYS.scheduled && versionIds.length === 0) {
    missing.push('versionIds');
  }
  if (transition.toState === REQUIREMENT_STATE_KEYS.released && !entity.hasCompletedRelease && !releaseId?.trim()) {
    missing.push('releaseId');
  }
  return missing;
}

export function transitionNeedsDialog(
  transition: WorkflowTransition,
  entity: WorkflowTransitionEntitySnapshot,
): boolean {
  if (transition.requireComment) return true;
  const keys = transition.requiredFieldKeys ?? [];
  if (keys.includes('comment')) return true;
  if (keys.includes('title') && !entity.title?.trim()) return true;
  if (keys.includes('grade') && !entity.grade?.trim()) return true;
  if (keys.includes('assigneeId') && !entity.assigneeId?.trim() && !transition.autoAssignToActor) return true;
  if (keys.includes('versionIds') && !(entity.versionIds?.length)) return true;
  if (missingRequirementGateFields(transition, entity, entity.versionIds ?? []).length > 0) return true;
  return false;
}

export function missingTransitionFieldKeys(
  transition: WorkflowTransition,
  entity: WorkflowTransitionEntitySnapshot,
  comment?: string,
  assigneeId?: string,
  selectedVersionIds?: string[],
): WorkflowTransitionFieldKey[] {
  const missing: WorkflowTransitionFieldKey[] = [];
  const keys = new Set<string>([
    ...(transition.requiredFieldKeys ?? []),
    ...(transition.requireComment ? ['comment'] : []),
  ]);
  const versionIds = selectedVersionIds?.length ? selectedVersionIds : (entity.versionIds ?? []);

  for (const key of keys) {
    switch (key) {
      case 'title':
        if (!entity.title?.trim()) missing.push('title');
        break;
      case 'grade':
        if (!entity.grade?.trim()) missing.push('grade');
        break;
      case 'assigneeId':
        if (!entity.assigneeId?.trim() && !assigneeId?.trim() && !transition.autoAssignToActor) missing.push('assigneeId');
        break;
      case 'comment':
        if (!comment?.trim()) missing.push('comment');
        break;
      case 'versionIds':
        if (versionIds.length === 0) missing.push('versionIds');
        break;
      default:
        break;
    }
  }
  return missing;
}
