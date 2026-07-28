/**
 * 发布 SSE 流的标准断点续传（id: 行 + Last-Event-ID）。
 *
 * 事故值：这条流此前只认 `?afterSeq=`，一行 `id:` 都不发。浏览器 EventSource 断线自动
 * 重连时**只会**带 Last-Event-ID 请求头、不会替你补 query，于是每次网络抖动重连都从
 * seq 0 把整份发布日志重放一遍 —— 一次输出几千行的生产发布，用户每断一次就重看一次全文，
 * 且没有任何办法判断哪些是新的。分支部署流（routes/deployment-runs.ts）早就是标准写法，
 * 两条生命周期在这一点上漂移了一个代际。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createReleasesRouter } from '../../src/routes/releases.js';
import { StateService } from '../../src/services/state.js';
import { releaseEvents } from '../../src/services/release-events.js';
import type { BranchEntry, ReleaseRun, ReleaseTarget } from '../../src/types.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

interface SseFrame {
  id?: string;
  event: string;
  data: any;
}

/** 按 SSE 分帧规则解析，顺带保留 id 行 —— 断言的正是「有没有 id」。 */
function parseFrames(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0);
    if (!lines.length) continue;
    let id: string | undefined;
    let event = '';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('id: ')) id = line.slice(4);
      else if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (!event) continue;
    frames.push({ id, event, data: dataLines.length ? JSON.parse(dataLines.join('\n')) : undefined });
  }
  return frames;
}

/** 打开一条 SSE 连接，返回累积缓冲的读取器与关闭钩子。 */
function openStream(
  server: http.Server,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<{ read: () => string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    let buffer = '';
    const req = http.request(
      { hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'GET', headers },
      (res) => {
        res.on('data', (chunk: Buffer) => (buffer += chunk.toString()));
        resolve({ read: () => buffer, close: () => { req.destroy(); res.destroy(); } });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

describe('release stream resume', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;
  const KEY_A = 'TEST-KEY-A';

  function releaseTarget(): ReleaseTarget {
    const now = new Date().toISOString();
    return {
      id: 'target-a',
      projectId: 'proj-a',
      name: 'A target',
      type: 'ssh',
      createdAt: now,
      updatedAt: now,
      isEnabled: true,
      ssh: {
        host: 'a.example.test',
        port: 22,
        user: 'deploy',
        privateKeyRef: 'a-host-key',
        appPath: '/srv/app',
        deployCommand: './deploy.sh',
        rollbackCommand: './rollback.sh',
        healthcheckUrl: 'http://a.example.test/healthz',
      },
    };
  }

  function branch(): BranchEntry {
    const now = new Date().toISOString();
    return {
      id: 'branch-a',
      projectId: 'proj-a',
      branch: 'main',
      worktreePath: path.join(tmpDir, 'worktrees', 'branch-a'),
      status: 'running',
      createdAt: now,
      lastDeployAt: now,
      githubCommitSha: 'abc1234',
      services: {},
    };
  }

  function addRun(releaseId: string): void {
    const now = new Date().toISOString();
    stateService.addReleaseRun({
      releaseId,
      projectId: 'proj-a',
      branchId: 'branch-a',
      commitSha: 'abc1234',
      artifact: {
        type: 'branch-preview',
        commitSha: 'abc1234',
        branchId: 'branch-a',
        branchName: 'main',
        previewUrl: 'https://a.example.test',
      },
      targetId: 'target-a',
      planId: 'proj-a:ssh-script',
      status: 'running',
      startedAt: now,
      heartbeatAt: now,
      logs: [],
      seq: 0,
    } as ReleaseRun);
  }

  /** 追加一条日志并像 release-service 那样推事件，返回该条的 seq。 */
  function appendLog(releaseId: string, message: string): number {
    const run = stateService.appendReleaseRunLog(releaseId, { level: 'info', message });
    const log = run.logs[run.logs.length - 1];
    releaseEvents.emitEvent({ type: 'release.log', payload: { releaseId, log } });
    return log.seq;
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-stream-'));
    stateService = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({ id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now });
    stateService.addBranch(branch());
    stateService.upsertReleaseTarget(releaseTarget());
    releaseEvents.resetLifecycleDedupeForTest();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if ((req.headers['x-test-key'] as string | undefined) === KEY_A) {
        (req as any).cdsProjectKey = { projectId: 'proj-a', keyId: 'k-a' };
      }
      next();
    });
    app.use('/api', createReleasesRouter({ stateService, config: { worktreeBase: path.join(tmpDir, 'wt') } }));
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  });

  afterEach(async () => {
    releaseEvents.removeAllListeners('any');
    releaseEvents.resetLifecycleDedupeForTest();
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('每条日志事件都带 id 行，值就是该条日志的 seq', async () => {
    addRun('rel-stream');
    const stream = await openStream(server, '/api/releases/runs/rel-stream/stream', { 'X-Test-Key': KEY_A });
    await settle();
    const seqOne = appendLog('rel-stream', '第一步');
    const seqTwo = appendLog('rel-stream', '第二步');
    await settle();

    const frames = parseFrames(stream.read()).filter((frame) => frame.event === 'release.log');
    stream.close();

    expect(frames).toHaveLength(2);
    expect(frames[0].id).toBe(String(seqOne));
    expect(frames[1].id).toBe(String(seqTwo));
  });

  it('状态事件也带 id，断点不会因为收到状态更新而倒退', async () => {
    addRun('rel-status');
    const stream = await openStream(server, '/api/releases/runs/rel-status/stream', { 'X-Test-Key': KEY_A });
    await settle();
    appendLog('rel-status', '第一步');
    const run = stateService.getReleaseRun('rel-status')!;
    releaseEvents.emitEvent({ type: 'release.status', payload: { releaseId: 'rel-status', run } });
    await settle();

    const frames = parseFrames(stream.read());
    stream.close();
    const status = frames.find((frame) => frame.event === 'release.status');

    expect(status?.id).toBe(String(run.seq));
    expect(Number(status!.id)).toBeGreaterThanOrEqual(1);
  });

  it('Last-Event-ID 重连只补发之后的日志，不重放全文', async () => {
    addRun('rel-resume');
    const first = appendLog('rel-resume', '第一步');
    appendLog('rel-resume', '第二步');

    const stream = await openStream(server, '/api/releases/runs/rel-resume/stream', {
      'X-Test-Key': KEY_A,
      'Last-Event-ID': String(first),
    });
    await settle();

    const snapshot = parseFrames(stream.read()).find((frame) => frame.event === 'snapshot');
    stream.close();

    expect(snapshot).toBeDefined();
    expect(snapshot!.data.logs.map((log: any) => log.message)).toEqual(['第二步']);
  });

  it('显式 afterSeq 覆盖 Last-Event-ID（与分支部署流同一优先级）', async () => {
    addRun('rel-precedence');
    appendLog('rel-precedence', '第一步');
    const second = appendLog('rel-precedence', '第二步');
    appendLog('rel-precedence', '第三步');

    const stream = await openStream(server, `/api/releases/runs/rel-precedence/stream?afterSeq=${second}`, {
      'X-Test-Key': KEY_A,
      'Last-Event-ID': '0',
    });
    await settle();

    const snapshot = parseFrames(stream.read()).find((frame) => frame.event === 'snapshot');
    stream.close();

    expect(snapshot!.data.logs.map((log: any) => log.message)).toEqual(['第三步']);
  });

  it('脏 Last-Event-ID 退回 0 而不是让快照静默变空', async () => {
    // 事故形状：Last-Event-ID 是客户端可控的裸字符串。Number('abc') = NaN，
    // 而 `seq > NaN` 恒 false —— 快照会一条日志都不带，且不报任何错。
    addRun('rel-dirty');
    appendLog('rel-dirty', '第一步');

    const stream = await openStream(server, '/api/releases/runs/rel-dirty/stream', {
      'X-Test-Key': KEY_A,
      'Last-Event-ID': 'not-a-number',
    });
    await settle();

    const snapshot = parseFrames(stream.read()).find((frame) => frame.event === 'snapshot');
    stream.close();

    expect(snapshot!.data.logs.map((log: any) => log.message)).toEqual(['第一步']);
  });

  it('重连后已覆盖的日志不会再从实时通道漏出来一遍', async () => {
    addRun('rel-dedupe');
    const first = appendLog('rel-dedupe', '第一步');

    const stream = await openStream(server, '/api/releases/runs/rel-dedupe/stream', {
      'X-Test-Key': KEY_A,
      'Last-Event-ID': String(first),
    });
    await settle();
    // 快照之后新产生的日志才该走实时通道；补一条验证闸门没有把新日志也吞掉。
    const next = appendLog('rel-dedupe', '第二步');
    await settle();

    const live = parseFrames(stream.read()).filter((frame) => frame.event === 'release.log');
    stream.close();

    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(String(next));
  });
});
