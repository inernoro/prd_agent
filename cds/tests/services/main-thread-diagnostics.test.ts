import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAIN_THREAD_WINDOW_MS,
  MainThreadDiagnostics,
  STALL_THRESHOLD_MS,
  STALL_TICK_MS,
  classifySseRequest,
  gcKindName,
  trackSseResponse,
  type MainThreadDiagnosticsClock,
} from '../../src/services/main-thread-diagnostics.js';
import { blockedFromHistogram } from '../../src/services/event-loop-lag.js';

class FakeClock implements MainThreadDiagnosticsClock {
  t = 1_000;
  wall = Date.parse('2026-10-08T04:00:00.000Z');
  now(): number { return this.t; }
  wallNow(): number { return this.wall + (this.t - 1_000); }
  advance(ms: number): void { this.t += ms; }
}

describe('主线程诊断 · 分段计时', () => {
  it('同名分段累计次数、总耗时、最大值与字节，并按总耗时降序', () => {
    const clock = new FakeClock();
    const d = new MainThreadDiagnostics(clock);
    d.recordSection('state.snapshot.full-clone', 800, 0);
    d.recordSection('state.snapshot.full-clone', 1200, 0);
    d.recordSection('api.branches.serialize', 50, 4096);
    const snap = d.snapshot();
    expect(snap.current.sections.map((s) => s.name)).toEqual(['state.snapshot.full-clone', 'api.branches.serialize']);
    expect(snap.current.sections[0]).toMatchObject({ count: 2, totalMs: 2000, maxMs: 1200 });
    expect(snap.current.sections[1]).toMatchObject({ count: 1, bytes: 4096 });
  });

  it('time() 用注入时钟计时，并能从返回值算出字节', () => {
    const clock = new FakeClock();
    const d = new MainThreadDiagnostics(clock);
    const out = d.time('uptime.persist', () => { clock.advance(37); return 'x'.repeat(10); }, (s) => s.length);
    expect(out).toBe('xxxxxxxxxx');
    expect(d.snapshot().current.sections[0]).toMatchObject({ name: 'uptime.persist', totalMs: 37, bytes: 10 });
  });

  it('满一个窗口后当前窗口归档为上一窗口，新窗口从零开始', () => {
    const clock = new FakeClock();
    const d = new MainThreadDiagnostics(clock);
    d.recordSection('a', 10);
    clock.advance(MAIN_THREAD_WINDOW_MS + 1);
    d.recordSection('b', 5);
    const snap = d.snapshot();
    expect(snap.previous?.sections.map((s) => s.name)).toEqual(['a']);
    expect(snap.previous?.durationMs).toBe(MAIN_THREAD_WINDOW_MS + 1);
    expect(snap.current.sections.map((s) => s.name)).toEqual(['b']);
  });
});

describe('主线程诊断 · 卡顿归因', () => {
  it('一跳迟到不足阈值不记卡顿', () => {
    const clock = new FakeClock();
    const d = new MainThreadDiagnostics(clock);
    clock.advance(STALL_TICK_MS + STALL_THRESHOLD_MS - 1);
    d.tick();
    expect(d.snapshot().stalls).toEqual([]);
  });

  it('卡顿窗口内结束的分段挂到这条卡顿上，剩余记为未标注', () => {
    const clock = new FakeClock();
    const d = new MainThreadDiagnostics(clock);
    // 卡顿开始前结束的分段不算
    clock.advance(10);
    d.recordSection('before', 5);
    clock.advance(STALL_TICK_MS - 10);
    d.tick();
    // 主线程被一次 1800ms 的全量克隆 + 300ms 未知工作占住
    clock.advance(1800);
    d.recordSection('state.snapshot.full-clone', 1800);
    clock.advance(300 + STALL_TICK_MS);
    d.tick();
    const [stall] = d.snapshot().stalls;
    expect(stall.ms).toBe(2100);
    expect(stall.parts).toEqual([{ name: 'state.snapshot.full-clone', ms: 1800 }]);
    expect(stall.unattributedMs).toBe(300);
  });

  it('GC 条目晚于卡顿送达时，按时间重叠补挂并扣减未标注', () => {
    const clock = new FakeClock();
    const d = new MainThreadDiagnostics(clock);
    const stallStart = clock.now();
    clock.advance(900 + STALL_TICK_MS);
    d.tick();
    expect(d.snapshot().stalls[0].unattributedMs).toBe(900);
    clock.advance(5);
    d.recordGc('major', stallStart + 100, 600);
    const [stall] = d.snapshot().stalls;
    expect(stall.parts).toEqual([{ name: 'gc.major', ms: 600 }]);
    expect(stall.unattributedMs).toBe(300);
    expect(d.snapshot().current.gc).toMatchObject({ count: 1, totalMs: 600, maxMs: 600 });
  });

  it('最新的卡顿排在最前，最多保留 50 条', () => {
    const clock = new FakeClock();
    const d = new MainThreadDiagnostics(clock);
    for (let i = 0; i < 60; i += 1) {
      clock.advance(STALL_TICK_MS + STALL_THRESHOLD_MS + i);
      d.tick();
    }
    const stalls = d.snapshot().stalls;
    expect(stalls).toHaveLength(50);
    expect(stalls[0].ms).toBe(STALL_THRESHOLD_MS + 59);
  });

  it('GC 类型编号翻译成可读名字', () => {
    expect(gcKindName(4)).toBe('major');
    expect(gcKindName(1)).toBe('minor');
    expect(gcKindName(undefined)).toBe('unknown');
  });
});

describe('事件循环被卡时间', () => {
  it('直方图记录完整间隔：总和减去样本数 × 分辨率才是被卡时长', () => {
    // 2026-10-08 实测：空闲 1s + 同步阻塞 1.5s + 空闲 1s，resolution 20ms →
    // mean 35.25ms、count 99。被卡时长应约 1.5s，而不是总和 3.49s。
    const r = blockedFromHistogram(35.254396 * 1e6, 99, 3500, 20);
    expect(r.blockedMs).toBeGreaterThan(1450);
    expect(r.blockedMs).toBeLessThan(1550);
    expect(r.blockedRatio).toBeCloseTo(r.blockedMs / 3500, 3);
  });

  it('空闲时接近 0，且不会出现负数', () => {
    expect(blockedFromHistogram(20 * 1e6, 3000, 60_000, 20).blockedMs).toBe(0);
    expect(blockedFromHistogram(19.9 * 1e6, 3000, 60_000, 20).blockedMs).toBe(0);
    expect(blockedFromHistogram(0, 0, 60_000, 20)).toEqual({ blockedMs: 0, blockedRatio: 0 });
  });
});

describe('SSE 连接计数', () => {
  it('按端点 × 来源 × 范围归类，id 段归一', () => {
    expect(classifySseRequest({ url: '/api/branches/stream?project=mdimp', headers: {} })).toBe('/branches/stream|dashboard|project');
    expect(classifySseRequest({ url: '/_cds/api/branches/stream', headers: { 'x-cds-source-host': 'a.miduo.org' } })).toBe('/branches/stream|widget|all');
    expect(classifySseRequest({ url: '/api/deployment-runs/run_1a2b3c/stream', headers: {} })).toBe('/deployment-runs/:id/stream|dashboard|all');
    expect(classifySseRequest({ url: '/api/activity-stream', headers: {} })).toBe('/activity-stream|dashboard|all');
  });

  let server: http.Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it('真实 HTTP：SSE 响应登记连接并计字节，客户端断开后注销；普通响应不计', async () => {
    const d = new MainThreadDiagnostics();
    server = http.createServer((req, res) => {
      trackSseResponse(req, res, d);
      if (req.url?.startsWith('/api/branches/stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: snapshot\ndata: {}\n\n');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;

    await new Promise<void>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/branches' }, (res) => {
        res.resume();
        res.on('end', () => resolve());
      }).on('error', reject);
    });
    expect(d.snapshot().sseOpen).toEqual({});

    const kind = '/branches/stream|widget|all';
    const sseReq = http.get({ host: '127.0.0.1', port, path: '/api/branches/stream', headers: { 'x-cds-source-host': 'p.miduo.org' } });
    await new Promise<void>((resolve) => sseReq.on('response', (res) => res.once('data', () => resolve())));
    const opened = d.snapshot();
    expect(opened.sseOpen).toEqual({ [kind]: 1 });
    expect(opened.current.sse[kind]).toEqual({ writes: 1, bytes: 'event: snapshot\ndata: {}\n\n'.length });

    sseReq.destroy();
    for (let i = 0; i < 50 && Object.keys(d.snapshot().sseOpen).length > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(d.snapshot().sseOpen).toEqual({});
  });
});
