/**
 * CDS 主线程诊断路由（系统级，2026-10-08 卡顿复盘药方第 1 步）。
 *
 * GET  /api/cds-system/diagnostics/main-thread
 *   一分钟窗口的主线程画像：事件循环延迟与被卡时间占比、已埋点同步工作的耗时排行、
 *   GC、最近 50 次卡顿及其归因、当前 SSE 长连接数与流量。只读。
 *
 * POST /api/cds-system/diagnostics/cpu-profile?seconds=30&format=summary|cpuprofile
 *   在本进程内采样 CPU。默认返回按函数聚合的自身耗时排行；format=cpuprofile 返回
 *   原始文件（可拖进 Chrome DevTools）。同一时刻只允许一次。
 *
 * 认证：挂在全局 auth 之后。这是系统级观测，项目级 Key 与只拿到项目授权的成员一律
 * 403（成员账号另有 human-project-access 中间件兜底，这里再判一次防漏）。
 */
import os from 'node:os';
import { Router, type Request, type Response } from 'express';

import { getEventLoopLag } from '../services/event-loop-lag.js';
import { getMainThreadDiagnostics } from '../services/main-thread-diagnostics.js';
import {
  captureCpuProfile,
  clampProfileSeconds,
  CpuProfileBusyError,
  isCpuProfileInFlight,
  summarizeCpuProfile,
} from '../services/cpu-profile.js';
import { isScopedHuman } from '../services/human-project-access.js';

function denySystemScope(req: Request, res: Response): boolean {
  const projectKey = (req as { cdsProjectKey?: { projectId: string } }).cdsProjectKey;
  if (projectKey || isScopedHuman(req)) {
    res.status(403).json({
      error: 'system_scope_required',
      message: '主线程诊断是 CDS 系统级观测，项目级 Key 或仅有项目授权的账号不能调用。',
    });
    return true;
  }
  return false;
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

export function createCdsSystemDiagnosticsRouter(): Router {
  const router = Router();

  router.get('/cds-system/diagnostics/main-thread', (req, res) => {
    if (denySystemScope(req, res)) return;
    const mem = process.memoryUsage();
    const cores = (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) || 1;
    res.json({
      generatedAt: new Date().toISOString(),
      eventLoop: getEventLoopLag(),
      mainThread: getMainThreadDiagnostics(),
      process: {
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        rssMB: mb(mem.rss),
        heapUsedMB: mb(mem.heapUsed),
        heapTotalMB: mb(mem.heapTotal),
        externalMB: mb(mem.external),
      },
      host: {
        cores,
        loadavg: os.loadavg().map((v) => Number(v.toFixed(2))),
      },
      cpuProfileInFlight: isCpuProfileInFlight(),
    });
  });

  router.post('/cds-system/diagnostics/cpu-profile', async (req, res) => {
    if (denySystemScope(req, res)) return;
    const seconds = clampProfileSeconds(req.query.seconds);
    const format = req.query.format === 'cpuprofile' ? 'cpuprofile' : 'summary';
    try {
      const profile = await captureCpuProfile(seconds);
      if (format === 'cpuprofile') {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        res.setHeader('Content-Disposition', `attachment; filename="cds-master-${stamp}.cpuprofile"`);
        res.type('application/json').send(JSON.stringify(profile));
        return;
      }
      res.json({ seconds, summary: summarizeCpuProfile(profile) });
    } catch (err) {
      if (err instanceof CpuProfileBusyError) {
        res.status(409).json({ error: 'cpu_profile_busy', message: err.message });
        return;
      }
      res.status(500).json({ error: 'cpu_profile_failed', message: (err as Error).message });
    }
  });

  return router;
}
