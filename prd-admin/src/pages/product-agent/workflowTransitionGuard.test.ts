import { describe, expect, it } from 'vitest';
import type { WorkflowTransition } from './types';
import {
  canExecuteWorkflowTransition,
  missingRequirementGateFields,
  missingTransitionFieldKeys,
  resolveWorkflowActorRoles,
  transitionNeedsDialog,
  type ProductWorkflowContext,
} from './workflowTransitionGuard';

const product: ProductWorkflowContext = {
  ownerId: 'owner-1',
  ownerIds: ['owner-1'],
  adminIds: ['admin-1'],
  memberIds: ['member-1', 'admin-1'],
};

describe('workflowTransitionGuard', () => {
  it('resolveWorkflowActorRoles maps owner and assignee', () => {
    const roles = resolveWorkflowActorRoles('owner-1', product, false, { ownerId: 'owner-1', assigneeId: 'member-1' });
    expect(roles.has('owner')).toBe(true);
    expect(roles.has('assignee')).toBe(false);
    expect(roles.has('product_admin')).toBe(true);
  });

  it('resolveWorkflowActorRoles treats secondary product owner as member', () => {
    const multiOwnerProduct: ProductWorkflowContext = {
      ownerId: 'owner-1',
      ownerIds: ['owner-1', 'owner-2'],
      adminIds: [],
      memberIds: [],
    };
    const roles = resolveWorkflowActorRoles('owner-2', multiOwnerProduct, false, {});
    expect(roles.has('member')).toBe(true);
    expect(roles.has('product_admin')).toBe(true);
  });

  it('canExecuteWorkflowTransition respects allowedRoles', () => {
    const transition: Pick<WorkflowTransition, 'allowedRoles'> = { allowedRoles: ['product_admin'] };
    expect(canExecuteWorkflowTransition('member-1', transition, product, false, { ownerId: 'x' })).toBe(false);
    expect(canExecuteWorkflowTransition('admin-1', transition, product, false, { ownerId: 'x' })).toBe(true);
  });

  it('transitionNeedsDialog when requireComment', () => {
    const tr = { requireComment: true } as WorkflowTransition;
    expect(transitionNeedsDialog(tr, { title: 'ok' })).toBe(true);
  });

  it('missingTransitionFieldKeys lists empty assignee', () => {
    const tr = { requiredFieldKeys: ['assigneeId'], autoAssignToActor: false } as WorkflowTransition;
    expect(missingTransitionFieldKeys(tr, { assigneeId: null })).toEqual(['assigneeId']);
  });

  it('missingRequirementGateFields for scheduled state', () => {
    const tr = { toState: 'status_3' } as WorkflowTransition;
    expect(missingRequirementGateFields(tr, { versionIds: [] }, [])).toEqual(['versionIds']);
    expect(missingRequirementGateFields(tr, { versionIds: ['v1'] }, [])).toEqual([]);
  });
});
