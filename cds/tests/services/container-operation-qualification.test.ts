import {unitBindMountInspector} from '../helpers/storage-bind-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { ContainerService } from '../../src/services/container.js';
import type { ServerEventLogSink } from '../../src/services/server-event-log-store.js';
import type { BranchEntry, BuildProfile, CdsConfig, ExecOptions, ExecResult, IShellExecutor, ServiceState } from '../../src/types.js';
const dirs: string[] = [];
function barrier(): { promise: Promise<void>; release: () => void } { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
async function fixture(shell: IShellExecutor, log?: ServerEventLogSink): Promise<{ service: ContainerService; entry: BranchEntry; profile: BuildProfile; state: ServiceState }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cds-qualified-private-')); dirs.push(dir);
  const service = new ContainerService(shell, { repoRoot: dir, worktreeBase: dir, dockerNetwork: 'fixture-shared', sharedEnv: {}, jwt: { secret: 'private-fixture-only', issuer: 'fixture' } } as CdsConfig, undefined, log, undefined, undefined, unitBindMountInspector);
  return { service, entry: { id: 'owned-branch', projectId: 'owned-project', branch: 'owned', worktreePath: dir, services: {}, status: 'idle', createdAt: new Date().toISOString() },
    profile: { id: 'owned-api', name: 'owned-api', dockerImage: 'alpine:3.20', workDir: '.', command: 'true', containerPort: 8080, prebuiltImage: true },
    state: { profileId: 'owned-api', containerName: 'cds-owned-branch-owned-api', hostPort: 10001, status: 'building' } };
}
const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fixtureImage = 'sha256:'+'a'.repeat(64);
const created = new Map<string, unknown[]>();
const fixtureId = (name: string) => createHash('sha256').update(name).digest('hex');
function result(command: string): ExecResult {
  if (command.startsWith('for p in /opt/ffmpeg-static/')) return ok('');
  if (command === 'git rev-parse HEAD') return ok('a'.repeat(40));
  if (command.startsWith('docker image inspect')) {
    if (command.includes("'owned/artifact:fixed'")) return {stdout:'',stderr:'No such image: owned/artifact:fixed',exitCode:1};
    return command.includes('[{{json .Id}},') ? ok(JSON.stringify([fixtureImage,null]))
      : ok(JSON.stringify([{Id:fixtureImage,Os:'linux',Architecture:'amd64',Config:{Labels:{},Volumes:null}}]));
  }
  if (command.startsWith('docker create')) {
    const name=/--name (?:'([^']+)'|([^ ]+))/.exec(command)?.slice(1).find(Boolean)!;
    const id=fixtureId(name),image=command.match(/sha256:[a-f0-9]{64}/g)?.at(-1)!;
    created.set(id,[id,'/'+name,image,0,'created',[],command.includes("--tmpfs '/tmp'")?{'/tmp':''}:null]);
    return ok(id);
  }
  if (command.startsWith('docker inspect')&&command.includes('json .Mounts')) {
    const id=command.match(/[a-f0-9]{64}/g)?.at(-1)!;
    return created.has(id)?ok(JSON.stringify(created.get(id))):{stdout:'',stderr:'No such object: '+id,exitCode:1};
  }
  if (command.includes('docker wait')) return ok('0'); return ok('owned-result');
}
afterEach(async () => { vi.restoreAllMocks(); created.clear(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
describe('容器操作在实际派发时保留资格及私有收尾', () => {
  it('迁移已经完成而回收未确认时不重跑业务，明确留下未确认资源事实', async () => {
    const record = vi.fn(); let waits = 0; let cleanups = 0;
    const shell: IShellExecutor = { exec: async (command, options) => {
      options?.beforeStart?.();
      if (command.startsWith('docker wait')) waits++;
      if (command.startsWith('docker rm -f') && waits > 0) { cleanups++; return { stdout: '', stderr: 'owned-cleanup-unavailable', exitCode: 1 }; }
      return result(command);
    } };
    const { service, entry, profile } = await fixture(shell, { record });
    expect((await service.runProfileCommand(entry, profile, 'echo owned-once')).exitCode).toBe(0);
    expect(waits).toBe(1); expect(cleanups).toBe(1);
    expect(record.mock.calls.some(([r]) => r.action === 'container.temporary.cleanup.unconfirmed' && r.details.cleanupConfirmed === false)).toBe(true);
  });
  it('迁移create在等待中被新目标取代，不创建、不启动也不删除未创建的job', async () => {
    const admitted = barrier(); const dispatch = barrier(); const started: string[] = []; let current = true;
    const original = new Error('原迁移已被取代');
    const shell: IShellExecutor = { exec: async (command, options?: ExecOptions) => {
      if (command.startsWith('docker create')) { admitted.release(); await dispatch.promise; }
      options?.beforeStart?.(); started.push(command); return result(command);
    } };
    const { service, entry, profile } = await fixture(shell);
    const running = service.runProfileCommand(entry, profile, 'echo owned-migration', undefined, undefined, { assertCurrent: () => { if (!current) throw original; } });
    const outcome = running.then(() => undefined, error => error);
    await admitted.promise; current = false; dispatch.release(); expect(await outcome).toBe(original);
    expect(started.some(c => c.startsWith('docker create') || c.startsWith('docker start'))).toBe(false);
    // 未收到create的完整CID之前不预清理名字，取消后也不得删除任何job。
    expect(started.filter(c => c.startsWith('docker rm -f'))).toEqual([]);
  });

  it('managed构建create等待后被取代，不创建后代或删除另一次构建；临时环境文件回收', async () => {
    const admitted = barrier(); const dispatch = barrier(); const started: string[] = []; let current = true;
    const original = new Error('原构建已被取代'); let envFile: string | undefined;
    const shell: IShellExecutor = { exec: async (command, options?: ExecOptions) => {
      if (command.startsWith('docker create')) { envFile = command.match(/--env-file '([^']+)'/)?.[1]; admitted.release(); await dispatch.promise; }
      options?.beforeStart?.(); started.push(command); return result(command);
    } };
    const { service, entry, profile, state } = await fixture(shell);
    profile.managedBuild = { stack: 'node', installCommand: 'true', buildCommand: 'true', startCommand: 'true', artifactImage: 'owned/artifact:fixed' };
    const running = (service as any).buildManagedArtifact(entry, profile, state, 'a'.repeat(40), 'fixture-shared', undefined, undefined, () => { if (!current) throw original; });
    const outcome = running.then(() => undefined, (error: unknown) => error);
    await admitted.promise; current = false; dispatch.release(); expect(await outcome).toBe(original);
    expect(started.some(c => c.startsWith('docker create') || c.startsWith('docker cp') || c.startsWith('docker exec'))).toBe(false);
    expect(started.filter(c => c.startsWith('docker rm -f'))).toEqual([]);
    expect(envFile).toBeDefined(); const { access } = await import('node:fs/promises'); await expect(access(envFile!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('同分支同服务的两次迁移分别创建和回收私有job，先一轮收尾不删除后一轮', async () => {
    const names: string[] = []; const ids: string[] = []; const removed: string[] = []; const active = new Set<string>(); const firstWait = barrier(); const firstFinished = barrier();
    const shell: IShellExecutor = { exec: async (command, options?: ExecOptions) => {
      options?.beforeStart?.();
      if (command.startsWith('docker create')) { const name = command.match(/--name '([^']+)'/)![1]; names.push(name); const id=fixtureId(name); ids.push(id); active.add(id); }
      if (command.startsWith('docker rm -f')) { const name = command.match(/docker rm -f '([^']+)'/)![1]; active.delete(name); removed.push(name); }
      if (command.startsWith('docker wait') && names.length === 1) { firstWait.release(); await firstFinished.promise; }
      return result(command);
    } };
    const { service, entry, profile } = await fixture(shell);
    const first = service.runProfileCommand(entry, profile, 'echo owned-first'); await firstWait.promise;
    const second = service.runProfileCommand(entry, profile, 'echo owned-second');
    try { expect((await second).exitCode).toBe(0); expect(new Set(names).size).toBe(2); expect(active.has(ids[0])).toBe(true); expect(new Set(ids).size).toBe(2); expect(ids.every(id=>/^[a-f0-9]{64}$/.test(id))).toBe(true); }
    finally { firstFinished.release(); await first; }
    expect(active.size).toBe(0); expect(removed.filter(id => ids.includes(id))).toHaveLength(2); expect([...removed].sort()).toEqual([...ids].sort());
  });
});
