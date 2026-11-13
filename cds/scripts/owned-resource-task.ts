import path from 'node:path';
import { OwnedResourceLifecycle } from '../src/services/owned-resource-task.js';
import { ShellExecutor } from '../src/services/shell-executor.js';
import { diskGuard } from '../src/services/disk-guard.js';
import { defaultDiskUsage } from '../src/services/janitor.js';
import { fileURLToPath } from 'node:url';

const argument = (key: string) => { const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1]; };
const repo = path.resolve(argument('--repo') || fileURLToPath(new URL('../..', import.meta.url)));
const resourceRoot = path.resolve(process.env.CDS_RESOURCE_ROOT || '/var/lib/cds-resource-lifecycle');
const workspaceBase = path.resolve(argument('--workspace-base') || path.join(resourceRoot, 'workspaces'));
const lifecycle = new OwnedResourceLifecycle({ shell: new ShellExecutor(), workspaceBase,
  catalog: path.resolve(argument('--catalog') || path.join(resourceRoot, 'catalog')),
  instanceId: argument('--instance') || 'local-acceptance-runner' });
const mode = process.argv[2];
if (mode === 'preview' || mode === 'reconcile') {
  process.stdout.write(JSON.stringify(await lifecycle.inspect(mode === 'preview')) + '\n');
} else if (mode === 'run') {
  const projectId = argument('--project');const owner = argument('--owner');const delimiter = process.argv.indexOf('--');
  if (!projectId || !owner || delimiter < 0 || !process.argv.includes('--ephemeral-test-data')) throw new Error('需要明确项目、任务所有者、--ephemeral-test-data，以及 -- 后的验收命令。');
  diskGuard.setProbe(() => defaultDiskUsage(path.dirname(workspaceBase)));
  const ttlSeconds = Number(argument('--ttl-seconds') || 600);
  const task = await lifecycle.begin({ projectId, owner, createdBy: 'owned-resource-task', ttlSeconds, dataDisposition: 'ephemeral-test' });
  process.stdout.write(JSON.stringify({ taskId: task.handle.taskId, workspace: task.handle.workspace, leaseUntil: task.handle.leaseUntil }) + '\n');
  let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';let cancelled = false;
  const cancel = () => { cancelled = true;outcome = 'cancelled';void task.finish(outcome).finally(() => { process.exitCode = 130; }); };
  process.once('SIGINT', cancel);process.once('SIGTERM', cancel);
  try { const code = await task.run(process.argv.slice(delimiter + 1), { cwd: repo, ttlSeconds });outcome = cancelled ? 'cancelled' : code === 0 ? 'completed' : 'failed';process.exitCode = cancelled ? 130 : code; }
  finally { process.removeListener('SIGINT', cancel);process.removeListener('SIGTERM', cancel);process.stdout.write(JSON.stringify(await task.finish(outcome)) + '\n'); }
} else throw new Error('用法：owned-resource-task.ts run|preview|reconcile；run 必须声明项目、所有者和可退役的测试数据。');
