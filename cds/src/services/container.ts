import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IShellExecutor, CdsConfig, BuildProfile, BranchEntry, ServiceState } from '../types.js';
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
    // Priority: sharedEnv (auto) < customEnv (user dashboard) < profile.env (per-profile)
    const mergedEnv: Record<string, string> = {
      ...this.config.sharedEnv,
    };

    // User-defined env vars from dashboard (override auto-detected)
    if (customEnv) {
      Object.assign(mergedEnv, customEnv);
    }

    // JWT
    mergedEnv['Jwt__Secret'] = this.config.jwt.secret;
    mergedEnv['Jwt__Issuer'] = this.config.jwt.issuer;

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
