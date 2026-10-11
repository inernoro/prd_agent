import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentWorkspaceSessionRuntime } from '../../src/services/agent-workspace-session-runtime.js';
import type { ExecOptions, ExecResult, IShellExecutor } from '../../src/types.js';
const result = (stdout = '', stderr = '', exitCode = 0): ExecResult => ({ stdout, stderr, exitCode });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

function fixture(visibleAfterCancel: boolean, config: { foreignOwner?: boolean; queued?: boolean; imageFailure?: string; emptyCidFile?: boolean } = {}) {
  const accepted = deferred<void>(); const calls: Array<{ command: string; options?: ExecOptions }> = [];
  const events: any[] = []; let visible = false; let pendingName = ''; let operationId = ''; let journalAtAdmission: any;
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
        if (config.emptyCidFile) fs.writeFileSync(command.match(/--cidfile '([^']+)'/)![1], '');
        if (!config.queued) options?.beforeStart?.();
        const journal = path.join(path.dirname(command.match(/--cidfile '([^']+)'/)![1]), 'probe.json');
        if (fs.existsSync(journal)) journalAtAdmission = JSON.parse(fs.readFileSync(journal, 'utf8'));
        accepted.resolve();
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
      if (command.startsWith('docker ps -aq')) return result(visible ? containerId : '');
      if (command.startsWith('docker network ls -q') || command.startsWith('docker volume ls -q')) return result();
      if (command.startsWith('docker kill')) return result('', 'container is not running', 1);
      if (command.startsWith('docker rm -f')) { visible = false; return result('removed'); }
      throw new Error('unexpected command: ' + command);
    },
  };
  if (config.queued) shell.execOwnedOperation = (command, options) => shell.exec(command, options);
  const runtime = new AgentWorkspaceSessionRuntime(shell, { rootDir, instanceId: 'cancel-owner', autoPullImage: false,
    probeCleanupTimeoutMs: 60, probeCleanupPollMs: 5, serverEventLogStore: { record: event => events.push(event) } });
  return { runtime, shell, accepted, calls, events, rootDir, containerId, reveal: () => { visible = true; },
    get journalAtAdmission() { return journalAtAdmission; }, get aborted() { return aborted; }, get visible() { return visible; } };
}

describe('capability probe cancellation reconciliation', () => {
  it('retains an issued but unacknowledged generation across restart and later removes only the owned ID', async () => {
    const f = fixture(false, { emptyCidFile: true });
    const restarted = new AgentWorkspaceSessionRuntime(f.shell, { rootDir: f.rootDir, instanceId: 'cancel-owner', autoPullImage: false,
      probeCleanupTimeoutMs: 60, probeCleanupPollMs: 5, serverEventLogStore: { record: event => f.events.push(event) } });
    try {
      const probe = f.runtime.capability(true); await f.accepted.promise;
      expect(f.journalAtAdmission).toMatchObject({ schema: 1, instanceId: 'cancel-owner', leases: [{ issued: true, cleaned: false }] });
      await expect(f.runtime.closeCapabilityProbes()).rejects.toMatchObject({ code: 'workspace_probe_cleanup_unconfirmed' });
      await expect(probe).resolves.toMatchObject({ available: false });
      await expect(restarted.bootstrapAndVerify()).rejects.toMatchObject({ code: 'workspace_orphan_cleanup_failed' });
      expect(f.calls.filter(x => x.command.startsWith('docker run --rm'))).toHaveLength(1);
      expect(f.calls.some(x => x.command.startsWith('docker rm -f'))).toBe(false);
      f.reveal(); await restarted.bootstrapAndVerify();
      expect(f.visible).toBe(false);
      expect(f.calls.filter(x => x.command.startsWith('docker rm -f')).map(x => x.command)).toEqual([`docker rm -f '${f.containerId}'`]);
      expect(f.events.some(x => x.action === 'agent.probe.recovery.loaded')).toBe(true);
      expect(f.calls.filter(x => x.command.startsWith('docker run --rm'))).toHaveLength(1);
    } finally { await restarted.closeCapabilityProbes().catch(() => undefined); fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });
  it('autonomously retries recovered unknown ownership and clears it after the late allocation appears', async () => {
    const f = fixture(false, { emptyCidFile: true }); const cleaned = deferred<void>();
    const restarted = new AgentWorkspaceSessionRuntime(f.shell, { rootDir: f.rootDir, instanceId: 'cancel-owner', autoPullImage: false,
      probeCleanupTimeoutMs: 60, probeCleanupPollMs: 5, cleanupRetryBaseMs: 5, cleanupRetryMaxMs: 10,
      serverEventLogStore: { record: event => { f.events.push(event); if (event.action === 'agent.probe.cleanup.confirmed') cleaned.resolve(); } } });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const probe = f.runtime.capability(true); await f.accepted.promise;
      await expect(f.runtime.closeCapabilityProbes()).rejects.toMatchObject({ code: 'workspace_probe_cleanup_unconfirmed' });
      await probe;
      await expect(restarted.bootstrapAndVerify()).rejects.toMatchObject({ code: 'workspace_orphan_cleanup_failed' });
      expect((await restarted.capability()).available).toBe(false);
      f.reveal();
      await Promise.race([cleaned.promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('late allocation was not reconciled')), 1000); })]);
      await restarted.bootstrapAndVerify();
      expect(f.visible).toBe(false);
      expect(f.calls.filter(x => x.command.startsWith('docker run --rm'))).toHaveLength(1);
      expect(f.calls.filter(x => x.command.startsWith('docker rm -f')).map(x => x.command)).toEqual([`docker rm -f '${f.containerId}'`]);
    } finally { clearTimeout(timeout); await restarted.closeCapabilityProbes().catch(() => undefined); fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });

  it('refuses a daemon allocation when the private responsibility record cannot be flushed', async () => {
    const f = fixture(false);
    const open = fs.promises.open.bind(fs.promises);
    const flush = vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (file, flags, mode) => {
      const descriptor = await open(file, flags, mode);
      vi.spyOn(descriptor, 'sync').mockRejectedValueOnce(new Error('private-fsync-failure-secret'));
      return descriptor;
    });
    try {
      await expect(f.runtime.capability(true)).resolves.toMatchObject({ available: false });
      expect(f.calls.some(x => x.command.startsWith('docker run --rm'))).toBe(false);
      expect(JSON.stringify(f.events)).not.toContain('private-fsync-failure-secret');
      await f.runtime.closeCapabilityProbes();
    } finally { flush.mockRestore(); fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });
  it('accepts shutdown while private flushing is pending and never authorizes the late daemon request', async () => {
    const f = fixture(false), flushing = deferred<void>(), release = deferred<void>();
    const open = fs.promises.open.bind(fs.promises);
    const flush = vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (file, flags, mode) => {
      const descriptor = await open(file, flags, mode);
      vi.spyOn(descriptor, 'sync').mockImplementationOnce(async () => { flushing.resolve(); await release.promise; });
      return descriptor;
    });
    try {
      const probe = f.runtime.capability(true); await flushing.promise;
      const closing = f.runtime.closeCapabilityProbes();
      release.resolve(); await closing;
      await expect(probe).resolves.toMatchObject({ available: false });
      expect(f.calls.some(x => x.command.startsWith('docker run --rm'))).toBe(false);
    } finally { release.resolve(); flush.mockRestore(); await f.runtime.closeCapabilityProbes().catch(() => undefined); fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });
  it('waits for pending restart receipt loading before deciding that shutdown is clean', async () => {
    const f = fixture(false), loading = deferred<void>(), release = deferred<void>();
    const restarted = new AgentWorkspaceSessionRuntime(f.shell, { rootDir: f.rootDir, instanceId: 'cancel-owner', autoPullImage: false,
      probeCleanupTimeoutMs: 60, probeCleanupPollMs: 5 });
    const probe = f.runtime.capability(true); await f.accepted.promise;
    await expect(f.runtime.closeCapabilityProbes()).rejects.toMatchObject({ code: 'workspace_probe_cleanup_unconfirmed' }); await probe;
    const open = fs.promises.open.bind(fs.promises); let held = false;
    const receipt = vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      if (!held && String(file).endsWith('probe.json')) { held = true; loading.resolve(); await release.promise; }
      return open(file, flags, mode);
    });
    try {
      const bootstrap = restarted.bootstrap(); await loading.promise;
      let finished = false;
      const closed = restarted.closeCapabilityProbes().then(() => { finished = true; return null; }, error => { finished = true; return error; });
      await new Promise<void>(resolve => setImmediate(resolve)); expect(finished).toBe(false);
      release.resolve(); await bootstrap;
      expect(await closed).toMatchObject({ code: 'workspace_probe_cleanup_unconfirmed' });
      expect(f.calls.filter(x => x.command.startsWith('docker run --rm'))).toHaveLength(1);
    } finally { release.resolve(); receipt.mockRestore(); await restarted.closeCapabilityProbes().catch(() => undefined); fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });
  it('reconciles an empty CLI-reserved CID file through owned inspection after cancellation', async () => {
    const f = fixture(true, { emptyCidFile: true });
    try {
      const probe = f.runtime.capability(true); await f.accepted.promise;
      await f.runtime.closeCapabilityProbes(); await expect(probe).resolves.toMatchObject({ available: false });
      expect(f.aborted).toBe(true); expect(f.visible).toBe(false);
      expect(f.calls.filter(x => x.command.startsWith('docker rm -f')).map(x => x.command)).toEqual([`docker rm -f '${f.containerId}'`]);
      expect(f.events.find(x => x.action === 'agent.probe.creation.acknowledged')?.details.receipt).toBe('owned-inspect');
      expect(f.events.some(x => x.action === 'agent.probe.cleanup.confirmed')).toBe(true);
    } finally { fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });
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
