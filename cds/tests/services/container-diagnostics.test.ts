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
  it('correlates restart by immutable CID, preserves late delivery, and does not hide a later crash', async () => {
    clearContainerLifecycleIntentsForTest();
    const cid = 'b'.repeat(64);
    const intent = recordContainerLifecycleIntent({ containerName: cid, kind: 'cds-restart', reason: '刷新连接',
      operationId: 'recovery-op' });
    // Use current timestamps so the global five-minute retention remains valid.
    const start = Date.now(); intent!.requestedAt = new Date(start).toISOString();
    intent!.completedAt = new Date(start + 100).toISOString();
    const records: any[] = [];
    const monitor = new DockerEventMonitor({ exec: async () => ({ stdout: '', stderr: '', exitCode: 1 }) },
      { record: record => { records.push(record); } });
    const event = (at: number, action = 'die') => JSON.stringify({ Action: action, timeNano: (at * 1e6),
      Actor: { ID: cid, Attributes: { name: 'cds-actual-runtime-name', exitCode: '0', signal: '15' } } });
    await (monitor as any).handleLine(event(start + 50));
    expect(records.at(-1)).toMatchObject({ operationId: 'recovery-op', details: { classification: { stopClass: 'cds-restart' } } });
    expect(records.at(-1).message).not.toContain('没有匹配到');
    await (monitor as any).handleLine(event(start + 101));
    expect(records.at(-1).details.classification.stopClass).not.toBe('cds-restart');
    expect(records.at(-1).operationId).toBeNull();
    clearContainerLifecycleIntentsForTest();
  });
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
      severity: 'warn',
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

  it('records normal docker exits as info instead of error', async () => {
    const containerName = 'cds-prd-agent-main-api-prd-agent';
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
              State: { Status: 'exited', ExitCode: 0, OOMKilled: false },
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
          return { stdout: 'clean shutdown', stderr: '', exitCode: 0 };
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
          exitCode: '0',
        },
      },
      time: 1,
      timeNano: 1,
    }));

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      category: 'docker',
      severity: 'info',
      source: 'docker-events',
      action: 'die',
      branchId: 'prd-agent-main',
      profileId: 'api',
      exitCode: 0,
      oomKilled: false,
    });
    expect(records[0].details.classification).toMatchObject({
      source: 'system',
      stopClass: 'normal-exit',
      unexpected: false,
      nextServiceStatus: 'stopped',
    });
  });
});
