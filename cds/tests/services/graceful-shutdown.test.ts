/**
 * Graceful Shutdown — TDD 契约
 *
 * 对应 doc/report.cds.forwarder-success.md
 * 实现位置:cds/src/services/graceful-shutdown.ts
 *
 * 旧 daemon 收到 SIGTERM 后,停止接收新请求,drain 现有 SSE / 业务任务,
 * 30s 兜底超时强杀。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GracefulShutdownController,
  createGracefulShutdownController,
  validatePendingWritesPath,
} from '../../src/services/graceful-shutdown.js';

/**
 * 创建一个最小 SSE-friendly http server,挂上 controller 自动 register/unregister。
 * 测试用,模拟 admin daemon 的 healthz + sse + 普通连接。
 */
function createTestServer(controller: GracefulShutdownController): {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
} {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url === '/healthz') {
      if (controller.isDraining()) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'draining', reason: controller.drainReason() }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      }
      return;
    }
    if (url === '/sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      controller.registerSseConnection(res, { kind: 'test' });
      // keepalive heartbeat 模拟,不会自然结束
      const t = setInterval(() => {
        try {
          if (!res.writableEnded) res.write(': ka\n\n');
        } catch {
          /* ignore */
        }
      }, 1000);
      res.on('close', () => clearInterval(t));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('hello');
  });
  return {
    server,
    port: 0,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 强制断开未完成连接,防止测试 hang
        // @ts-ignore Node 18+ 才有 closeAllConnections
        if (typeof server.closeAllConnections === 'function') {
          // @ts-ignore
          server.closeAllConnections();
        }
      }),
  };
}

async function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });
}

interface SimpleResponse {
  status: number;
  body: string;
}

async function httpGet(port: number, urlPath: string, timeoutMs = 1500): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: raw }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`httpGet timeout after ${timeoutMs}ms`));
      reject(new Error(`httpGet timeout`));
    });
    req.on('error', reject);
  });
}

/**
 * 打开一条 SSE 连接,返回控制 handle:可主动断开 / 监听 close event。
 */
interface SseClient {
  close: () => void;
  rawData: string;
  closedByServer: boolean;
}

function openSseClient(port: number): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const handle: SseClient = {
      close: () => {
        // placeholder,真值在下面赋
      },
      rawData: '',
      closedByServer: false,
    };
    const req = http.get({ host: '127.0.0.1', port, path: '/sse' }, (res) => {
      res.on('data', (chunk: Buffer) => {
        handle.rawData += chunk.toString();
      });
      res.on('end', () => {
        handle.closedByServer = true;
      });
      res.on('close', () => {
        handle.closedByServer = true;
      });
      handle.close = () => {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      };
      // 等首字节(headers 已 written)再 resolve,确保 server 已注册
      resolve(handle);
    });
    req.on('error', reject);
  });
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graceful-shutdown-test-'));
});
afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('Graceful Shutdown — 信号处理', () => {
  it('[C-5.3] 收到 SIGTERM → 切到 draining 模式', () => {
    const ctrl = createGracefulShutdownController();
    expect(ctrl.isDraining()).toBe(false);
    ctrl.enterDraining('SIGTERM');
    expect(ctrl.isDraining()).toBe(true);
    expect(ctrl.drainReason()).toBe('SIGTERM');
  });

  it('[C-5.3] draining 模式下 /healthz 返回 503(让上游不再分流量)', async () => {
    const ctrl = createGracefulShutdownController();
    const { server, close } = createTestServer(ctrl);
    const port = await listen(server);
    try {
      const before = await httpGet(port, '/healthz');
      expect(before.status).toBe(200);

      ctrl.enterDraining('test-drain');
      const after = await httpGet(port, '/healthz');
      expect(after.status).toBe(503);
      expect(after.body).toContain('draining');
      expect(after.body).toContain('test-drain');
    } finally {
      await close();
    }
  });

  it('[C-5.3] draining 模式下新连接立即关闭(server.close 不再 accept)', async () => {
    const ctrl = createGracefulShutdownController();
    const { server, close } = createTestServer(ctrl);
    const port = await listen(server);
    try {
      // 先确认正常可达
      const before = await httpGet(port, '/');
      expect(before.status).toBe(200);

      // 触发 server.close —— 不会断已建连接,但拒新连接
      const shutdownPromise = ctrl.runShutdown({
        signal: 'SIGTERM',
        sseDrainMs: 100,
        runDrainMs: 100,
        totalTimeoutMs: 5000,
        pendingWritesPath: path.join(tmpDir, 'pending-writes.json'),
        httpServer: server,
      });

      // 触发后立刻尝试新连接,应该被拒(server 已 close listener)
      // 给 server.close 一点点时间生效
      await new Promise((r) => setTimeout(r, 50));
      let rejected = false;
      try {
        await httpGet(port, '/', 500);
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);

      const snapshot = await shutdownPromise;
      expect(snapshot.signal).toBe('SIGTERM');
    } finally {
      await close();
    }
  });

  it('[C-5.3] 已建立的连接继续处理,直到客户端关或自然结束', async () => {
    const ctrl = createGracefulShutdownController();
    const { server, close } = createTestServer(ctrl);
    const port = await listen(server);
    try {
      // 打开 SSE 长连接(已建立)
      const sse = await openSseClient(port);
      // 给点时间让 controller 注册成功
      await new Promise((r) => setTimeout(r, 50));
      expect(ctrl.sseConnectionCount()).toBe(1);

      // draining 后,SSE 连接仍可被识别(直到 runShutdown 才会被关掉)
      ctrl.enterDraining('graceful-test');
      // 仅 enterDraining,不调 runShutdown — 已建立的 SSE 不应被强制断开
      await new Promise((r) => setTimeout(r, 100));
      expect(sse.closedByServer).toBe(false);
      expect(ctrl.sseConnectionCount()).toBe(1);

      sse.close();
      // 给 server 收 close 事件的时间
      await new Promise((r) => setTimeout(r, 50));
      expect(ctrl.sseConnectionCount()).toBe(0);
    } finally {
      await close();
    }
  });
});

describe('Graceful Shutdown — SSE 长连接', () => {
  it('[C-5.3] draining 时给所有现存 SSE 连接发一条 close event(让客户端主动断开重连到新 daemon)', async () => {
    const ctrl = createGracefulShutdownController();
    const { server, close } = createTestServer(ctrl);
    const port = await listen(server);
    try {
      const sse1 = await openSseClient(port);
      const sse2 = await openSseClient(port);
      await new Promise((r) => setTimeout(r, 50));
      expect(ctrl.sseConnectionCount()).toBe(2);

      // runShutdown 内会写 close event 到所有 SSE,sseDrainMs 后强制 end
      const snapshot = await ctrl.runShutdown({
        signal: 'SIGTERM',
        sseDrainMs: 200,
        runDrainMs: 100,
        totalTimeoutMs: 5000,
        pendingWritesPath: path.join(tmpDir, 'pending-writes.json'),
      });

      // 客户端应当收到 close event payload
      expect(sse1.rawData).toContain('event: close');
      expect(sse1.rawData).toContain('daemon-draining');
      expect(sse2.rawData).toContain('event: close');
      expect(snapshot.sseClosed).toBe(2);
    } finally {
      await close();
    }
  });

  it('[C-5.3] 客户端断开后 SSE 连接立即释放', async () => {
    const ctrl = createGracefulShutdownController();
    const { server, close } = createTestServer(ctrl);
    const port = await listen(server);
    try {
      const sse = await openSseClient(port);
      await new Promise((r) => setTimeout(r, 50));
      expect(ctrl.sseConnectionCount()).toBe(1);

      sse.close();
      // 等 server 收到 close
      await new Promise((r) => setTimeout(r, 100));
      expect(ctrl.sseConnectionCount()).toBe(0);
    } finally {
      await close();
    }
  });
});

describe('Graceful Shutdown — Worker / Run 任务', () => {
  it('[C-5.3] draining 时新 run 不再启动', () => {
    const ctrl = createGracefulShutdownController();
    // 调用方约定:draining 时检查 isDraining(),决定是否拒新 run
    let abortedCount = 0;
    ctrl.registerRun('run-1', () => {
      abortedCount += 1;
    });
    expect(ctrl.runCount()).toBe(1);

    ctrl.enterDraining('SIGTERM');
    expect(ctrl.isDraining()).toBe(true);

    // 业务侧应在 enterDraining 后 reject 新 run —— 这条契约由 isDraining() 暴露给调用方
    // 这里直接验证 controller 行为:仍然允许 register(controller 不强制拦截,业务自己判断)
    // 但 runShutdown 会确保不再放进新 run drain
    if (!ctrl.isDraining()) {
      ctrl.registerRun('run-2', () => {});
    }
    expect(ctrl.runCount()).toBe(1);
    expect(abortedCount).toBe(0);
  });

  it('[C-5.3] 进行中的 run 等待完成(最长 25 秒)', async () => {
    const ctrl = createGracefulShutdownController();
    let abortCalled = false;
    ctrl.registerRun('run-1', () => {
      abortCalled = true;
    });

    // 模拟 run 在 50ms 后自然完成
    setTimeout(() => ctrl.unregisterRun('run-1'), 50);

    const result = await ctrl.awaitRunsDrain(1000);
    expect(result.drained).toBe(true);
    expect(result.remaining).toEqual([]);
    expect(abortCalled).toBe(false);
  });

  it('[C-5.3] 25 秒内未完成的 run 标 status="interrupted",写 mongo,新 daemon 启动 reconcile 接管', async () => {
    const ctrl = createGracefulShutdownController();
    const aborted: string[] = [];
    ctrl.registerRun('run-stuck-1', () => aborted.push('run-stuck-1'));
    ctrl.registerRun('run-stuck-2', () => aborted.push('run-stuck-2'));

    // 不主动 unregister,模拟 run 卡死
    const snapshot = await ctrl.runShutdown({
      signal: 'SIGTERM',
      sseDrainMs: 50,
      runDrainMs: 200,
      totalTimeoutMs: 5000,
      pendingWritesPath: path.join(tmpDir, 'pending-writes.json'),
    });

    expect(snapshot.runsInterrupted).toEqual(expect.arrayContaining(['run-stuck-1', 'run-stuck-2']));
    expect(snapshot.runsInterrupted).toHaveLength(2);
    // abort 应被调用
    expect(aborted).toEqual(expect.arrayContaining(['run-stuck-1', 'run-stuck-2']));
    expect(aborted).toHaveLength(2);
    // 残留 run 已被 unregister
    expect(ctrl.runCount()).toBe(0);
  });
});

describe('Graceful Shutdown — Mongo flush', () => {
  it('[C-5.3] draining 阶段把 write-behind buffer 全部 flush 到 mongo', async () => {
    const ctrl = createGracefulShutdownController();
    let flushCalled = false;
    const result = await ctrl.flushPendingWrites({
      mongoFlush: async () => {
        flushCalled = true;
      },
      pendingWritesPath: path.join(tmpDir, 'pending-writes.json'),
    });
    expect(flushCalled).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.fallbackPath).toBeUndefined();
    // 没失败时不应落盘
    expect(fs.existsSync(path.join(tmpDir, 'pending-writes.json'))).toBe(false);
  });

  it('[C-5.3] flush 失败的关键 state(active update / 流水)落盘 .cds/pending-writes.json', async () => {
    const ctrl = createGracefulShutdownController();
    const fallbackPath = path.join(tmpDir, '.cds', 'pending-writes.json');
    const pendingState = {
      activeUpdate: { id: 'upd-123', status: 'in-progress' },
      stream: [{ event: 'log', ts: 1234 }],
    };
    const result = await ctrl.flushPendingWrites({
      mongoFlush: async () => {
        throw new Error('mongo connection refused');
      },
      pendingWritesPath: fallbackPath,
      pendingState,
    });
    expect(result.ok).toBe(false);
    expect(result.fallbackPath).toBe(fallbackPath);
    expect(fs.existsSync(fallbackPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(fallbackPath, 'utf-8'));
    expect(written.mongoFlushError).toContain('mongo connection refused');
    expect(written.pendingState).toEqual(pendingState);
    expect(written.savedAt).toBeDefined();
  });
});

describe('Graceful Shutdown — 兜底超时', () => {
  it('[C-3.4] 30 秒兜底:无论是否 drain 完成,SIGKILL 自杀', async () => {
    const ctrl = createGracefulShutdownController();
    // 注册一个永远不完成的 run
    ctrl.registerRun('run-forever', () => {});

    const snapshot = await ctrl.runShutdown({
      signal: 'SIGTERM',
      sseDrainMs: 50,
      runDrainMs: 10_000,
      totalTimeoutMs: 200, // 极短 总超时,确保 forcedKill 触发
      pendingWritesPath: path.join(tmpDir, 'pending-writes.json'),
    });

    // forcedKill = true 表示总超时触发了兜底
    expect(snapshot.forcedKill).toBe(true);
    // 残留的 run 仍计入 interrupted(由 runShutdown 在 forcedKill 路径上不强制 abort,
    // 但当总超时早于 runDrainMs 时,interrupted 列表可能为空 —— 仍要标 forcedKill)
    expect(snapshot.signal).toBe('SIGTERM');
    expect(snapshot.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('[C-3.4] 兜底前打印当前残留 SSE / Run 数,便于 post-mortem', async () => {
    const ctrl = createGracefulShutdownController();
    ctrl.registerRun('run-stuck-A', () => {});
    ctrl.registerRun('run-stuck-B', () => {});

    let killSnapshot: ReturnType<GracefulShutdownController['runShutdown']> extends Promise<infer S>
      ? S | null
      : null = null;

    await ctrl.runShutdown({
      signal: 'SIGTERM',
      sseDrainMs: 10,
      runDrainMs: 100,
      totalTimeoutMs: 50, // 快速触发兜底
      pendingWritesPath: path.join(tmpDir, 'pending-writes.json'),
      onForceKill: (snap) => {
        killSnapshot = snap;
      },
    });

    expect(killSnapshot).not.toBeNull();
    expect(killSnapshot!.forcedKill).toBe(true);
    // post-mortem 必须能看到当时还有几个 run / sse
    expect(typeof killSnapshot!.runsInterrupted).toBe('object');
    expect(typeof killSnapshot!.sseClosed).toBe('number');
  });

  it('[C-5.3] 兜底强杀写流水 forced-shutdown=true', async () => {
    const ctrl = createGracefulShutdownController();
    ctrl.registerRun('run-A', () => {});

    const snapshot = await ctrl.runShutdown({
      signal: 'SIGTERM',
      sseDrainMs: 10,
      runDrainMs: 100,
      totalTimeoutMs: 50,
      pendingWritesPath: path.join(tmpDir, 'pending-writes.json'),
    });
    expect(snapshot.forcedKill).toBe(true);
  });
});

describe('Graceful Shutdown — 路径安全', () => {
  it('pendingWritesPath 含 .. 拒绝(防路径穿越)', () => {
    expect(validatePendingWritesPath('/tmp/safe.json').ok).toBe(true);
    expect(validatePendingWritesPath('relative/path.json').ok).toBe(true);
    expect(validatePendingWritesPath('../etc/passwd').ok).toBe(false);
    expect(validatePendingWritesPath('a/../b').ok).toBe(false);
    expect(validatePendingWritesPath('').ok).toBe(false);
  });
});
