import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';

// 唯一接主 Docker 的外层：只创建带随机归属的容器、镜像和卷；原应用使用另一个守护进程。
const execute = promisify(execFile);
const primaryHost = 'unix:///var/run/docker.sock';
const docker = async (args: string[], timeout = 120_000) => {
  const result = await execute('docker', ['--host', primaryHost, ...args], { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function hashes(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = path.join(prefix, item.name);
    if (item.isDirectory()) Object.assign(result, await hashes(root, name));
    else if (item.isFile()) result[name] = createHash('sha256').update(await fs.readFile(path.join(root, name))).digest('hex');
  }
  return result;
}
async function main(): Promise<void> {
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(os.platform(), 'linux'); assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/);
  const cancelAfterDaemonCreate = process.argv.includes('--cancel-after-daemon-create');
  const qualifyUnknownCreationShutdown = process.argv.includes('--qualify-unknown-create-shutdown');
  assert.ok(!qualifyUnknownCreationShutdown || !cancelAfterDaemonCreate);
  const sourceHead = (await execute('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim(); assert.match(sourceHead, /^[a-f0-9]{40}$/);
  const owner = `cds_app_${randomBytes(8).toString('hex')}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-application-docker-ci-')); await fs.chmod(root, 0o700);
  const output = path.resolve(cancelAfterDaemonCreate ? 'application-probe-cancel-output' : 'application-docker-output'); await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const report: any = { schema: 1, sourceHead, owner, startedAt: new Date().toISOString(), verdict: 'failed',
    scope: 'owned network namespace with original full application and separate real Docker daemon; generic fixtures; prerequisite only, not STG-03 business coverage or STG-04/public acceptance',
    actualWholeFirstStageVerified: false, formalAcceptancePassed: false, productionChanged: false,
    cancellationBoundary: cancelAfterDaemonCreate ? 'daemon-created' : 'client-disconnect',
    ownedContainerRemoved: false, ownedVolumeRemoved: false, ownedImageRemoved: false };
  let containerId: string | undefined, volume: string | undefined, imageId: string | undefined;
  const tag = `${owner}:fixture`;
  const ownedContainer = async () => {
    assert.ok(containerId); assert.match(containerId, /^[a-f0-9]{64}$/);
    const view = JSON.parse(await docker(['inspect', containerId]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], owner); return view;
  };
  try {
    report.stage = 'prepare-source-snapshot';
    report.primaryDaemon = JSON.parse(await docker(['info', '--format', '{{json .}}']));
    // 只存必要身份和资源，避免把宿主完整配置写入报告。
    report.primaryDaemon = { id: report.primaryDaemon.ID, architecture: report.primaryDaemon.Architecture, cpus: report.primaryDaemon.NCPU, memoryBytes: report.primaryDaemon.MemTotal };
    const snapshot = path.join(root, 'snapshot'); await fs.mkdir(snapshot);
    for (const name of ['src', 'dist']) await fs.cp(path.resolve(name), path.join(snapshot, name), { recursive: true });
    await fs.mkdir(path.join(snapshot, 'scripts'));
    for (const name of ['application-bootstrap-drill.ts', 'application-docker-host-drill.ts', 'application-docker-inner-drill.ts']) {
      await fs.copyFile(path.join('scripts', name), path.join(snapshot, 'scripts', name));
    }
    await fs.copyFile('package.json', path.join(snapshot, 'package.json')); await fs.mkdir(path.join(snapshot, 'web'));
    await fs.cp(path.resolve('web/dist'), path.join(snapshot, 'web/dist'), { recursive: true });
    report.snapshotHashes = await hashes(snapshot);
    // 原源码、编译态、脚本及 Web 分别复制，没有仓库凭据、.git、环境文件或缓存目录。
    for (const name of ['src', 'dist', 'web/dist']) {
      const original = await hashes(path.resolve(name)), copied = await hashes(path.join(snapshot, name)); assert.deepEqual(copied, original);
    }
    // 父快照只读；嵌套依赖挂载点必须在绑定父目录之前存在。
    await fs.mkdir(path.join(snapshot, 'node_modules'));
    await fs.writeFile(path.join(snapshot, 'owned-source.json'), JSON.stringify({ sourceHead, owner, hashes: report.snapshotHashes }) + '\n');
    const buildContext = path.join(root, 'build'); await fs.mkdir(buildContext);
    await fs.writeFile(path.join(buildContext, 'Dockerfile'), `FROM node:22-alpine AS node\nFROM docker:29-dind\nCOPY --from=node /usr/local/bin/node /usr/local/bin/node\nRUN apk add --no-cache libstdc++ git procps bash curl\nLABEL cds.acceptance.owner="${owner}" org.opencontainers.image.revision="${sourceHead}"\n`);
    report.stage = 'owned-daemon-image-build';
    await docker(['build', '--quiet', '-t', tag, buildContext], 300_000);
    const image = JSON.parse(await docker(['image', 'inspect', tag]))[0]; assert.equal(image.Config.Labels['cds.acceptance.owner'], owner);
    imageId = image.Id; report.outerImage = { id: image.Id, revision: image.Config.Labels['org.opencontainers.image.revision'], baseImages: ['node:22-alpine', 'docker:29-dind'] };
    volume = `${owner}-data`; await docker(['volume', 'create', '--label', `cds.acceptance.owner=${owner}`, volume]);
    report.stage = 'owned-container-create';
    containerId = await docker(['create', '--privileged', '--network', 'bridge', '--name', owner, '--label', `cds.acceptance.owner=${owner}`,
      '--cpus', '4', '--memory', '6g', '--pids-limit', '1024', '-e', 'DOCKER_TLS_CERTDIR=',
      '-e', 'GITHUB_ACTIONS=true', '-e', `GITHUB_RUN_ID=${process.env.GITHUB_RUN_ID}`,
      '--mount', `type=bind,src=${snapshot},dst=/owned/source,readonly`,
      '--mount', `type=bind,src=${path.resolve('node_modules')},dst=/owned/source/node_modules,readonly`,
      '--mount', `type=bind,src=${output},dst=/owned/output`, '-v', `${volume}:/var/lib/docker`,
      tag, 'dockerd', '--host=unix:///var/run/owned.sock', '--storage-driver=vfs', '--feature=containerd-snapshotter=false']);
    // 分开create/start，启动报错仍持有已验证的ID，最后可清理创建的容器和卷。
    await ownedContainer(); report.stage = 'owned-container-start-and-isolation'; await docker(['start', containerId]);
    const outer = await ownedContainer(); assert.equal(outer.HostConfig.NetworkMode, 'bridge'); assert.equal(outer.HostConfig.PidMode, '');
    assert.equal(outer.Mounts.some((m: any) => /docker\.sock$/.test(m.Source)), false);
    report.outerRuntime = { containerId, networkMode: outer.HostConfig.NetworkMode, sharedPrimarySocket: false, sharedHostPid: false,
      cpuQuotaNano: outer.HostConfig.NanoCpus, memoryBytes: outer.HostConfig.Memory, pidsLimit: outer.HostConfig.PidsLimit };
    const deadline = performance.now() + 90_000;
    for (;;) {
      assert.equal((await ownedContainer()).State.Running, true);
      try {
        const info = JSON.parse(await docker(['exec', containerId, 'docker', '--host', 'unix:///var/run/owned.sock', 'info', '--format', '{{json .}}'], 5000));
        assert.ok(info.ID); assert.notEqual(info.ID, report.primaryDaemon.id);
        report.isolatedDaemon = { id: info.ID, serverVersion: info.ServerVersion, architecture: info.Architecture, driver: info.Driver, cpus: info.NCPU, memoryBytes: info.MemTotal };
        break;
      } catch (error) { if (performance.now() >= deadline) throw error; await sleep(250); }
    }
    report.stage = 'original-application-owned-docker';
    let result: { stdout: string; stderr: string };
    const commandStartedAt = new Date().toISOString(), commandStarted = performance.now();
    const commandEvidence = (failed?: Error & { code?: unknown; signal?: unknown; killed?: unknown; stdout?: string; stderr?: string }) => ({
      boundary: 'outer-docker-exec-client', configuredTimeoutMs: 600_000,
      startedAt: commandStartedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - commandStarted,
      exitCode: failed ? typeof failed.code === 'number' ? failed.code : null : 0,
      errorCode: failed && typeof failed.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(failed.code) ? failed.code : null,
      signal: failed && typeof failed.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(failed.signal) ? failed.signal : null,
      killed: failed ? typeof failed.killed === 'boolean' ? failed.killed : null : false,
      stdoutBytes: failed ? Buffer.byteLength(failed.stdout || '') : Buffer.byteLength(result.stdout),
      stderrBytes: failed ? Buffer.byteLength(failed.stderr || '') : Buffer.byteLength(result.stderr),
      nativeProcessDispositionVerified: false,
    });
    try { result = await execute('docker', ['--host', primaryHost, 'exec', '-w', '/owned/source', containerId,
      'node', '--import', 'tsx', 'scripts/application-docker-inner-drill.ts', '--native',
      ...(cancelAfterDaemonCreate ? ['--cancel-after-daemon-create'] : []),
      ...(qualifyUnknownCreationShutdown ? ['--qualify-unknown-create-shutdown'] : [])],
    { encoding: 'utf8', timeout: 600_000, maxBuffer: 2 * 1024 * 1024 }); }
    catch (error) { const failed = error as Error & { code?: unknown; signal?: unknown; killed?: unknown; stdout?: string; stderr?: string };
      report.innerCommand = commandEvidence(failed);
      await fs.writeFile(path.join(output, 'inner-driver.log'), ((failed.stdout || '') + (failed.stderr || '')).slice(-65536)); throw error; }
    report.innerCommand = commandEvidence();
    await fs.writeFile(path.join(output, 'inner-driver.log'), (result.stdout + result.stderr).slice(-65536));
    const application = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8')); assert.equal(application.verdict, 'passed');
    assert.equal(application.actualFullIndexBootstrapVerified, true); assert.equal(application.actualOwnedDockerApplicationPreflightVerified, true);
    if (cancelAfterDaemonCreate) assert.equal(application.actualBudgetProbeCancellationVerified, true);
    if (qualifyUnknownCreationShutdown) {
      assert.equal(application.originalFirstShutdownVerdict, 'failed');
      assert.equal(application.unknownCreationShutdownSafetyVerified, true);
      assert.equal(application.failureRecoveryVerified, true);
    }
    assert.equal(application.actualWholeFirstStageVerified, false); assert.equal(application.formalAcceptancePassed, false);
    report.applicationReportSha256 = createHash('sha256').update(await fs.readFile(path.join(output, 'report.json'))).digest('hex');
    report.verdict = 'passed';
  } catch (error) {
    report.failure = { stage: report.stage, message: String((error as Error).message).slice(0, 4000) };
    if (containerId) { try { await fs.writeFile(path.join(output, 'owned-daemon.log'), (await docker(['logs', '--tail', '150', containerId])).slice(-65536)); } catch { /* 自有日志不可取不掩盖首次错误。 */ } }
    throw error;
  } finally {
    const cleanupErrors: string[] = [];
    if (containerId) { try { await ownedContainer(); await docker(['rm', '-f', containerId]);
      assert.equal((await docker(['ps', '-aq', '--no-trunc', '--filter', `id=${containerId}`])), ''); report.ownedContainerRemoved = true;
    } catch (error) { cleanupErrors.push(String(error)); } }
    if (volume) { try { const view = JSON.parse(await docker(['volume', 'inspect', volume]))[0]; assert.equal(view.Labels['cds.acceptance.owner'], owner);
      await docker(['volume', 'rm', volume]);
      assert.equal(await docker(['volume', 'ls', '-q', '--filter', `label=cds.acceptance.owner=${owner}`]), ''); report.ownedVolumeRemoved = true;
    } catch (error) { cleanupErrors.push(String(error)); } }
    if (imageId) { try { const view = JSON.parse(await docker(['image', 'inspect', imageId]))[0]; assert.equal(view.Config.Labels['cds.acceptance.owner'], owner);
      assert.deepEqual(view.RepoTags, [tag]); await docker(['image', 'rm', imageId]);
      assert.equal(await docker(['image', 'ls', '-q', '--no-trunc', '--filter', `label=cds.acceptance.owner=${owner}`]), ''); report.ownedImageRemoved = true;
    } catch (error) { cleanupErrors.push(String(error)); } }
    await fs.rm(root, { recursive: true, force: true }); report.isolatedFilesRemoved = true;
    if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.verdict = 'failed'; process.exitCode = 1; }
    report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'host-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  assert.equal(report.ownedContainerRemoved, true); assert.equal(report.ownedVolumeRemoved, true); assert.equal(report.ownedImageRemoved, true);
}
await main().catch(error => { console.error(error instanceof Error ? error.message : '完整应用独占Docker前提演练失败'); process.exitCode = 1; });
