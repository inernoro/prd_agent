import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IShellExecutor, CdsConfig, BuildProfile, BranchEntry, ServiceState, InfraService } from '../types.js';
import { combinedOutput } from '../types.js';

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

    // Build environment variables (later entries override earlier ones)
    // Priority: customEnv (user dashboard) < profile.env (per-profile)
    // Only user-configured env vars are sent — no auto-detected business vars.
    const mergedEnv: Record<string, string> = {};

    // User-defined env vars from dashboard
    if (customEnv) {
      Object.assign(mergedEnv, customEnv);
    }

    // JWT
    mergedEnv['Jwt__Secret'] = this.config.jwt.secret;
    mergedEnv['Jwt__Issuer'] = this.config.jwt.issuer;

    // Inject git branch name so frontend build tools (e.g. Vite __GIT_BRANCH__) can pick it up.
    // The Docker container mounts only the workDir subdirectory (no .git), so
    // `git rev-parse --abbrev-ref HEAD` would fail inside the container.
    if (entry.branch) {
      mergedEnv['VITE_GIT_BRANCH'] = entry.branch;
    }

    // Profile-specific env (highest priority)
    if (profile.env) {
      Object.assign(mergedEnv, profile.env);
    }

    // Write to temp file — avoids shell escaping issues with special chars
    const envFilePath = this.writeEnvFile(mergedEnv);
    const envFlag = `--env-file "${envFilePath}"`;

    // Shared cache mounts (avoid duplicating node_modules, nuget, etc.)
    const volumeFlags: string[] = [`-v "${srcMount}":/src`];
    if (profile.cacheMounts) {
      for (const cm of profile.cacheMounts) {
        // Ensure host path exists
        await this.shell.exec(`mkdir -p "${cm.hostPath}"`);
        volumeFlags.push(`-v "${cm.hostPath}":"${cm.containerPath}"`);
      }
    }

    try {
      // Install step (if defined)
      if (profile.installCommand) {
        onOutput?.(`── 安装: ${profile.installCommand} ──\n`);
        const installCmd = [
          'docker run --rm',
          `--network ${this.config.dockerNetwork}`,
          ...volumeFlags,
          '-w /src',
          envFlag,
          '--tmpfs /tmp',
          profile.dockerImage,
          `sh -c "${profile.installCommand.replace(/"/g, '\\"')}"`,
        ].join(' ');

        const installResult = await this.shell.exec(installCmd, {
          timeout: profile.buildTimeout ?? 600_000,
          onData: onOutput,
        });
        if (installResult.exitCode !== 0) {
          throw new Error(`安装失败:\n${combinedOutput(installResult)}`);
        }
      }

      // Build step (if defined)
      if (profile.buildCommand) {
        onOutput?.(`\n── 构建: ${profile.buildCommand} ──\n`);
        const buildCmd = [
          'docker run --rm',
          `--network ${this.config.dockerNetwork}`,
          ...volumeFlags,
          '-w /src',
          envFlag,
          '--tmpfs /tmp',
          profile.dockerImage,
          `sh -c "${profile.buildCommand.replace(/"/g, '\\"')}"`,
        ].join(' ');

        const buildResult = await this.shell.exec(buildCmd, {
          timeout: profile.buildTimeout ?? 600_000,
          onData: onOutput,
        });
        if (buildResult.exitCode !== 0) {
          throw new Error(`构建失败:\n${combinedOutput(buildResult)}`);
        }
      }

      // Run step — start the service in the background
      onOutput?.(`\n── 运行: ${profile.runCommand} ──\n`);
      const runCmd = [
        'docker run -d',
        `--name ${service.containerName}`,
        `--network ${this.config.dockerNetwork}`,
        `-p ${service.hostPort}:${profile.containerPort}`,
        ...volumeFlags,
        '-w /src',
        envFlag,
        '--tmpfs /tmp',
        profile.dockerImage,
        `sh -c "${profile.runCommand.replace(/"/g, '\\"')}"`,
      ].join(' ');

      const result = await this.shell.exec(runCmd);
      if (result.exitCode !== 0) {
        throw new Error(`启动服务 "${service.containerName}" 失败:\n${combinedOutput(result)}`);
      }
    } finally {
      this.removeEnvFile(envFilePath);
    }
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

  async getLogs(containerName: string, tail = 100): Promise<string> {
    const result = await this.shell.exec(`docker logs --tail ${tail} ${containerName}`);
    return combinedOutput(result);
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

  // ── Infrastructure service management ──

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

    // Build volume flags (Docker named volumes)
    const volumeFlags = service.volumes.map(
      v => `-v "${v.name}":"${v.containerPath}"`,
    );

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
