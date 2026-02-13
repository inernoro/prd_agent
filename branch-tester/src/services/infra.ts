import type { IShellExecutor, BtConfig } from '../types.js';

/**
 * InfraService — ensures infrastructure containers (MongoDB, Redis, Gateway)
 * are running before branch-tester starts managing branches.
 *
 * On startup:
 *   1. Check each infra container
 *   2. If any missing, run `docker compose up -d` for infra services only
 *   3. Stop the production `prdagent-api` if running (branch-tester manages its own)
 */
export class InfraService {
  private readonly infraContainers = [
    { name: 'prdagent-mongodb', service: 'mongodb', label: 'MongoDB' },
    { name: 'prdagent-redis', service: 'redis', label: 'Redis' },
    { name: 'prdagent-gateway', service: 'gateway', label: 'Gateway (Nginx)' },
  ];

  /** The production API container that conflicts with branch-tester */
  private readonly prodApiContainer = 'prdagent-api';

  constructor(
    private readonly shell: IShellExecutor,
    private readonly config: BtConfig,
  ) {}

  private async isContainerRunning(name: string): Promise<boolean> {
    const result = await this.shell.exec(
      `docker inspect --format="{{.State.Running}}" "${name}"`,
    );
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  /**
   * Ensure all infrastructure containers are running.
   * Returns a summary of what was done.
   */
  async ensure(): Promise<string[]> {
    const log: string[] = [];

    // Step 1: Check which infra containers are running
    const missing: typeof this.infraContainers = [];
    for (const c of this.infraContainers) {
      const running = await this.isContainerRunning(c.name);
      if (running) {
        log.push(`  ✓ ${c.label} (${c.name}) — running`);
      } else {
        log.push(`  ✗ ${c.label} (${c.name}) — not running`);
        missing.push(c);
      }
    }

    // Step 2: Start missing infra via docker compose
    if (missing.length > 0) {
      log.push('');
      log.push(`  Starting infrastructure via docker compose...`);

      const composeDir = this.config.repoRoot;
      const services = missing.map((c) => c.service).join(' ');
      const result = await this.shell.exec(
        `docker compose up -d ${services}`,
        { cwd: composeDir, timeout: 120_000 },
      );

      if (result.exitCode === 0) {
        log.push(`  ✓ docker compose up -d ${services} — OK`);
      } else {
        // Fallback: try docker-compose (v1)
        const v1Result = await this.shell.exec(
          `docker-compose up -d ${services}`,
          { cwd: composeDir, timeout: 120_000 },
        );
        if (v1Result.exitCode === 0) {
          log.push(`  ✓ docker-compose up -d ${services} — OK`);
        } else {
          log.push(`  ✗ Failed to start infrastructure.`);
          log.push(`    Please run manually: cd ${composeDir} && docker compose up -d ${services}`);
        }
      }

      // Verify they came up (brief wait for container startup)
      await new Promise((r) => setTimeout(r, 2000));
      for (const c of missing) {
        const running = await this.isContainerRunning(c.name);
        log.push(running
          ? `  ✓ ${c.label} (${c.name}) — started`
          : `  ✗ ${c.label} (${c.name}) — failed to start`);
      }
    }

    // Step 3: Stop production API container if running (branch-tester manages its own)
    const prodRunning = await this.isContainerRunning(this.prodApiContainer);
    if (prodRunning) {
      log.push('');
      log.push(`  Stopping production API (${this.prodApiContainer}) — branch-tester will manage API containers`);
      await this.shell.exec(`docker stop ${this.prodApiContainer}`);
      log.push(`  ✓ ${this.prodApiContainer} stopped`);
    }

    return log;
  }
}
