import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ContainerService, resolveEffectiveProfile } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BranchEntry, BuildProfile, CdsConfig, ServiceState } from '../../src/types.js';

const directories: string[] = [];
const managers: ContainerService[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.closeStaticWebRuntimes();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-native-static-')); directories.push(directory);
  const image = `sha256:${'a'.repeat(64)}`, revision = 'b'.repeat(40), id = 'c'.repeat(64);
  const shell = new MockShellExecutor(); let exporterName = '';
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
  shell.addResponsePattern(/docker image inspect.*json .Id/, () => ok(JSON.stringify([image, null])));
  shell.addResponsePattern(/^docker create .*/, match => { exporterName = /--name '([^']+)'/.exec(match[0])![1]; return ok(id); });
  shell.addResponsePattern(/^docker inspect.*json .Mounts/, () => ok(JSON.stringify([id, `/${exporterName}`, image, 0, 'created', [], null])));
  shell.addResponsePattern(/^docker cp .*/, match => {
    const destination = /'([^']+)'$/.exec(match[0])![1];
    fs.mkdirSync(path.join(destination, 'assets'));
    fs.writeFileSync(path.join(destination, 'index.html'), '<html><script type="module" src="/assets/index-12345678.js"></script></html>');
    fs.writeFileSync(path.join(destination, 'assets/index-12345678.js'), 'export default 42');
    return ok();
  });
  shell.addResponsePattern(/^docker rm -f /, () => ok());
  shell.addResponsePattern(/^docker ps /, () => ok());
  const config = { repoRoot: directory, worktreeBase: directory, masterPort: 9900, workerPort: 5500, dockerNetwork: 'test',
    portStart: 10000, sharedEnv: {}, jwt: { secret: 'unit-test', issuer: 'unit-test' } } as CdsConfig;
  const manager = new ContainerService(shell, config); managers.push(manager);
  vi.spyOn(manager, 'inspectDeploymentArtifacts').mockResolvedValue({ state: 'ready', targetCommitSha: revision,
    checkedAt: new Date().toISOString(), artifacts: [{ profileIds: ['web'], requestedImage: 'ci-image', image, revision, platform: 'linux/amd64', proof: { kind: 'exact-target' } }] });
  const profile: BuildProfile = { id: 'web', name: 'Web', dockerImage: 'ci-image', workDir: '.', containerPort: 80,
    prebuiltImage: true, staticWeb: { imagePath: '/usr/share/nginx/html' } };
  const service: ServiceState = { profileId: 'web', containerName: 'cds-branch-web', hostPort: 0, status: 'building' };
  const entry = { id: 'branch', projectId: 'project', worktreePath: directory, githubCommitSha: revision, services: { web: service } } as BranchEntry;
  return { manager, shell, config, profile, service, entry };
}

describe('正常部署入口的非容器前端', () => {
  it('仅从从未启动的隔离导出器读取文件，站点停止/重启/冷恢复不走 Docker', async () => {
    const f = fixture();
    await f.manager.runService(f.entry, f.profile, f.service);
    f.service.status = 'running';
    const port = f.service.hostPort;
    expect(await (await fetch(`http://127.0.0.1:${port}/products/123`)).text()).toContain('/assets/index-12345678.js');
    expect(f.shell.commands.some(command => /^docker (run|start|restart)\b/.test(command))).toBe(false);
    expect(f.shell.commands.find(command => command.startsWith('docker create'))).toContain('--read-only --network none');
    expect(f.shell.commands.some(command => command.startsWith('docker rm -f'))).toBe(true);
    expect(await f.manager.getRunningServiceNames()).toContain(f.service.containerName);
    expect(await f.manager.getRunningContainerNames()).not.toContain(f.service.containerName);
    await f.manager.stop(f.service.containerId!);
    expect(await f.manager.isRunning(f.service.containerId!)).toBe(false);
    expect(await f.manager.restartServiceInPlace(f.service.containerId!)).toBe(true);
    await f.manager.closeStaticWebRuntimes();
    const restored = new ContainerService(f.shell, f.config); managers.push(restored);
    const before = f.shell.commands.length;
    await restored.restoreStaticWebRuntimes([f.entry]);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    expect(f.shell.commands.length).toBe(before);
    await restored.removeOwnedRuntime(f.entry, 'web', f.service);
    expect(fs.existsSync(f.service.staticWeb!.rootDirectory)).toBe(false);
  });

  it('核验失败不导出、不启动，取消的候选也不会留下监听器', async () => {
    const f = fixture();
    vi.mocked(f.manager.inspectDeploymentArtifacts).mockResolvedValueOnce({ state: 'waiting', targetCommitSha: 'b'.repeat(40), checkedAt: '', reason: 'revision-mismatch', artifacts: [] });
    await expect(f.manager.runService(f.entry, f.profile, f.service)).rejects.toThrow('尚未核验');
    expect(f.shell.commands).toEqual([]);
    await expect(f.manager.runService(f.entry, f.profile, f.service, undefined, undefined, {
      onRuntimeCreated: async () => { throw new Error('operation cancelled'); },
    })).rejects.toThrow('operation cancelled');
    expect(await f.manager.isRunning(f.service.containerId!)).toBe(false);
  });

  it('选择静态模式才启用文件托管，切回 express 时没有静态运行声明', () => {
    const f = fixture();
    const baseline = { ...f.profile, staticWeb: undefined, deployModes: {
      'static-files': { label: '静态文件', prebuilt: true, staticWeb: f.profile.staticWeb },
      express: { label: '容器', prebuilt: true },
    } };
    expect(resolveEffectiveProfile(baseline, { ...f.entry, profileOverrides: { web: { activeDeployMode: 'static-files' } } }).staticWeb).toEqual(f.profile.staticWeb);
    expect(resolveEffectiveProfile(baseline, { ...f.entry, profileOverrides: { web: { activeDeployMode: 'express' } } }).staticWeb).toBeUndefined();
  });
});
