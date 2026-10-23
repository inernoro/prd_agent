import {unitBindMountInspector} from '../helpers/storage-bind-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ContainerService } from '../../src/services/container.js';
import { DeploymentVersionService, isImmutableImageReference } from '../../src/services/deployment-version.js';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { BranchEntry, BuildProfile, CdsConfig, IShellExecutor, ServiceState } from '../../src/types.js';
const dirs: string[] = [];
const target = 'b'.repeat(40), oldId = `sha256:${'a'.repeat(64)}`, fixedId = `sha256:${'c'.repeat(64)}`;
const builderId = `sha256:${'e'.repeat(64)}`;
const artifact = 'owned/managed:sha-' + 'd'.repeat(40);
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-managed-policy-')); dirs.push(dir); fs.writeFileSync(path.join(dir, 'owned.txt'), 'owned-source');
  const profile: BuildProfile = { id: 'web', name: 'owned', dockerImage: 'node:22-alpine', workDir: '.', command: 'compile && serve', containerPort: 8080,
    managedBuild: { stack: 'node', installCommand: 'true', buildCommand: 'echo owned-build', startCommand: 'node /app/server.cjs', artifactImage: artifact } };
  const entry: BranchEntry = { id: 'owned', projectId: 'owned', branch: 'owned', status: 'running', worktreePath: dir,
    githubCommitSha: 'a'.repeat(40), createdAt: new Date().toISOString(), services: {} };
  const runtime: ServiceState = { profileId: 'web', containerName: 'old-owned-web', hostPort: 10001, status: 'running' }; entry.services.web = runtime;
  const commands: string[] = [], buildEnvs: string[] = [], images = new Map<string, any>(), created = new Map<string, any>(), builderIds: string[] = [];
  const baseImage = { Id: builderId, Os: 'linux', Architecture: 'amd64', Config: { Labels: {}, Volumes: null } };
  images.set('node:22-alpine',baseImage); images.set(builderId,baseImage);
  let sourceHead = target, commitRevision = target;
  const shell: IShellExecutor = { exec: async (command, options) => {
    options?.beforeStart?.(); commands.push(command);
    if (command.startsWith('docker create') && command.includes('-managed-build-')) {
      const match = command.match(/--env-file (?:'([^']+)'|"([^"]+)")/); const envFile = match?.[1] || match?.[2];
      if (envFile) buildEnvs.push(fs.readFileSync(envFile, 'utf8'));
    }
    const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
    if (command.startsWith('docker create')) {
      const name = /--name (?:'([^']+)'|([^ ]+))/.exec(command)?.slice(1).find(Boolean)!;
      const id = createHash('sha256').update(name).digest('hex');
      const imageId = command.match(/sha256:[a-f0-9]{64}/g)?.at(-1)!;
      const mounts = [...command.matchAll(/--mount '([^']+)'/g)].map(match => {
        const fields = Object.fromEntries(match[1].split(',').map(field => field.includes('=') ? field.split('=') : [field,true]));
        return {Type: fields.type,Source: fields.src || fields.source,Destination: fields.dst,RW: !fields.readonly};
      });
      const tmpfs = command.includes("--tmpfs '/tmp'") ? {'/tmp':''} : null;
      created.set(id,[id,'/'+name,imageId,0,'created',mounts,tmpfs]);
      if(name.includes('-managed-build-'))builderIds.push(id);
      return ok(id);
    }
    if (command.startsWith('docker inspect') && command.includes('json .Mounts')) {
      const id=command.match(/[a-f0-9]{64}/g)?.at(-1)!;
      return created.has(id) ? ok(JSON.stringify(created.get(id))) : {exitCode:1,stdout:'',stderr:'No such object: '+id};
    }
    if (command === 'git rev-parse HEAD') return ok(sourceHead);
    if (command.startsWith('docker info')) return ok(JSON.stringify({ OSType: 'linux', Architecture: 'amd64' }));
    if (command.startsWith('docker image inspect')) {
      const image = command.match(/docker image inspect '([^']+)'/)?.[1] || '';
      const metadata = images.get(image);
      if (!metadata) return { stdout: '', stderr: 'No such image: owned', exitCode: 1 };
      return ok(JSON.stringify(command.includes('[{{json .Id}},') ? [metadata.Id, metadata.Config.Volumes ?? null] : command.includes('--format') ? metadata.Config.Labels : [metadata]));
    }
    if (command.startsWith('docker pull')) return { stdout: '', stderr: 'manifest unknown', exitCode: 1 };
    if (command.startsWith('docker commit')) {
      const hash = command.match(/LABEL cds\.managed\.contract=([a-f0-9]{64})/)?.[1];
      const metadata = { Id: fixedId, Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': commitRevision, 'cds.managed.contract': hash } } };
      images.set(fixedId, metadata); images.set(artifact, metadata); return ok(fixedId);
    }
    if (command.startsWith('docker run')) return ok('owned-runtime');
    return ok();
  } };
  const state = new StateService(path.join(dir, 'state.json'));
  state.addProject({ id: 'owned', slug: 'owned', name: 'owned' } as any); state.addBranch(entry);
  const config = { repoRoot: dir, worktreeBase: dir, dockerNetwork: 'owned-network', sharedEnv: {}, jwt: { secret: 'owned-synthetic-only', issuer: 'owned' } } as CdsConfig;
  const service = new ContainerService(shell, config, undefined, undefined, undefined, undefined, unitBindMountInspector);
  vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
  vi.spyOn(service as any, 'waitForReadiness').mockResolvedValue(true);
  const versionService = new DeploymentVersionService(state);
  const hash = () => { const env = (service as any).resolveProfileRuntimeEnv({ ...entry, pinnedCommit: undefined, githubCommitSha: sourceHead, ciTargetSha: undefined }, profile); delete env.CDS_BUILD_TIME; return versionService.computeConfigHash([profile], env); };
  const cached = (revision = target, contractHash = hash()) => { const metadata = { Id: oldId, Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': revision, 'cds.managed.contract': contractHash } } }; images.set(artifact, metadata); images.set(oldId, metadata); };
  return { service, state, versionService, entry, profile, runtime, commands, buildEnvs, images, builderIds, hash, cached, setHead: (value: string) => { sourceHead = value; }, setCommittedRevision: (value: string) => { commitRevision = value; } };
}
afterEach(async () => { vi.restoreAllMocks(); await flushAllJsonStateStores(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe('受管产物生产身份与显式源码政策', () => {
  it('同源码及配置再次派发仅更新时间时复用实际已有产物，不重新编译', async () => {
    const f = fixture(); await f.service.runService(f.entry, f.profile, f.runtime);
    f.entry.lastDeployDispatchAt = '2026-10-11T08:00:00.000Z';
    await f.service.runService(f.entry, f.profile, f.runtime);
    expect(f.commands.filter(c => c.startsWith('docker exec'))).toHaveLength(1);
  });
  it('无源码上下文的真实运行入口，构建环境使用工作树目标而不是旧固定或缓存提交', async () => {
    const f = fixture(); f.entry.pinnedCommit = 'e'.repeat(40); f.entry.ciTargetSha = 'f'.repeat(40);
    await f.service.runService(f.entry, f.profile, f.runtime);
    expect(f.buildEnvs).toHaveLength(1); expect(f.buildEnvs[0]).toContain(`CDS_COMMIT_SHA=${target}`);
    expect(f.buildEnvs[0]).not.toContain(`CDS_COMMIT_SHA=${f.entry.pinnedCommit}`);
    expect(f.commands.find(c => c.startsWith('docker commit'))).toContain(`LABEL cds.managed.contract=${f.hash()}`);
  });
  it('源码完整身份无法确认时不因旧镜像存在而复用，不构建或拆旧服务', async () => {
    const f = fixture(); f.cached(); f.setHead('bbbbbbb');
    await expect(f.service.runService(f.entry, f.profile, f.runtime)).rejects.toThrow('源码目标尚未确认');
    expect(f.commands.some(c => /docker (create|commit|cp|rm|run)|network create/.test(c))).toBe(false);
  });
  it.each(['wrong-revision', 'wrong-config', 'unlabeled'])('已选择源码模式的%s缓存重新构建并使用核验后的固定内容', async (reason) => {
    const f = fixture(); f.cached(reason === 'wrong-revision' ? 'a'.repeat(40) : target, reason === 'wrong-config' ? 'f'.repeat(64) : f.hash());
    if (reason === 'unlabeled') f.images.get(artifact).Config.Labels = {};
    await f.service.runService(f.entry, f.profile, f.runtime);
    expect(f.commands.filter(c => c.startsWith('docker exec'))).toHaveLength(1);
    const commit = f.commands.find(c => c.startsWith('docker commit'))!;
    expect(commit).toContain(`LABEL org.opencontainers.image.revision=${target}`); expect(commit).toContain(`LABEL cds.managed.contract=${f.hash()}`);
    expect(f.runtime.deployedImage).toBe(fixedId);
    expect(f.commands.find(c => /docker (run|create).*--name old-owned-web /.test(c))).toContain(fixedId);
    const replace = f.commands.findIndex(c => c.startsWith('docker rm -f old-owned-web'));
    expect(replace).toBeGreaterThan(f.commands.findIndex(c => c.startsWith('docker commit')));
  });
  it('同目标同配置缓存核平台/revision/配置后复用固定ID，不重新构建', async () => {
    const f = fixture(); f.cached(); const metadata = f.images.get(artifact); f.images.set(oldId, metadata);
    await f.service.runService(f.entry, f.profile, f.runtime);
    expect(f.commands.some(c => /docker (cp|exec|commit)/.test(c) || c.includes('-managed-build-'))).toBe(false); expect(f.runtime.deployedImage).toBe(oldId);
    expect(f.commands.some(c => c.startsWith('docker info'))).toBe(true);
  });
  it('新构建实际标签与目标不符时拒绝运行，旧容器未删除', async () => {
    const f = fixture(); f.setCommittedRevision('e'.repeat(40));
    await expect(f.service.runService(f.entry, f.profile, f.runtime)).rejects.toThrow('新构建产物');
    expect(f.commands.some(c => c.startsWith('docker run') || c.startsWith('docker rm -f old-owned-web'))).toBe(false);
    expect(f.builderIds).toHaveLength(1);
    expect(f.commands).toContain(`docker rm -f '${f.builderIds[0]}'`);
  });
  it.each(['revision', 'platform', 'unknown-target'])('本地固定版本拒绝%s并保持旧容器', async reason => {
    const f = fixture(); f.cached(reason === 'revision' ? 'e'.repeat(40) : target);
    const profile = { ...f.profile, managedBuild: undefined, prebuiltImage: true, localArtifact: true, dockerImage: oldId };
    if (reason === 'platform') f.images.get(oldId).Architecture = 'arm64';
    if (reason === 'unknown-target') f.entry.githubCommitSha = undefined;
    const context = reason === 'unknown-target' ? {} : { artifactCommitSha: target };
    await expect(f.service.runService(f.entry, profile, f.runtime, undefined, undefined, context)).rejects.toThrow(reason === 'unknown-target' ? '目标尚未确认' : '实际提交、平台');
    expect(f.commands.some(c => c.startsWith('docker rm -f old-owned-web') || /^docker (create|exec|commit|run)/.test(c))).toBe(false);
  });
  it('本地版本运行使用已核验的版本提交而不是分支新的缓存目标，且不读Git或编译', async () => {
    const f = fixture(); f.cached(); const profile = { ...f.profile, managedBuild: undefined, prebuiltImage: true, localArtifact: true, dockerImage: oldId };
    await f.service.runService(f.entry, profile, f.runtime, undefined, undefined, { artifactCommitSha: target });
    expect(f.runtime.deployedImage).toBe(oldId);
    expect(f.commands.some(c => c.startsWith('git ') || /^docker (cp|exec|commit)/.test(c))).toBe(false);
  });
  it('已确认的仓库内容digest保留可取回引用，不降为只在本执行器存在的裸ID', async () => {
    const f = fixture(); f.cached(); const reference = `ghcr.io/owned/managed@${oldId}`; f.images.set(reference, f.images.get(oldId));
    const profile = { ...f.profile, managedBuild: undefined, prebuiltImage: true, localArtifact: true, dockerImage: reference };
    await f.service.runService(f.entry, profile, f.runtime, undefined, undefined, { artifactCommitSha: target });
    expect(f.runtime.deployedImage).toBe(reference);
  });
  it('运行模式未选择源码时缺产物不调用隐式回退、不清别名或拆旧容器', async () => {
    const f = fixture(), fallback = vi.fn(); const prune = vi.spyOn(f.service as any, 'pruneStaleAppContainersForProfile');
    const profile = { ...f.profile, managedBuild: undefined, prebuiltImage: true, dockerImage: `ghcr.io/owned/web:sha-${target}`, command: '', sourceFallbackProfile: f.profile };
    await expect(f.service.runService(f.entry, profile, f.runtime, undefined, undefined, { onSourceCompileFallback: fallback })).rejects.toThrow('部署未转为源码编译');
    expect(fallback).not.toHaveBeenCalled(); expect(prune).not.toHaveBeenCalled();
    expect(f.commands.some(c => /docker (create|cp|exec|commit|run)|docker rm -f old-owned-web/.test(c))).toBe(false);
  });
  it('明确选择既有源码模式时仍运行源码命令，不以缺预构建为条件', async () => {
    const f = fixture(); const profile = { ...f.profile, managedBuild: undefined, prebuiltImage: false, command: 'echo explicitly-selected-source' };
    await f.service.runService(f.entry, profile, f.runtime);
    expect(f.commands.find(c => /docker (run|create).*--name old-owned-web /.test(c))).toContain('explicitly-selected-source');
    expect(f.commands.some(c => c.startsWith('docker pull'))).toBe(false);
  });
  it('本地固定内容可进入可复用版本并保持local标记，普通源码基础镜像ID不能当可复用业务版本', () => {
    const f = fixture(); expect(isImmutableImageReference(fixedId)).toBe(true); f.runtime.deployedImage = fixedId;
    const create = (profile: BuildProfile, id: string) => f.versionService.create({ projectId: 'owned', branchId: f.entry.id, commitSha: target,
      configHash: id, profiles: [profile], branch: f.entry, createdByRunId: id });
    const version = create({ ...f.profile, managedBuild: undefined, prebuiltImage: true, localArtifact: true }, 'local-content');
    expect(version.profiles[0]).toMatchObject({ reusable: true, artifactKind: 'managed-image', artifactImage: fixedId });
    expect(f.versionService.materializeProfiles(version, [f.profile])[0]).toMatchObject({ dockerImage: fixedId, localArtifact: true, prebuiltImage: true });
    expect(create({ ...f.profile, managedBuild: undefined, prebuiltImage: false }, 'source-base').profiles[0]).toMatchObject({ reusable: false, artifactKind: 'legacy-runtime' });
  });
});
