import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentWorkspaceSessionRuntime } from '../../src/services/agent-workspace-session-runtime.js';
import type { ExecOptions, ExecResult, IShellExecutor } from '../../src/types.js';
const result = (stdout = '', stderr = '', exitCode = 0): ExecResult => ({ stdout, stderr, exitCode });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

function fixture(visibleAfterCancel: boolean, config: { foreignOwner?: boolean; queued?: boolean; imageFailure?: string } = {}) {
  const accepted = deferred<void>(); const calls: Array<{ command: string; options?: ExecOptions }> = [];
  const events: any[] = []; let visible = false; let pendingName = ''; let operationId = '';
  const containerId = 'a'.repeat(64); let aborted = false;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-probe-cancel-'));
  const shell: IShellExecutor = {
    async exec(command, options) {
      calls.push({ command, options });
      if (command.startsWith('docker version')) return result('27.0.0');
      if (command.startsWith('docker image inspect')) return config.imageFailure ? result('', config.imageFailure, 1) : result('sha256:actual-fixture-image');
      if (command.startsWith('docker run --rm')) {
        pendingName = command.match(/--name '([^']+)'/)![1];
        operationId = command.match(/cds.agent.probe.operation=([a-f0-9]{32})/)![1];
        if (!config.queued) options?.beforeStart?.(); accepted.resolve();
        return new Promise<ExecResult>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            aborted = true;
            if (visibleAfterCancel) setTimeout(() => { visible = true; }, 5);
            reject(Object.assign(new Error('cancelled after daemon acceptance'), { code: 'cancelled' }));
          }, { once: true });
        });
      }
      if (command.startsWith('docker inspect')) {
        if (!visible) return result('', 'No such object', 1);
        return result(JSON.stringify({ Id: containerId, Name: '/' + pendingName,
          Config: { Labels: { 'cds.instance': config.foreignOwner ? 'other-owner' : 'cancel-owner', 'cds.type': 'agent-session', 'cds.agent.probe.operation': operationId } } }));
      }
      if (command.startsWith('docker rm -f')) { visible = false; return result('removed'); }
      throw new Error('unexpected command: ' + command);
    },
  };
  if (config.queued) shell.execOwnedOperation = (command, options) => shell.exec(command, options);
  const runtime = new AgentWorkspaceSessionRuntime(shell, { rootDir, instanceId: 'cancel-owner', autoPullImage: false,
    probeCleanupTimeoutMs: 60, probeCleanupPollMs: 5, serverEventLogStore: { record: event => events.push(event) } });
  return { runtime, accepted, calls, events, rootDir, containerId, get aborted() { return aborted; }, get visible() { return visible; } };
}

describe('capability probe cancellation reconciliation', () => {
  it('records a classified pre-create image failure without copying the diagnostic into persistent events', async () => {
    const f = fixture(false, { imageFailure: 'No such image: private-diagnostic-secret' });
    try {
      await expect(f.runtime.capability(true)).resolves.toMatchObject({ available: false });
      const event = f.events.find(x => x.action === 'agent.capability.image-inspect.finished');
      expect(event.details).toMatchObject({ phase: 'capability', exitCode: 1, imageIdPresent: false, category: 'not-found', executorAssignment: null });
      expect(JSON.stringify(f.events)).not.toContain('private-diagnostic-secret');
      expect(f.calls.some(x => x.command.startsWith('docker run --rm'))).toBe(false);
      await f.runtime.closeCapabilityProbes();
    } finally { fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });
  it('does not remove a late resource whose instance label is foreign', async () => {
    const f = fixture(true, { foreignOwner: true });
    try {
      const probe = f.runtime.capability(true); await f.accepted.promise;
      await expect(f.runtime.closeCapabilityProbes()).rejects.toMatchObject({ code: 'workspace_probe_cleanup_unconfirmed' });
      await expect(probe).resolves.toMatchObject({ available: false });
      expect(f.visible).toBe(true);
      expect(f.calls.some(x => x.command.startsWith('docker rm -f'))).toBe(false);
    } finally { fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });
  it('closes a cancelled, never-authorized queue item without pretending it created a resource', async () => {
    const f = fixture(false, { queued: true });
    try {
      const probe = f.runtime.capability(true); await f.accepted.promise;
      await f.runtime.closeCapabilityProbes(); await expect(probe).resolves.toMatchObject({ available: false });
      expect(f.calls.some(x => x.command.startsWith('docker inspect') || x.command.startsWith('docker rm -f'))).toBe(false);
    } finally { fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });

  it('waits for a late acknowledged allocation and removes its exact ID through the cleanup reservation', async () => {
    const f = fixture(true);
    try {
      const probe = f.runtime.capability(true); await f.accepted.promise;
      await f.runtime.closeCapabilityProbes(); await expect(probe).resolves.toMatchObject({ available: false });
      expect(f.aborted).toBe(true); expect(f.visible).toBe(false);
      const removal = f.calls.find(x => x.command.startsWith('docker rm -f'))!;
      expect(removal.command).toBe(`docker rm -f '${f.containerId}'`);
      expect(removal.options?.executionPurpose).toBe('temporary-cleanup');
      expect(f.calls.some(x => x.command.includes('prune'))).toBe(false);
      expect(f.events.some(x => x.action === 'agent.probe.cleanup.confirmed')).toBe(true);
      await expect(f.runtime.capability(true)).resolves.toMatchObject({ available: false });
      expect(f.calls.filter(x => x.command.startsWith('docker run --rm'))).toHaveLength(1);
    } finally { fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });
  it('reports absence as unconfirmed at the finite deadline and does not delete an unknown resource', async () => {
    const f = fixture(false);
    try {
      const probe = f.runtime.capability(true); await f.accepted.promise;
      await expect(f.runtime.closeCapabilityProbes()).rejects.toMatchObject({ code: 'workspace_probe_cleanup_unconfirmed' });
      await expect(probe).resolves.toMatchObject({ available: false });
      expect(f.calls.some(x => x.command.startsWith('docker rm -f'))).toBe(false);
      expect(f.events.some(x => x.action === 'agent.probe.cleanup.unconfirmed')).toBe(true);
    } finally { fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });
});
