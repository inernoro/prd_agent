import { afterEach, describe, expect, it } from 'vitest';
import {
  clearContainerLifecycleIntentsForTest,
  DockerEventMonitor,
  findRecentContainerLifecycleIntent,
  recordContainerLifecycleIntent,
} from '../../src/services/container-diagnostics.js';
import type { ServerEventLogSink } from '../../src/services/server-event-log-store.js';
import type { IShellExecutor, ShellResult } from '../../src/types.js';

describe('container lifecycle intent correlation', () => {
  afterEach(() => clearContainerLifecycleIntentsForTest());

  it('matches docker event container names with a leading slash', () => {
    recordContainerLifecycleIntent({
      containerName: 'cds-prd-agent-main-api-prd-agent',
      kind: 'cds-pre-run-replace',
      reason: 'deploy replacement',
      requestId: 'req-123',
      operationId: 'op-123',
      operation: 'deploy-pre-run-replace',
    });

    const intent = findRecentContainerLifecycleIntent('/cds-prd-agent-main-api-prd-agent');
    expect(intent?.kind).toBe('cds-pre-run-replace');
    expect(intent?.reason).toBe('deploy replacement');
    expect(intent?.requestId).toBe('req-123');
    expect(intent?.operationId).toBe('op-123');
    expect(intent?.operation).toBe('deploy-pre-run-replace');
  });

  it('expires stale intents so old CDS actions cannot mask external kills', () => {
    recordContainerLifecycleIntent({
      containerName: 'cds-prd-agent-main-api-prd-agent',
      kind: 'cds-stop',
      reason: 'manual stop',
      requestedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    expect(findRecentContainerLifecycleIntent('cds-prd-agent-main-api-prd-agent')).toBeUndefined();
  });

  it('records docker event lifecycle intent and classification as queryable top-level fields', async () => {
    const containerName = 'cds-prd-agent-main-api-prd-agent';
    recordContainerLifecycleIntent({
      containerName,
      kind: 'cds-pre-run-replace',
      reason: 'deploy replacement',
      projectId: 'prd-agent',
      branchId: 'prd-agent-main',
      profileId: 'api',
      requestId: 'req-123',
      operationId: 'op-123',
      actor: 'system:webhook',
      trigger: 'webhook',
      operation: 'deploy-pre-run-replace',
      source: 'container.runService',
    });
    const records: any[] = [];
    const store: ServerEventLogSink = {
      record(record) {
        records.push(record);
      },
    };
    const shell: IShellExecutor = {
      async exec(command): Promise<ShellResult> {
        if (command.startsWith('docker inspect')) {
          return {
            stdout: JSON.stringify([{
              Name: `/${containerName}`,
              State: { Status: 'exited', ExitCode: 137, OOMKilled: false },
              Config: {
                Labels: {
                  'cds.managed': 'true',
                  'cds.type': 'app',
                  'cds.branch.id': 'prd-agent-main',
                  'cds.profile.id': 'api',
                },
              },
            }]),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command.startsWith('docker logs')) {
          return { stdout: 'previous container log', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const monitor = new DockerEventMonitor(shell, store);

    await (monitor as any).handleLine(JSON.stringify({
      Type: 'container',
      Action: 'die',
      Actor: {
        ID: 'abcdef',
        Attributes: {
          name: containerName,
          'cds.branch.id': 'prd-agent-main',
          'cds.profile.id': 'api',
          exitCode: '137',
        },
      },
      time: 1,
      timeNano: 1,
    }));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      category: 'docker',
      source: 'docker-events',
      action: 'die',
      projectId: 'prd-agent',
      branchId: 'prd-agent-main',
      profileId: 'api',
      requestId: 'req-123',
      operationId: 'op-123',
      operationKind: 'deploy-pre-run-replace',
      operationTrigger: 'webhook',
      operationActor: 'system:webhook',
      operationSource: 'container.runService',
      exitCode: 137,
      oomKilled: false,
    });
    expect(records[0].details.classification).toMatchObject({
      source: 'cds',
      stopClass: 'cds-pre-run-replace',
      unexpected: false,
      nextServiceStatus: 'stopped',
    });
  });
});
