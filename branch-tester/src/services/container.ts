import path from 'node:path';
import type { IShellExecutor, BranchEntry, BtConfig, RunFromSourceOptions } from '../types.js';
import { combinedOutput } from '../types.js';

export class ContainerService {
  constructor(
    private readonly shell: IShellExecutor,
    private readonly config: BtConfig,
  ) {}

  /** Start a deploy container from a pre-built Docker image */
  async start(entry: BranchEntry): Promise<void> {
    const { mongodb, redis, jwt, docker } = this.config;

    await this.ensureNetwork(docker.network);

    const envVars = [
      `ASPNETCORE_ENVIRONMENT=Production`,
      `ASPNETCORE_URLS=http://+:8080`,
      `MongoDB__ConnectionString=mongodb://${mongodb.containerHost}:${mongodb.port}`,
      `MongoDB__DatabaseName=${entry.dbName}`,
      `Redis__ConnectionString=${redis.connectionString}`,
      `Jwt__Secret=${jwt.secret}`,
      `Jwt__Issuer=${jwt.issuer}`,
    ];

    const envFlags = envVars.map((e) => `-e ${e}`).join(' ');

    const cmd = [
      'docker run -d',
      `--name ${entry.containerName}`,
      `--network ${docker.network}`,
      envFlags,
      '--read-only',
      '--tmpfs /tmp',
      entry.imageName,
    ].join(' ');

    const result = await this.shell.exec(cmd);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start container "${entry.containerName}":\n${combinedOutput(result)}`);
    }
  }

  /** Run a container from source code (mount worktree + SDK image + dotnet run) */
  async runFromSource(entry: BranchEntry, options: RunFromSourceOptions): Promise<void> {
    const { mongodb, redis, jwt, docker } = this.config;
    const containerName = entry.runContainerName!;

    await this.ensureNetwork(docker.network);

    const srcMount = path.join(entry.worktreePath, options.sourceDir);

    const envVars = [
      `ASPNETCORE_ENVIRONMENT=Development`,
      `ASPNETCORE_URLS=http://+:8080`,
      `MongoDB__ConnectionString=mongodb://${mongodb.containerHost}:${mongodb.port}`,
      `MongoDB__DatabaseName=${entry.dbName}`,
      `Redis__ConnectionString=${redis.connectionString}`,
      `Jwt__Secret=${jwt.secret}`,
      `Jwt__Issuer=${jwt.issuer}`,
    ];

    const envFlags = envVars.map((e) => `-e ${e}`).join(' ');

    const cmd = [
      'docker run -d',
      `--name ${containerName}`,
      `--network ${docker.network}`,
      `-p ${options.hostPort}:8080`,
      `-v ${srcMount}:/src`,
      `-w /src`,
      envFlags,
      '--tmpfs /tmp',
      options.baseImage,
      options.command,
    ].join(' ');

    const result = await this.shell.exec(cmd);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to run container "${containerName}":\n${combinedOutput(result)}`);
    }
  }

  private async ensureNetwork(network: string): Promise<void> {
    const inspect = await this.shell.exec(`docker network inspect ${network}`);
    if (inspect.exitCode !== 0) {
      const create = await this.shell.exec(`docker network create ${network}`);
      if (create.exitCode !== 0) {
        throw new Error(`Failed to create Docker network "${network}":\n${combinedOutput(create)}`);
      }
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

  async removeImage(imageName: string): Promise<void> {
    await this.shell.exec(`docker rmi ${imageName}`);
  }
}
