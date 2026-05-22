import { describe, expect, it } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { archiveBranchContainerLogs } from '../../src/services/container-log-archiver.js';
import type { BranchEntry } from '../../src/types.js';

describe('archiveBranchContainerLogs', () => {
  it('persists masked docker logs with lifecycle source before containers disappear', async () => {
    const stateService = new StateService('/tmp/cds-archiver-test-state.json', '/tmp/prd_agent');
    const branch: BranchEntry = {
      id: 'branch-a',
      projectId: 'prd-agent',
      branch: 'feature/a',
      worktreePath: '/tmp/wt',
      status: 'running',
      createdAt: '2026-05-22T00:00:00.000Z',
      lastAccessedAt: '2026-05-22T00:00:00.000Z',
      services: {
        api: {
          profileId: 'api',
          containerName: 'cds-branch-a-api',
          hostPort: 12000,
          status: 'running',
        },
      },
    };

    const containerService = {
      getLogs: async () => 'started\nAuthorization: Bearer secret-token\nfailed\n',
    };

    await archiveBranchContainerLogs({
      stateService,
      containerService: containerService as never,
      branch,
      source: 'manual-stop',
      message: 'unit-test',
    });

    const archives = stateService.getContainerLogArchives('branch-a');
    expect(archives).toHaveLength(1);
    expect(archives[0].source).toBe('manual-stop');
    expect(archives[0].profileId).toBe('api');
    expect(archives[0].logs).toContain('started');
    expect(archives[0].logs).not.toContain('secret-token');
    expect(archives[0].message).toBe('unit-test');
  });
});
