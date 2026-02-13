import type { IShellExecutor, BranchEntry, BtConfig, StartOptions } from '../types.js';
import { combinedOutput } from '../types.js';

export class ContainerService {
  constructor(
    private readonly shell: IShellExecutor,
    private readonly config: BtConfig,
  ) {}

  async start(entry: BranchEntry, options?: StartOptions): Promise<void> {
    const { mongodb, redis, jwt, docker } = this.config;

    // Ensure Docker network exists
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

    const parts = [
      'docker run -d',
      `--name ${entry.containerName}`,
      `--network ${docker.network}`,
      envFlags,
    ];

    // Quick-run: expose port to host
    if (options?.exposePort) {
      parts.push(`-p ${options.exposePort}:8080`);
    }

    // Quick-run: mount admin static files as wwwroot
    if (options?.volumes) {
      for (const vol of options.volumes) {
        parts.push(`-v ${vol}`);
      }
    }

    parts.push('--read-only', '--tmpfs /tmp', entry.imageName);

    const cmd = parts.join(' ');
    const result = await this.shell.exec(cmd);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to start container "${entry.containerName}":\n${combinedOutput(result)}`);
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
