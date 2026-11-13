import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { BACKUP_RETENTION_PROGRAM } from '../src/services/backup-retention-program.js';
import { OwnedResourceLifecycle } from '../src/services/owned-resource-task.js';
import { ShellExecutor } from '../src/services/shell-executor.js';
import { shellQuoteArg } from '../src/services/secure-database-cli.js';

// This test deliberately needs a private, file-backed VM with complete /proc
// and Docker storage visibility. Never run it against a production daemon.
assert.equal(process.env.CDS_NATIVE_RESOURCE_DRILL, '1');assert.equal(process.getuid?.(), 0);
assert.equal((await fs.readFile('/sys/block/vda/serial', 'utf8')).trim(), 'codex-cow-fixture-01');
const shell = new ShellExecutor();
const info = await shell.exec('docker info --format \'{{json .}}\'');
assert.equal(info.exitCode, 0);assert.equal(JSON.parse(info.stdout).DockerRootDir, '/data/docker');
const lifecycle = new OwnedResourceLifecycle({ shell, catalog: '/data/backup-mount-catalog', workspaceBase: '/data/backup-mount-workspaces', instanceId: 'private-backup-mount-drill', reserveBytes: 32 * 1024 ** 2, maxBytes: 256 * 1024 ** 2, projectBudgetBytes: 4 * 1024 ** 3, globalBudgetBytes: 6 * 1024 ** 3 });
const projectId = 'backup-mount-' + randomUUID();
const begin = () => lifecycle.begin({ projectId, owner: 'native-backup-mount-drill', createdBy: 'private-file-backed-vm', ttlSeconds: 3600, dataDisposition: 'ephemeral-test' });
const fixture = await begin();
const directory = path.join(fixture.handle.workspace, 'backups');await fs.mkdir(directory);
const archive = path.join(directory, 'synthetic-old.gz'), bytes = gzipSync(randomBytes(4 * 1024 ** 2));
const checksum = createHash('sha256').update(bytes).digest('hex');
await fs.writeFile(archive, bytes);const old = new Date(Date.now() - 20 * 86400000);await fs.utimes(archive, old, old);
let disconnected = false;
const request = async (action: string, extra: Record<string, unknown> = {}) => {
  const result = await shell.exec('python3 -c ' + shellQuoteArg(BACKUP_RETENTION_PROGRAM), {
    stdin: JSON.stringify({ action, directories: [directory], catalog: path.join(directory, '.cds-retention'), instanceId: 'native-backup-fixture', maxRemovals: 8, ...extra }),
    timeout: 305000, env: disconnected ? { DOCKER_HOST: 'unix://' + fixture.handle.workspace + '/missing.sock' } : undefined,
  });
  assert.equal(result.exitCode, 0, result.stderr);return JSON.parse(result.stdout);
};
await request('register', { path: archive, projectId, serviceId: 'synthetic-only', origin: 'historical', disposition: 'reproducible-artifact', attestedBy: 'private-fixture-owner', dispositionReason: 'Known synthetic random bytes, never a business backup' });
assert.equal((await request('preview')).candidates.length, 1);
const protectedBy = async (source: string, label: string) => {
  const task = await begin();
  const container = await task.createContainer({ image: 'alpine:3.21', role: label, command: ['sleep', '3600'], mounts: [{ kind: 'bind', source, target: '/protected', readOnly: true }] });
  const running = await request('preview');assert(running.held.some((row: any) => row.reason === 'running-or-stopped-container-mount'));
  const stop = await shell.exec('docker stop --time 1 ' + shellQuoteArg(container.identity));assert.equal(stop.exitCode, 0, stop.stderr);
  const report = await request('reconcile');assert.deepEqual(report.removed, []);assert(report.held.some((row: any) => row.reason === 'running-or-stopped-container-mount'));
  assert.equal(createHash('sha256').update(await fs.readFile(archive)).digest('hex'), checksum);
  const finished: any = await task.finish('completed');assert(finished.removed.some((row: any) => row.taskId === task.handle.taskId && row.kind === 'workspace'), JSON.stringify(finished));
};
// The first native plan predates these real containers. Both file and ancestor
// bind mounts, including stopped containers, must invalidate that plan.
await protectedBy(archive, 'backup-file-reader');
await protectedBy(directory, 'backup-directory-reader');
disconnected = true;
const unknown = await request('reconcile');assert.equal(unknown.scanStatus, 'partial');assert.deepEqual(unknown.removed, []);
assert(unknown.held.some((row: any) => row.reason === 'container-or-stopped-container-references-unconfirmed'));disconnected = false;
const fd = await fs.open(archive, 'r');
try { assert((await request('reconcile')).held.some((row: any) => row.reason === 'file-still-open')); } finally { await fd.close(); }
const removed = await request('reconcile');assert.deepEqual(removed.removed, [archive]);
assert(removed.filesystems[0].netAvailableBytesDelta > 3 * 1024 ** 2);
const continuous = await fs.readFile('/data/continuous-deploy-result.json', 'utf8').then(JSON.parse).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return {};throw error; });
const result = { provenance: 'integration-live', scope: 'Unmodified native backup worker in private XFS/Docker VM, complete proc and all running/stopped container references',
  fileAndAncestorBindProtected: true, stoppedContainerAfterPlanProtected: true, realDockerQueryFailureRetained: true, nativeOpenDescriptorProtected: true,
  checksumPreservedUntilUnreferenced: true, filesystemNetAvailableBytesDelta: removed.filesystems[0].netAvailableBytesDelta,
  earlierContinuousBaseline: { baselineFiveEndedTasksIncrementBytes: continuous.baselineFiveEndedTasksIncrementBytes ?? null } };
await fs.writeFile('/data/backup-mount-integration-result.json', JSON.stringify(result));
await fixture.finish('completed');console.log('BACKUP_MOUNT_NATIVE_RESULT', JSON.stringify(result));console.log('DRILL_COMPLETE');
