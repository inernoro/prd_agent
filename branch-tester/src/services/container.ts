import type { IShellExecutor, BranchEntry, BtConfig } from '../types.js';

export class ContainerService {
  constructor(
    private readonly shell: IShellExecutor,
    private readonly config: BtConfig,
  ) {}

  async start(entry: BranchEntry): Promise<void> {
    const { mongodb, redis, jwt, docker } = this.config;

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
      throw new Error(`Failed to start container "${entry.containerName}": ${result.stderr}`);
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
