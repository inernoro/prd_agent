import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { ContainerService, resolveEffectiveProfile } from '../../src/services/container.js';
import { servingRuntime } from '../../src/services/service-runtime.js';
import { StaticWebService } from '../../src/services/static-web.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { ObservationStreamExecutor } from '../../src/services/observation-stream-executor.js';
import type { ContainerLogStreamHub } from '../../src/services/container-log-stream-hub.js';
import { reconcileHostRebootBranch, shouldPruneDeletedBranchStartupResidue } from '../../src/services/startup-reconcile.js';
import type { BranchEntry, BuildProfile, CdsConfig, ServiceState } from '../../src/types.js';

const directories: string[] = [];
const managers: ContainerService[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.closeStaticWebRuntimes();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture(options: { startup?: ObservationStreamExecutor; logs?: ContainerLogStreamHub } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-native-static-')); directories.push(directory);
  let content = 'version-A';
  const image = `sha256:${'a'.repeat(64)}`, revision = 'b'.repeat(40), id = 'c'.repeat(64);
  const shell = new MockShellExecutor(); let exporterName = '';
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
  shell.addResponsePattern(/docker image inspect.*json .Id/, () => ok(JSON.stringify([image, null])));
  shell.addResponsePattern(/^docker create .*/, match => { const name = /--name (?:'([^']+)'|([^\s]+))/.exec(match[0])!; exporterName = name[1] || name[2]; return ok(id); });
  shell.addResponsePattern(/^docker inspect.*json .Mounts/, () => ok(JSON.stringify([id, `/${exporterName}`, image, 0, 'created', [], null])));
  shell.addResponsePattern(/^docker cp .*/, match => {
    const destination = /'([^']+)'$/.exec(match[0])![1];
    fs.mkdirSync(path.join(destination, 'assets'));
    fs.writeFileSync(path.join(destination, 'index.html'), `<html><main>${content}</main><script type="module" src="/assets/index-12345678.js"></script></html>`);
    fs.writeFileSync(path.join(destination, 'assets/index-12345678.js'), 'export default 42');
    fs.writeFileSync(path.join(destination, 'runtime-config.json'), JSON.stringify({ VITE_TARGET_SHA: null, VITE_BUILD_ID: null }));
    return ok();
  });
  shell.addResponsePattern(/^docker rm -f /, () => ok());
  shell.addResponsePattern(/^docker ps /, () => ok());
  const config = { repoRoot: directory, worktreeBase: directory, masterPort: 9900, workerPort: 5500, dockerNetwork: 'test',
    portStart: 10000, sharedEnv: {}, jwt: { secret: 'unit-test', issuer: 'unit-test' } } as CdsConfig;
  const manager = new ContainerService(shell, config, undefined, undefined, options.startup, options.logs); managers.push(manager);
  vi.spyOn(manager, 'inspectDeploymentArtifacts').mockResolvedValue({ state: 'ready', targetCommitSha: revision,
    checkedAt: new Date().toISOString(), artifacts: [{ profileIds: ['web'], requestedImage: 'ci-image', image, revision, platform: 'linux/amd64', proof: { kind: 'exact-target' } }] });
  const profile: BuildProfile = { id: 'web', name: 'Web', dockerImage: 'ci-image', workDir: '.', containerPort: 80,
    prebuiltImage: true, staticWeb: { imagePath: '/usr/share/nginx/html' } };
  const service: ServiceState = { profileId: 'web', containerName: 'cds-branch-web', hostPort: 0, status: 'building' };
  const entry = { id: 'branch', projectId: 'project', worktreePath: directory, githubCommitSha: revision, services: { web: service } } as BranchEntry;
  return { manager, shell, config, profile, service, entry, setContent: (value: string) => { content = value; } };
}

describe('正常部署入口的非容器前端', () => {
  it.each([
    { name: '全新分支尚无提交缓存', recordedCommit: undefined, pinnedCommit: undefined },
    { name: '已有提交缓存与固定值均落后于本次产物', recordedCommit: 'c'.repeat(40), pinnedCommit: 'd'.repeat(40) },
  ])('$name 时公开配置仍采用本次已核验产物提交', async ({ recordedCommit, pinnedCommit }) => {
    const f = fixture();
    const revision = 'b'.repeat(40);
    f.entry.githubCommitSha = recordedCommit;
    f.entry.pinnedCommit = pinnedCommit;
    f.profile.env = { IMP_TARGET_SHA: '${CDS_COMMIT_SHA}', VITE_TARGET_SHA: '${CDS_COMMIT_SHA}' };
    f.profile.staticWeb!.runtimeConfig = true;
    await f.manager.runService(f.entry, f.profile, f.service, undefined, undefined, { artifactCommitSha: revision });
    const response = await fetch(`http://127.0.0.1:${f.service.hostPort}/runtime-config`);
    expect(response.status).toBe(200);
    const script = await response.text();
    expect(script).toContain(`"VITE_TARGET_SHA":"${revision}"`);
    expect(script).toContain(`"VITE_BUILD_ID":"${revision.slice(0, 12)}"`);
    expect(f.entry.githubCommitSha).toBe(recordedCommit);
    expect(f.entry.pinnedCommit).toBe(pinnedCommit);
    expect(f.shell.commands.some(command => /^docker (run|start|restart)\b/.test(command))).toBe(false);
  });

  it.each(['owned', 'direct'] as const)('删除前旧入口前置条件拒绝时，保留真实静态监听器与产物 %s', async mode => {
    const f = fixture(); await f.manager.runService(f.entry, f.profile, f.service);
    const runtime = f.service.staticWeb!;
    const beforeRemove = vi.fn(async () => { throw new Error('old-serving-unavailable'); });
    const context = { beforeRemove };
    const error = await (mode === 'owned'
      ? f.manager.removeOwnedRuntime(f.entry, 'web', f.service, context)
      : f.manager.remove(runtime.id, context)).then(() => null, error => error.message);
    const listening = await f.manager.isRunning(runtime.id);
    expect({ error, calls: beforeRemove.mock.calls.length, listening,
      files: fs.existsSync(runtime.rootDirectory),
      status: listening ? (await fetch(`http://127.0.0.1:${f.service.hostPort}/`)).status : null,
    }).toEqual({ error: 'old-serving-unavailable', calls: 1, listening: true, files: true, status: 200 });
  });

  it.each(['owned', 'direct'] as const)('静态监听关闭后旧入口失效时，仍保留待回收产物责任 %s', async mode => {
    const f = fixture(); await f.manager.runService(f.entry, f.profile, f.service);
    const runtime = f.service.staticWeb!;
    let checks = 0;
    const beforeRemove = vi.fn(async () => {
      if (++checks === 2) throw new Error('old-serving-lost-after-stop');
    });
    const context = { beforeRemove };
    const error = await (mode === 'owned'
      ? f.manager.removeOwnedRuntime(f.entry, 'web', f.service, context)
      : f.manager.remove(runtime.id, context)).then(() => null, error => error.message);
    expect({ error, calls: beforeRemove.mock.calls.length, listening: await f.manager.isRunning(runtime.id),
      files: fs.existsSync(runtime.rootDirectory),
    }).toEqual({ error: 'old-serving-lost-after-stop', calls: 2, listening: false, files: true });
  });

  it.each(['owned', 'direct'] as const)('删除前置条件等待期间代次变化时，不停止或删除当前静态运行 %s', async mode => {
    const f = fixture(); await f.manager.runService(f.entry, f.profile, f.service);
    const runtime = f.service.staticWeb!; let superseded = false;
    const beforeRemove = vi.fn(async () => { superseded = true; });
    const context = { beforeRemove, assertCurrent: () => { if (superseded) throw new Error('operation superseded'); } };
    const error = await (mode === 'owned'
      ? f.manager.removeOwnedRuntime(f.entry, 'web', f.service, context)
      : f.manager.remove(runtime.id, context)).then(() => null, error => error.message);
    expect({ error, calls: beforeRemove.mock.calls.length, listening: await f.manager.isRunning(runtime.id),
      files: fs.existsSync(runtime.rootDirectory),
    }).toEqual({ error: 'operation superseded', calls: 1, listening: true, files: true });
  });

  it('产物已准备但尚未交付运行身份时被取消，自己的未发布目录也必须收回', async () => {
    const f = fixture(); let superseded = false;
    const prepare = StaticWebService.prototype.prepare;
    const spy = vi.spyOn(StaticWebService.prototype, 'prepare').mockImplementation(async function(options) {
      const runtime = await prepare.call(this, options); superseded = true; return runtime;
    });
    try {
      await expect(f.manager.runService(f.entry, f.profile, f.service, undefined, undefined, {
        assertCurrent: () => { if (superseded) throw new Error('operation superseded'); },
      })).rejects.toThrow('operation superseded');
      const root = path.join(f.config.repoRoot, '.cds-static-previews');
      expect(fs.readdirSync(root).flatMap(owner => fs.readdirSync(path.join(root, owner)))).toEqual([]);
      expect(f.service.staticWeb).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

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

  it('执行实际启动对账后仍保留恢复的静态入口，同时缺失的 Docker 服务仍报错', async () => {
    const f = fixture();
    await f.manager.runService(f.entry, f.profile, f.service);
    f.service.status = 'running';
    f.entry.status = 'running';
    const port = f.service.hostPort;
    await f.manager.closeStaticWebRuntimes();
    const restored = new ContainerService(f.shell, f.config); managers.push(restored);
    await restored.restoreStaticWebRuntimes([f.entry]);
    f.entry.services.api = { profileId: 'api', containerName: 'missing-api', hostPort: 1234, status: 'running' };
    const source = fs.readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('    const appDiscovery = await containerService.discoverAppContainersWithStatus();');
    const end = source.indexOf('    // Log orphan app containers', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const script = ts.transpileModule(`(async () => { ${source.slice(start, end)} })()`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    await vm.runInNewContext(script, {
      containerService: restored, stateService: { getAllBranches: () => [f.entry], getProjects: () => [] },
      os, Date, activeServerEventLogStore: null, console: { warn: vi.fn() },
      reconcileHostRebootBranch, shouldPruneDeletedBranchStartupResidue, servingRuntime,
    });
    expect(f.service.status).toBe('running');
    expect(f.service.errorMessage).toBeUndefined();
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    expect(f.entry.services.api.status).toBe('error');
    expect(f.entry.services.api.errorMessage).toBe('容器已丢失，需重新部署');
  });

  it.each(['idle', 'stopped', 'stopping'] as const)('冷恢复%s静态站不打开监听，保留原端口供正常重启', async status => {
    const f = fixture();
    await f.manager.runService(f.entry, f.profile, f.service);
    const port = f.service.hostPort;
    await f.manager.stop(f.service.containerId!);
    f.service.status = status;
    await f.manager.closeStaticWebRuntimes();
    const restored = new ContainerService(f.shell, f.config); managers.push(restored);
    f.shell.addResponsePattern(/^docker inspect --format="\{\{.State.Status\}\}"/, () => ({ stdout: '', stderr: 'no such container', exitCode: 1 }));
    const before = f.shell.commands.length;
    await restored.restoreStaticWebRuntimes([f.entry]);
    expect(f.service.status).toBe(status);
    expect(await restored.isRunning(f.service.containerName)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    expect(await restored.restartServiceInPlace(f.service.containerName)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    expect(f.shell.commands.length).toBe(before);
  });

  it('冷停静态身份恢复后正常删除自有产物', async () => {
    const f = fixture();
    await f.manager.runService(f.entry, f.profile, f.service);
    await f.manager.stop(f.service.containerId!);
    f.service.status = 'stopped';
    await f.manager.closeStaticWebRuntimes();
    const restored = new ContainerService(f.shell, f.config); managers.push(restored);
    await restored.restoreStaticWebRuntimes([f.entry]);
    const before = f.shell.commands.length;
    const root = f.service.staticWeb!.rootDirectory;
    expect(fs.existsSync(root)).toBe(true);
    await restored.remove(f.service.containerName);
    expect(fs.existsSync(root)).toBe(false);
    expect(f.shell.commands.length).toBe(before);
  });

  it('静态模式继承容器启动信号时继续实际HTTP就绪，不订阅Docker日志', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    const f = fixture({ startup: { exec } as unknown as ObservationStreamExecutor });
    await f.manager.runService(f.entry, f.profile, f.service);
    const before = f.shell.commands.length;
    expect(await f.manager.waitForStartupSignal(f.service.containerName, 'container-only-banner', undefined, 1)).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(await f.manager.waitForReadiness(f.service.hostPort, { timeoutSeconds: 2, intervalSeconds: 1 }, undefined, undefined, f.service.containerName)).toBe(true);
    expect(f.shell.commands.length).toBe(before);
  });

  it('实际就绪死亡判据保留静态监听，普通Docker缺失判据仍生效', async () => {
    const f = fixture();
    await f.manager.runService(f.entry, f.profile, f.service);
    f.shell.addResponsePattern(/^docker inspect --format="/, () => ({ stdout: '', stderr: 'no such container', exitCode: 1 }));
    const source = fs.readFileSync(new URL('../../src/services/container.ts', import.meta.url), 'utf8');
    const start = source.indexOf('    const containerGaveUp = async (attempt: number)');
    const end = source.indexOf('    // CDS build profiles represent HTTP', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const script = ts.transpileModule(`(function () { let consecutiveDead = 0; ${source.slice(start, end)} return containerGaveUp; })`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const check = (containerName: string) => vm.runInNewContext(script, { containerName, onOutput: vi.fn() }).call(f.manager) as (attempt: number) => Promise<boolean>;
    const before = f.shell.commands.length;
    const staticCheck = check(f.service.containerName);
    expect(await staticCheck(5)).toBe(false);
    expect(await staticCheck(10)).toBe(false);
    expect(f.shell.commands.length).toBe(before);
    expect(await f.manager.waitForReadiness(f.service.hostPort, { timeoutSeconds: 2, intervalSeconds: 1 }, undefined, undefined, f.service.containerName)).toBe(true);
    const dockerCheck = check('missing-native-api');
    expect(await dockerCheck(5)).toBe(false);
    expect(await dockerCheck(10)).toBe(true);
    expect(f.shell.commands.length).toBe(before + 2);
  });

  it('静态日志面板返回准确说明且正常结束，不占用Docker日志订阅', async () => {
    const subscribe = vi.fn((_name, _onData, onClose) => { onClose({ reason: 'unavailable' }); return new AbortController(); });
    const f = fixture({ logs: { subscribe } as unknown as ContainerLogStreamHub });
    await f.manager.runService(f.entry, f.profile, f.service);
    const chunks: string[] = []; let reason = '';
    await new Promise<void>(resolve => {
      f.manager.streamLogs(f.service.containerName, chunk => { chunks.push(chunk); }, result => { reason = result?.reason || ''; resolve(); });
    });
    expect(chunks.join('')).toContain('无独立前端容器');
    expect(reason).toBe('closed');
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('静态环境诊断明确没有容器环境变量，不向Docker读取', async () => {
    const f = fixture();
    await f.manager.runService(f.entry, f.profile, f.service);
    const before = f.shell.commands.length;
    expect(await f.manager.getEnv(f.service.containerName)).toContain('没有独立容器环境变量');
    expect(f.shell.commands.length).toBe(before);
  });

  it('静态站A冷停后重新部署B，再停启必须保持当前B身份与内容', async () => {
    const f = fixture();
    await f.manager.runService(f.entry, f.profile, f.service);
    const original = f.service.staticWeb!;
    f.service.status = 'running';
    await f.manager.stopRuntimeGroup(f.service);
    f.service.status = 'stopped';
    f.setContent('version-B');
    await f.manager.runService(f.entry, f.profile, f.service);
    const current = f.service.staticWeb!;
    expect(current.id).not.toBe(original.id);
    expect(await (await fetch(`http://127.0.0.1:${f.service.hostPort}/`)).text()).toContain('version-B');
    f.service.status = 'running';
    await f.manager.stopRuntimeGroup(f.service);
    f.service.status = 'stopped';
    expect(await f.manager.restartServiceInPlace(f.service.containerName)).toBe(true);
    expect(await (await fetch(`http://127.0.0.1:${f.service.hostPort}/`)).text()).toContain('version-B');
    expect(f.service.staticWeb!.id).toBe(current.id);
    expect(fs.existsSync(original.rootDirectory)).toBe(true);
  });

  it('已冷停静态站切回真实容器创建路径后，不以旧静态身份拒绝容器启动', async () => {
    const exec = vi.fn(async (_command, options) => { options.onData('container-ready'); return { stdout: '', stderr: '', exitCode: 0 }; });
    const f = fixture({ startup: { exec } as unknown as ObservationStreamExecutor });
    await f.manager.runService(f.entry, f.profile, f.service);
    await f.manager.stopRuntimeGroup(f.service);
    f.service.status = 'stopped';
    f.shell.addResponsePattern(/^docker pull /, () => ({ stdout: 'pulled', stderr: '', exitCode: 0 }));
    f.shell.addResponsePatternFirst(/docker inspect.*json .Mounts/, () => ({
      stdout: JSON.stringify(['c'.repeat(64), `/${f.service.containerName}`, `sha256:${'a'.repeat(64)}`, 0, 'created', [], { '/tmp': '' }]), stderr: '', exitCode: 0,
    }));
    f.shell.addResponsePattern(/^docker run /, () => ({ stdout: 'c'.repeat(64), stderr: '', exitCode: 0 }));
    f.shell.addResponsePattern(/^docker network /, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    f.shell.addResponsePattern(/^docker start /, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    f.shell.addResponsePattern(/^docker inspect --format="/, () => ({ stdout: 'running|0', stderr: '', exitCode: 0 }));
    f.shell.addResponsePattern(/^docker logs --timestamps --tail /, () => ({ stdout: 'container-output', stderr: '', exitCode: 0 }));
    vi.useFakeTimers();
    try {
      const deploying = f.manager.runService(f.entry, { ...f.profile, dockerImage: `repo/web:sha-${'b'.repeat(40)}`, staticWeb: undefined, cacheMounts: [] }, f.service);
      await vi.advanceTimersByTimeAsync(7000);
      await deploying;
    } finally { vi.useRealTimers(); }
    expect(f.service.staticWeb).toBeUndefined();
    expect(await f.manager.waitForStartupSignal(f.service.containerName, 'container-ready', undefined, 1)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(await f.manager.getLogs(f.service.containerName)).toBe('container-output');
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
