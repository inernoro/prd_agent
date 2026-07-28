/**
 * 生产发布：真 SSH 端到端验收（2026-07-28）。
 *
 * 为什么需要这一套：PR #1273 的发布系统止血此前**只有服务层单测**——ssh 执行器是
 * 注入的假实现，路由是直接调方法绕过的。于是三件真正的风险点从来没被真的跑过：
 *   A. 取消之后目标是否真的保持占用，直到执行体退出；
 *   B. 取消之后是否真的不再对目标机器写任何东西（自动恢复被抑制）；
 *   C. 回滚是否走了与发布同一道并发闸（它在另一个 handler 里）；
 *   D. 自更新排空是否真的挡得住 /releases/*（它在另一个**路由器**里）。
 * D 尤其关键：判定曾经只挂在 branches 路由器上，/releases/* 压根不经过它。
 *
 * 这里用**真 sshd**（本机 127.0.0.1:2222）+ **真 ssh2**（router 内部自己 new 的
 * ReleaseService，没有任何注入）+ **真 express 路由**跑完整链路，只有健康检查是
 * 本地 http 服务器。没有 sshd 时整套跳过，不拖累 CI。
 *
 * 起 sshd 的方式见 doc/debt.cds.release-system.md「尚未取得真实环境证据」一节。
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createReleasesRouter } from '../../src/routes/releases.js';
import { StateService } from '../../src/services/state.js';
import { isDrainBlockedPath, beginSelfUpdateDrain, endSelfUpdateDrain, selfUpdateDrainBlockReason } from '../../src/services/deploy-drain.js';
import type { ReleaseTarget } from '../../src/types.js';

const SSH_HOST = '127.0.0.1';
const SSH_PORT = 2222;
const SSH_KEY = path.join(os.tmpdir(), 'claude-0/-home-user-prd-agent/6335caf6-77a2-5ce5-81e9-efc08841c3d8/scratchpad/sshtest/clientkey');

/** 本机 sshd 是否可用（不可用则整套跳过，CI 上没有 sshd 是正常的）。 */
function sshReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(SSH_KEY)) { resolve(false); return; }
    const sock = net.connect({ host: SSH_HOST, port: SSH_PORT });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(1500);
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
  });
}

let available = false;
let stateDir: string;
let stateService: StateService;
let app: express.Express;
let server: http.Server;
let baseUrl: string;
let healthServer: http.Server;
let healthUrl: string;
/** 远端「发布脚本」的落点：每次执行 append 一行，用来数**真的写了几次**。 */
let writeLog: string;
let scriptPath: string;
/**
 * 健康检查的挂起开关走**文件标记**而不是内存布尔：预检自己也会探这个地址，
 * 提前把它挂住会让预检的「上线地址可访问」直接失败。所以挂起必须由**发布脚本
 * 执行之后**才武装——armFile 在，脚本就创建 holdFile，此后的探测才被挂住。
 */
let armFile: string;
let holdFile: string;
let heldOnce = false;
let releaseHealth: (() => void) | null = null;
let healthHeld: Promise<void>;

function releaseTarget(healthcheckUrl: string, deployCommand: string): ReleaseTarget {
  return {
    id: 'target-e2e',
    projectId: 'p1',
    name: '本机 SSH 目标',
    type: 'ssh',
    createdAt: '2026-07-28T00:00:00.000Z',
    isEnabled: true,
    ssh: {
      host: SSH_HOST,
      port: SSH_PORT,
      user: 'root',
      privateKeyRef: 'host-e2e',
      appPath: '/tmp',
      deployCommand,
      healthcheckUrl,
    },
  } as ReleaseTarget;
}

async function call(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${pathname}`,
      {
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try { json = JSON.parse(text || '{}'); } catch { json = { raw: text }; }
          resolve({ status: res.statusCode || 0, json });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor 超时');
}

/**
 * 发起一次发布，允许「上一次执行体还在摘牌」时短暂重试。
 * 用于「本来就该成功」的场景；验证闸门本身的用例一律直接调 call()，不走这里。
 */
async function startReleaseEventually(timeoutMs = 15_000): Promise<{ status: number; json: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs;
  let last = await call('POST', '/api/releases/branches/b1/runs', {
    targetId: 'target-e2e', previewUrl: 'https://preview.example.test',
  });
  while (last.status !== 202 && Date.now() < deadline && /执行体尚未退出/.test(JSON.stringify(last.json))) {
    await new Promise((r) => setTimeout(r, 200));
    last = await call('POST', '/api/releases/branches/b1/runs', {
      targetId: 'target-e2e', previewUrl: 'https://preview.example.test',
    });
  }
  return last;
}

function runStatus(releaseId: string): string {
  return stateService.getReleaseRun(releaseId)?.status || '(none)';
}

/** 远端脚本被真的执行了几次（数落点文件行数）。 */
function remoteWrites(): number {
  try {
    return fs.readFileSync(writeLog, 'utf-8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

beforeAll(async () => {
  available = await sshReachable();
  if (!available) return;

  healthHeld = new Promise<void>((r) => { releaseHealth = () => r(); });
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-release-e2e-'));
  writeLog = path.join(stateDir, 'remote-writes.log');
  stateService = new StateService(path.join(stateDir, 'state.json'));
  stateService.load();
  stateService.addProject({ id: 'p1', slug: 'p1', name: 'P1' } as never);
  stateService.addBranch({
    id: 'b1',
    projectId: 'p1',
    branch: 'main',
    worktreePath: '/tmp/b1',
    services: {},
    status: 'running',
    pinnedCommit: 'a'.repeat(40),
    createdAt: '2026-07-28T00:00:00.000Z',
  } as never);
  // 无 CDS_SECRET_KEY 时 sealToken 是 no-op，明文私钥可被 unsealToken 原样读回。
  stateService.addRemoteHost({
    id: 'host-e2e',
    name: '本机',
    host: SSH_HOST,
    sshPort: SSH_PORT,
    sshUser: 'root',
    sshPrivateKeyEncrypted: fs.readFileSync(SSH_KEY, 'utf-8'),
    sshPrivateKeyFingerprint: 'e2e',
    tags: [],
    isEnabled: true,
    createdAt: '2026-07-28T00:00:00.000Z',
  } as never);

  healthServer = http.createServer((_req, res) => {
    // **只挂住一次**：被卡住的是「那一次正在飞的最终入口探测」。后续探测必须照常
    // 200，否则新发布会先被预检的「上线地址可访问」挡下——那样测到的是预检，
    // 不是我们要验的并发闸（startRelease 是先 preflight 再过闸）。
    if (!fs.existsSync(holdFile) || heldOnce) { res.writeHead(200); res.end('ok'); return; }
    heldOnce = true;
    // 挂住不答：复刻「取消时最终入口探测还在飞」——它是普通 HTTP 请求，不接 abort。
    void healthHeld.then(() => { res.writeHead(500); res.end('down'); });
  });
  await new Promise<void>((r) => healthServer.listen(0, '127.0.0.1', r));
  healthUrl = `http://127.0.0.1:${(healthServer.address() as AddressInfo).port}/healthz`;

  // 远端「发布脚本」：真在磁盘上生成一个可执行脚本，记一行落点后挂住 90 秒
  // （模拟长发布，方便测取消）。命名成 local-prod-release.sh 是为了走「本机发布」
  // 这条预检分支——它按分支产物 + 项目 ID 锁定，不要求远端有匹配的 Git 目录。
  armFile = path.join(stateDir, 'arm-hold');
  holdFile = path.join(stateDir, 'hold-health');
  scriptPath = path.join(stateDir, 'local-prod-release.sh');
  fs.writeFileSync(
    scriptPath,
    `#!/bin/bash\necho run >> ${writeLog}\nif [ -f '${armFile}' ]; then touch '${holdFile}'; fi\n`,
    'utf-8',
  );
  fs.chmodSync(scriptPath, 0o755);
  stateService.upsertReleaseTarget(releaseTarget(healthUrl, `'${scriptPath}'`));

  app = express();
  app.use(express.json());
  // 与 server.ts 同款的 app 级排空闸（判定同一个源）。
  app.use('/api', (req, res, next) => {
    if (!isDrainBlockedPath(req.method, req.path)) { next(); return; }
    const draining = selfUpdateDrainBlockReason(Date.now());
    if (!draining) { next(); return; }
    res.setHeader('Retry-After', '60');
    res.status(503).json({ error: 'self_update_draining', message: draining });
  });
  app.use('/api', createReleasesRouter({ stateService }));

  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  endSelfUpdateDrain();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (healthServer) await new Promise<void>((r) => healthServer.close(() => r()));
  if (stateService) await stateService.flush();
  if (stateDir && fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('生产发布 · 真 SSH 端到端', () => {
  it('本机 sshd 可用（不可用则本套件跳过）', () => {
    if (!available) {
      console.warn('[release-e2e] 本机 127.0.0.1:2222 无 sshd，整套跳过');
    }
    expect(true).toBe(true);
  });

  it('A+B+C：取消后目标保持占用、不再写目标机器，发布与回滚都被同一道闸挡住', async () => {
    if (!available) return;

    // ── 前置：先真发一次成功的发布 ──────────────────────────────────────
    // 没有「上一次成功版本」的话，restorePreviousAfterFailedProbe 会因为
    // previousReleaseId 为空直接早退——B 的断言就成了空跑。必须先造出前序版本，
    // 让「取消后自动恢复」这条路真的有机会被触发，抑制才算被验证。
    const first = await call('POST', '/api/releases/branches/b1/runs', {
      targetId: 'target-e2e', previewUrl: 'https://preview.example.test',
    });
    if (first.status !== 202) console.error('[e2e] first failed:', first.status, JSON.stringify(first.json).slice(0, 800));
    expect(first.status).toBe(202);
    const firstId = String(((first.json as { run?: { releaseId?: string } }).run || {}).releaseId || '');
    await waitFor(() => runStatus(firstId) === 'success', 30_000);
    const afterFirst = remoteWrites();
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // ── 正题：第二次发布卡在最终入口探测上时取消 ────────────────────────
    fs.writeFileSync(armFile, '', 'utf-8'); // 本次脚本跑完后武装「探测挂起」
    const started = await startReleaseEventually();
    if (started.status !== 202) console.error('[e2e] second start:', started.status, JSON.stringify(started.json).slice(0, 300));
    expect(started.status).toBe(202);
    const releaseId = String(((started.json as { run?: { releaseId?: string } }).run || {}).releaseId || '');
    // 这一次确实有可回滚的上一版本——自动恢复的前提成立
    expect(stateService.getReleaseRun(releaseId)?.previousReleaseId).toBe(firstId);

    await waitFor(() => remoteWrites() === afterFirst + 1);       // 真 SSH 跑过了
    await waitFor(() => runStatus(releaseId) === 'healthchecking'); // 卡在不接 abort 的探测上

    // 目标被占着：状态在途这一层
    const busy = await call('POST', '/api/releases/branches/b1/runs', {
      targetId: 'target-e2e', previewUrl: 'https://preview.example.test',
    });
    expect(busy.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(busy.json)).toMatch(/进行中的发布/);

    // 取消：run 立刻终态，但探测还在飞，执行体没退出
    const cancelled = await call('POST', `/api/releases/runs/${releaseId}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(['failed', 'rollback_failed']).toContain(runStatus(releaseId));

    // A：取消后立刻发起必须被「执行体尚未退出」挡住
    const settling = await call('POST', '/api/releases/branches/b1/runs', {
      targetId: 'target-e2e', previewUrl: 'https://preview.example.test',
    });
    expect(settling.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(settling.json)).toMatch(/执行体尚未退出/);

    // C：回滚走同一道闸（它在另一个 handler 里，此前一道闸都没有）
    const rollback = await call('POST', `/api/releases/runs/${releaseId}/rollback`, {});
    expect(rollback.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(rollback.json)).toMatch(/执行体尚未退出|进行中的发布/);

    // B：放开探测 → 500 失败 → 自动恢复本该被触发，但已取消，必须跳过
    //    事故值：这里会多出一次 SSH 写入（把上一版本推回目标机器）
    releaseHealth!();
    await new Promise((r) => setTimeout(r, 2000));
    expect(remoteWrites()).toBe(afterFirst + 1);
    const logs = stateService.getReleaseRun(releaseId)?.logs ?? [];
    expect(logs.some((l) => String(l.message).includes('跳过自动恢复'))).toBe(true);

    // 执行体真的退出后，目标才释放
    fs.rmSync(armFile, { force: true });
    fs.rmSync(holdFile, { force: true });
    const after = await startReleaseEventually();
    if (after.status !== 202) console.error('[e2e] final start:', after.status, JSON.stringify(after.json).slice(0, 300));
    expect(after.status).toBe(202);
    const nextId = String(((after.json as { run?: { releaseId?: string } }).run || {}).releaseId || '');
    await waitFor(() => runStatus(nextId) === 'success', 30_000);
    expect(remoteWrites()).toBe(afterFirst + 2);
  }, 150_000);

  it('D：自更新排空期间，/releases/* 的发起与回滚都拿 503（它在另一个路由器里）', async () => {
    if (!available) return;
    beginSelfUpdateDrain(Date.now(), 30_000);
    try {
      const start = await call('POST', '/api/releases/branches/b1/runs', {
        targetId: 'target-e2e', previewUrl: 'https://preview.example.test',
      });
      expect(start.status).toBe(503);
      expect(String((start.json as { error?: string }).error)).toBe('self_update_draining');

      const rollback = await call('POST', '/api/releases/runs/rel_whatever/rollback', {});
      expect(rollback.status).toBe(503);

      // 只读不受影响：排空期间照样能查
      const list = await call('GET', '/api/releases/runs');
      expect(list.status).toBe(200);
    } finally {
      endSelfUpdateDrain();
    }
    // 开闸后立刻恢复放行（不必等 fail-open 窗口）
    const after = await call('GET', '/api/releases/runs');
    expect(after.status).toBe(200);
  }, 30_000);
});
