import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearContainerLifecycleIntentsForTest,
  collectContainerDiagnostics,
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

describe('failure diagnostic IO budget', () => {
  it('archives delayed old events but fences their state callbacks after same-ID restart or name recreation', async () => {
    for (const nextId of ['c'.repeat(64), 'd'.repeat(64)]) {
      const id = 'c'.repeat(64);
      let release!: (value: ShellResult) => void;
      const pending = new Promise<ShellResult>(resolve => { release = resolve; });
      const exec = vi.fn().mockImplementationOnce(() => pending).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      const records: any[] = [];
      let visibleStatus = 'running';
      const callback = vi.fn((event: any) => {
        if (event.action === 'start') visibleStatus = 'running';
        if (event.action === 'die' && event.stateSyncEligible !== false) visibleStatus = 'stopped';
      });
      const monitor = new DockerEventMonitor({ exec }, { record: r => { records.push(r); } }, callback);
      const event = (Action: string, ID: string) => (monitor as any).handleLine(JSON.stringify({ Action,
        Actor: { ID, Attributes: { name: 'canonical-name', 'cds.branch.id': 'branch' } } }));
      const old = event('die', id);
      await Promise.resolve();
      await event('start', nextId);
      release({ stdout: JSON.stringify({ Id: id, State: { Status: 'exited', ExitCode: 137 } }), stderr: '', exitCode: 0 });
      await old;
      expect(records).toHaveLength(2);
      expect(visibleStatus).toBe('running');
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ action: 'die', containerId: id, stateSyncEligible: false }));
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ action: 'start', containerId: nextId, stateSyncEligible: true }));
    }
  });
  it('captures unhealthy events and invalidates the snapshot on start and healthy recovery', async () => {
    const id = 'b'.repeat(64);
    const records: any[] = [];
    const exec = vi.fn(async (command: string) => ({
      stdout: command.startsWith('docker inspect') ? JSON.stringify({ Id: id }) : '', stderr: '', exitCode: 0,
    }));
    const monitor = new DockerEventMonitor({ exec }, { record: r => { records.push(r); } });
    const event = (Action: string) => (monitor as any).handleLine(JSON.stringify({ Action, Actor: { ID: id,
      Attributes: { name: 'same-name', 'cds.deployment.operation': 'run' } } }));
    await event('health_status: unhealthy');
    await event('die');
    expect(exec).toHaveBeenCalledTimes(2);
    expect(records[0].severity).toBe('error');
    await event('start');
    await event('die');
    expect(exec).toHaveBeenCalledTimes(4);
    await event('health_status: healthy');
    await event('health_status: unhealthy');
    expect(exec).toHaveBeenCalledTimes(6);
    expect(records).toHaveLength(6);
  });
  it('deduplicates concurrent immutable-container events without dropping lifecycle facts', async () => {
    const id = 'a'.repeat(64);
    const records: any[] = [];
    const callback = vi.fn();
    const exec = vi.fn(async (command: string) => ({
      stdout: command.startsWith('docker inspect')
        ? JSON.stringify({ Id: id, State: { Status: 'exited', ExitCode: 137 } }) : 'stopped',
      stderr: '', exitCode: 0,
    }));
    const monitor = new DockerEventMonitor({ exec }, { record: r => { records.push(r); } }, callback);
    await Promise.all(Array.from({ length: 20 }, (_, i) => (monitor as any).handleLine(JSON.stringify({
      Action: i % 2 ? 'die' : 'stop', Actor: { ID: id, Attributes: {
        name: 'mutable-name', 'cds.deployment.operation': 'run-1', 'cds.branch.id': 'b',
      } },
    }))));
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.every(([command]) => command.includes(id))).toBe(true);
    expect(exec.mock.calls.every((call: any[]) => call[1]?.priority === 'diagnostic')).toBe(true);
    expect(records).toHaveLength(20);
    expect(callback).toHaveBeenCalledTimes(20);
  });

  it('does not copy malformed inspect output into a diagnostic record', async () => {
    const exec = vi.fn(async (command: string) => ({
      stdout: command.startsWith('docker inspect') ? '{"Env":["TOKEN=private-value"]' : '',
      stderr: '', exitCode: 0,
    }));
    const result = await collectContainerDiagnostics({ exec }, 'a'.repeat(64));
    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(result.inspect).toEqual({ parseError: 'invalid_inspect_json' });
    expect(exec.mock.calls[0][0]).toContain('--format');
  });
});
