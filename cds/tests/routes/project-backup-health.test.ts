/**
 * GET /api/projects/:id/backup-health —— 项目设置里「周期备份」面板的数据源。
 *
 * 这条用例走真实路由（express + MockShellExecutor 喂一份健康文件和一份 `ls -la`），
 * 断言的是**接口返回了什么**，不是源码里出现过哪个函数名。
 *
 * 它守着两件在这条链路上真出过事的事：
 *
 *   1. 按项目筛。备份目录是所有项目共用的，而 infra id 只在项目内唯一——真机一轮里
 *      有六个叫 `redis` 的目标。少了这一步，别的项目的服务会摆进这个项目的面板。
 *   2. 只读不建目录。面板去解析目录只是为了回答「有没有备份过」；顺手把目录建出来，
 *      紧跟着的 `test -d` 必然为真，「一份都没有过」就被报成「目录在、只是没匹配项」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createInfraBackupRouter } from '../../src/routes/infra-backup.js';
import { assertProjectAccess } from '../../src/routes/projects.js';
import { StateService } from '../../src/services/state.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { resolveApiLabel } from '../../src/server.js';

/** 真机的形状：两个项目各有一个 redis，其中 proj-a 那个拿不到口令、一直备不成。 */
const HEALTH = {
  coverageComplete: false,
  completedAt: '2026-08-28T09:00:00.000Z',
  localVerifiedAt: '2026-08-25T09:00:00.000Z',
  remoteVerifiedAt: '2026-08-25T09:00:00.000Z',
  coverageGaps: [{ id: 'minio', projectId: 'proj-a', reason: '需要桶到桶复制，不是一份 dump' }],
  failedTargets: [{ id: 'redis', projectId: 'proj-a', reason: 'NOAUTH Authentication required' }],
  offsiteOnlyTargets: [{ id: 'mysql', projectId: 'proj-a', reason: '离机副本缺失：连接超时' }],
  objects: [
    { id: 'mongo', projectId: 'proj-a', fileName: 'proj-a--mongo-auto-20260828T090000Z.archive.gz', bytes: 4096, remoteObjectKey: 'k1' },
    { id: 'mysql', projectId: 'proj-a', fileName: 'proj-a--mysql-auto-20260828T090000Z.sql.gz', bytes: 2048 },
    { id: 'redis', projectId: 'proj-b', fileName: 'proj-b--redis-auto-20260828T090000Z.rdb', bytes: 1024, remoteObjectKey: 'k2' },
    // 只属于 proj-b 的一台。它一旦出现在 proj-a 的面板里，就是筛漏了——
    // 光靠同名的 redis 看不出来（两边 id 一样，混进来也不改变 id 清单）。
    { id: 'postgres', projectId: 'proj-b', fileName: 'proj-b--postgres-auto-20260828T090000Z.sql.gz', bytes: 8192 },
    // 记录说这一轮导出成功了，但下面的 ls 输出里没有这个文件——产物被删/被移走了。
    { id: 'nacos', projectId: 'proj-a', fileName: 'proj-a--nacos-auto-20260828T090000Z.tar.gz', bytes: 1024, remoteObjectKey: 'k3' },
  ],
};

const LISTING = [
  'total 40',
  'drwxr-xr-x 2 root root 4096 Aug 28 09:00 .',
  '-rw-r--r-- 1 root root 4096 Aug 28 09:00 proj-a--mongo-auto-20260828T090000Z.archive.gz',
  '-rw-r--r-- 1 root root 2048 Aug 28 09:00 proj-a--mysql-auto-20260828T090000Z.sql.gz',
  '-rw-r--r-- 1 root root  512 Aug 25 09:00 proj-a--redis-auto-20260825T090000Z.rdb',
  '-rw-r--r-- 1 root root 1024 Aug 28 09:00 proj-b--redis-auto-20260828T090000Z.rdb',
].join('\n');

async function get(server: http.Server, urlPath: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request({ hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'GET' }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => (raw += c.toString()));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode!, body: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/projects/:id/backup-health', () => {
  let tmpDir: string;
  let server: http.Server;
  let stateService: StateService;
  let shell: MockShellExecutor;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-backup-panel-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now });
    stateService.addProject({ id: 'proj-b', slug: 'b', name: 'B', kind: 'git', createdAt: now, updatedAt: now });
    // 台账里有一台上一轮记录里完全没提到的库（比如上一轮之后才建的）。
    stateService.addInfraService({
      id: 'fresh-pg', projectId: 'proj-a', name: 'fresh-pg', dockerImage: 'postgres:16',
      containerPort: 5432, hostPort: 15432, containerName: 'cds-infra-proj-a-fresh-pg',
      status: 'running', volumes: [], env: {}, createdAt: now,
    } as any);

    shell = new MockShellExecutor();
    // handler 拿到的是**匹配结果**不是命令字符串（`match.input` 才是原命令）。
    // 直接把它当字符串用能「碰巧跑通」——`/^cat /.test(match)` 会先隐式 toString——
    // 但 `match.includes('mkdir')` 就变成了数组元素相等比较，永远为 false，
    // 于是「只读路径不许建目录」那条断言从来不会响（形状 6）。
    shell.addResponsePattern(/.*/, (match) => {
      const cmd = match.input ?? '';
      if (/^cat /.test(cmd)) return { stdout: `${JSON.stringify(HEALTH)}\n`, stderr: '', exitCode: 0 };
      if (/^ls -la /.test(cmd)) return { stdout: LISTING, stderr: '', exitCode: 0 };
      // 回应命令自己 echo 的那个词，而不是一律回 'yes'：只读档的判据是
      // `test -d … && echo ok`，一律回 'yes' 会让它一个候选都选不中，
      // 用例就测不到真正跑的那条路。
      if (/^test -[dfw] /.test(cmd)) {
        return { stdout: /echo ok/.test(cmd) ? 'ok\n' : 'yes\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

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

  it('只返回这个项目的目标，别的项目的同名 redis 不出现', async () => {
    const res = await get(server, '/api/projects/proj-a/backup-health');
    expect(res.status).toBe(200);
    const byId = new Map(res.body.targets.map((t: any) => [t.id, t]));
    expect([...byId.keys()].sort()).toEqual(['fresh-pg', 'minio', 'mongo', 'mysql', 'nacos', 'redis']);
    // 上一轮的记录里没有它，但它此刻真跑着——必须出现，否则一台从没备过的库
    // 在这一屏上根本不存在（Codex review 第二轮 P1）。
    expect(byId.get('fresh-pg').status).toBe('not-in-last-round');
    // proj-b 的 redis 这一轮是成功的；如果筛错了，这里的 redis 会变成 ok。
    expect(byId.get('redis').status).toBe('failed');
  });

  it('每个目标的处境、原因、产物大小都摆出来', async () => {
    const res = await get(server, '/api/projects/proj-a/backup-health');
    const byId = new Map(res.body.targets.map((t: any) => [t.id, t]));
    expect(byId.get('mongo')).toMatchObject({ status: 'ok', bytes: 4096, offsite: true });
    expect(byId.get('mysql')).toMatchObject({ status: 'offsite-only', bytes: 2048, offsite: false });
    // MinIO 有满桶对象、这套 dump 式备份接不了它，落盘记的是一条拉低整轮健康的缺口——
    // 不能和「没有需要备份的状态」混成一档，那会让第一屏在数据没保护时报绿。
    expect(byId.get('minio').status).toBe('unprotected');
    // 健康记录说 nacos 这一轮成功了，可 ls 里没有那个文件——不许报成「正常」，
    // 否则真要恢复的那天才发现产物不在（Codex review P1）。
    expect(byId.get('nacos').status).toBe('artifact-missing');
    expect(byId.get('nacos').reason).toContain('proj-a--nacos-auto-20260828T090000Z.tar.gz');
    // 失败原因要能点开看，不用用户自己去翻容器日志。
    expect(byId.get('redis').reason).toContain('NOAUTH');
    // 这一轮没备成，但盘上还有三天前那一份——答「三天前」可行动，答「未知」不行。
    expect(byId.get('redis').lastSuccessAt).toBe('2026-08-25T09:00:00.000Z');
  });

  it('三个时间戳各答一个问题，不互相顶替', async () => {
    const res = await get(server, '/api/projects/proj-a/backup-health');
    expect(res.body.lastRoundAt).toBe('2026-08-28T09:00:00.000Z');
    expect(res.body.localVerifiedAt).toBe('2026-08-25T09:00:00.000Z');
    expect(res.body.remoteVerifiedAt).toBe('2026-08-25T09:00:00.000Z');
  });

  it('文件数只数这个项目的', async () => {
    const res = await get(server, '/api/projects/proj-a/backup-health');
    expect(res.body.files.count).toBe(3);
    expect(res.body.files.bytes).toBe(4096 + 2048 + 512);
  });

  it('页脚的体检结论直接复用体检那套判据，措辞不另写一份', async () => {
    const res = await get(server, '/api/projects/proj-a/backup-health');
    const ids: string[] = res.body.findings.map((f: any) => f.id);
    expect(ids).toContain('backup.failed-targets');
    expect(ids).toContain('backup.offsite-only-failed');
    expect(ids).toContain('restore-drill.never');
    const failed = res.body.findings.find((f: any) => f.id === 'backup.failed-targets');
    // 带项目的称呼：六个同名 redis 里，运维要看得出是哪一个。
    expect(failed.message).toContain('proj-a 项目的 redis');
  });

  it('只读路径不许把备份目录建出来', async () => {
    await get(server, '/api/projects/proj-a/backup-health');
    // 用 executor 自己记的那份命令流水（string[]），不自己再攒一份。
    expect(shell.commands.some((c) => c.includes('mkdir -p'))).toBe(false);
    expect(shell.commands.some((c) => c.startsWith('test -d '))).toBe(true);
  });

  it('读不到健康文件时说「读不到」，不说「没问题」', async () => {
    const blank = new MockShellExecutor();
    blank.addResponsePattern(/.*/, (match) => {
      if (/^test -d /.test(match.input ?? '')) return { stdout: 'yes\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const app = express();
    app.use('/api', createInfraBackupRouter({ stateService, shell: blank, assertProjectAccess: assertProjectAccess as any }));
    const local = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const res = await get(local, '/api/projects/proj-a/backup-health');
      expect(res.body.verdict.tone).toBe('bad');
      expect(res.body.verdict.headline).toContain('读不到');
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  });

  it('不存在的项目不糊弄，直接 404', async () => {
    const res = await get(server, '/api/projects/nope/backup-health');
    expect(res.status).toBe(404);
  });

  /**
   * Activity Monitor 上每一条 /api/* 都要有中文 label（cds/CLAUDE.md §0.1）。
   * 没有的话面板上只显示一串裸 URL，用户看不出 AI 在干什么。
   */
  /**
   * Codex review 第三轮 P2 两条，都是「读到的不是真正生效的那份」（形状 6）。
   */
  it('多个候选目录都有结果文件时，读最新的那一份', async () => {
    // 高优先级目录变只读、写入端切到后面的候选之后，前面那个目录照样留着一份旧结果
    // 文件。取「第一个有结果文件的」会静默读到几天前的快照。
    const stale = { ...HEALTH, completedAt: '2026-08-20T09:00:00.000Z' };
    const fresh = { ...HEALTH, completedAt: '2026-08-28T09:00:00.000Z' };
    const local = new MockShellExecutor();
    local.addResponsePattern(/.*/, (match) => {
      const cmd = match.input ?? '';
      // 第一个候选（CDS_BACKUP_DIR 未设时是 /data/cds/<slug>/backups）存着旧的那份。
      if (/^cat /.test(cmd)) {
        const body = /\/data\/cds\//.test(cmd) ? stale : fresh;
        return { stdout: `${JSON.stringify(body)}\n`, stderr: '', exitCode: 0 };
      }
      if (/^ls -la /.test(cmd)) return { stdout: LISTING, stderr: '', exitCode: 0 };
      if (/^test -[dfw] /.test(cmd)) {
        return { stdout: /echo ok/.test(cmd) ? 'ok\n' : 'yes\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const app = express();
    app.use('/api', createInfraBackupRouter({
      stateService, shell: local, assertProjectAccess: assertProjectAccess as any, repoRoot: '/srv/cds/repo',
    }));
    const srv = await new Promise<http.Server>((resolve) => {
      const x = app.listen(0, '127.0.0.1', () => resolve(x));
    });
    try {
      const res = await get(srv, '/api/projects/proj-a/backup-health');
      expect(res.body.lastRoundAt).toBe('2026-08-28T09:00:00.000Z');
      expect(res.body.directory).not.toMatch(/^\/data\/cds\//);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it('运维故意停掉的服务不进「需要你管的」', async () => {
    // 周期备份对停着的容器记的是「不阻塞健康」的跳过，那是有意为之。把它也算进来，
    // 面板会为一台故意停掉的库天天报一次「上轮没备到」——一盏没人会看的灯。
    stateService.addInfraService({
      id: 'stopped-mysql', projectId: 'proj-a', name: 'stopped-mysql', dockerImage: 'mysql:8',
      containerPort: 3306, hostPort: 13306, containerName: 'cds-infra-proj-a-stopped-mysql',
      status: 'stopped', volumes: [], env: {}, createdAt: new Date().toISOString(),
    } as any);
    const res = await get(server, '/api/projects/proj-a/backup-health');
    const ids: string[] = res.body.targets.map((t: any) => t.id);
    expect(ids).not.toContain('stopped-mysql');
    // 正在跑的那台照样在。
    expect(ids).toContain('fresh-pg');
  });

  it('在活动面板上有中文名字，不是一串裸 URL', () => {
    expect(resolveApiLabel('GET', '/projects/proj-a/backup-health')).toBe('查看周期备份');
  });
});
