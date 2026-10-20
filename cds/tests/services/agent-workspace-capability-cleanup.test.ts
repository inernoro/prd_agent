import { createCoreImageCacheShell, installCoreImageCacheTestRoot } from '../helpers/core-image-cache-shell.js';
const coreCacheShell = createCoreImageCacheShell();
installCoreImageCacheTestRoot();
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentWorkspaceSessionRuntime } from '../../src/services/agent-workspace-session-runtime.js';
import { OperationExecutionError } from '../../src/services/isolated-shell-executor.js';
import type { ExecOptions, ExecResult, IShellExecutor } from '../../src/types.js';
const result = (stdout = '', stderr = '', exitCode = 0): ExecResult => ({ stdout, stderr, exitCode });
// 夹具会真实刷盘；留出调度余量，截止时间和确认窗口仍使用同一个固定预算。
const cleanupBudgetMs = 300;
const cleanupPollMs = 20;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

function fixture(visibleAfterCancel: boolean, config: { foreignOwner?: boolean; queued?: boolean; imageFailure?: string; emptyCidFile?: boolean;
  removingReplies?: number; neverCompletesRemoval?: boolean; removeFailure?: boolean; delayedRemovalReply?: boolean; keepRemovalVisible?: boolean; delayedRemovalMs?: number;
  earlyRemovalExpiry?: 'deadline' | 'cancelled'; cleanupBudgetMs?: number; cleanupPollMs?: number } = {}) {
  const accepted = deferred<void>(); const removalStarted = deferred<void>(); const calls: Array<{ command: string; options?: ExecOptions }> = [];
  const events: any[] = []; let visible = false; let pendingName = ''; let operationId = ''; let journalAtAdmission: any;
  const containerId = 'a'.repeat(64); let aborted = false, removalAttempts = 0;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-probe-cancel-'));
  const shell: IShellExecutor = {
    async exec(command, options) {
        const cached = coreCacheShell(command); if (cached) return cached;
      calls.push({ command, options });
      if (command.startsWith('docker version')) return result('27.0.0');
      if (command.startsWith('docker image inspect')) return config.imageFailure ? result('', config.imageFailure, 1) : result('sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
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
        if (!visible) return result('', `No such object: ${command.match(/'([^']+)'$/)?.[1] || pendingName}`, 1);
        return result(JSON.stringify({ Id: containerId, Name: '/' + pendingName,
          Config: { Labels: { 'cds.instance': config.foreignOwner ? 'other-owner' : 'cancel-owner', 'cds.type': 'agent-session', 'cds.agent.probe.operation': operationId } } }));
      }
      if (command.startsWith('docker ps -aq')) return result(visible ? containerId : '');
      if (command.startsWith('docker network ls -q') || command.startsWith('docker volume ls -q')) return result();
      if (command.startsWith('docker kill')) return result('', 'container is not running', 1);
      if (command.startsWith('docker rm -f')) {
        removalAttempts++;
        removalStarted.resolve();
        if (config.earlyRemovalExpiry && removalAttempts === 1) throw new OperationExecutionError(config.earlyRemovalExpiry);
        if (config.delayedRemovalMs) {
          if (!visible) return result('', `No such container: ${containerId}`, 1);
          if (removalAttempts > 1) return result('', `removal of container ${containerId} is already in progress`, 1);
          setTimeout(() => { visible = false; }, config.delayedRemovalMs);
          return new Promise<ExecResult>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('original step deadline'), { code: 'deadline' })), { once: true });
          });
        }
        if (config.removeFailure) return result('', 'permission denied', 1);
        if (config.neverCompletesRemoval || removalAttempts <= (config.removingReplies ?? 0))
          return result('', `Error response from daemon: removal of container ${containerId} is already in progress`, 1);
        if (!config.keepRemovalVisible) visible = false;
        if (config.delayedRemovalReply) return new Promise<ExecResult>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('reply cancelled after confirmed deletion'), { code: 'cancelled' })), { once: true });
        });
        return config.removingReplies ? result('', 'No such container: ' + containerId, 1) : result('removed');
      }
      throw new Error('unexpected command: ' + command);
    },
  };
  if (config.queued) shell.execOwnedOperation = (command, options) => shell.exec(command, options);
  const runtime = new AgentWorkspaceSessionRuntime(shell, { rootDir, instanceId: 'cancel-owner', autoPullImage: false,
    // 真实 IO 场景沿用 main 的 300/20；受控时钟场景和原窗交界场景保留 60/5。
    probeCleanupTimeoutMs: config.cleanupBudgetMs ?? (config.earlyRemovalExpiry ? 60 : cleanupBudgetMs),
    probeCleanupPollMs: config.cleanupPollMs ?? (config.earlyRemovalExpiry ? 5 : cleanupPollMs), serverEventLogStore: { record: event => events.push(event) } });
  return { runtime, shell, accepted, removalStarted, calls, events, rootDir, containerId, reveal: () => { visible = true; },
    get journalAtAdmission() { return journalAtAdmission; }, get aborted() { return aborted; }, get visible() { return visible; } };
}

describe('capability probe cancellation reconciliation', () => {
  it.each(['deadline', 'cancelled'] as const)('已确认 CID 在原窗口内收到 %s 后仍按同一有限期限核实清理', async code => {
    const f = fixture(true, { earlyRemovalExpiry: code });
    let restoreClock = () => {}, restoreRemove = () => {};
    if (code === 'deadline') {
      const runtime = f.runtime as any;
      const remove = runtime.removeConfirmedProbeContainer.bind(runtime);
      const intercepted = vi.spyOn(runtime, 'removeConfirmedProbeContainer').mockImplementation(async (...args: any[]) => {
        try { return await remove(...args); }
        catch (error) {
          // 仅固定原 D 交界的两次读钟；不改生产期限或真实 AbortSignal。
          const clock = vi.spyOn(Date, 'now').mockReturnValue(args[2]);
          clock.mockReturnValueOnce(args[2] - 1);
          restoreClock = () => clock.mockRestore();
          throw error;
        }
      });
      restoreRemove = () => intercepted.mockRestore();
    }
    try {
      const probe = f.runtime.capability(true); await f.accepted.promise;
      await expect(f.runtime.closeCapabilityProbes()).resolves.toBeUndefined(); await probe;
      const early = f.events.find(event => event.action === 'agent.probe.cleanup.step.interrupted' && event.details.outcome === code);
      expect(early).toBeDefined();
      expect(early.details.finishedAt).toBeLessThan(early.details.deadline);
      expect(f.calls.filter(call => call.command.startsWith('docker rm -f')).map(call => call.command))
        .toEqual([`docker rm -f '${f.containerId}'`, `docker rm -f '${f.containerId}'`]);
      expect(f.calls.filter(call => call.command.startsWith('docker run --rm'))).toHaveLength(1);
      const steps = f.events.filter(event => event.action === 'agent.probe.cleanup.step.requested');
      expect(steps.every(event => event.details.deadline - event.details.requestedAt > 0 && event.details.deadline - event.details.requestedAt <= 60)).toBe(true);
      const windows = f.events.filter(event => event.action === 'agent.probe.cleanup.confirmation-window.started');
      expect(windows.length).toBeLessThanOrEqual(1);
      if (code === 'deadline') expect(windows).toHaveLength(1);
      expect(windows.every(event => event.details.originalDeadline === early.details.deadline
        && event.details.confirmationDeadline - event.details.originalDeadline === 60)).toBe(true);
      expect(f.events.some(event => event.action === 'agent.probe.cleanup.confirmed')).toBe(true);
      expect(f.visible).toBe(false);
    } finally {
      restoreClock(); restoreRemove();
      await f.runtime.closeCapabilityProbes().catch(() => undefined);
      fs.rmSync(f.rootDir, { recursive: true, force: true });
    }
  });

  it('uses the fixed confirmed-resource window after one step expires, without extending any step or reissuing a name', async () => {
    vi.useFakeTimers();
    // Node's native AbortSignal.timeout does not follow Vitest's clock.
    // Keep cancellation and Date.now on the same deterministic timeline.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    const f = fixture(true, { delayedRemovalMs: 80, cleanupBudgetMs: 60, cleanupPollMs: 5 });
    try {
      const probe = f.runtime.capability(true); await f.accepted.promise;
      const closing = expect(f.runtime.closeCapabilityProbes()).resolves.toBeUndefined();
      f.reveal();
      // Real journal IO completes before advancing time. CI scheduling must
      // not consume the deliberately tiny 60ms cleanup budget in this test.
      await f.removalStarted.promise;
      await vi.advanceTimersByTimeAsync(60);
      expect(f.visible).toBe(true);
      expect(f.events.some(event => event.action === 'agent.probe.cleanup.confirmation-window.started')).toBe(true);
      await vi.advanceTimersByTimeAsync(25);
      await closing; await probe;
      const window = f.events.find(event => event.action === 'agent.probe.cleanup.confirmation-window.started');
      expect(window.details.confirmationDeadline - window.details.originalDeadline).toBe(60);
      const steps = f.events.filter(event => event.action === 'agent.probe.cleanup.step.requested');
      expect(steps.every(event => event.details.deadline - event.details.requestedAt > 0 && event.details.deadline - event.details.requestedAt <= 60)).toBe(true);
      expect(f.calls.filter(call => call.command.startsWith('docker rm -f')).every(call => call.command === `docker rm -f '${f.containerId}'`)).toBe(true);
      expect(f.events.some(event => event.action === 'agent.probe.cleanup.confirmed')).toBe(true);
      expect(f.visible).toBe(false);
    } finally {
      timeout.mockRestore(); vi.clearAllTimers(); vi.useRealTimers();
      fs.rmSync(f.rootDir, { recursive: true, force: true });
    }
  });

  it('a delayed removal reply with the exact CID still present remains unconfirmed at the original deadline', async () => {
    const f = fixture(true, { delayedRemovalReply: true, keepRemovalVisible: true });
    try {
      const probe = f.runtime.capability(true); await f.accepted.promise;
      await expect(f.runtime.closeCapabilityProbes()).rejects.toMatchObject({ code: 'workspace_probe_cleanup_unconfirmed' }); await probe;
      expect(f.visible).toBe(true);
      expect(f.events.some(event => event.action === 'agent.probe.cleanup.removal-confirmed-by-id')).toBe(false);
      expect(f.events.some(event => event.action === 'agent.probe.cleanup.unconfirmed')).toBe(true);
    } finally { fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });

  it('confirms the exact acknowledged CID disappeared while removal reply is delayed, within the original cleanup budget', async () => {
    const f = fixture(true, { delayedRemovalReply: true });
    try {
      const probe = f.runtime.capability(true); await f.accepted.promise;
      await expect(f.runtime.closeCapabilityProbes()).resolves.toBeUndefined(); await probe;
      expect(f.visible).toBe(false);
      expect(f.events.some(event => event.action === 'agent.probe.cleanup.removal-confirmed-by-id')).toBe(true);
      expect(f.events.some(event => event.action === 'agent.probe.cleanup.confirmed')).toBe(true);
      expect(f.events.some(event => event.action === 'agent.probe.cleanup.unconfirmed')).toBe(false);
      expect(f.calls.filter(call => call.command.startsWith('docker rm -f'))).toHaveLength(1);
      expect(f.calls.some(call => call.command.startsWith('docker inspect') && call.command.endsWith(`'${f.containerId}'`))).toBe(true);
    } finally { fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });

  it('shutdown does not restart the exhausted cleanup budget; unknown creation stays durable and unconfirmed', async () => {
    const f = fixture(false);
    try {
      const probe = f.runtime.capability(true); await f.accepted.promise;
      await expect(f.runtime.closeCapabilityProbes()).rejects.toMatchObject({ code: 'workspace_probe_cleanup_unconfirmed' });
      await probe;
      expect(f.events.filter(x => x.action === 'agent.probe.cleanup.unconfirmed')).toHaveLength(1);
      expect(f.events.some(x => x.action === 'agent.probe.cleanup.confirmed')).toBe(false);
      const receipts = fs.readdirSync(f.rootDir).flatMap(instance =>
        fs.readdirSync(path.join(f.rootDir, instance)).filter(name => name.startsWith('capability-'))
          .map(name => path.join(f.rootDir, instance, name, 'probe.json')));
      expect(receipts).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(receipts[0], 'utf8')).leases).toMatchObject([{ issued: true, cleaned: false }]);
      expect(f.calls.some(x => x.command.startsWith('docker rm -f'))).toBe(false);
    } finally { await f.runtime.closeCapabilityProbes().catch(() => undefined); fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });
  it('confirms a daemon deletion that is still in progress without failing shutdown before its original deadline', async () => {
    const f = fixture(true, { emptyCidFile: true, removingReplies: 2 });
    try {
      const probe = f.runtime.capability(true); await f.accepted.promise;
      await f.runtime.closeCapabilityProbes(); await expect(probe).resolves.toMatchObject({ available: false });
      expect(f.visible).toBe(false);
      const removals = f.calls.filter(x => x.command.startsWith('docker rm -f'));
      expect(removals).toHaveLength(3); expect(removals.every(x => x.command === `docker rm -f '${f.containerId}'`)).toBe(true);
      expect(removals.every(x => x.options?.executionPurpose === 'temporary-cleanup')).toBe(true);
      const finished = f.events.filter(x => x.action === 'agent.probe.cleanup.step.finished' && x.details.cleanupStep === 'remove');
      expect(finished.map(x => x.details.outcome)).toEqual(['removing', 'removing', 'absent']);
      expect(new Set(finished.map(x => x.details.deadline)).size).toBe(1);
      expect(f.events.some(x => x.action === 'agent.probe.cleanup.confirmed')).toBe(true);
    } finally { await f.runtime.closeCapabilityProbes().catch(() => undefined); fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });
  it('retains the owned receipt when daemon removal never completes within the unchanged finite budget', async () => {
    const f = fixture(true, { neverCompletesRemoval: true });
    try {
      const probe = f.runtime.capability(true); await f.accepted.promise;
      await expect(f.runtime.closeCapabilityProbes()).rejects.toMatchObject({ code: 'workspace_probe_cleanup_unconfirmed' }); await probe;
      expect(f.visible).toBe(true); expect(f.events.some(x => x.action === 'agent.probe.cleanup.confirmed')).toBe(false);
      const removals = f.calls.filter(x => x.command.startsWith('docker rm -f'));
      expect(removals.length).toBeGreaterThan(2); expect(removals.length).toBeLessThan(40);
      expect(removals.every(x => x.command === `docker rm -f '${f.containerId}'` && x.options?.timeout! <= cleanupBudgetMs)).toBe(true);
      const journals = fs.readdirSync(f.rootDir, { recursive: true }).filter(name => String(name).endsWith('probe.json'));
      expect(journals.length).toBeGreaterThan(0);
      const receipt = JSON.parse(fs.readFileSync(path.join(f.rootDir, String(journals[0])), 'utf8'));
      expect(receipt.leases.some((lease: any) => lease.containerId === f.containerId && lease.cleaned === false)).toBe(true);
    } finally { await f.runtime.closeCapabilityProbes().catch(() => undefined); fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });
  it('does not keep retrying a real removal failure or mark it as confirmed', async () => {
    const f = fixture(true, { removeFailure: true });
    try {
      const probe = f.runtime.capability(true); await f.accepted.promise;
      await expect(f.runtime.closeCapabilityProbes()).rejects.toMatchObject({ code: 'workspace_probe_cleanup_unconfirmed' }); await probe;
      expect(f.visible).toBe(true); expect(f.calls.filter(x => x.command.startsWith('docker rm -f')).length).toBeLessThanOrEqual(2);
      expect(f.events.some(x => x.action === 'agent.probe.cleanup.confirmed')).toBe(false);
    } finally { await f.runtime.closeCapabilityProbes().catch(() => undefined); fs.rmSync(f.rootDir, { recursive: true, force: true }); }
  });
  it('retains an issued but unacknowledged generation across restart and later removes only the owned ID', async () => {
    const f = fixture(false, { emptyCidFile: true });
    const restarted = new AgentWorkspaceSessionRuntime(f.shell, { rootDir: f.rootDir, instanceId: 'cancel-owner', autoPullImage: false,
      probeCleanupTimeoutMs: cleanupBudgetMs, probeCleanupPollMs: cleanupPollMs, serverEventLogStore: { record: event => f.events.push(event) } });
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
      probeCleanupTimeoutMs: cleanupBudgetMs, probeCleanupPollMs: cleanupPollMs, cleanupRetryBaseMs: 5, cleanupRetryMaxMs: 10,
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
      probeCleanupTimeoutMs: cleanupBudgetMs, probeCleanupPollMs: cleanupPollMs });
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
