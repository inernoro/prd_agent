import { describe, expect, it } from 'vitest';
import type { StateService } from '../../src/services/state.js';
import { environmentAuditFacts } from '../../src/services/environment-audit.js';

describe('legacy configuration audit in branch previews', () => {
  it('shows a policy-related historical write only where its first subsequent deployment belongs', () => {
    const first = '2026-01-03T01:00:00.000Z';
    const second = '2026-01-04T01:00:00.000Z';
    const entries = [
      { op: 'set', actor: '智能体', ts: '2026-01-01T01:00:00.000Z', keys: ['PREVIEW_PASSWORD', 'OTHER_KEY'] },
      { op: 'set', actor: '智能体', ts: '2026-01-08T01:00:00.000Z', keys: ['PREVIEW_PASSWORD'] },
    ];
    const runs = [
      { id: 'second-run', finishedAt: second, branchId: 'preview-other' },
      { id: 'first-run', finishedAt: first, branchId: 'preview-target' },
    ];
    const state = { getEnvChangeLog: () => entries, getDeploymentRuns: () => runs } as unknown as StateService;
    const related = new Set(['PREVIEW_PASSWORD']);
    expect(environmentAuditFacts(state, 'fixture-project', 'preview-other', false, related)).toEqual([]);
    expect(environmentAuditFacts(state, 'fixture-project', 'preview-target')).toEqual([]);
    const project = environmentAuditFacts(state, 'fixture-project');
    expect(project).toHaveLength(3);
    expect(project.at(-1)?.effect.state).toBe('unknown');
    const visible = environmentAuditFacts(state, 'fixture-project', 'preview-target', false, related);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ eventId: project[0].eventId, key: 'PREVIEW_PASSWORD', disposition: 'unknown',
      branchReason: expect.stringContaining('缺少分支信息'), sessionReason: expect.stringContaining('没有记录会话'),
      effect: { state: 'inferred', runId: 'first-run', at: first } });
    expect(visible[0].branchId).toBeUndefined();
  });
});
