import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { BACKUP_RETENTION_PROGRAM } from '../src/services/backup-retention-program.js';
import { OwnedResourceLifecycle } from '../src/services/owned-resource-task.js';
import { ShellExecutor } from '../src/services/shell-executor.js';
import { shellQuoteArg } from '../src/services/secure-database-cli.js';
import { DEFAULT_KEEP_COUNT, DEFAULT_KEEP_DAYS, buildRedisBackupProbeScript, buildRedisSnapshotCopyArgv, buildRedisRestorePlan } from '../src/services/infra-backup-schedule.js';

// This test deliberately needs a private, file-backed VM with complete /proc
// and Docker storage visibility. Never run it against a production daemon.
assert.equal(process.env.CDS_NATIVE_RESOURCE_DRILL, '1');assert.equal(process.getuid?.(), 0);
assert.equal((await fs.readFile('/sys/block/vda/serial', 'utf8')).trim(), 'codex-cow-fixture-01');
const shell = new ShellExecutor();
const executeNative = shell.exec.bind(shell);
shell.exec = async (command, options) => {
  const result = await executeNative(command, options);
  if (result.exitCode && command.startsWith('python3 ')) console.error('NATIVE_BACKUP_BOUNDARY_FAILURE', result.stderr.split('\n').filter(line => line.startsWith('ValueError:')).at(-1) || 'native operation unconfirmed');
  return result;
};
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
    stdin: JSON.stringify({ action, directories: [directory], catalog: path.join(directory, '.cds-retention'), instanceId: 'native-backup-fixture', automaticPolicy: { keepCount: DEFAULT_KEEP_COUNT, keepDays: DEFAULT_KEEP_DAYS }, maxRemovals: 8, ...extra }),
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
// Synthetic exports of one declared fixture source: exercise the actual native
// count policy and fresh revalidation across independent worker processes.
const automatic: string[] = [];
for (let index = 0; index < DEFAULT_KEEP_COUNT + 2; index++) {
  const file = path.join(directory, `complete-${index}.gz`);await fs.writeFile(file, gzipSync(randomBytes(128 * 1024)));
  const time = new Date(Date.now() - index * 60000);await fs.utimes(file, time, time);
  await request('register', { path: file, projectId, serviceId: 'synthetic-auto-source', origin: 'automatic', sourceFingerprint: 'a'.repeat(64), sourceComplete: true });automatic.push(file);
}
const countPlan = await request('preview');assert.deepEqual(countPlan.candidates.map((row: any) => row.path).sort(), automatic.slice(DEFAULT_KEEP_COUNT).sort());
const bounded = await request('reconcile');assert.deepEqual(bounded.removed.sort(), automatic.slice(DEFAULT_KEEP_COUNT).sort());
assert.equal((await request('preview')).candidates.length, 0);
for (const file of automatic.slice(0, DEFAULT_KEEP_COUNT)) assert((await fs.stat(file)).isFile());
assert(bounded.filesystems[0].netAvailableBytesDelta > 128 * 1024);
// Redis must stream into the already registered inode, including while the
// source is stopped for restore. All data and volumes belong to this fixture.
const native = async (args: string[]) => {
  const result = await shell.exec(args.map(shellQuoteArg).join(' '), { timeout: 120000 });
  assert.equal(result.exitCode, 0, result.stderr);return result.stdout.trim();
};
await native(['docker', 'load', '-i', '/redis.tar']);
const sourceVolume = await fixture.createVolume('synthetic-redis-source');
const sourceRedis = await fixture.createContainer({ image: 'redis:7-alpine', role: 'synthetic-redis-source',
  command: ['redis-server', '--appendonly', 'no', '--dbfilename', 'current.rdb'], mounts: [{ kind: 'volume', source: sourceVolume.identity, target: '/data' }] });
const redisReady = async (identity: string, owner = fixture) => {
  const until = Date.now() + 30000;
  while (true) {
    const value = await owner.exec(identity, ['redis-cli', 'PING']);if (value.exitCode === 0 && value.stdout.trim() === 'PONG')return;
    if (Date.now() > until)throw new Error('Synthetic Redis did not become ready');await new Promise(resolve => setTimeout(resolve, 100));
  }
};
await redisReady(sourceRedis.identity);
const keys = Array.from({ length: 64 }, (_, i) => 'fixture-key-' + i), values = keys.map(key => 'value-' + key);
const commands = keys.map((key, i) => ['SET', key, values[i]].map(v => '$' + Buffer.byteLength(v) + '\r\n' + v + '\r\n').join('')).map(v => '*3\r\n' + v).join('');
const seeded = await fixture.exec(sourceRedis.identity, ['redis-cli', '--pipe'], commands);assert.equal(seeded.exitCode, 0, seeded.stderr);assert(seeded.stdout.includes('errors: 0'));
const probe = await fixture.exec(sourceRedis.identity, ['sh', '-s'], buildRedisBackupProbeScript());assert.equal(probe.exitCode, 0, probe.stderr);
const rdbPath = probe.stdout.trim().split('\n').at(-1)!;assert.equal(rdbPath, '/data/current.rdb');
const sourceFingerprint = (await request('source', { containerName: sourceRedis.identity })).sourceFingerprint;assert(/^[a-f0-9]{64}$/.test(sourceFingerprint));
const redisOutput = async (name: string) => {
  const round = path.join(directory, '.tmp', 'redis-' + randomUUID());await fs.mkdir(round, { recursive: true, mode: 0o700 });const file = path.join(round, name + '.rdb');
  await request('output', { path: file, projectId, serviceId: 'synthetic-redis', sourceFingerprint, disposition: 'business-backup' });
  return { file, before: await fs.stat(file, { bigint: true }) };
};
const promoteRedis = async (output: Awaited<ReturnType<typeof redisOutput>>, name: string, origin: string) => {
  const after = await fs.stat(output.file, { bigint: true });assert.equal(after.ino, output.before.ino);assert.equal(after.birthtimeNs, output.before.birthtimeNs);
  const final = path.join(directory, name + '.rdb');await request('promote-output', { path: output.file, destination: final });
  const registration = await request('register', { path: final, projectId, serviceId: 'synthetic-redis',
    ...(origin === 'automatic' ? { sourceFingerprint, sourceComplete: true } : {}), requireManagedOutput: true, origin, disposition: 'business-backup' });
  if (origin !== 'automatic')assert.equal(registration.receipt.sourceFingerprint, 'unconfirmed');return final;
};
const automaticRedis = await redisOutput('automatic');await native(buildRedisSnapshotCopyArgv(sourceRedis.identity, rdbPath, automaticRedis.file));
const automaticRdb = await promoteRedis(automaticRedis, 'redis-automatic', 'automatic');
assert.equal((await fs.readFile(automaticRdb)).subarray(0, 5).toString(), 'REDIS');
const changed = await fixture.exec(sourceRedis.identity, ['redis-cli', 'SET', 'after-automatic', 'pre-restore-state']);assert.equal(changed.exitCode, 0);
const preRestore = await redisOutput('pre-restore');let preRdb = '';
for (const step of buildRedisRestorePlan({ containerName: sourceRedis.identity, rdbPath, uploadPath: automaticRdb, preBackupPath: preRestore.file })) {
  await native(step.argv);
  if (step.id === 'save-current')preRdb = await promoteRedis(preRestore, 'redis-pre-restore', 'pre-restore');
}
await redisReady(sourceRedis.identity);
assert.equal((await fixture.exec(sourceRedis.identity, ['redis-cli', 'DBSIZE'])).stdout.trim(), '64');
assert.deepEqual((await fixture.exec(sourceRedis.identity, ['redis-cli', '--raw', 'MGET', ...keys])).stdout.trim().split('\n'), values);
// An independent recovery gets its own unchanged 256 MiB task envelope. Two
// 150 MiB log peak reservations must not bypass one task's existing budget.
const recoveryTask = await begin();
const recoveryVolume = await recoveryTask.createVolume('synthetic-redis-independent-recovery');
const recovery = await recoveryTask.createContainer({ image: 'redis:7-alpine', role: 'synthetic-redis-independent-recovery',
  command: ['redis-server', '--appendonly', 'no', '--dbfilename', 'current.rdb'], mounts: [{ kind: 'volume', source: recoveryVolume.identity, target: '/data' }] });
await redisReady(recovery.identity, recoveryTask);await native(['docker', 'stop', recovery.identity]);await native(['docker', 'cp', preRdb, recovery.identity + ':' + rdbPath]);await native(['docker', 'start', recovery.identity]);await redisReady(recovery.identity, recoveryTask);
assert.equal((await recoveryTask.exec(recovery.identity, ['redis-cli', 'DBSIZE'])).stdout.trim(), '65');
assert.deepEqual((await recoveryTask.exec(recovery.identity, ['redis-cli', '--raw', 'MGET', ...keys])).stdout.trim().split('\n'), values);
assert.equal((await recoveryTask.exec(recovery.identity, ['redis-cli', '--raw', 'GET', 'after-automatic'])).stdout.trim(), 'pre-restore-state');
await recoveryTask.finish('completed');
const redisProof = { syntheticKeys: 64, automaticRegisteredBirthPreserved: true, stoppedPreRestoreRegisteredBirthPreserved: true,
  outputsPromotedAndRegistered: true, automatic64RecordsRestored: true, preRestore65RecordsIndependentlyRecovered: true,
  preRestoreLineageRemainsUnconfirmedAndProtected: true,
  automaticSha256: createHash('sha256').update(await fs.readFile(automaticRdb)).digest('hex'), preRestoreSha256: createHash('sha256').update(await fs.readFile(preRdb)).digest('hex') };
const continuous = await fs.readFile('/data/continuous-deploy-result.json', 'utf8').then(JSON.parse).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return {};throw error; });
const result = { provenance: 'integration-live', scope: 'Unmodified native backup worker in private XFS/Docker VM, complete proc and all running/stopped container references',
  fileAndAncestorBindProtected: true, stoppedContainerAfterPlanProtected: true, realDockerQueryFailureRetained: true, nativeOpenDescriptorProtected: true,
  checksumPreservedUntilUnreferenced: true, filesystemNetAvailableBytesDelta: removed.filesystems[0].netAvailableBytesDelta,
  automaticPolicy: { keepCount: DEFAULT_KEEP_COUNT, keepDays: DEFAULT_KEEP_DAYS, syntheticCompletedExports: automatic.length, retired: bounded.removed.length, kept: DEFAULT_KEEP_COUNT, filesystemNetAvailableBytesDelta: bounded.filesystems[0].netAvailableBytesDelta },
  redis: redisProof,
  earlierContinuousBaseline: { baselineFiveEndedTasksIncrementBytes: continuous.baselineFiveEndedTasksIncrementBytes ?? null } };
await fs.writeFile('/data/backup-mount-integration-result.json', JSON.stringify(result));
await fixture.finish('completed');console.log('BACKUP_MOUNT_NATIVE_RESULT', JSON.stringify(result));console.log('DRILL_COMPLETE');
