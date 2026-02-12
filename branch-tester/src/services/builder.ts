import path from 'node:path';
import type { IShellExecutor, BtConfig } from '../types.js';

export class BuilderService {
  constructor(
    private readonly shell: IShellExecutor,
    private readonly config: BtConfig,
  ) {}

  /** Merge stdout + stderr — Docker BuildKit / pnpm may write to either stream */
  private static combinedOutput(result: { stdout: string; stderr: string }): string {
    return [result.stdout, result.stderr].filter(Boolean).join('\n');
  }

  async buildApiImage(worktreePath: string, imageName: string): Promise<string> {
    const dockerfile = path.join(worktreePath, this.config.docker.apiDockerfile);
    const context = path.join(worktreePath, 'prd-api');

    const cmd = `docker build -f "${dockerfile}" -t ${imageName} "${context}"`;
    const result = await this.shell.exec(cmd, { timeout: 600_000 });

    if (result.exitCode !== 0) {
      throw new Error(`API image build failed:\n${BuilderService.combinedOutput(result)}`);
    }
    return BuilderService.combinedOutput(result);
  }

  async buildAdminStatic(worktreePath: string, outputDir: string): Promise<string> {
    const adminDir = path.join(worktreePath, 'prd-admin');

    const installResult = await this.shell.exec('pnpm install --frozen-lockfile', {
      cwd: adminDir,
      timeout: 120_000,
    });
    if (installResult.exitCode !== 0) {
      throw new Error(`pnpm install failed:\n${BuilderService.combinedOutput(installResult)}`);
    }

    const buildResult = await this.shell.exec('pnpm build', {
      cwd: adminDir,
      timeout: 300_000,
    });
    if (buildResult.exitCode !== 0) {
      throw new Error(`pnpm build failed:\n${BuilderService.combinedOutput(buildResult)}`);
    }

    // Copy dist to output directory
    await this.shell.exec(`mkdir -p "${outputDir}"`);
    const distDir = path.join(adminDir, 'dist');
    const copyResult = await this.shell.exec(
      `cp -r "${distDir}/"* "${outputDir}/"`,
    );
    if (copyResult.exitCode !== 0) {
      throw new Error(`Failed to copy admin build output:\n${BuilderService.combinedOutput(copyResult)}`);
    }

    return BuilderService.combinedOutput(buildResult);
  }
}
