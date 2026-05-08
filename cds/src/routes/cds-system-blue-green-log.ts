/**
 * Blue-Green daemon spawn log peek route — 维护诊断工具(B'.5.1 hotfix)
 *
 * 蓝绿切换时 supervisor spawn 的子进程是 detached + unref,主 daemon 收不到
 * stdio。子进程的输出会被写到 cds/.cds/daemon-{blue|green}.log。冒烟反复发现
 * "wait-healthz socket hang up",但不知道子进程到底在启动里出了什么错 —
 * 没有 SSH 看不了 log file。
 *
 * 本路由暴露这两个 log 文件的最后 N KB 给运维诊断,**只接受已认证的管理员**。
 * 不写、不删,只读。
 */

import express from 'express';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export interface BlueGreenLogRouterDeps {
  cdsRoot: string;
  /** 最大返回字节数,默认 16 KB */
  maxBytes?: number;
}

export function createBlueGreenLogRouter(deps: BlueGreenLogRouterDeps): express.Router {
  const router = express.Router();
  const maxBytes = deps.maxBytes ?? 16 * 1024;

  router.get('/blue-green-daemon-log', (req, res) => {
    const colorRaw = String(req.query.color || 'green');
    if (colorRaw !== 'blue' && colorRaw !== 'green') {
      res.status(400).json({ error: 'color must be blue or green' });
      return;
    }
    const logPath = path.join(deps.cdsRoot, 'cds', '.cds', `daemon-${colorRaw}.log`);
    if (!fs.existsSync(logPath)) {
      res.json({
        path: logPath,
        exists: false,
        size: 0,
        tail: '',
        message: `${logPath} 不存在 — daemon 颜色 ${colorRaw} 还没启动过,或 spawn 失败前就 exit 了`,
      });
      return;
    }
    const stat = fs.statSync(logPath);
    const start = Math.max(0, stat.size - maxBytes);
    let tail = '';
    try {
      const fd = fs.openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        tail = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      res.status(500).json({ error: 'read failed', message: (err as Error).message });
      return;
    }
    res.json({
      path: logPath,
      exists: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      tailFromOffset: start,
      tail,
    });
  });

  /**
   * GET /api/cds-system/probe-port?port=9901
   * 直接 net.connect 本机端口,确认是否真 listen + 拿到 banner。
   * 用于诊断 supervisor wait-healthz 失败时绿 daemon 实际 listen 哪个端口。
   */
  router.get('/probe-port', (req, res) => {
    const portRaw = Number(req.query.port);
    if (!Number.isFinite(portRaw) || portRaw < 1 || portRaw > 65535) {
      res.status(400).json({ error: 'port must be 1-65535' });
      return;
    }
    const port = portRaw;
    const startedAt = Date.now();
    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: 1500 });
    let resolved = false;
    const finalize = (result: Record<string, unknown>) => {
      if (resolved) return;
      resolved = true;
      try { socket.destroy(); } catch { /* ignore */ }
      res.json({ port, elapsedMs: Date.now() - startedAt, ...result });
    };
    socket.on('connect', () => {
      // 连上了说明真 listen,试发个 HTTP 请求看响应类型
      socket.write('GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n');
    });
    let chunks = '';
    socket.on('data', (buf) => {
      chunks += buf.toString('utf8', 0, Math.min(buf.length, 1024));
      if (chunks.length > 1024) {
        finalize({ listening: true, banner: chunks.slice(0, 512) });
      }
    });
    socket.on('end', () => {
      finalize({ listening: true, banner: chunks.slice(0, 512) });
    });
    socket.on('timeout', () => {
      finalize({ listening: false, error: 'timeout' });
    });
    socket.on('error', (err) => {
      finalize({ listening: false, error: (err as Error).message });
    });
  });

  return router;
}
