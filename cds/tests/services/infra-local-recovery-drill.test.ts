import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InfraService } from '../../src/types.js';
import {
  markRotationRecoveryArtifactsForCleanup,
  markRotationRecoveryArtifactsForManualReview,
  pruneExpiredRotationRecoveryArtifacts,
  runLocalInfraRecoveryDrill,
  type LocalDrillCommandRunner,
} from '../../src/services/infra-local-recovery-drill.js';

function service(runtime: 'mongodb' | 'redis', secret: string): InfraService {
  return {
    id: runtime,
    projectId: 'project-a',
    name: runtime,
    dockerImage: runtime === 'mongodb' ? 'mongo:7' : 'redis:7',
    containerPort: runtime === 'mongodb' ? 27017 : 6379,
    hostPort: runtime === 'mongodb' ? 17017 : 16379,
    containerName: `cds-${runtime}`,
    status: 'running',
    volumes: [],
    env: runtime === 'mongodb'
      ? { MONGO_INITDB_ROOT_USERNAME: 'root', MONGO_INITDB_ROOT_PASSWORD: secret }
      : { REDIS_PASSWORD: secret },
    createdAt: '2026-09-06T00:00:00.000Z',
  };
}

describe('MongoDB 与 Redis 本地隔离恢复门禁', () => {
  it('Mongo 密码只走 stdin，恢复容器无网络且可恢复副本受控保留', async () => {
    const secret = 'mongo-secret-only-stdin';
    const calls: Array<{ args: readonly string[]; stdin?: string | Buffer }> = [];
    let localBackup = '';
    const runner: LocalDrillCommandRunner = async (_command, args, stdin) => {
      calls.push({ args, stdin });
      if (args[0] === 'cp') {
        localBackup = String(args[2]);
        await fs.promises.writeFile(localBackup, 'not-a-real-mongo-archive');
      }
      if (args.some((arg) => arg.includes('print(n);'))) return { exitCode: 0, stdout: '3\n', stderr: '' };
      return { exitCode: 0, stdout: 'ok\n', stderr: '' };
    };

    const recoveryDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cds-rotation-test-'));
    const result = await runLocalInfraRecoveryDrill({ service: service('mongodb', secret), recoveryDir, commandRunner: runner, readinessAttempts: 1 });
    expect(result.restoredItemCount).toBe(3);
    expect(result.backupSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.some((call) => String(call.stdin || '').includes(secret))).toBe(true);
    expect(calls.every((call) => !call.args.join(' ').includes(secret))).toBe(true);
    const start = calls.find((call) => call.args[0] === 'run');
    expect(start?.args).toContain('none');
    expect(start?.args).not.toContain('-p');
    expect(fs.existsSync(localBackup)).toBe(true);
    expect(fs.statSync(localBackup).mode & 0o777).toBe(0o600);
    await fs.promises.rm(recoveryDir, { recursive: true, force: true });
  });

  it('Redis AUTH 与 SAVE 使用 RESP stdin，RDB 在无网络容器中实际读出 key 数', async () => {
    const secret = 'redis-secret-only-stdin';
    const calls: Array<{ args: readonly string[]; stdin?: string | Buffer }> = [];
    let localBackup = '';
    const runner: LocalDrillCommandRunner = async (_command, args, stdin) => {
      calls.push({ args, stdin });
      if (args[0] === 'cp') {
        localBackup = String(args[2]);
        await fs.promises.writeFile(localBackup, 'not-a-real-rdb');
      }
      if (args[0] === 'exec' && args.includes('sh') && args.includes('-s')) return { exitCode: 0, stdout: '/var/lib/redis/snapshot.rdb\n', stderr: '' };
      if (args.includes('DBSIZE')) return { exitCode: 0, stdout: '4\n', stderr: '' };
      return { exitCode: 0, stdout: 'ok\n', stderr: '' };
    };

    const recoveryDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cds-rotation-test-'));
    const redisService = service('redis', secret);
    redisService.env.REDIS_USERNAME = 'map-agent';
    const result = await runLocalInfraRecoveryDrill({ service: redisService, recoveryDir, commandRunner: runner, readinessAttempts: 1 });
    expect(result.restoredItemCount).toBe(4);
    const save = calls.find((call) => call.args.includes('sh') && call.args.includes('-s'));
    expect(String(save?.stdin)).toContain(secret);
    expect(String(save?.stdin)).toContain('map-agent');
    expect(calls.find((call) => call.args[0] === 'cp')?.args[1]).toContain('/var/lib/redis/snapshot.rdb');
    expect(calls.every((call) => !call.args.join(' ').includes(secret))).toBe(true);
    const start = calls.find((call) => call.args[0] === 'run');
    expect(start?.args).toContain('none');
    expect(start?.args).not.toContain('-p');
    expect(calls.at(-1)?.args.slice(0, 3)).toEqual(['rm', '-f', expect.stringMatching(/^cds-infra-drill-/)]);
    expect(fs.existsSync(localBackup)).toBe(true);
    await fs.promises.rm(recoveryDir, { recursive: true, force: true });
  });

  it('Redis 无法取得真实 RDB 路径时拒绝猜默认路径', async () => {
    let localBackup = '';
    const calls: readonly string[][] = [];
    const mutable = calls as string[][];
    const runner: LocalDrillCommandRunner = async (_command, args) => {
      mutable.push([...args]);
      if (args[0] === 'cp') {
        localBackup = String(args[2]);
        await fs.promises.writeFile(localBackup, 'empty-rdb');
      }
      if (args[0] === 'exec' && args.includes('sh') && args.includes('-s')) return { exitCode: 0, stdout: '\n', stderr: '' };
      if (args.includes('DBSIZE')) return { exitCode: 0, stdout: '0\n', stderr: '' };
      return { exitCode: 0, stdout: 'ok\n', stderr: '' };
    };
    const recoveryDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cds-rotation-test-'));
    await expect(runLocalInfraRecoveryDrill({
      service: service('redis', 'secret'), recoveryDir, commandRunner: runner, readinessAttempts: 1,
    })).rejects.toThrow('recovery.redis_snapshot_path_missing');
    expect(localBackup).toBe('');
    await fs.promises.rm(recoveryDir, { recursive: true, force: true });
  });

  it('成功副本进入 TTL 清理，失败副本标记人工处置且不会自动删除', async () => {
    const recoveryDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cds-rotation-retention-'));
    const successRoot = path.join(recoveryDir, 'rotation-a1b2c3');
    const failedRoot = path.join(recoveryDir, 'rotation-d4e5f6');
    await fs.promises.mkdir(successRoot, { mode: 0o700 });
    await fs.promises.mkdir(failedRoot, { mode: 0o700 });
    const started = new Date('2026-09-06T00:00:00.000Z');
    await markRotationRecoveryArtifactsForCleanup({
      recoveryDir,
      backupIds: ['local:project-a:mongodb:rotation-a1b2c3:1111111111111111'],
      retentionMs: 60_000,
      now: started,
    });
    await markRotationRecoveryArtifactsForManualReview({
      recoveryDir,
      backupIds: ['local:project-a:mongodb:rotation-d4e5f6:2222222222222222'],
      operationId: 'icr-failed',
      reason: 'rollback-failed',
      now: started,
    });
    expect(fs.existsSync(successRoot)).toBe(true);
    expect(fs.existsSync(failedRoot)).toBe(true);
    expect(fs.statSync(path.join(successRoot, '.cleanup.json')).mode & 0o777).toBe(0o600);
    const manualMarker = path.join(failedRoot, '.manual-review.json');
    expect(fs.statSync(manualMarker).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(manualMarker, 'utf8'))).toMatchObject({
      operationId: 'icr-failed',
      disposition: 'manual-review-required',
      reason: 'rollback-failed',
    });

    // 模拟 success finalize 写过 cleanup 后在清 vault/flush 之前失败，回滚再标人工处置。
    // 标记函数应主动撤销旧 TTL；即使崩溃留下双 marker，重启 prune 也必须人工处置优先。
    await markRotationRecoveryArtifactsForCleanup({
      recoveryDir,
      backupIds: ['local:project-a:mongodb:rotation-d4e5f6:2222222222222222'],
      retentionMs: 1,
      now: started,
    });
    await markRotationRecoveryArtifactsForManualReview({
      recoveryDir,
      backupIds: ['local:project-a:mongodb:rotation-d4e5f6:2222222222222222'],
      operationId: 'icr-rollback-after-finalize-failure',
      reason: 'rollback-completed',
      now: started,
    });
    expect(fs.existsSync(path.join(failedRoot, '.cleanup.json'))).toBe(false);
    await fs.promises.writeFile(
      path.join(failedRoot, '.cleanup.json'),
      `${JSON.stringify({ expiresAt: new Date(started.getTime() + 1).toISOString() })}\n`,
      { mode: 0o600 },
    );

    await pruneExpiredRotationRecoveryArtifacts(recoveryDir, new Date(started.getTime() + 60_001));
    expect(fs.existsSync(successRoot)).toBe(false);
    expect(fs.existsSync(failedRoot)).toBe(true);
    expect(fs.existsSync(path.join(failedRoot, '.cleanup.json'))).toBe(false);
    await fs.promises.rm(recoveryDir, { recursive: true, force: true });
  });

  it('CDS 启动与关闭生命周期接入周期清理器', async () => {
    const source = await fs.promises.readFile(path.resolve('src/index.ts'), 'utf8');
    expect(source).toContain('startRotationRecoveryArtifactCleanup({');
    expect(source).toContain('clearInterval(rotationRecoveryCleanup);');
  });
});
