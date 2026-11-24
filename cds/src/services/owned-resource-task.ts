import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { IShellExecutor } from '../types.js';
import { shellQuoteArg } from './secure-database-cli.js';
import { diskGuard } from './disk-guard.js';
import { reclaimLock } from './reclaim-lock.js';
import { OWNED_RESOURCE_PROGRAM } from './owned-resource-program.js';
import { DOCKER_LOG_LIMIT_ARGS } from './docker-log-policy.js';
import { resumedReclaimExecution, recordReclaimExecution, type ReclaimExecutionJournal } from './reclaim-execution-journal.js';

export interface OwnedResourceOptions {
  shell: IShellExecutor; catalog: string; workspaceBase: string; instanceId: string;
  reserveBytes?: number; projectBudgetBytes?: number; globalBudgetBytes?: number;
  historyLimit?: number; maxBytes?: number;
  journal?: ReclaimExecutionJournal;
}
export interface OwnedTaskHandle { taskId: string; token: string; workspace: string; leaseUntil: number }
export class OwnedResourceLifecycle {
  private execution: { id: string; status: 'running' | 'completed' | 'failed'; startedAt: string; report?: any; error?: string } | null = null;
  constructor(readonly options: OwnedResourceOptions) { this.execution = resumedReclaimExecution(options.journal); }
  private persist() { recordReclaimExecution(this.options.journal, this.execution); }
  getSnapshot() { return structuredClone(this.execution); }
  startReconcile() {
    if (this.execution?.status === 'running' || reclaimLock.getState().holder) throw new Error('回收正在执行。');
    const id = randomBytes(16).toString('hex');
    this.execution = { id, status: 'running', startedAt: new Date().toISOString() };
    this.persist();
    void this.inspect(false, undefined, id).then(report => {
      if (this.execution?.id === id) Object.assign(this.execution, { status: 'completed', report });
      this.persist();
    }, () => { if (this.execution?.id === id) Object.assign(this.execution, { status: 'failed', error: '资源对账未完成，未知对象保持保护。' }); this.persist(); });
    return this.getSnapshot();
  }
  async cancel(id: string) {
    if (this.execution?.id !== id || this.execution.status !== 'running') throw new Error('任务已结束或身份已变化。');
    return this.request('cancel', { executionId: id });
  }
  async request(action: string, input: Record<string, unknown> = {}): Promise<any> {
    const loader = `import base64;exec(base64.b64decode("${Buffer.from(OWNED_RESOURCE_PROGRAM).toString('base64')}"))`;
    const until = Date.now() + 35_000;
    let result;
    do {
    result = await this.options.shell.exec(`python3 -c ${shellQuoteArg(loader)}`, {
      stdin: JSON.stringify({ ...this.options, shell: undefined, journal: undefined, ...input, action }),
      executionLane: action === 'preview' ? 'observation' : 'operation', timeout: action === 'reconcile' ? 125_000 : 30_000,
    });
    if (result.exitCode !== 3) break;
    if (action === 'preview' || action === 'reconcile') return { scanStatus: 'partial', catalogError: 'catalog-busy', usageBytes: null };
    await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < until);
    if (result.exitCode !== 0 || result.stdout.length > 4 * 1024 * 1024) throw new Error('验收资源身份、租约或查询未确认，相关资源保持保留。');
    try { return JSON.parse(result.stdout); } catch { throw new Error('验收资源对账响应未确认，不能判断零占用。'); }
  }
  async begin(input: { projectId: string; owner: string; createdBy: string; ttlSeconds?: number; dataDisposition: 'ephemeral-test' }): Promise<OwnedTask> {
    const reason = diskGuard.blockReasonForDeploy();
    if (reason) throw new Error(reason);
    const handle: OwnedTaskHandle = await this.request('begin', { ...input, producerPid: process.pid });
    return new OwnedTask(this, handle);
  }
  async inspect(dryRun = true, taskId?: string, executionId?: string) {
    const run = () => this.request(dryRun ? 'preview' : 'reconcile', { ...(taskId ? { taskId } : {}), ...(executionId ? { executionId } : {}), maxTasks: 2 });
    return dryRun ? run() : reclaimLock.run('owned-resource-retention', run);
  }
}

export class OwnedTask {
  private cleanup: Promise<unknown> | undefined;
  static fromEnvironment(shell: IShellExecutor) {
    const { CDS_RESOURCE_TASK_ID: taskId, CDS_RESOURCE_LEASE_TOKEN: token, CDS_RESOURCE_WORKSPACE: workspace,
      CDS_RESOURCE_INSTANCE: instanceId, CDS_RESOURCE_WORKSPACE_BASE: workspaceBase, CDS_RESOURCE_CATALOG: catalog } = process.env;
    if (!taskId || !token || !workspace || !instanceId || !workspaceBase || !catalog) throw new Error('验收必须从资源清单启动器进入。');
    return new OwnedTask(new OwnedResourceLifecycle({ shell, instanceId, workspaceBase, catalog }), { taskId, token, workspace, leaseUntil: 0 });
  }
  constructor(readonly lifecycle: OwnedResourceLifecycle, readonly handle: OwnedTaskHandle) {}
  private call(action: string, input: Record<string, unknown> = {}) { return this.lifecycle.request(action, { ...input, taskId: this.handle.taskId, token: this.handle.token }); }
  heartbeat(ttlSeconds = 600) { return this.call('heartbeat', { ttlSeconds }); }
  async finish(outcome: 'completed' | 'failed' | 'cancelled') {
    return this.cleanup ??= (async () => { await this.call('finish', { outcome });return this.lifecycle.inspect(false, this.handle.taskId); })();
  }
  /** Native creation arguments are constructed by trusted acceptance code, never an HTTP request. */
  private async create(kind: 'container' | 'volume' | 'network' | 'image', name: string, argv: string[], role: string) {
    const prefix = kind === 'container' ? ['create'] : kind === 'image' ? ['build'] : [kind, 'create'];
    if (prefix.some((part, index) => argv[index] !== part)) throw new Error('创建入口与资源类型不一致。');
    const intent = await this.call('intent', { kind, name, role });
    const labels = Object.entries(intent.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    const args = [...prefix, ...labels, ...argv.slice(prefix.length)];
    // Journal the native creator as well as the requested object. Closing the lease fences late starts.
    const child = await this.launch(['docker', ...args], { quiet: true, role: 'resource-creator', resourceId: intent.resourceId });
    const timer = setTimeout(() => child.kill('SIGTERM'), kind === 'image' ? 600_000 : 120_000);timer.unref();
    let code: number | null;
    try { code = child.exitCode !== null ? child.exitCode : (await once(child, 'exit'))[0]; }
    finally { clearTimeout(timer); }
    if (code !== 0) {
      await this.call('creation-ended', { resourceId: intent.resourceId }).catch(() => undefined);
      throw new Error('创建未完成，意图和原生结果已保留，等待独立对账。');
    }
    return this.call('confirm', { resourceId: intent.resourceId });
  }
  async createVolume(role: string) {
    const name = `cds-owned-${this.handle.taskId}-${randomBytes(8).toString('hex')}`;
    return this.create('volume', name, ['volume', 'create', name], role);
  }
  async buildImage(role: string, context: string) {
    const name = `cds-owned-${this.handle.taskId}:build-${randomBytes(4).toString('hex')}`;
    return { ...await this.create('image', name, ['build', '--quiet', '-t', name, context], role), name };
  }
  async exec(containerId: string, command: string[], stdin?: string) {
    await this.call('binding', { kind: 'container', identity: containerId });
    return this.lifecycle.options.shell.exec(['docker', 'exec', '-i', containerId, ...command].map(shellQuoteArg).join(' '), { stdin, executionLane: 'operation', timeout: 120_000 });
  }
  async createContainer(options: { image: string; role: string; command: string[]; isolatedDockerHost?: boolean; mounts?: Array<{ kind: 'volume' | 'bind'; source: string; target: string; readOnly?: boolean }> }) {
    const name = `cds-owned-${this.handle.taskId}-${randomBytes(4).toString('hex')}`;
    const mounts = options.mounts || [];
    for (const mount of mounts) {
      if (!path.isAbsolute(mount.target)
        || /[\0\r\n,]/.test(mount.source + mount.target)) throw new Error('测试数据必须使用本任务的独立存储，源码只能只读挂载。');
      if (mount.kind === 'bind' && !mount.readOnly) await this.call('workspace-binding', { path: path.resolve(mount.source) });
      if (mount.kind === 'volume') await this.call('binding', { kind: 'volume', identity: mount.source });
    }
    const result = await this.lifecycle.options.shell.exec(`docker image inspect ${shellQuoteArg(options.image)} --format '{{json (index .Config "Volumes")}}'`, { executionLane: 'observation' });
    if (result.exitCode !== 0) throw new Error('预构建镜像未就绪，未创建验收容器。');
    const declared = JSON.parse(result.stdout) || {};
    if (Object.keys(declared).some(target => !mounts.some(mount => mount.target === target))) throw new Error('镜像数据目录尚未绑定任务独立存储。');
    const created = await this.create('container', name, ['create', '--name', name, '--network', options.isolatedDockerHost ? 'bridge' : 'none',
      '--cpus', options.isolatedDockerHost ? '4' : '0.5', '--memory', options.isolatedDockerHost ? '6g' : '256m', '--pids-limit', options.isolatedDockerHost ? '1024' : '128',
      ...(options.isolatedDockerHost ? ['--privileged', '-e', 'DOCKER_TLS_CERTDIR=', '-e', 'GITHUB_ACTIONS=true', '-e', `GITHUB_RUN_ID=${process.env.GITHUB_RUN_ID || ''}`] : []),
      ...DOCKER_LOG_LIMIT_ARGS,
      ...mounts.flatMap(mount => ['--mount', `type=${mount.kind},source=${mount.kind === 'bind' ? path.resolve(mount.source) : mount.source},target=${mount.target}${mount.readOnly ? ',readonly' : ''}`]), options.image, ...options.command], options.role);
    await this.call('binding', { kind: 'container', identity: created.identity });
    const started = await this.lifecycle.options.shell.exec(`docker start ${shellQuoteArg(created.identity)}`, { executionLane: 'operation' });
    if (started.exitCode !== 0) throw new Error('验收容器启动未完成，资源清单已保留。');
    return { ...created, name };
  }
  /** A private daemon is born empty; its data, endpoint and launcher are journaled before use. */
  async startPrivateDaemon() {
    const volume = await this.createVolume('private-docker-data');
    const intent = await this.call('daemon-intent', { volumeIdentity: volume.identity });
    const workspace = this.handle.workspace;
    const child = await this.launch(['dockerd', `--config-file=${path.join(workspace, 'd.json')}`, `--data-root=${intent.dataRoot}`, `--exec-root=${path.join(workspace, 'r')}`,
      `--pidfile=${path.join(workspace, 'd.pid')}`, `--host=${intent.endpoint}`,
      '--storage-driver=vfs', '--iptables=false', '--bridge=none', '--shutdown-timeout=3'],
    { role: 'private-daemon', privateDaemonId: intent.id, quiet: true });
    // Keep the process supervised without retaining event-loop handles after a caller crash.
    child.unref();
    await this.call('daemon-confirm', { resourceId: intent.id });
    return { endpoint: intent.endpoint, resourceId: intent.id,
      exec: async (args: string[]) => {
        await this.call('daemon-binding', { resourceId: intent.id });
        return this.lifecycle.options.shell.exec(['docker', '--host', intent.endpoint, ...args].map(shellQuoteArg).join(' '), { executionLane: 'operation', timeout: 120_000 });
      } };
  }
  /** The child cannot execute user code before its native PID/session receipt is durable. */
  private async launch(argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; role?: string; privateDaemonId?: string; resourceId?: string; quiet?: boolean } = {}) {
    const gate = 'import os,sys,json,base64;os.write(4,b"R");ready=os.read(3,1);os.close(3);os.close(4);args=json.loads(base64.b64decode(sys.argv[2]));os.chdir(args["cwd"]);os.execvpe(args["argv"][0],args["argv"],os.environ) if ready==b"G" else sys.exit(1)';
    const child = spawn('python3', ['-c', gate, 'cds-owned-launcher-v1', Buffer.from(JSON.stringify({ argv, cwd: options.cwd || this.handle.workspace })).toString('base64')], {
      cwd: this.handle.workspace, detached: true, stdio: [options.quiet ? 'ignore' : 'inherit', options.quiet ? 'ignore' : 'inherit', options.quiet ? 'ignore' : 'inherit', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env, CDS_RESOURCE_TASK_ID: this.handle.taskId, CDS_RESOURCE_LEASE_TOKEN: this.handle.token,
        CDS_RESOURCE_INSTANCE: this.lifecycle.options.instanceId, CDS_RESOURCE_WORKSPACE_BASE: this.lifecycle.options.workspaceBase,
        CDS_RESOURCE_WORKSPACE: this.handle.workspace, CDS_RESOURCE_CATALOG: this.lifecycle.options.catalog },
    });
    const ready = child.stdio[4]!;
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);timer.unref();
    try {
      await once(ready, 'data');
      await this.call('process', { pid: child.pid, role: options.role, privateDaemonId: options.privateDaemonId, resourceId: options.resourceId });
      const channel = child.stdio[3] as import('node:stream').Writable;
      channel.end('G');
    } catch (error) {
      (child.stdio[3] as import('node:stream').Writable).destroy();throw error;
    } finally { clearTimeout(timer); }
    return child;
  }
  async run(argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; ttlSeconds?: number } = {}): Promise<number> {
    const child = await this.launch(argv, options);
    const exited = child.exitCode !== null ? Promise.resolve([child.exitCode]) : once(child, 'exit');
    let renewing = Promise.resolve<unknown>(undefined);
    const heartbeat = setInterval(() => { renewing = renewing.then(() => this.heartbeat(options.ttlSeconds)).catch(() => child.kill('SIGTERM')); }, Math.max(1000, Math.min(30_000, (options.ttlSeconds || 600) * 300)));
    heartbeat.unref();
    try { const [code] = await exited;return typeof code === 'number' ? code : 1; }
    finally { clearInterval(heartbeat);await renewing; }
  }
}
