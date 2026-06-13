import { describe, expect, it } from 'vitest';
import type { Product, WorkflowTransition } from './types';
import {
  canExecuteWorkflowTransition,
  missingRequirementGateFields,
  missingTransitionFieldKeys,
  resolveWorkflowActorRoles,
  transitionNeedsDialog,
} from './workflowTransitionGuard';

const product: Pick<Product, 'ownerId' | 'adminIds' | 'memberIds'> = {
  ownerId: 'owner-1',
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
