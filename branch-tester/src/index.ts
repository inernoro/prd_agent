import path from 'node:path';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { ShellExecutor } from './services/shell-executor.js';
import { StateService } from './services/state.js';
import { WorktreeService } from './services/worktree.js';
import { ContainerService } from './services/container.js';
import { SwitcherService } from './services/switcher.js';
import { BuilderService } from './services/builder.js';
import { InfraService } from './services/infra.js';

const configPath = process.argv[2] || undefined;
const config = loadConfig(configPath);

const shell = new ShellExecutor();

// ── Ensure infrastructure (MongoDB, Redis, Gateway) is running ──
const infraService = new InfraService(shell, config);
console.log('\n  Checking infrastructure...');
const infraLog = await infraService.ensure();
infraLog.forEach((line) => console.log(line));
console.log('');

const stateFile = path.join(config.repoRoot, '.bt', 'state.json');
const stateService = new StateService(stateFile);
stateService.load();

const worktreeService = new WorktreeService(shell, config.repoRoot);
const containerService = new ContainerService(shell, config);
const switcherService = new SwitcherService(shell, {
  confDir: path.join(config.repoRoot, config.deployDir, 'nginx', 'conf.d'),
  distPath: path.join(config.repoRoot, config.deployDir, 'web', 'dist'),
  gatewayContainerName: config.gateway.containerName,
});
const builderService = new BuilderService(shell, config);

const app = createServer({
  stateService,
  worktreeService,
  containerService,
  switcherService,
  builderService,
  shell,
  config,
});

const port = config.dashboard.port;

app.listen(port, () => {
  console.log(`\n  Branch Tester Dashboard`);
  console.log(`  ──────────────────────`);
  console.log(`  Dashboard:  http://localhost:${port}`);
  console.log(`  Gateway:    http://localhost:${config.gateway.port}`);
  console.log(`  State file: ${stateFile}`);
  console.log(`  Repo root:  ${config.repoRoot}`);
  console.log('');
});
