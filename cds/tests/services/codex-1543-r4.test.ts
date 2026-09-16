/*
 * Codex PR #1543 第四轮（5df810d1 上）——五条直接缺陷各配一条会红的判据。
 *
 *   1. no-op 更新（HEAD 已是最新）记录不带 updateMode，restartStatus 把它当「该重启却没换进程」；
 *   2. 换了投递目标（Bark key / Webhook 地址 / MAP 凭据）却沿用旧的投递证明，通道假绿；
 *   3. 换 masterPort 之后旧的回环自检端点永远留着，十三条死监控一直挂着。
 * （全局面板的 unknown 档与前端「通着」口径在 tests/web 里。）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { alarmTransportChanged, parseChannel } from '../../src/routes/alarm-channels.js';
import { AlarmLedger } from '../../src/services/alarm-channel.js';
import { alarmTransportFingerprint, type AlarmChannelConfig } from '../../src/services/alarm-route.js';
import { resolveRestartStatus } from '../../src/services/self-restart-wait.js';
import {
  SELF_PROJECT_ID,
  ensureSelfMonitoring,
  type SelfMonitoringState,
} from '../../src/services/self-monitoring-bootstrap.js';
import type { Project } from '../../src/types.js';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const codeOf = (src: string): string => src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^\s*\/\/.*$/gm, '');

describe('P1 no-op 更新不需要重启', () => {
  const T0 = '2026-09-16T08:16:46.000Z';
  const before = '2026-09-16T08:10:00.000Z';
  const base = { activeSelfUpdate: null, restartWait: null, daemonReadyAt: null, pidStartedAt: before };

  it('updateMode=noOp 或存量写法 noOp:true 的成功记录 → not_required，不是 incomplete', () => {
    expect(resolveRestartStatus({ ...base, lastSelfUpdate: { status: 'success', updateMode: 'noOp', ts: T0 } })).toBe('not_required');
    expect(resolveRestartStatus({ ...base, lastSelfUpdate: { status: 'success', ts: T0, noOp: true } })).toBe('not_required');
    // 对照：真正该重启的记录仍是 incomplete
    expect(resolveRestartStatus({ ...base, lastSelfUpdate: { status: 'success', updateMode: 'restart', ts: T0 } })).toBe('incomplete');
  });

  it('两条 no-op 分支（自更新 / 强制同步）都在 done 里标 mode=noOp、记录里标 updateMode=noOp', () => {
    const branches = codeOf(read('../../src/routes/branches.ts'));
    const doneNoOp = branches.match(/sendSSE\(res, 'done', \{ message: `[^`]*`, mode: 'noOp' \}\)/g) ?? [];
    expect(doneNoOp, 'done 事件带 mode=noOp 的分支数').toHaveLength(2);
    const recordNoOp = branches.match(/updateMode: 'noOp'/g) ?? [];
    expect(recordNoOp, '记录带 updateMode=noOp 的分支数').toHaveLength(2);
  });
});

describe('P1 换了投递目标就不许沿用旧的投递证明', () => {
  const now = 1_700_000_000_000;
  const proof = { at: now - 60_000, ok: true, kind: 'drill' as const };
  const bark = (): AlarmChannelConfig => ({
    id: 'c1', name: '手机', kind: 'bark', enabled: true, projects: [], events: ['business-down'],
    bark: { key: 'old-key-000000' }, lastDelivery: proof, createdAt: now - 1, updatedAt: now - 1,
  });
  const body = (over: Record<string, unknown>): Record<string, unknown> => ({ kind: 'bark', name: '手机', events: ['business-down'], ...over });

  it('改名 / 改事件 / 改项目：证明保留', () => {
    const next = parseChannel(body({ name: '我的手机', events: ['business-down', 'infra-down'], projects: ['p1'] }), bark(), now);
    expect(next.lastDelivery).toEqual(proof);
    expect(alarmTransportChanged(bark(), next)).toBe(false);
  });

  it('换 Bark key：证明丢掉，通道回到「没发过」', () => {
    const next = parseChannel(body({ bark: { key: 'new-key-111111' } }), bark(), now);
    expect(next.lastDelivery).toBeUndefined();
    expect(alarmTransportChanged(bark(), next)).toBe(true);
    expect(new AlarmLedger().view(next, true).status).toBe('untested');
  });

  it('Webhook 改地址 / 改请求头 / 改模板都算换目标；MAP 换凭据也算', () => {
    const wh: AlarmChannelConfig = {
      id: 'w', name: '群', kind: 'webhook', enabled: true, projects: [], events: ['business-down'],
      webhook: { method: 'POST', url: 'https://hook.example.test/a', headers: { 'X-Token': 't1' } }, createdAt: 1, updatedAt: 1,
    };
    const fp = alarmTransportFingerprint(wh);
    expect(alarmTransportFingerprint({ ...wh, webhook: { ...wh.webhook!, url: 'https://hook.example.test/b' } })).not.toBe(fp);
    expect(alarmTransportFingerprint({ ...wh, webhook: { ...wh.webhook!, headers: { 'X-Token': 't2' } } })).not.toBe(fp);
    expect(alarmTransportFingerprint({ ...wh, webhook: { ...wh.webhook!, bodyTemplate: '{"x":1}' } })).not.toBe(fp);
    expect(alarmTransportFingerprint({ ...wh, name: '别的名字', events: ['infra-down'] })).toBe(fp);
    const map: AlarmChannelConfig = {
      id: 'm', name: 'MAP', kind: 'map', enabled: true, projects: [], events: ['business-down'],
      map: { endpoint: 'https://map.example.test', keyId: 'k1', username: 'u', privateKey: '-----BEGIN PRIVATE KEY-----\nA\n-----END PRIVATE KEY-----' }, createdAt: 1, updatedAt: 1,
    };
    expect(alarmTransportFingerprint({ ...map, map: { ...map.map!, keyId: 'k2' } })).not.toBe(alarmTransportFingerprint(map));
  });

  it('写接口在换目标时把内存台账里那条也清掉（不然 view 仍按旧成功记录说 healthy）', () => {
    const routes = codeOf(read('../../src/routes/alarm-channels.ts'));
    expect(routes).toMatch(/if \(previous && alarmTransportChanged\(previous, next\)\) deps\.ledger\.forget\(next\.id\);\s*\n\s*deps\.upsert\(next\);/);
  });
});

describe('P2 换了 masterPort：旧的回环端点退掉，只留当前这一条', () => {
  const NOW = 1_700_000_000_000;
  function fakeState(): SelfMonitoringState & { projects: Project[] } {
    const projects: Project[] = [];
    return {
      projects,
      getProjects: () => projects,
      addProject: (p) => { projects.push(p); },
      addMonitorEndpoint: (projectId, url) => {
        const p = projects.find((x) => x.id === projectId);
        if (!p) return false;
        p.monitorEndpoints = [...(p.monitorEndpoints || []), url];
        return true;
      },
      removeMonitorEndpoint: (projectId, url) => {
        const p = projects.find((x) => x.id === projectId);
        if (!p || !(p.monitorEndpoints || []).includes(url)) return false;
        p.monitorEndpoints = (p.monitorEndpoints || []).filter((u) => u !== url);
        return true;
      },
    };
  }

  it('7000 → 7100：旧端点被退掉、新端点插上，用户自己插的别的端点不动', () => {
    const state = fakeState();
    ensureSelfMonitoring(state, 7000, NOW);
    state.addMonitorEndpoint(SELF_PROJECT_ID, 'https://other.example.test/api/self-check');
    const moved = ensureSelfMonitoring(state, 7100, NOW + 1000);
    expect(moved.retiredEndpoints).toEqual(['http://127.0.0.1:7000/api/self-check']);
    expect(moved.addedEndpoint).toBe(true);
    expect(state.projects[0].monitorEndpoints).toEqual([
      'https://other.example.test/api/self-check',
      'http://127.0.0.1:7100/api/self-check',
    ]);
  });

  it('端口没变：什么都不退', () => {
    const state = fakeState();
    ensureSelfMonitoring(state, 7000, NOW);
    expect(ensureSelfMonitoring(state, 7000, NOW + 1000).retiredEndpoints).toEqual([]);
  });
});
