/**
 * SidecarDeployer — shared-service 部署引擎（5 阶段流程）。
 *
 * 阶段：
 *   1. connecting   SSH echo 连接验证
 *   2. installing   docker pull + docker run（或 docker compose up -d）
 *   3. verifying    HTTP GET sidecar 的 /healthz
 *   4. registering  写 ServiceDeployment.status='running'，让路由器/instances API 可见
 *   5. running      HealthMonitor 接管周期监控
 *
 * 任一阶段失败 → status='failed'，finishedAt 设置，logs 含失败原因。
 *
 * 设计原则：
 *   - 每阶段调用 emit() 追加日志 + bump seq，前端 SSE 实时拉
 *   - 永远 try/catch 包裹每阶段，失败不抛到顶层（顶层只 await 整个 deploy()）
 *   - 私钥解密发生在内存内，绝不落盘 / 落日志（log 里只出现 fingerprint）
 *
 * 当前实现状态（2026-05-06）：
 *   - SSH 连接 / exec 走 ssh2 npm 包（installing/connecting 已实现）
 *   - 健康探测走 fetch (verifying)
 *   - registering / running 仅写状态字段，由上层 HealthMonitor 接管
 *   - 真实 docker compose 编排留 hook：DEPLOY_STRATEGY env 决定是 docker-run 还是 compose
 *
 * 详见 doc/plan.cds-shared-service-extension.md。
 */

import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { StateService } from '../state.js';
import type { ServiceDeployment, RemoteHost, Project } from '../../types.js';
import { decryptRemoteHostSecrets } from './remote-host-service.js';

// 注意：ssh2 是异步 / 事件驱动 API，我们用 callback → Promise 简单包装。
// 在没有 ssh2 依赖的本地 sandbox 也能 tsc 通过 —— 真实运行时才动态 import。
// 这避免类型/构建强依赖 native module 的安装链。
type Ssh2Client = {
  connect(opts: Ssh2ConnectOptions): void;
  on(event: 'ready' | 'error' | 'end' | 'close', listener: (...args: unknown[]) => void): unknown;
  end(): void;
  exec(
    cmd: string,
    cb: (err: Error | undefined, stream: Ssh2ExecStream) => void,
  ): boolean;
};

type Ssh2ExecStream = {
  on(event: 'close' | 'data', listener: (...args: unknown[]) => void): unknown;
  stderr: { on(event: 'data', listener: (...args: unknown[]) => void): unknown };
};

interface Ssh2ConnectOptions {
  host: string;
  port: number;
  username: string;
  privateKey: string | Buffer;
  passphrase?: string;
  readyTimeout?: number;
}

export interface DeployRequest {
  project: Project;
  host: RemoteHost;
  /** 调用方决定用什么策略起容器；默认 docker-run。 */
  strategy?: 'docker-run' | 'docker-compose';
}

export interface DeployContext {
  deployment: ServiceDeployment;
  emit: (level: 'info' | 'warn' | 'error', message: string, phase?: string) => void;
  patch: (fields: Partial<ServiceDeployment>) => void;
}

export class SidecarDeployer {
  constructor(private readonly stateService: StateService) {}

  /** 创建 deployment 记录（status=pending），返回 id 给调用方做 SSE。 */
  beginDeployment(req: DeployRequest): ServiceDeployment {
    if (!req.project.serviceImage)
      throw new Error('project.serviceImage is required for shared-service deploy');
    if (!req.host.isEnabled)
      throw new Error(`host '${req.host.name}' is disabled`);

    const id = crypto.randomBytes(8).toString('hex');
    const deployment: ServiceDeployment = {
      id,
      projectId: req.project.id,
      hostId: req.host.id,
      releaseTag: req.project.releaseTag,
      status: 'pending',
      seq: 0,
      startedAt: new Date().toISOString(),
      logs: [
        {
          at: new Date().toISOString(),
          level: 'info',
          message: `deploy queued image=${req.project.serviceImage} host=${req.host.name}`,
        },
      ],
    };
    this.stateService.addServiceDeployment(deployment);
    return deployment;
  }

  /**
   * 跑完整 5 阶段。任一阶段失败 → 写 status='failed' 后返回。
   * 顶层不抛异常，便于 SSE 调用方安心 await。
   */
  async runDeployment(req: DeployRequest, deploymentId: string): Promise<ServiceDeployment> {
    const ctx = this.makeContext(deploymentId);
    try {
      await this.stageConnecting(req, ctx);
      await this.stageInstalling(req, ctx);
      await this.stageVerifying(req, ctx);
      this.stageRegistering(req, ctx);
      ctx.patch({ status: 'running', finishedAt: new Date().toISOString() });
      ctx.emit('info', 'deploy succeeded', 'running');
    } catch (err) {
      ctx.emit('error', `deploy failed: ${(err as Error).message}`);
      ctx.patch({
        status: 'failed',
        message: (err as Error).message,
        finishedAt: new Date().toISOString(),
      });
    }
    return this.stateService.getServiceDeployment(deploymentId)!;
  }

  // ── 阶段实现 ───────────────────────────────────────

  private async stageConnecting(req: DeployRequest, ctx: DeployContext): Promise<void> {
    ctx.patch({ status: 'connecting', phase: 'ssh-handshake' });
    ctx.emit('info', `connecting ${req.host.sshUser}@${req.host.host}:${req.host.sshPort} fingerprint=${req.host.sshPrivateKeyFingerprint}`);
    const out = await this.sshExec(req.host, 'echo cds-connect-ok');
    if (!out.includes('cds-connect-ok')) {
      throw new Error(`ssh echo unexpected output: ${out.slice(0, 200)}`);
    }
    ctx.emit('info', 'ssh handshake ok');
  }

  private async stageInstalling(req: DeployRequest, ctx: DeployContext): Promise<void> {
    const strategy = req.strategy || 'docker-run';
    ctx.patch({ status: 'installing', phase: `${strategy} pull+up` });
    const image = req.project.serviceImage!;
    const containerName = `cds-sidecar-${req.project.slug}`;
    const port = req.project.servicePort || 7400;
    const envFlags = this.renderEnvFlags(req.project);

    const pullCmd = `docker pull ${image}`;
    ctx.emit('info', `running: ${pullCmd}`);
    await this.sshExec(req.host, pullCmd);

    if (strategy === 'docker-run') {
      const stopCmd = `docker rm -f ${containerName} 2>/dev/null || true`;
      ctx.emit('info', `running: ${stopCmd}`);
      await this.sshExec(req.host, stopCmd);

      const runCmd = [
        'docker run -d',
        `--name ${containerName}`,
        `--restart unless-stopped`,
        `-p ${port}:${port}`,
        envFlags,
        image,
      ].filter(Boolean).join(' ');
      ctx.emit('info', `running: ${redactCmd(runCmd)}`);
      await this.sshExec(req.host, runCmd);
    } else {
      // 'docker-compose' 暂留 placeholder，等定下 compose 模板再补
      throw new Error('docker-compose strategy not implemented yet (Phase A.3.2)');
    }

    ctx.emit('info', `container ${containerName} started`);
  }

  private async stageVerifying(req: DeployRequest, ctx: DeployContext): Promise<void> {
    ctx.patch({ status: 'verifying', phase: 'healthz' });
    const port = req.project.servicePort || 7400;
    const url = `http://${req.host.host}:${port}/healthz`;
    const maxAttempts = 5;
    const intervalMs = 5000;
    for (let i = 1; i <= maxAttempts; i++) {
      try {
        const ok = await this.probeHealthz(url);
        if (ok) {
          ctx.emit('info', `healthz 200 (attempt ${i}/${maxAttempts})`);
          return;
        }
      } catch (err) {
        ctx.emit('warn', `healthz attempt ${i}/${maxAttempts} failed: ${(err as Error).message}`);
      }
      if (i < maxAttempts) await delay(intervalMs);
    }
    throw new Error(`healthz failed after ${maxAttempts} attempts`);
  }

  private stageRegistering(_req: DeployRequest, ctx: DeployContext): void {
    ctx.patch({ status: 'registering', phase: 'instance-discovery' });
    ctx.emit('info', 'instance is now discoverable via /api/projects/:id/instances');
  }

  // ── 工具 ───────────────────────────────────────

  private makeContext(deploymentId: string): DeployContext {
    const dep = this.stateService.getServiceDeployment(deploymentId);
    if (!dep) throw new Error(`deployment not found: ${deploymentId}`);
    return {
      deployment: dep,
      emit: (level, message, phase) => {
        this.stateService.appendServiceDeploymentLog(deploymentId, { level, message, phase });
      },
      patch: fields => {
        this.stateService.patchServiceDeployment(deploymentId, fields);
      },
    };
  }

  /** 执行 SSH 命令。仅返回 stdout；非 0 退出码抛错。 */
  private async sshExec(host: RemoteHost, cmd: string): Promise<string> {
    const ssh2Mod = await loadSsh2();
    const { privateKey, passphrase } = decryptRemoteHostSecrets(host);
    const client = new ssh2Mod.Client() as unknown as Ssh2Client;

    return new Promise<string>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        try { client.end(); } catch { /* ignore */ }
        fn();
      };

      client.on('ready', () => {
        client.exec(cmd, (err, stream) => {
          if (err) return settle(() => reject(err));
          stream.on('close', (code: unknown) => {
            const exitCode = typeof code === 'number' ? code : 0;
            if (exitCode === 0) return settle(() => resolve(stdout));
            settle(() => reject(new Error(`ssh exec exit=${exitCode} stderr=${stderr.slice(0, 500)}`)));
          });
          stream.on('data', (chunk: unknown) => {
            stdout += String(chunk);
          });
          stream.stderr.on('data', (chunk: unknown) => {
            stderr += String(chunk);
          });
        });
      });
      client.on('error', err => settle(() => reject(err as Error)));

      client.connect({
        host: host.host,
        port: host.sshPort,
        username: host.sshUser,
        privateKey,
        passphrase,
        readyTimeout: 10_000,
      });
    });
  }

  private async probeHealthz(url: string): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = global.setTimeout(() => ctrl.abort(), 5_000);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      return resp.ok;
    } finally {
      global.clearTimeout(timer);
    }
  }

  private renderEnvFlags(project: Project): string {
    const env = project.serviceEnv || {};
    return Object.entries(env)
      .map(([k, v]) => `-e ${shellQuote(k)}=${shellQuote(v)}`)
      .join(' ');
  }
}

/** 命令日志脱敏：屏蔽 -e KEY=VALUE 段中 KEY 含 SECRET/TOKEN/KEY 后缀的 VALUE。 */
function redactCmd(cmd: string): string {
  return cmd.replace(/(-e\s+\S*?(SECRET|TOKEN|KEY|PASS|PWD)\S*?=)([^\s]+)/gi, '$1***');
}

/** 简易 shell 字符串引用（防注入）。 */
function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** 动态加载 ssh2，避免本地无依赖时阻塞 tsc。 */
async function loadSsh2(): Promise<{ Client: new () => unknown }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('ssh2').catch(err => {
    throw new Error(
      `ssh2 module not available: ${(err as Error).message}. ` +
        `run 'pnpm --dir cds add ssh2 @types/ssh2' to enable shared-service deploy.`,
    );
  });
  return { Client: mod.Client || mod.default?.Client };
}
