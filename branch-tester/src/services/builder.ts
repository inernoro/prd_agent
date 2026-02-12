import path from 'node:path';
import type { IShellExecutor, BtConfig } from '../types.js';

export class BuilderService {
  constructor(
    private readonly shell: IShellExecutor,
    private readonly config: BtConfig,
  ) {}

  async buildApiImage(worktreePath: string, imageName: string): Promise<string> {
    const dockerfile = path.join(worktreePath, this.config.docker.apiDockerfile);
    const context = path.join(worktreePath, 'prd-api');

    const cmd = `docker build -f "${dockerfile}" -t ${imageName} "${context}"`;
    const result = await this.shell.exec(cmd, { timeout: 600_000 });

    if (result.exitCode !== 0) {
      throw new Error(`API image build failed: ${result.stderr}`);
    }
    return result.stdout;
  }

  async buildAdminStatic(worktreePath: string, outputDir: string): Promise<string> {
    const adminDir = path.join(worktreePath, 'prd-admin');

    const installResult = await this.shell.exec('pnpm install --frozen-lockfile', {
      cwd: adminDir,
      timeout: 120_000,
    });
    if (installResult.exitCode !== 0) {
      throw new Error(`pnpm install failed: ${installResult.stderr}`);
    }

    const buildResult = await this.shell.exec('pnpm build', {
      cwd: adminDir,
      timeout: 300_000,
    });
    if (buildResult.exitCode !== 0) {
      throw new Error(`pnpm build failed: ${buildResult.stderr}`);
    }

    // Copy dist to output directory
    await this.shell.exec(`mkdir -p "${outputDir}"`);
    const distDir = path.join(adminDir, 'dist');
    const copyResult = await this.shell.exec(
      `cp -r "${distDir}/"* "${outputDir}/"`,
    );
    if (copyResult.exitCode !== 0) {
      throw new Error(`Failed to copy admin build output: ${copyResult.stderr}`);
    }

    return buildResult.stdout;
  }
}
