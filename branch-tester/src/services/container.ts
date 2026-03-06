import path from 'node:path';
import type { IShellExecutor, CdsConfig, BuildProfile, BranchEntry, ServiceState } from '../types.js';
import { combinedOutput } from '../types.js';

export class ContainerService {
  constructor(
    private readonly shell: IShellExecutor,
    private readonly config: CdsConfig,
  ) {}

  /**
   * Run a branch service from source using a build profile.
   * Mounts the worktree + shared cache volumes into a Docker container.
   */
  async runService(
    entry: BranchEntry,
    profile: BuildProfile,
    service: ServiceState,
    onOutput?: (chunk: string) => void,
  ): Promise<void> {
    await this.ensureNetwork();

    // Remove any existing container
    await this.shell.exec(`docker rm -f ${service.containerName}`);

    const srcMount = path.join(entry.worktreePath, profile.workDir);

    // Build environment variables
    const envVars: string[] = [];

    // Shared env from config (MongoDB, Redis, etc.)
    for (const [key, val] of Object.entries(this.config.sharedEnv)) {
      envVars.push(`${key}=${val}`);
    }

    // JWT
    envVars.push(`Jwt__Secret=${this.config.jwt.secret}`);
    envVars.push(`Jwt__Issuer=${this.config.jwt.issuer}`);

    // Profile-specific env
    if (profile.env) {
      for (const [key, val] of Object.entries(profile.env)) {
        envVars.push(`${key}=${val}`);
      }
    }

    const envFlags = envVars.map(e => `-e "${e}"`).join(' ');

    // Shared cache mounts (avoid duplicating node_modules, nuget, etc.)
    const volumeFlags: string[] = [`-v "${srcMount}":/src`];
    if (profile.cacheMounts) {
      for (const cm of profile.cacheMounts) {
        // Ensure host path exists
        await this.shell.exec(`mkdir -p "${cm.hostPath}"`);
        volumeFlags.push(`-v "${cm.hostPath}":"${cm.containerPath}"`);
      }
    }

    // Install step (if defined)
    if (profile.installCommand) {
      onOutput?.(`── Install: ${profile.installCommand} ──\n`);
      const installCmd = [
        'docker run --rm',
        `--network ${this.config.dockerNetwork}`,
        ...volumeFlags,
        '-w /src',
        envFlags,
        '--tmpfs /tmp',
        profile.dockerImage,
        `sh -c "${profile.installCommand.replace(/"/g, '\\"')}"`,
      ].join(' ');

      const installResult = await this.shell.exec(installCmd, {
        timeout: profile.buildTimeout ?? 600_000,
        onData: onOutput,
      });
      if (installResult.exitCode !== 0) {
        throw new Error(`Install failed:\n${combinedOutput(installResult)}`);
      }
    }

    // Build step (if defined)
    if (profile.buildCommand) {
      onOutput?.(`\n── Build: ${profile.buildCommand} ──\n`);
      const buildCmd = [
        'docker run --rm',
        `--network ${this.config.dockerNetwork}`,
        ...volumeFlags,
        '-w /src',
        envFlags,
        '--tmpfs /tmp',
        profile.dockerImage,
        `sh -c "${profile.buildCommand.replace(/"/g, '\\"')}"`,
      ].join(' ');

      const buildResult = await this.shell.exec(buildCmd, {
        timeout: profile.buildTimeout ?? 600_000,
        onData: onOutput,
      });
      if (buildResult.exitCode !== 0) {
        throw new Error(`Build failed:\n${combinedOutput(buildResult)}`);
      }
    }

    // Run step — start the service in the background
    onOutput?.(`\n── Run: ${profile.runCommand} ──\n`);
    const runCmd = [
      'docker run -d',
      `--name ${service.containerName}`,
      `--network ${this.config.dockerNetwork}`,
      `-p ${service.hostPort}:${profile.containerPort}`,
      ...volumeFlags,
      '-w /src',
      envFlags,
      '--tmpfs /tmp',
      profile.dockerImage,
      `sh -c "${profile.runCommand.replace(/"/g, '\\"')}"`,
    ].join(' ');

    const result = await this.shell.exec(runCmd);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to run service "${service.containerName}":\n${combinedOutput(result)}`);
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
        throw new Error(`Failed to create Docker network "${this.config.dockerNetwork}":\n${combinedOutput(create)}`);
      }
    }
  }
}
