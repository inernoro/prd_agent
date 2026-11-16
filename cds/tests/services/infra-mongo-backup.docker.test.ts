import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMongoBackupInvocation } from '../../src/services/infra-mongo-backup.js';
import { buildSizeCappedCommand } from '../../src/services/infra-backup-schedule.js';
import { acquireDockerSlot, releaseDockerSlot } from '../helpers/docker-container.js';

const token = randomUUID();
const label = 'cds.backup-followup.fixture';
const password = `fixture-only-'-$-${token}`;
let dir = '';
const containers: string[] = [];
let acquiredSlot = false;
const available = spawnSync('docker', ['image', 'inspect', 'mongo:7'], { stdio: 'ignore' }).status === 0;
if (!available) console.warn('[mongo-backup-followup] Mongo 7 镜像不可用，真实导出恢复未验证。');

function docker(args: string[], input?: string, env = process.env): string {
  const r = spawnSync('docker', args, { input, env, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`隔离 Mongo Docker ${args[0]} 失败（exit=${r.status}）：`
    + String(r.stderr).replaceAll(password, '[fixture-redacted]').slice(-400));
  return r.stdout.trim();
}

const auth = 'const admin = db.getSiblingDB("admin");'
  + ' if (!admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD)) quit(2);';

async function start(name: string): Promise<string> {
  const id = docker(['run', '-d', '--network', 'none', '--name', name,
    '--label', `${label}=${token}`, '--memory', '768m', '--cpus', '1',
    '--tmpfs', '/data/db:rw,size=512m', '--tmpfs', '/data/configdb:rw,size=32m',
    '-e', 'MONGO_INITDB_ROOT_USERNAME', '-e', 'MONGO_INITDB_ROOT_PASSWORD', 'mongo:7'],
  undefined, { ...process.env, MONGO_INITDB_ROOT_USERNAME: 'backup_fixture', MONGO_INITDB_ROOT_PASSWORD: password });
  containers.push(id);
  const mounts = JSON.parse(docker(['inspect', '--format', '{{json .Mounts}}', id])) as Array<{ Type: string }>;
  expect(mounts.some(m => m.Type === 'volume')).toBe(false);
  for (let i = 0; i < 120; i += 1) {
    // The image briefly accepts connections during init, then stops that
    // bootstrap server. Wait for the final mongod before seeding the fixture.
    const finalProcess = spawnSync('docker', ['exec', id, 'sh', '-c', 'test "$(cat /proc/1/comm)" = mongod'], { timeout: 5_000 });
    if (finalProcess.status !== 0) {
      await new Promise(resolve => setTimeout(resolve, 250));
      continue;
    }
    const r = spawnSync('docker', ['exec', '-i', id, 'mongosh', '--quiet', '--file', '/dev/stdin'], {
      input: `${auth} print("fixture-ready");`, encoding: 'utf8', timeout: 5_000,
    });
    if (r.status === 0 && r.stdout.includes('fixture-ready')) return id;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('隔离 Mongo 启动超时');
}

beforeAll(() => {
  if (available) {
    acquireDockerSlot('system-mongo-backup-followup'); acquiredSlot = true;
    dir = mkdtempSync(join(tmpdir(), 'cds-mongo-backup-followup-'));
  }
}, 1_800_000);

afterAll(() => {
  try {
    for (const id of containers.reverse()) {
      const inspected = spawnSync('docker', ['inspect', '--format', '{{json .Config.Labels}}', id], { encoding: 'utf8' });
      if (inspected.status === 0 && JSON.parse(inspected.stdout)?.[label] === token) {
        docker(['rm', '-f', id]);
      }
    }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (acquiredSlot) releaseDockerSlot();
  }
});

describe.skipIf(!available)('系统 Mongo 备份真实认证与隔离恢复', () => {
  it('无台账账号的旧导出失败；沿用系统认证后可导出，并在原实例停止后独立恢复', async () => {
    // This Docker daemon is the local isolated test environment. Creation fails
    // on a pre-existing name; cleanup only ever uses our labelled immutable ID.
    const name = 'cds-infra-cds-state-mongo';
    const source = await start(name);
    docker(['exec', '-i', source, 'mongosh', '--quiet', '--file', '/dev/stdin'],
      `${auth} db.getSiblingDB("backup_fixture").sentinel.insertOne({_id:"fixture", value:"preserved"});`
      + 'db.getSiblingDB("backup_auth_fixture").sentinel.insertOne({_id:"auth", value:"auth-preserved"});'
      + `admin.createUser({user:"limited",pwd:${JSON.stringify(password)},roles:[{role:"read",db:"backup_fixture"}]});`
      + `admin.createUser({user:"dedicated_backup",pwd:${JSON.stringify(password)},roles:[{role:"backup",db:"admin"}]});`);

    const old = spawnSync('docker', ['exec', source, 'mongodump', '--archive', '--gzip'], {
      encoding: 'utf8', timeout: 20_000,
    });
    expect(old.status).not.toBe(0);
    expect(old.stderr).toMatch(/Unauthorized|requires authentication/);

    const limitedArchive = join(dir, 'limited.archive.gz');
    const limited = await buildMongoBackupInvocation({
      service: { id: 'cds-state-mongo', projectId: '__system__', scope: 'system', containerName: name },
      variables: {}, outputPath: limitedArchive,
      systemMongoUri: `mongodb://limited:${encodeURIComponent(password)}@ignored.example/?authSource=admin`,
    });
    expect(limited.accessCheck).toBeDefined();
    const denied = spawnSync('sh', ['-c', limited.accessCheck!.command], {
      input: limited.accessCheck!.stdin, encoding: 'utf8', timeout: 30_000,
    });
    expect(denied.status).toBe(43);
    expect(denied.stdout).toContain('CDS_SYSTEM_BACKUP_ROLE_UNCONFIRMED');
    expect(existsSync(limitedArchive)).toBe(false);

    const archive = join(dir, 'fixture.archive.gz');
    const invocation = await buildMongoBackupInvocation({
      service: { id: 'cds-state-mongo', projectId: '__system__', scope: 'system', containerName: name },
      variables: {}, outputPath: archive,
      systemMongoUri: `mongodb://limited:${encodeURIComponent(password)}@ignored.example/?authSource=admin`,
      systemMongoBackupUri: `mongodb://dedicated_backup:${encodeURIComponent(password)}@unreachable.example:27018/?authSource=admin`,
    });
    expect(invocation.credentialSource).toBe('cds-state-backup-uri');
    expect(invocation.command).not.toContain(password);
    const checked = spawnSync('sh', ['-c', invocation.accessCheck!.command], {
      input: invocation.accessCheck!.stdin, encoding: 'utf8', timeout: 30_000,
    });
    expect(checked.status).toBe(0);
    expect(checked.stdout).toContain('CDS_SYSTEM_BACKUP_ROLE_CONFIRMED');
    const capped = buildSizeCappedCommand(invocation.command, 16 * 1024 ** 2, 2 * 1024 ** 2)!;
    const exported = spawnSync('sh', ['-c', capped.command], {
      input: invocation.stdin, encoding: 'utf8', timeout: 30_000,
    });
    expect(exported.status).toBe(0);
    expect(gunzipSync(readFileSync(archive)).length).toBeGreaterThan(100);
    docker(['stop', source]);

    const restored = await start(`cds-mongo-followup-restored-${token}`);
    docker(['cp', archive, `${restored}:/tmp/fixture.archive.gz`]);
    docker(['exec', '-i', restored, 'mongorestore', '--archive=/tmp/fixture.archive.gz', '--gzip',
      '--username=backup_fixture', '--authenticationDatabase=admin', '--config=/dev/stdin',
      '--nsInclude=backup_fixture.*', '--nsInclude=backup_auth_fixture.*'], `password: ${JSON.stringify(password)}\n`);
    const value = docker(['exec', '-i', restored, 'mongosh', '--quiet', '--file', '/dev/stdin'],
      `${auth} print(db.getSiblingDB("backup_fixture").sentinel.findOne({_id:"fixture"}).value);`);
    expect(value).toBe('preserved');
    const restoredAuth = docker(['exec', '-i', restored, 'mongosh', '--quiet', '--file', '/dev/stdin'],
      `${auth} print(db.getSiblingDB("backup_auth_fixture").sentinel.findOne({_id:"auth"}).value);`);
    expect(restoredAuth).toBe('auth-preserved');
  }, 120_000);
});
