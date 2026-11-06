import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildRedisAppendOnlyScript, buildRedisBackupProbeScript, buildRedisRdbPathScript, redisProbeStdin } from '../../src/services/infra-backup-schedule.js';

const docker = (args: string[], input?: string): string => execFileSync('docker', args, {
  input, encoding: 'utf8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'],
}).trim();
let ready = false;
try { docker(['info']); docker(['image', 'inspect', 'redis:7-alpine']); ready = true; } catch { /* 远端必跑，缺 Docker 明确跳过。 */ }
if (!ready) console.warn('[redis-acl-backup] 没有可用 Docker/Redis 镜像，本次未验证真实备份恢复。');

const name = `cds-backup-acl-${process.pid}-${Date.now()}`;
const restored = `${name}-restored`;
const user = 'backup_fixture';
const password = "fixture'password-$-only";
const dir = mkdtempSync(join(tmpdir(), 'cds-redis-acl-backup-'));
async function waitForRedis(container: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    try { if (docker(['exec', container, 'redis-cli', 'PING']) === 'PONG') return; } catch { /* 启动中 */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('隔离 Redis 未就绪');
}

afterAll(() => {
  if (ready) for (const container of [name, restored]) spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!ready)('命名 ACL 账号的真实 Redis 备份与隔离恢复', () => {
  it('默认账号停用后，认证、BGSAVE、路径探测与恢复产物均使用同一命名账号', async () => {
    docker(['run', '-d', '--network', 'none', '--name', name, 'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no']);
    await waitForRedis(name);
    docker(['exec', name, 'redis-cli', 'SET', 'backup-fixture-key', 'backup-fixture-value']);
    docker(['exec', name, 'redis-cli', 'ACL', 'SETUSER', user, 'on', `>${password}`, '~*', '+@all']);
    docker(['exec', name, 'redis-cli', 'ACL', 'SETUSER', 'default', 'off']);
    const missingUser = spawnSync('docker', ['exec', '-i', name, 'sh', '-s'], {
      input: redisProbeStdin(buildRedisBackupProbeScript(), password), encoding: 'utf8', timeout: 30_000,
    });
    expect(missingUser.status).toBe(22);
    const probe = (script: string): string => docker(['exec', '-i', name, 'sh', '-s'], redisProbeStdin(script, password, user));
    expect(probe(buildRedisAppendOnlyScript())).toBe('no');
    const path = probe(buildRedisBackupProbeScript());
    expect(path).toBe('/data/dump.rdb');
    expect(probe(buildRedisRdbPathScript())).toBe(path);
    expect(docker(['exec', name, 'redis-check-rdb', path])).toContain('RDB looks OK');
    docker(['cp', `${name}:${path}`, join(dir, 'dump.rdb')]);
    docker(['create', '--network', 'none', '--name', restored, 'redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no']);
    docker(['cp', join(dir, 'dump.rdb'), `${restored}:/data/dump.rdb`]);
    docker(['start', restored]);
    await waitForRedis(restored);
    expect(docker(['exec', restored, 'redis-cli', 'GET', 'backup-fixture-key'])).toBe('backup-fixture-value');
    expect(docker(['exec', restored, 'redis-cli', 'DBSIZE'])).toBe('1');
  }, 120_000);
});
