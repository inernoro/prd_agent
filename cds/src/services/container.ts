import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { IShellExecutor, CdsConfig, BuildProfile, BranchEntry, ServiceState, InfraService, DeployModeOverride } from '../types.js';
import { combinedOutput } from '../types.js';
import { resolveEnvTemplates } from './compose-parser.js';

/**
 * Resolve a BuildProfile with active deploy mode overrides applied.
 * Returns a new profile object with command/dockerImage/env merged from the mode.
 */
export function resolveProfileWithMode(profile: BuildProfile): BuildProfile {
  const mode = profile.activeDeployMode;
  if (!mode || !profile.deployModes?.[mode]) return profile;

  const override = profile.deployModes[mode];
  return {
    ...profile,
    command: override.command ?? profile.command,
    dockerImage: override.dockerImage ?? profile.dockerImage,
    env: override.env
      ? { ...profile.env, ...override.env }
      : profile.env,
  };
}

export class ContainerService {
  constructor(
    private readonly shell: IShellExecutor,
    private readonly config: CdsConfig,
  ) {}

  /**
   * Write env vars to a temp file and return its path.
   * Uses --env-file instead of -e to avoid shell escaping issues
   * with special characters (@, #, !, etc.) in values.
   */
  private writeEnvFile(mergedEnv: Record<string, string>): string {
    const envFilePath = path.join(os.tmpdir(), `cds-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const lines = Object.entries(mergedEnv).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(envFilePath, lines.join('\n'), 'utf-8');
    return envFilePath;
  }

  private removeEnvFile(envFilePath: string): void {
    try { fs.unlinkSync(envFilePath); } catch { /* ok */ }
  }

  /**
   * Run a branch service from source using a build profile.
   * Mounts the worktree + shared cache volumes into a Docker container.
   * Uses profile.command to run everything in one persistent container.
   */
  async runService(
    entry: BranchEntry,
    profile: BuildProfile,
    service: ServiceState,
    onOutput?: (chunk: string) => void,
    customEnv?: Record<string, string>,
  ): Promise<void> {
    await this.ensureNetwork();

    // Remove any existing container
    await this.shell.exec(`docker rm -f ${service.containerName}`);

    const srcMount = path.join(entry.worktreePath, profile.workDir);
    const containerWorkDir = profile.containerWorkDir || '/app';

    // Build environment variables (later entries override earlier ones)
    // Priority: customEnv (user dashboard) < profile.env (per-profile)
    const mergedEnv: Record<string, string> = {};

    // User-defined env vars from dashboard (includes CDS_* vars from infra services)
    if (customEnv) {
      Object.assign(mergedEnv, customEnv);
    }

    // JWT
    mergedEnv['Jwt__Secret'] = this.config.jwt.secret;
    mergedEnv['Jwt__Issuer'] = this.config.jwt.issuer;

    // Inject git branch name so frontend build tools (e.g. Vite __GIT_BRANCH__) can pick it up.
    if (entry.branch) {
      mergedEnv['VITE_GIT_BRANCH'] = entry.branch;
    }

    // Detect Node.js containers by image name (node:*, *node:*, etc.)
    const isNodeContainer = /\bnode:/.test(profile.dockerImage);

    // For Node.js containers: move pnpm store outside the bind-mounted source directory.
    // Without this, pnpm creates .pnpm-store inside /app (the bind mount), and Vite's
    // chokidar watches all those files, quickly exhausting the kernel inotify limit (ENOSPC).
    // Setting PNPM_HOME=/pnpm puts the store at /pnpm/store (container overlay FS),
    // invisible to Vite's file watcher. pnpm falls back to copying instead of hard-linking,
    // which is fine for dev environments.
    if (isNodeContainer) {
      mergedEnv['PNPM_HOME'] = mergedEnv['PNPM_HOME'] || '/pnpm';
      // Move pnpm content-addressable store outside the project directory.
      // Without this, pnpm creates <project>/.pnpm-store and Vite's chokidar
      // watches all those files, exhausting the kernel inotify limit (ENOSPC).
      // pnpm reads store-dir from npm_config_store_dir (NOT "PNPM_STORE_DIR").
      // See: https://github.com/orgs/pnpm/discussions/6566
      mergedEnv['npm_config_store_dir'] = mergedEnv['npm_config_store_dir'] || '/pnpm/store';
      // Ensure pnpm binary is on PATH after corepack enable
      const currentPath = mergedEnv['PATH'] || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
      if (!currentPath.includes('/pnpm')) {
        mergedEnv['PATH'] = `/pnpm:${currentPath}`;
      }
    }

    // Profile-specific env (highest priority)
    if (profile.env) {
      Object.assign(mergedEnv, profile.env);
    }

    // Resolve ${CDS_*} env var templates in all values
    // e.g., MongoDB__ConnectionString: "mongodb://${CDS_HOST}:${CDS_MONGODB_PORT}"
    // → "mongodb://172.17.0.1:37821"
    const resolvedEnv = resolveEnvTemplates(mergedEnv, mergedEnv);

    // Write to temp file — avoids shell escaping issues with special chars
    const envFilePath = this.writeEnvFile(resolvedEnv);
    const envFlag = `--env-file "${envFilePath}"`;

    // Shared cache mounts (avoid duplicating node_modules, nuget, etc.)
    const volumeFlags: string[] = [`-v "${srcMount}":"${containerWorkDir}"`];

    if (profile.cacheMounts) {
      for (const cm of profile.cacheMounts) {
        // Ensure host path exists
        await this.shell.exec(`mkdir -p "${cm.hostPath}"`);
        volumeFlags.push(`-v "${cm.hostPath}":"${cm.containerPath}"`);
      }
    }

    try {
      const command = profile.command || '';
      if (!command) {
        throw new Error(`构建配置 "${profile.id}" 缺少 command 字段`);
      }

      onOutput?.(`── 运行: ${command} ──\n`);
      if (isNodeContainer) {
        onOutput?.(`── Node.js 容器: node_modules 已隔离到 Docker volume ──\n`);
      }
      const runCmd = [
        'docker run -d',
        `--name ${service.containerName}`,
        `--network ${this.config.dockerNetwork}`,
        `-p ${service.hostPort}:${profile.containerPort}`,
        ...volumeFlags,
        `-w ${containerWorkDir}`,
        envFlag,
        '--tmpfs /tmp',
        this.appLabels(entry.id, profile.id),
        profile.dockerImage,
        `sh -c "${command.replace(/"/g, '\\"')}"`,
      ].join(' ');

      const result = await this.shell.exec(runCmd);
      if (result.exitCode !== 0) {
        throw new Error(`启动服务 "${service.containerName}" 失败:\n${combinedOutput(result)}`);
      }

      // Phase 1: Liveness — verify the container process hasn't crashed immediately.
      // docker run -d returns immediately; the process inside may crash shortly after.
      // Poll a few times to catch early exits (e.g., ENOSPC, missing deps, syntax errors).
      await this.waitForContainerAlive(service.containerName, onOutput);
    } finally {
      this.removeEnvFile(envFilePath);
    }
  }

  /**
   * Phase 1: Liveness check — poll container status to catch early crashes.
   * Checks 3 times over ~6 seconds. If the container exits during this window,
   * it grabs the last 30 lines of logs and throws an error so deploy is marked failed.
   */
  private async waitForContainerAlive(
    containerName: string,
    onOutput?: (chunk: string) => void,
  ): Promise<void> {
    const CHECKS = 3;
    const INTERVAL_MS = 2000;

    for (let i = 0; i < CHECKS; i++) {
      await new Promise(r => setTimeout(r, INTERVAL_MS));

      const inspect = await this.shell.exec(
        `docker inspect --format="{{.State.Status}}|{{.State.ExitCode}}" ${containerName}`,
      );
      if (inspect.exitCode !== 0) {
        throw new Error(`容器 "${containerName}" 已消失`);
      }

      const [status, exitCode] = inspect.stdout.trim().split('|');

      if (status === 'running') {
        onOutput?.(`── 存活检查 ${i + 1}/${CHECKS}: 容器运行中 ──\n`);
        continue;
      }

      if (status === 'exited' || status === 'dead') {
        const logs = await this.getLogs(containerName, 30);
        throw new Error(
          `容器 "${containerName}" 启动后退出 (exit code: ${exitCode}):\n${logs}`,
        );
      }

      onOutput?.(`── 容器状态: ${status}, 等待中... ──\n`);
    }
  }

  /**
   * Phase 2 alternative: Watch container logs for a startup signal string.
   * Monitors docker logs in real-time; resolves true when the signal appears,
   * false on timeout. More reliable than HTTP probes for services that print
   * a known banner on successful startup.
   */
  async waitForStartupSignal(
    containerName: string,
    signal: string,
    onOutput?: (chunk: string) => void,
    timeoutSeconds = 300,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        onOutput?.(`── 启动信号超时 (${timeoutSeconds}s)，未检测到: "${signal}" ──\n`);
        resolve(false);
      }, timeoutSeconds * 1000);

      const child = spawn('docker', ['logs', '-f', containerName], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let resolved = false;
      const checkChunk = (data: Buffer) => {
        if (resolved) return;
        const text = data.toString();
        if (text.includes(signal)) {
          resolved = true;
          clearTimeout(timeout);
          child.kill();
          onOutput?.(`── 检测到启动信号: "${signal}" ✓ ──\n`);
          resolve(true);
        }
      };

      child.stdout?.on('data', checkChunk);
      child.stderr?.on('data', checkChunk);
      child.on('error', () => {
        if (!resolved) { clearTimeout(timeout); resolve(false); }
      });
      child.on('exit', () => {
        if (!resolved) { clearTimeout(timeout); resolve(false); }
      });
    });
  }

  async stop(containerName: string): Promise<void> {
    await this.shell.exec(`docker stop ${containerName}`);
    await this.shell.exec(`docker rm ${containerName}`);
  }

  async isRunning(containerName: string): Promise<boolean> {
    const result = await this.shell.exec(
      `docker inspect --format="{{.State.Running}}" ${containerName}`,
    );
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  async getLogs(containerName: string, tail = 500): Promise<string> {
    const result = await this.shell.exec(`docker logs --tail ${tail} ${containerName}`);
    return combinedOutput(result);
  }

  /**
   * Stream container logs via `docker logs -f`. Returns an AbortController
   * to stop the stream. Calls onData with each chunk, onClose when done.
   */
  streamLogs(
    containerName: string,
    onData: (chunk: string) => void,
    onClose: () => void,
    tail = 200,
  ): AbortController {
    const ac = new AbortController();
    const child = spawn('docker', ['logs', '-f', '--tail', String(tail), containerName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const forward = (data: Buffer) => {
      if (!ac.signal.aborted) onData(data.toString());
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('close', () => { if (!ac.signal.aborted) onClose(); });
    child.on('error', () => onClose());
    ac.signal.addEventListener('abort', () => { child.kill(); });
    return ac;
  }

  async getEnv(containerName: string): Promise<string> {
    // Use docker inspect instead of docker exec to support stopped containers
    const result = await this.shell.exec(
      `docker inspect ${containerName} --format='{{range .Config.Env}}{{println .}}{{end}}'`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`获取环境变量失败:\n${combinedOutput(result)}`);
    }
    return result.stdout;
  }

  // ── Container labels & discovery ──

  /** Docker labels applied to all CDS-managed app containers */
  private appLabels(branchId: string, profileId: string): string {
    return [
      '--label cds.managed=true',
      '--label cds.type=app',
      `--label cds.branch.id=${branchId}`,
      `--label cds.profile.id=${profileId}`,
      `--label cds.network=${this.config.dockerNetwork}`,
    ].join(' ');
  }

  /** Docker labels applied to all CDS-managed infra containers */
  private infraLabels(service: InfraService): string {
    return [
      '--label cds.managed=true',
      '--label cds.type=infra',
      `--label cds.service.id=${service.id}`,
      `--label cds.network=${this.config.dockerNetwork}`,
    ].join(' ');
  }

  /**
   * Start an infrastructure service container.
   * Uses Docker named volumes for persistence and labels for discovery.
   */
  async startInfraService(service: InfraService): Promise<void> {
    await this.ensureNetwork();

    // Remove any existing container with the same name
    await this.shell.exec(`docker rm -f ${service.containerName}`);

    // Build volume flags (named volumes + bind mounts)
    const volumeFlags = service.volumes.map(v => {
      const roSuffix = v.readOnly ? ':ro' : '';
      if (v.type === 'bind') {
        // Resolve relative paths against repo root
        const hostPath = v.name.startsWith('/') ? v.name : `${this.config.repoRoot}/${v.name}`;
        return `-v "${hostPath}":"${v.containerPath}${roSuffix}"`;
      }
      return `-v "${v.name}":"${v.containerPath}${roSuffix}"`;
    });

    // Build env flags
    const envFlags = Object.entries(service.env).map(
      ([k, v]) => `-e "${k}=${v}"`,
    );

    // Health check flags
    const healthFlags: string[] = [];
    if (service.healthCheck) {
      healthFlags.push(
        `--health-cmd="${service.healthCheck.command.replace(/"/g, '\\"')}"`,
        `--health-interval=${service.healthCheck.interval}s`,
        `--health-retries=${service.healthCheck.retries}`,
        `--health-start-period=10s`,
      );
    }

    const cmd = [
      'docker run -d',
      `--name ${service.containerName}`,
      `--network ${this.config.dockerNetwork}`,
      `-p ${service.hostPort}:${service.containerPort}`,
      ...volumeFlags,
      ...envFlags,
      ...healthFlags,
      this.infraLabels(service),
      '--restart unless-stopped',
      service.dockerImage,
    ].join(' ');

    const result = await this.shell.exec(cmd);
    if (result.exitCode !== 0) {
      throw new Error(`启动基础设施服务 "${service.containerName}" 失败:\n${combinedOutput(result)}`);
    }
  }

  /** Stop and remove an infrastructure service container */
  async stopInfraService(containerName: string): Promise<void> {
    await this.shell.exec(`docker stop ${containerName}`);
    await this.shell.exec(`docker rm ${containerName}`);
  }

  /**
   * Discover CDS-managed infra containers by Docker labels.
   * Returns a map of service.id → container status.
   */
  async discoverInfraContainers(): Promise<Map<string, { running: boolean; containerName: string }>> {
    const result = await this.shell.exec(
      `docker ps -a --filter "label=cds.managed=true" --filter "label=cds.type=infra" --filter "label=cds.network=${this.config.dockerNetwork}" --format '{{.Names}}|{{.State}}|{{.Labels}}'`,
    );

    const discovered = new Map<string, { running: boolean; containerName: string }>();
    if (result.exitCode !== 0 || !result.stdout.trim()) return discovered;

    for (const line of result.stdout.trim().split('\n')) {
      if (!line) continue;
      const [name, state, labels] = line.split('|');
      // Extract cds.service.id from labels
      const idMatch = labels?.match(/cds\.service\.id=([^,]+)/);
      if (idMatch) {
        discovered.set(idMatch[1], {
          running: state === 'running',
          containerName: name,
        });
      }
    }
    return discovered;
  }

  /**
   * Discover CDS-managed app containers by Docker labels.
   * Returns a map of "branchId/profileId" → { running, containerName }.
   */
  async discoverAppContainers(): Promise<Map<string, { running: boolean; containerName: string; branchId: string; profileId: string }>> {
    const result = await this.shell.exec(
      `docker ps -a --filter "label=cds.managed=true" --filter "label=cds.type=app" --filter "label=cds.network=${this.config.dockerNetwork}" --format '{{.Names}}|{{.State}}|{{.Labels}}'`,
    );

    const discovered = new Map<string, { running: boolean; containerName: string; branchId: string; profileId: string }>();
    if (result.exitCode !== 0 || !result.stdout.trim()) return discovered;

    for (const line of result.stdout.trim().split('\n')) {
      if (!line) continue;
      const [name, state, labels] = line.split('|');
      const branchMatch = labels?.match(/cds\.branch\.id=([^,]+)/);
      const profileMatch = labels?.match(/cds\.profile\.id=([^,]+)/);
      if (branchMatch && profileMatch) {
        const key = `${branchMatch[1]}/${profileMatch[1]}`;
        discovered.set(key, {
          running: state === 'running',
          containerName: name,
          branchId: branchMatch[1],
          profileId: profileMatch[1],
        });
      }
    }
    return discovered;
  }

  /** Check health of an infrastructure container */
  async getInfraHealth(containerName: string): Promise<'healthy' | 'unhealthy' | 'starting' | 'none'> {
    const result = await this.shell.exec(
      `docker inspect --format="{{.State.Health.Status}}" ${containerName} 2>/dev/null || echo none`,
    );
    const status = result.stdout.trim();
    if (['healthy', 'unhealthy', 'starting'].includes(status)) {
      return status as 'healthy' | 'unhealthy' | 'starting';
    }
    return 'none';
  }

  private async ensureNetwork(): Promise<void> {
    const inspect = await this.shell.exec(`docker network inspect ${this.config.dockerNetwork}`);
    if (inspect.exitCode !== 0) {
      const create = await this.shell.exec(`docker network create ${this.config.dockerNetwork}`);
      if (create.exitCode !== 0) {
        throw new Error(`创建 Docker 网络 "${this.config.dockerNetwork}" 失败:\n${combinedOutput(create)}`);
      }
    }
  }
}
