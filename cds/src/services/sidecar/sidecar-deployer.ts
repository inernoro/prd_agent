/**
 * SidecarDeployer — 共享基础设施服务的部署引擎（5 阶段流程）。
 *
 * 阶段：
 *   1. connecting   SSH echo 连接验证
 *   2. installing   docker pull + docker run（或 docker compose up -d）
 *   3. verifying    HTTP GET sidecar 的 /healthz
 *   4. registering  写 ServiceDeployment.status='running'，让 instance API 可见
 *   5. running      HealthMonitor 接管周期监控
 *
 * 任一阶段失败 → status='failed'，finishedAt 设置，logs 含失败原因。
 *
 * 设计原则：
 *   - 每阶段调用 emit() 追加日志 + bump seq，前端 SSE 实时拉
 *   - 永远 try/catch 包裹每阶段，失败不抛到顶层（顶层只 await 整个 deploy()）
 *   - 私钥解密发生在内存内，绝不落盘 / 落日志（log 里只出现 fingerprint）
 *
 * MVP 设计选择（2026-05-06）：
 *   - 部署单位 = RemoteHost + SidecarSpec（不绑 Project，每主机一个 sidecar）
 *   - SSH 连接走 ssh2 npm 包；动态 import 让无依赖时 tsc 也能过
 *   - docker-compose 策略保留 hook，当前只实现 docker-run
 *
 * 详见 doc/plan.cds-shared-service-extension.md。
 */

import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import type { StateService } from '../state.js';
import type { ServiceDeployment, RemoteHost } from '../../types.js';
import { decryptRemoteHostSecrets } from './remote-host-service.js';

// 注意：ssh2 是异步 / 事件驱动 API，我们用 callback → Promise 简单包装。
// 在没有 ssh2 依赖的本地 sandbox 也能 tsc 通过 —— 真实运行时才动态 import。
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

/**
 * Sidecar 部署规格 —— 最小可部署的描述。不依赖 CDS Project 抽象，
 * 让 RemoteHost 直接成为部署单位（"每主机一个 sidecar"）。
 *
 * 未来 shared-service Project 的部署调用同样的 deployer，只是从
 * Project.serviceImage / servicePort / serviceEnv 派生 spec。
 */
export interface SidecarSpec {
  /** docker 镜像（含 tag），如 'prdagent/claude-sidecar:v0.2.1'。 */
  image: string;
  /** sidecar 容器对外暴露的端口（默认 7400）。 */
  port: number;
  /** 容器名后缀，与 host.name 拼接得到 "cds-sidecar-<hostName>-<slug>"。 */
  slug: string;
  /** 环境变量 —— ANTHROPIC_API_KEY 等敏感字段调用方应在写库前 sealToken。 */
  env?: Record<string, string>;
  /** Release / git tag 标识，仅用于 UI 展示。 */
  releaseTag?: string;
  /** 可选 strategy；当前默认 docker-run。 */
  strategy?: 'docker-run' | 'docker-compose';
}

export interface DeployContext {
  deployment: ServiceDeployment;
  emit: (level: 'info' | 'warn' | 'error', message: string, phase?: string) => void;
  patch: (fields: Partial<ServiceDeployment>) => void;
}

export class SidecarDeployer {
  constructor(private readonly stateService: StateService) {}

  /**
   * 创建 deployment 记录（status=pending），返回 id 给调用方做 SSE。
   * 不启动实际部署 —— runDeployment(spec, host, id) 才真跑。
   */
  beginDeployment(host: RemoteHost, spec: SidecarSpec): ServiceDeployment {
    if (!spec.image) throw new Error('SidecarSpec.image is required');
    if (!host.isEnabled) throw new Error(`host '${host.name}' is disabled`);

    const id = crypto.randomBytes(8).toString('hex');
    const deployment: ServiceDeployment = {
      id,
      // MVP: projectId 写 host.id 当 placeholder（未来 shared-service Project
      // 落地时改为真实 projectId）。Logs 里 message 已含 host name + image，
      // 不影响审计。
      projectId: host.id,
      hostId: host.id,
      releaseTag: spec.releaseTag,
      status: 'pending',
      seq: 0,
      startedAt: new Date().toISOString(),
      logs: [
        {
          at: new Date().toISOString(),
          level: 'info',
          message: `deploy queued image=${spec.image} host=${host.name}`,
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
  async runDeployment(
    host: RemoteHost,
    spec: SidecarSpec,
    deploymentId: string,
  ): Promise<ServiceDeployment> {
    const ctx = this.makeContext(deploymentId);
    try {
      await this.stageConnecting(host, ctx);
      await this.stageInstalling(host, spec, ctx);
      await this.stageVerifying(host, spec, ctx);
      this.stageRegistering(ctx);
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

  /**
   * 仅做 SSH echo 连接测试（不部署任何容器），用于 RemoteHostsTab 的「测试」按钮。
   * 不持久化任何 ServiceDeployment；调用方负责 stateService.recordTestResult。
   */
  async testConnection(host: RemoteHost): Promise<{ ok: boolean; message: string }> {
    try {
      const out = await this.sshExec(host, 'echo cds-connect-ok');
      const ok = out.includes('cds-connect-ok');
      return ok
        ? { ok: true, message: 'ssh handshake ok' }
        : { ok: false, message: `unexpected output: ${out.slice(0, 200)}` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  // ── 阶段实现 ───────────────────────────────────────

  private async stageConnecting(host: RemoteHost, ctx: DeployContext): Promise<void> {
    ctx.patch({ status: 'connecting', phase: 'ssh-handshake' });
    ctx.emit(
      'info',
      `connecting ${host.sshUser}@${host.host}:${host.sshPort} fingerprint=${host.sshPrivateKeyFingerprint}`,
    );
    const out = await this.sshExec(host, 'echo cds-connect-ok');
    if (!out.includes('cds-connect-ok')) {
      throw new Error(`ssh echo unexpected output: ${out.slice(0, 200)}`);
    }
    ctx.emit('info', 'ssh handshake ok');
  }

  private async stageInstalling(
    host: RemoteHost,
    spec: SidecarSpec,
    ctx: DeployContext,
  ): Promise<void> {
    const strategy = spec.strategy || 'docker-run';
    ctx.patch({ status: 'installing', phase: `${strategy} pull+up` });

    const containerName = `cds-sidecar-${spec.slug}`;
    const port = spec.port || 7400;
    const envFlags = renderEnvFlags(spec.env);

    const pullCmd = `docker pull ${spec.image}`;
    ctx.emit('info', `running: ${pullCmd}`);
    await this.sshExec(host, pullCmd);

    if (strategy === 'docker-run') {
      const stopCmd = `docker rm -f ${containerName} 2>/dev/null || true`;
      ctx.emit('info', `running: ${stopCmd}`);
      await this.sshExec(host, stopCmd);

      const runCmd = [
        'docker run -d',
        `--name ${containerName}`,
        `--restart unless-stopped`,
        `-p ${port}:${port}`,
        envFlags,
        spec.image,
      ]
        .filter(Boolean)
        .join(' ');
      ctx.emit('info', `running: ${redactCmd(runCmd)}`);
      await this.sshExec(host, runCmd);
    } else {
      throw new Error('docker-compose strategy not implemented yet');
    }

    ctx.emit('info', `container ${containerName} started`);
  }

  private async stageVerifying(
    host: RemoteHost,
    spec: SidecarSpec,
    ctx: DeployContext,
  ): Promise<void> {
    ctx.patch({ status: 'verifying', phase: 'healthz' });
    const port = spec.port || 7400;
    const url = `http://${host.host}:${port}/healthz`;
    const maxAttempts = 5;
    const intervalMs = 5000;
    for (let i = 1; i <= maxAttempts; i++) {
      try {
        const ok = await probeHealthz(url);
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

  private stageRegistering(ctx: DeployContext): void {
    ctx.patch({ status: 'registering', phase: 'instance-discovery' });
    ctx.emit('info', 'instance is now discoverable via /api/cds-system/remote-hosts/:id/instance');
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
        try {
          client.end();
        } catch {
          /* ignore */
        }
        fn();
      };

      client.on('ready', () => {
        client.exec(cmd, (err, stream) => {
          if (err) return settle(() => reject(err));
          stream.on('close', (code: unknown) => {
            const exitCode = typeof code === 'number' ? code : 0;
            if (exitCode === 0) return settle(() => resolve(stdout));
            settle(() =>
              reject(new Error(`ssh exec exit=${exitCode} stderr=${stderr.slice(0, 500)}`)),
            );
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
}

// ── 模块级工具（导出供单测直接验证）───────────────────────────────────────

/** 命令日志脱敏：屏蔽 -e KEY=VALUE 段中 KEY 含 SECRET/TOKEN/KEY 后缀的 VALUE。 */
export function redactCmd(cmd: string): string {
  return cmd.replace(/(-e\s+\S*?(SECRET|TOKEN|KEY|PASS|PWD)\S*?=)([^\s]+)/gi, '$1***');
}

/** 简易 shell 字符串引用（防注入）。 */
export function shellQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** 把 env 字典转为 `-e KEY='VAL' -e KEY2='VAL2'`。 */
export function renderEnvFlags(env: Record<string, string> | undefined): string {
  if (!env) return '';
  return Object.entries(env)
    .map(([k, v]) => `-e ${shellQuote(k)}=${shellQuote(v)}`)
    .join(' ');
}

async function probeHealthz(url: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = global.setTimeout(() => ctrl.abort(), 5_000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    return resp.ok;
  } finally {
    global.clearTimeout(timer);
  }
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
