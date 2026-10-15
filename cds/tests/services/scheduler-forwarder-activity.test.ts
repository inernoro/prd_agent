import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PreviewActivityCollector, resolvePreviewActivity } from '../../src/forwarder/preview-activity.js';
import { SchedulerService } from '../../src/services/scheduler.js';
import { StateService } from '../../src/services/state.js';
import { probeRequestHeaders, PROBE_MARKER_HEADER, isTrustedProbeFingerprint } from '../../src/services/probe-marker.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';

const roots: string[] = [];
afterEach(async () => {
  await flushAllJsonStateStores();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  let now = 1_790_000_000_000;
  let mono = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-forwarder-clock-')); roots.push(root);
  const state = new StateService(path.join(root, 'state.json')); state.load();
  for (const [id, age] of [['file', 3 * 3600_000], ['quiet', 3600_000]] as const) {
    state.addBranch({ id, projectId: 'default', branch: `codex/${id}`, services: {}, status: 'running',
      heatState: 'hot', worktreePath: path.join(root, id), createdAt: new Date(now - 86400_000).toISOString(),
      lastAccessedAt: new Date(now - age).toISOString() });
  }
  const scheduler = new SchedulerService(state, { enabled: true, maxHotBranches: 1, idleTTLSeconds: 86400,
    tickIntervalSeconds: 60, pinnedBranches: [] }, { now: () => now, monotonicNow: () => mono });
  const cooled: string[] = [];
  scheduler.setCoolFn(async id => { cooled.push(id); });
  return { state, scheduler, cooled, now: () => now,
    advance: (ms: number) => { now += ms; mono += ms; },
    rollback: (ms: number) => { now -= ms; },
    advanceMonotonic: (ms: number) => { mono += ms; } };
}

describe('forwarder活动收据的有限资格与恢复', () => {
  it('老的无marker用户收据回放原始时间；重复读取不把历史活动续到当前', async () => {
    const f = fixture();
    let observedAt = f.now() - 20 * 60_000;
    const collector = new PreviewActivityCollector(() => observedAt);
    collector.record('file', {});
    observedAt = f.now();
    f.scheduler.setPreviewActivitySource(async () => collector.snapshot(), isTrustedProbeFingerprint, f.now() - 1000);
    await f.scheduler.tick();
    expect(f.cooled).toEqual(['quiet']);
    const original = f.state.getBranch('file')!.lastAccessedAt;
    expect(original).toBe(new Date(f.now() - 20 * 60_000).toISOString());
    f.advance(10_000); observedAt = f.now();
    await f.scheduler.tick();
    expect(f.state.getBranch('file')!.lastAccessedAt).toBe(original);
    expect(f.scheduler.getSnapshot().previewActivity?.status).toBe('ready');
  });

  it('前代有效形状marker只得一次unknown宽限；原时间不被当用户或读取时钟', async () => {
    const f = fixture();
    let observedAt = f.now() - 5000;
    const collector = new PreviewActivityCollector(() => observedAt);
    collector.record('file', { [PROBE_MARKER_HEADER]: 'b'.repeat(48) });
    observedAt = f.now();
    f.scheduler.setPreviewActivitySource(async () => collector.snapshot(), isTrustedProbeFingerprint, f.now() - 1000);
    const original = f.state.getBranch('file')!.lastAccessedAt;
    await f.scheduler.tick();
    expect(f.cooled).toEqual([]);
    expect(f.scheduler.getSnapshot().previewActivity).toMatchObject({ status: 'unknown', recoveryGraceRemainingMs: 60_000 });
    f.advance(59_000); observedAt = f.now(); await f.scheduler.tick();
    expect(f.scheduler.getSnapshot().previewActivity?.recoveryGraceRemainingMs).toBe(1000);
    f.advance(1001); observedAt = f.now(); await f.scheduler.tick();
    expect(f.cooled).toEqual(['file']);
    expect(f.state.getBranch('file')!.lastAccessedAt).toBe(original);
    expect(f.scheduler.getSnapshot().previewActivity).toMatchObject({ status: 'ready', recoveryGraceRemainingMs: 0 });
  });

  it('墙钟回拨和持续读取失败不能延长恢复宽限', async () => {
    const f = fixture();
    f.scheduler.setPreviewActivitySource(async () => { throw new Error('不可读取'); }, isTrustedProbeFingerprint, f.now());
    await f.scheduler.tick();
    f.rollback(3600_000); f.advanceMonotonic(60_001);
    await f.scheduler.tick();
    expect(f.cooled).toEqual([]);
    expect(f.scheduler.getSnapshot().previewActivity?.recoveryGraceRemainingMs).toBe(0);
  });

  it('通道短暂恢复后再次失败也不能重新领宽限', async () => {
    const f = fixture(); let available = false;
    const collector = new PreviewActivityCollector(f.now);
    f.scheduler.setPreviewActivitySource(async () => {
      if (!available) throw new Error('不可读取');
      return collector.snapshot();
    }, isTrustedProbeFingerprint, f.now());
    await f.scheduler.tick();
    f.advance(30_000); available = true; f.scheduler.setMaxHotBranches(2);
    await f.scheduler.tick();
    expect(f.scheduler.getSnapshot().previewActivity?.status).toBe('ready');
    f.advance(31_000); available = false; f.scheduler.setMaxHotBranches(1);
    await f.scheduler.tick();
    expect(f.cooled).toEqual([]);
    expect(f.scheduler.getSnapshot().previewActivity?.recoveryGraceRemainingMs).toBe(0);
  });

  it('未知不能在宽限结束后当闲置或放宽maxHot；真实通道恢复才先冷却再唤醒', async () => {
    const f = fixture(); f.scheduler.setMaxHotBranches(2);
    f.state.addBranch({ id: 'new', branch: 'codex/new', services: {}, status: 'idle', heatState: 'cold',
      worktreePath: '/unused', createdAt: new Date(f.now()).toISOString() });
    const woken: string[] = []; f.scheduler.setWakeFn(async id => { woken.push(id); });
    f.scheduler.setPreviewActivitySource(async () => undefined, isTrustedProbeFingerprint, f.now());
    await expect(f.scheduler.wake('new')).rejects.toThrow('预览访问状态暂不可确认');
    expect(woken).toEqual([]); expect(f.cooled).toEqual([]);
    expect(f.state.getBranch('new')!.heatState).toBe('cold');
    f.advance(60_001);
    await expect(f.scheduler.wake('new')).rejects.toThrow('预览访问状态暂不可确认');
    expect(woken).toEqual([]); expect(f.cooled).toEqual([]);
    const collector = new PreviewActivityCollector(f.now);
    f.scheduler.setPreviewActivitySource(async () => collector.snapshot(), isTrustedProbeFingerprint, f.now());
    await f.scheduler.wake('new');
    expect(f.cooled).toEqual(['file']); expect(woken).toEqual(['new']);
    expect(f.scheduler.getSnapshot().capacityUsage).toEqual({ current: 2, max: 2 });
  });

  it('大量同分支访问与探针合并而非每轮overflow，真probe不能覆盖先前用户时间', () => {
    let at = 1_790_000_000_000;
    const collector = new PreviewActivityCollector(() => at);
    const headers = probeRequestHeaders();
    for (let i = 0; i < 10_000; i++) { collector.record('file', {}); collector.record('file', headers); }
    const userAt = at; at += 1000; collector.record('file', headers);
    const snapshot = collector.snapshot();
    expect(snapshot.branches).toHaveLength(1);
    expect(snapshot.branches[0].markers).toHaveLength(1);
    expect(snapshot.overflowAt).toBeUndefined();
    expect(JSON.stringify(snapshot).includes(headers[PROBE_MARKER_HEADER])).toBe(false);
    expect(resolvePreviewActivity(snapshot, at, userAt - 1, isTrustedProbeFingerprint))
      .toEqual({ observations: [{ branchId: 'file', at: userAt }], unknown: false });
  });

  it('本代匹配由master原进程校验；伪token当用户，未命中分支不记活动', () => {
    const at = 1_790_000_000_000;
    const collector = new PreviewActivityCollector(() => at);
    collector.record(undefined, {});
    collector.record('file', probeRequestHeaders());
    collector.record('quiet', { [PROBE_MARKER_HEADER]: 'a'.repeat(48), 'x-cds-poll': 'true' });
    expect(resolvePreviewActivity(collector.snapshot(), at, at - 1000, isTrustedProbeFingerprint))
      .toEqual({ observations: [{ branchId: 'quiet', at }], unknown: false });
    expect(isTrustedProbeFingerprint(createHash('sha256').update('a'.repeat(48)).digest('hex'))).toBe(false);
  });

  it('分支或指纹容量超过硬界限明确unknown，而不是悄悄称覆盖完整', () => {
    const at = 1_790_000_000_000;
    const collector = new PreviewActivityCollector(() => at);
    for (let i = 0; i < 1025; i++) collector.record(`branch-${i}`, {});
    expect(collector.snapshot().branches).toHaveLength(1024);
    expect(resolvePreviewActivity(collector.snapshot(), at, at - 1, isTrustedProbeFingerprint).unknown).toBe(true);
    const markers = new PreviewActivityCollector(() => at);
    for (let i = 0; i < 9; i++) markers.record('file', { [PROBE_MARKER_HEADER]: i.toString(16).padStart(48, '0') });
    expect(markers.snapshot().branches[0].markers).toHaveLength(8);
    expect(resolvePreviewActivity(markers.snapshot(), at, at - 1, isTrustedProbeFingerprint).unknown).toBe(true);
    expect(resolvePreviewActivity(markers.snapshot(), at, at - 1, isTrustedProbeFingerprint, true).unknown).toBe(true);
    expect(resolvePreviewActivity(markers.snapshot(), at, at + 1, isTrustedProbeFingerprint, true))
      .toEqual({ observations: [], unknown: false });
  });

  it('可信路由退出回收历史分支；仍存活的丢失观察不得随裁剪或时间假恢复', () => {
    let at = 1_790_000_000_000;
    const collector = new PreviewActivityCollector(() => at);
    for (let i = 0; i < 1025; i++) collector.record(`branch-${i}`, {});
    collector.retainBranches(new Set(['branch-1024']));
    expect(collector.snapshot().branches).toHaveLength(0);
    expect(resolvePreviewActivity(collector.snapshot(), at, at - 1, isTrustedProbeFingerprint, true).unknown).toBe(true);
    at++; collector.record('branch-1024', {});
    expect(resolvePreviewActivity(collector.snapshot(), at, at - 1, isTrustedProbeFingerprint).unknown).toBe(false);
    collector.retainBranches(new Set());
    expect(collector.snapshot().branches).toHaveLength(0);
    expect(collector.snapshot().overflowAt).toBeUndefined();
    // 多轮正常分支更换不会把历史 branch map 永久填满。
    for (let i = 0; i < 2000; i++) {
      collector.retainBranches(new Set([`current-${i}`]));
      collector.record(`current-${i}`, {});
    }
    expect(collector.snapshot().branches).toHaveLength(1);
    expect(collector.snapshot().overflowAt).toBeUndefined();
  });

  it('合法快照持续重放旧userAt不续期，真正闲置仍可按原TTL回收', async () => {
    const f = fixture(); f.scheduler.setMaxHotBranches(2); f.scheduler.setIdleTTLSeconds(60);
    const collector = new PreviewActivityCollector(f.now); collector.record('file', {});
    f.scheduler.setPreviewActivitySource(async () => collector.snapshot(), isTrustedProbeFingerprint, f.now() - 1000);
    await f.scheduler.tick();
    const original = f.state.getBranch('file')!.lastAccessedAt;
    f.advance(60_001); await f.scheduler.tick();
    expect(f.cooled).toContain('file');
    expect(f.state.getBranch('file')!.lastAccessedAt).toBe(original);
  });

  it.each(['future', 'before-start', 'stale'] as const)('不接受%s可信时间边界以外的收据', async kind => {
    const f = fixture(); const at = f.now();
    const snapshot = { version: 1, startedAt: at - 1000, generatedAt: at,
      branches: [{ branchId: 'file', userAt: at, markers: [] }] };
    if (kind === 'future') snapshot.generatedAt = at + 1;
    if (kind === 'before-start') snapshot.branches[0].userAt = at - 1001;
    if (kind === 'stale') { snapshot.generatedAt = at - 30_001; snapshot.startedAt = at - 40_000;
      snapshot.branches[0].userAt = at - 35_000; }
    f.scheduler.setPreviewActivitySource(async () => snapshot, isTrustedProbeFingerprint, at - 500);
    const original = f.state.getBranch('file')!.lastAccessedAt;
    await f.scheduler.tick();
    expect(f.state.getBranch('file')!.lastAccessedAt).toBe(original);
    expect(f.scheduler.getSnapshot().previewActivity?.status).toBe('unknown');
  });

  it('真实启动接线与诊断两条入口保持在原受限GET，非widget或日志分类兜底', () => {
    const source = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, '../../src', file), 'utf8');
    expect(source('index.ts')).toContain('schedulerService.setPreviewActivitySource(() => readForwarderPreviewActivity(diagnosticsPort), isTrustedProbeFingerprint)');
    expect(source('forwarder-main.ts')).toContain('isPrivateForwarderDiagnostic(req)');
    expect(source('forwarder-main.ts')).toContain('JSON.stringify(proxy.getStats())');
    expect(source('forwarder-main.ts')).toContain('proxy.reconcilePreviewActivityRoutes(routes)');
    expect(source('forwarder/diagnostic-routes.ts')).toContain('previewActivity: stats.previewActivity');
    expect(source('forwarder/diagnostic-routes.ts')).toContain('opts.watcher.onChange(routes => opts.proxy.reconcilePreviewActivityRoutes(routes))');
    const handler = source('forwarder/proxy-handler.ts');
    expect(handler.indexOf('this.previewActivity.record(route.branchId, req.headers)'))
      .toBeLessThan(handler.indexOf('const activeRequestId ='));
  });
});
