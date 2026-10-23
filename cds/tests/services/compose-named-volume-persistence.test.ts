import {withStorageImages} from '../helpers/storage-image-mock.js';
import {stableStorageVolumeName,storageOwnerLabels} from '../../src/services/deployment-storage-plan.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { parseCdsCompose, toCdsCompose } from '../../src/services/compose-parser.js';
import { StateService } from '../../src/services/state.js';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { createCacheRouter } from '../../src/routes/cache.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { BuildProfile } from '../../src/types.js';

const volumeName = 'small-steps-data';
const compose = `
services:
  web:
    image: ghcr.io/example/small-steps:sha-test
    ports: ['3000']
    volumes: ['small-steps-data:/data']
    labels:
      cds.prebuilt-image: 'true'
      cds.subdomain: 'web'
volumes:
  small-steps-data: {}
`;

function profileFromCompose(): BuildProfile {
  const profile = parseCdsCompose(compose)!.buildProfiles[0];
  return { ...profile, command: profile.command || '' };
}

describe('Compose 命名卷跨 CDS 重启保持挂载身份', () => {
  let root: string;
  let state: StateService;
  let shell: MockShellExecutor;
  let server: Server | undefined;
  let originalIsolation: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-named-volume-'));
    vi.stubEnv('CDS_CACHE_BASE', path.join(root, 'cache'));
    state = new StateService(path.join(root, 'state.json'), root);
    state.load();
    shell = new MockShellExecutor();
    originalIsolation = process.env.CDS_BRANCH_NETWORK_ISOLATION;
    process.env.CDS_BRANCH_NETWORK_ISOLATION = '0';
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (originalIsolation === undefined) delete process.env.CDS_BRANCH_NETWORK_ISOLATION;
    else process.env.CDS_BRANCH_NETWORK_ISOLATION = originalIsolation;
    await flushAllJsonStateStores();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('标准 compose 往返序列化保留卷名和类型，不增加自定义配置', () => {
    const parsed = parseCdsCompose(compose)!;
    const expected = [{ kind: 'volume', hostPath: volumeName, containerPath: '/data' }];
    expect(parsed.buildProfiles[0].cacheMounts).toEqual(expected);
    const yaml = toCdsCompose(parsed.buildProfiles, parsed.envVars, parsed.infraServices, parsed.routingRules);
    expect(yaml).toContain('small-steps-data:/data');
    expect(yaml).not.toContain('kind: volume');
    expect(parseCdsCompose(yaml)!.buildProfiles[0].cacheMounts).toEqual(expected);
  });

  it('历史卷声明重载后保持原名，归属未确认时拒绝重建且不创建空卷', async () => {
    state.addBuildProfile(profileFromCompose());
    state.save();
    await flushAllJsonStateStores();
    const reloaded = new StateService(path.join(root, 'state.json'), root);
    reloaded.load();
    const profile = reloaded.getBuildProfiles()[0];
    expect(profile.cacheMounts).toEqual([{ kind: 'volume', hostPath: volumeName, containerPath: '/data' }]);
    const containers = new ContainerService(shell, {
      repoRoot: root, worktreeBase: root, masterPort: 9900, workerPort: 5500,
      dockerNetwork: 'cds-network', portStart: 10001, sharedEnv: {},
      jwt: { secret: 'test', issuer: 'test' },
    });
    await expect(containers.runService({
      id:'main',branch:'main',worktreePath:root,services:{},status:'idle',createdAt:new Date().toISOString(),
    },profile,{profileId:profile.id,containerName:'cds-main-web',hostPort:10001,status:'building'}))
      .rejects.toThrow('storage-contract-required');
    expect(shell.commands).toEqual([]);
    expect(reloaded.getBuildProfiles()[0].cacheMounts).toEqual([{kind:'volume',hostPath:volumeName,containerPath:'/data'}]);
  });

  it('显式归属卷冷重载后复用同一身份，经实际创建投影核验后按精确CID启动',async()=>{
    const storage={version:1 as const,instanceId:'owned',projectId:'default',scope:'branch-private' as const,
      branchId:'main',serviceId:'web',mountKey:'data',purpose:'persistent' as const};
    const name=stableStorageVolumeName(storage),profile=profileFromCompose();
    profile.cacheMounts=[{kind:'volume',hostPath:name,containerPath:'/data',storage}];
    state.addBuildProfile(profile);state.save();await state.flush();
    const cold=new StateService(path.join(root,'state.json'),root);cold.load();
    const restored=cold.getBuildProfiles()[0];expect(restored.cacheMounts).toEqual(profile.cacheMounts);
    shell=withStorageImages(shell);
    shell.addResponsePattern(/^docker volume inspect /,()=>({exitCode:0,stderr:'',stdout:JSON.stringify([{Name:name,Driver:'local',Options:null,Mountpoint:'/var/lib/docker/volumes/'+name+'/_data',Labels:storageOwnerLabels(storage)}])}));
    shell.addResponsePattern(/^docker image inspect .*json .Id/,()=>({exitCode:0,stderr:'',stdout:JSON.stringify(['sha256:'+'a'.repeat(64),null])}));
    shell.addResponsePattern(/^docker (network|pull|create|start|inspect|rm)/,()=>({exitCode:0,stderr:'',stdout:''}));
    const container=new ContainerService(shell,{repoRoot:root,worktreeBase:root,storageInstanceId:'owned',masterPort:9900,workerPort:5500,dockerNetwork:'cds-network',portStart:10001,sharedEnv:{},jwt:{secret:'test',issuer:'test'}});
    vi.spyOn(container as any,'waitForContainerAlive').mockResolvedValue(undefined);
    vi.spyOn(container as any,'pruneStaleAppContainersForProfile').mockResolvedValue(undefined);
    await container.runService({id:'main',projectId:'default',branch:'main',worktreePath:root,services:{},status:'idle',createdAt:new Date().toISOString()},restored,
      {profileId:'web',containerName:'cds-main-web',hostPort:10001,status:'building'});
    const create=shell.commands.find(c=>c.startsWith('docker create '))!;
    expect(create).toContain('source='+name+',dst=/data,volume-nocopy');
    expect(shell.commands.some(c=>/^docker start [a-f0-9]{64}$/.test(c))).toBe(true);
    expect(shell.commands.some(c=>/^mkdir |^docker volume create |^docker run /.test(c))).toBe(false);
  });

  it('缓存诊断和修复不把业务卷当目录，清理请求也不能删除同名旧目录', async () => {
    const profile = profileFromCompose();
    state.addBuildProfile(profile);
    // 已被旧版本错误创建的目录只保护、不推测迁移回卷。
    const oldPath = path.join(state.getCacheBase(), volumeName);
    fs.mkdirSync(oldPath, { recursive: true });
    fs.writeFileSync(path.join(oldPath, 'tasks.json'), 'preserve-old-copy');
    const app = express();
    app.use('/api', createCacheRouter({ stateService: state, shell }));
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/cache`;
    const status = await (await fetch(`${base}/status`)).json() as { caches: unknown[]; orphans: unknown[] };
    expect(status.caches).toEqual([]);
    expect(status.orphans).toEqual([]);
    const repair = await (await fetch(`${base}/repair`, { method: 'POST' })).json() as { actions: unknown[] };
    expect(repair.actions).toEqual([]);
    expect(state.getBuildProfiles()[0].cacheMounts).toEqual(profile.cacheMounts);
    expect(shell.commands.some((command) => command.includes(volumeName))).toBe(false);
    const purge = await fetch(`${base}/purge?name=${volumeName}`, { method: 'POST' });
    expect(purge.status).toBe(409);
    expect(fs.readFileSync(path.join(oldPath, 'tasks.json'), 'utf8')).toBe('preserve-old-copy');
    expect(shell.commands.some((command) => command.startsWith('rm '))).toBe(false);
  });
});
