import { describe, expect, it } from 'vitest';
import {
  normalizeRequirementStateKey,
  requirementTransitionButtonLabel,
  resolveRequirementStateLabel,
} from './requirementWorkflowUtils';
import type { WorkflowDefinition } from './types';

const mockWorkflow: WorkflowDefinition = {
  id: 'wf-default-requirement',
  name: '米多需求收集工作流',
  entityType: 'requirement',
  isDefault: true,
  states: [
    { key: 'new', label: '待评审', isInitial: true, isFinal: false, sortOrder: 0 },
    { key: 'planning', label: '待规划', isInitial: false, isFinal: false, sortOrder: 1 },
  ],
  transitions: [{ key: 'new-to-planning', label: '到待规划', fromState: 'new', toState: 'planning', requireComment: false }],
};

describe('requirementWorkflowUtils', () => {
  it('normalizeRequirementStateKey migrates legacy keys', () => {
    expect(normalizeRequirementStateKey('pending')).toBe('new');
    expect(normalizeRequirementStateKey('done')).toBe('resolved');
  });

  it('resolveRequirementStateLabel uses workflow then tapd fallback', () => {
    expect(resolveRequirementStateLabel('new', mockWorkflow)).toBe('待评审');
    expect(resolveRequirementStateLabel('pending', mockWorkflow)).toBe('待评审');
    expect(resolveRequirementStateLabel('resolved', null)).toBe('已上线');
  });

  it('requirementTransitionButtonLabel prefers short label', () => {
    expect(requirementTransitionButtonLabel({ label: '到待规划', toState: 'planning' }, mockWorkflow)).toBe('到待规划');
    expect(requirementTransitionButtonLabel({ label: '待评审→待规划', toState: 'planning' }, mockWorkflow)).toBe('到待规划');
  });
});
