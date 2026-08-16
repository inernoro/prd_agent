/**
 * 备份历史只能列出「这个项目的这个服务」的文件。
 *
 * 背景（Codex review P2，2026-08-16）：备份目录是所有项目共用的一个目录，而 infra id
 * 只在项目内唯一——这台机器上六个项目各有一个叫 `redis` 的服务。写入端这一轮已经把
 * 文件名改成项目限定（`backupKey`），读取端却还在 `ls -la | grep <id>`：
 *
 *   - 跨项目泄漏：A 项目的备份历史里混进 B 项目同名服务的文件名、大小、时间
 *   - 子串误伤：`grep redis` 会把 `redis-cache` 的文件一起捞出来
 *
 * 这条用例走真实路由（express + MockShellExecutor 喂一份 `ls -la` 输出），断言的是
 * **接口返回了什么**，不是源码里出现过哪个函数名——把实现换回 grep 就会红。
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createInfraBackupRouter } from '../../src/routes/infra-backup.js';
import { assertProjectAccess } from '../../src/routes/projects.js';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { InfraService } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

/**
 * 恢复用例要走到 `spawn('docker', …)`。这台机器上有没有 docker 不该决定这条判据
 * 红不红——用例问的是「恢复前快照存到哪个文件名」，不是「docker 能不能跑」。
 * 所以把 spawn 换成一个立刻成功收尾的假进程。
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: () => {
      const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
      proc.stdin = new PassThrough();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      setTimeout(() => proc.emit('close', 0), 0);
      return proc;
    },
  };
});

/** 一份共享备份目录的真实形状：两个项目各有一个 redis，外加一个名字含 redis 的邻居。 */
const LISTING = [
  'total 40',
  'drwxr-xr-x 2 root root 4096 Aug 16 10:00 .',
  'drwxr-xr-x 8 root root 4096 Aug 16 10:00 ..',
  '-rw-r--r-- 1 root root 1024 Aug 16 10:01 proj-a--redis-auto-20260816T100100Z.rdb',
  '-rw-r--r-- 1 root root 2048 Aug 16 10:02 proj-b--redis-auto-20260816T100200Z.rdb',
  '-rw-r--r-- 1 root root 4096 Aug 16 10:03 proj-a--redis-cache-auto-20260816T100300Z.rdb',
  '-rw-r--r-- 1 root root  512 Aug 16 10:04 proj-a--redis-pre-restore-2026-08-16T10-04-00.bin',
  '-rw-r--r-- 1 root root  256 Aug 15 09:00 redis-pre-restore-2026-08-15T09-00-00.bin',
].join('\n');

async function get(server: http.Server, urlPath: string): Promise<{ status: number; body: any }> {
  return send(server, 'GET', urlPath);
}

async function send(
  server: http.Server, method: string, urlPath: string, body?: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); }
          catch { resolve({ status: res.statusCode!, body: raw }); }
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('GET /api/infra/:id/backup-history 的筛选范围', () => {
  let tmpDir: string;
  let server: http.Server;
  let stateService: StateService;

  function seedInfra(id: string, projectId: string): void {
    stateService.addInfraService({
      id, projectId, name: id, dockerImage: 'redis:7-alpine', containerPort: 6379,
      hostPort: 16379, containerName: `cds-infra-${projectId}-${id}`,
      status: 'running', volumes: [], env: {}, createdAt: new Date().toISOString(),
    } as InfraService);
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-backup-history-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now });
    stateService.addProject({ id: 'proj-b', slug: 'b', name: 'B', kind: 'git', createdAt: now, updatedAt: now });
    // 同名服务分属两个项目，外加一个名字以 redis 开头的邻居——三者共用同一个备份目录。
    seedInfra('redis', 'proj-a');
    seedInfra('redis', 'proj-b');
    seedInfra('redis-cache', 'proj-a');
    // 恢复前快照只有 mongo 会产出，单独种一个。
    stateService.addInfraService({
      id: 'mongo', projectId: 'proj-a', name: 'mongo', dockerImage: 'mongo:7', containerPort: 27017,
      hostPort: 27117, containerName: 'cds-infra-proj-a-mongo',
      status: 'running', volumes: [], env: {}, createdAt: now,
    } as InfraService);

    const shell = new MockShellExecutor();
    shell.addResponsePattern(/^test -d /, () => ({ stdout: 'yes\n', stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/^ls -la /, () => ({ stdout: LISTING, stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    const app = express();
    app.use(express.json());
    app.use('/api', createInfraBackupRouter({ stateService, shell, assertProjectAccess: assertProjectAccess as any }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('不列出另一个项目同名服务的备份', async () => {
    const res = await get(server, '/api/infra/redis/backup-history?project=proj-a');
    expect(res.status).toBe(200);
    const names: string[] = res.body.backups.map((b: { name: string }) => b.name);
    expect(names).not.toContain('proj-b--redis-auto-20260816T100200Z.rdb');
    expect(names).toContain('proj-a--redis-auto-20260816T100100Z.rdb');
  });

  it('不把名字撞前缀的邻居服务算进来', async () => {
    // `grep redis` 会把 redis-cache 一起捞出来，前缀判据不会。
    const res = await get(server, '/api/infra/redis/backup-history?project=proj-a');
    const names: string[] = res.body.backups.map((b: { name: string }) => b.name);
    expect(names).not.toContain('proj-a--redis-cache-auto-20260816T100300Z.rdb');
  });

  it('本项目的恢复前快照要列出来', async () => {
    const res = await get(server, '/api/infra/redis/backup-history?project=proj-a');
    const names: string[] = res.body.backups.map((b: { name: string }) => b.name);
    expect(names).toContain('proj-a--redis-pre-restore-2026-08-16T10-04-00.bin');
  });

  /**
   * 项目限定命名之前留下的文件没有项目段，判不出属于谁。照列（它多半就是本项目的
   * 救命快照，正需要时消失最糟），但要标出来，别让它冒充已归属的文件。
   */
  it('旧命名的恢复前快照照列，但标成未归属', async () => {
    const res = await get(server, '/api/infra/redis/backup-history?project=proj-a');
    const legacy = res.body.backups.find((b: { name: string }) => b.name === 'redis-pre-restore-2026-08-15T09-00-00.bin');
    expect(legacy).toBeTruthy();
    expect(legacy.unscoped).toBe(true);
    const own = res.body.backups.find((b: { name: string }) => b.name === 'proj-a--redis-auto-20260816T100100Z.rdb');
    expect(own.unscoped).toBe(false);
  });

  it('B 项目看到的是自己那份，不是 A 的', async () => {
    const res = await get(server, '/api/infra/redis/backup-history?project=proj-b');
    const names: string[] = res.body.backups.map((b: { name: string }) => b.name);
    expect(names).toContain('proj-b--redis-auto-20260816T100200Z.rdb');
    expect(names).not.toContain('proj-a--redis-auto-20260816T100100Z.rdb');
  });

  /**
   * 恢复前快照的文件名同样得带项目段。周期备份这一轮修了，这一处是同一个形状的
   * 另一半：两个项目各有一个 mongo，同一秒里各恢复一次，后写的会盖掉先写的那份
   * 救命快照——而它恰恰是出事时唯一能退回去的东西。
   */
  it('恢复前快照的文件名带项目段', async () => {
    const res = await send(server, 'POST', '/api/infra/mongo/restore?project=proj-a', 'dump-bytes');
    expect(res.status).toBe(200);
    expect(res.body.preRestoreBackup).toContain('/proj-a--mongo-pre-restore-');
    expect(res.body.preRestoreBackup).not.toMatch(/\/mongo-pre-restore-/);
  });

  it('大小与时间取自 ls 输出，不是占位值', async () => {
    const res = await get(server, '/api/infra/redis/backup-history?project=proj-a');
    const own = res.body.backups.find((b: { name: string }) => b.name === 'proj-a--redis-auto-20260816T100100Z.rdb');
    expect(own.size).toBe(1024);
    expect(own.mtime).toBe('Aug 16 10:01');
  });
});
