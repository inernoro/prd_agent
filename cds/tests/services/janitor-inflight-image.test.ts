import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JanitorService, createJanitorDockerAdapters, IMAGE_HELD_PREFIX } from '../../src/services/janitor.js';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor, ShellExecutor } from '../../src/services/shell-executor.js';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';
import { captureDeploymentInput } from '../../src/services/deployment-input.js';
import type { BuildProfile } from '../../src/types.js';

const oldImage = 'ghcr.io/owned/web:sha-' + '1'.repeat(40);
const target = 'ghcr.io/owned/web:sha-' + '2'.repeat(40);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('部署已受理而尚无容器时的镜像保护', () => {
  it('真实Janitor保留在途必需镜像，终态解除后按原代数回收', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-inflight-image-')); roots.push(root);
    const state = new StateService(path.join(root, 'state.json')); state.load();
    state.addProject({ id: 'owned', slug: 'owned', name: 'owned', kind: 'git', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' });
    state.addBranch({ id: 'branch', projectId: 'owned', branch: 'feature', worktreePath: root, services: {}, status: 'idle', createdAt: '2026-11-01T00:00:00Z' });
    state.addDeploymentVersion({ id: 'old', projectId: 'owned', branchId: 'branch', commitSha: '1'.repeat(40),
      configHash: 'original', createdByRunId: 'original', createdAt: '2026-11-01T00:00:00Z', migrations: [], capabilities: [],
      profiles: [{ profileId: 'web', name: 'web', artifactImage: oldImage, artifactKind: 'prebuilt-image', reusable: true, containerPort: 80 }] });
    let references = [target]; const removeImage = vi.fn().mockResolvedValue(null);
    const janitor = new JanitorService(state, { enabled: false, worktreeTTLDays: 7, diskWarnPercent: 80,
      sweepIntervalSeconds: 3600, dockerPrune: false, orphanWorktrees: false, imageKeepGenerations: 5 }, root,
      undefined, () => ({ totalBytes: 10000, freeBytes: 9000 }), undefined,
      { listImages: async () => [oldImage, target], listInUseImages: async () => [], removeImage }, undefined,
      () => references);
    await janitor.sweep(); expect(removeImage).not.toHaveBeenCalled();
    references = []; await janitor.sweep(); expect(removeImage).toHaveBeenCalledWith(target, expect.any(Function));
  });

  it('原生引用查询等待期间新增的部署保护在实际rmi派发前复核', async () => {
    let protectedNow = false;
    const shell = new MockShellExecutor();
    shell.addResponsePattern(/ancestor=/, () => { protectedNow = true; return { stdout: '', stderr: '', exitCode: 0 }; });
    const result = await createJanitorDockerAdapters(shell).imageDocker.removeImage(target, () => protectedNow);
    expect(shell.commands.some(command => /\brmi\b/.test(command))).toBe(false);
    expect(result).toMatch(new RegExp('^' + IMAGE_HELD_PREFIX));
  });

  it('操作排队后新增保护由实际beforeStart取消，不执行删除', async () => {
    let protectedNow = false, executed = false;
    const shell = { exec: vi.fn(async (command: string, options?: import('../../src/types.js').ExecOptions) => {
      if (/\brmi\b/.test(command)) {
        protectedNow = true; expect(options?.timeout).toBe(60000);
        expect(options?.executionLane).toBe('operation');
        expect(options?.beforeStart).toBeTypeOf('function');
        options?.beforeStart?.(); executed = true;
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }) };
    const result = await createJanitorDockerAdapters(shell).imageDocker.removeImage(target, () => protectedNow);
    expect(executed).toBe(false); expect(result).toMatch(new RegExp('^' + IMAGE_HELD_PREFIX));
  });
});

const nativeDockerAvailable = (() => {
  // 只让既有托管LinuxCI执行新物理用例，避免使用开发者本机的Docker上下文。
  if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux') return false;
  try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 }); return true; }
  catch { return false; }
})();

describe.skipIf(!nativeDockerAvailable)('真实Docker在途镜像回收', () => {
  it('只在原代次结束后实际删除独占目标标签，保留旧版标签', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-native-retention-')); roots.push(root);
    const build = path.join(root, 'build'); fs.mkdirSync(build);
    const repo = `cds-native-retention-${randomUUID().replaceAll('-', '')}`;
    const old = `${repo}:sha-${'1'.repeat(40)}`, target = `${repo}:sha-${'2'.repeat(40)}`;
    const coordinator = new BranchOperationCoordinator();
    const raw: Array<{ command: string; stdout: string; stderr: string; exitCode: number }> = [];
    const shell = new ShellExecutor();
    const native = createJanitorDockerAdapters({ exec: async (command, options) => {
      const result = await shell.exec(command, options);
      if (command.includes('rmi') && command.includes(repo)) raw.push({ command, ...result });
      return result;
    } });
    try {
      // scratch加独占标签只生成本测试的配置镜像，不拉基础镜像、不启业务容器。
      execFileSync('docker', ['build', '--network=none', '--pull=false', '--tag', old, '--file', '-', build], {
        input: `FROM scratch\nLABEL cds.native-test="${repo}"\n`, timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'],
      });
      execFileSync('docker', ['tag', old, target], { timeout: 10_000 });
      const inspect = (image: string) => JSON.parse(execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8', timeout: 10_000 }))[0];
      const imageId = inspect(target).Id;
      expect(inspect(old).Id).toBe(imageId);
      const state = new StateService(path.join(root, 'state.json')); state.load();
      const now = new Date().toISOString();
      state.addProject({ id: 'owned', slug: 'owned', name: 'owned', kind: 'git', createdAt: now, updatedAt: now });
      state.addBranch({ id: 'branch', projectId: 'owned', branch: 'feature', worktreePath: root, services: {}, status: 'idle', createdAt: now });
      state.addDeploymentVersion({ id: 'old', projectId: 'owned', branchId: 'branch', commitSha: '1'.repeat(40),
        configHash: 'original', createdByRunId: 'original', createdAt: now, migrations: [], capabilities: [],
        profiles: [{ profileId: 'web', name: 'web', artifactImage: old, artifactKind: 'prebuilt-image', reusable: true, containerPort: 80 }] });
      const owner = coordinator.begin({ projectId: 'owned', branchId: 'branch', kind: 'deploy', trigger: 'manual',
        commitSha: '2'.repeat(40), commitPinned: true }, { waitForArtifacts: true });
      const input = captureDeploymentInput(state.getBranch('branch')!, [{ id: 'web', name: 'web', dockerImage: target, containerPort: 80 } as BuildProfile], {}, null, '2'.repeat(40));
      coordinator.rememberDeploymentInput(owner.operationId, owner.generation, input);
      const janitor = new JanitorService(state, { enabled: false, worktreeTTLDays: 7, diskWarnPercent: 80,
        sweepIntervalSeconds: 3600, dockerPrune: false, orphanWorktrees: false, imageKeepGenerations: 1 }, root,
        undefined, () => ({ totalBytes: 10000, freeBytes: 9000 }), undefined,
        { ...native.imageDocker, listImages: async () => (await native.imageDocker.listImages()).filter(image => image.startsWith(repo + ':')) },
        undefined, () => coordinator.getDeploymentImageReferences((_request, captured) => captured.profiles.map(profile => profile.dockerImage)));
      await janitor.sweep();
      expect(inspect(target).Id).toBe(imageId); expect(raw).toEqual([]);
      coordinator.cancelBranch('branch', '本次产物等待明确取消');
      const completed = await janitor.sweep();
      expect(completed.imageRetention?.removed).toEqual([target]);
      expect(raw).toHaveLength(1); expect(raw[0].exitCode).toBe(0); expect(raw[0].stdout).toContain(target);
      expect(() => inspect(target)).toThrow(); expect(inspect(old).Id).toBe(imageId);
      console.info('::notice title=CDS native image retention::' + JSON.stringify({ nativeImageRetention: { operationId: owner.operationId, imageId, target,
        ownerCancelledThenRemoved: true, oldTagPreserved: true, rawRemoval: raw } }));
    } finally {
      coordinator.cancelBranch('branch', '测试收尾');
      for (const image of [target, old]) {
        try { execFileSync('docker', ['image', 'rm', image], { stdio: 'ignore', timeout: 15_000 }); } catch { /* 本测试标签已被回收或未创建。 */ }
      }
    }
  }, 180_000);
});
