/**
 * Phase 9.5 — env 修改审计日志测试。
 *
 * 锁住"appendEnvChangeLog ring buffer ≤ 200 + 不记 value 只记 key + 项目隔离"。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Request } from 'express';
import { appendEnvironmentAudit } from '../../src/services/environment-audit.js';
import { StateService } from '../../src/services/state.js';

import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
describe('Phase 9.5 — StateService env audit log', () => {
  let tmpDir: string;
  let svc: StateService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-audit-'));
    svc = new StateService(path.join(tmpDir, 'state.json'), tmpDir);
    svc.load();
    svc.addProject({
      id: 'projA',
      slug: 'proj-a',
      name: 'A',
      kind: 'git',
      dockerNetwork: 'cds-a',
      legacyFlag: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });
  afterEach(async () => {
    await flushAllJsonStateStores();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('append + 读取', () => {
    svc.appendEnvChangeLog('projA', { op: 'set', keys: ['SMTP_PASSWORD'], actor: 'u1', source: 'ui' });
    const log = svc.getEnvChangeLog('projA');
    expect(log).toHaveLength(1);
    expect(log[0].op).toBe('set');
    expect(log[0].keys).toEqual(['SMTP_PASSWORD']);
    expect(log[0].actor).toBe('u1');
    expect(log[0].ts).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('ring buffer 上限 200,溢出丢最旧', () => {
    for (let i = 0; i < 250; i++) {
      svc.appendEnvChangeLog('projA', { op: 'set', keys: [`K${i}`] });
    }
    const log = svc.getEnvChangeLog('projA');
    expect(log).toHaveLength(200);
    // 最旧的 50 条应该被丢掉,首条是 K50
    expect(log[0].keys).toEqual(['K50']);
    expect(log[199].keys).toEqual(['K249']);
  });

  it('保留过期留痕供项目导出并保持普通历史的时间范围', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2024-01-05T00:00:00Z'));
      const facts = [{ eventId: 'fixture-event', projectId: 'projA', ts: new Date().toISOString(), key: 'FIXTURE_KEY',
        actor: 'fixture-agent', disposition: 'added', effect: { state: 'pending' } }] as const;
      svc.appendEnvChangeLog('projA', { op: 'set', keys: ['FIXTURE_KEY'], facts: [...facts] });
      vi.setSystemTime(new Date('2026-01-06T00:00:00Z'));
      svc.appendEnvChangeLog('projA', { op: 'set', keys: ['CURRENT_KEY'] });
      expect(svc.getEnvChangeLog('projA').flatMap(row => row.keys)).toEqual(['CURRENT_KEY']);
      expect(svc.getEnvChangeLog('projA', true).flatMap(row => row.keys)).toEqual(['FIXTURE_KEY', 'CURRENT_KEY']);
      expect(svc.getEnvChangeLog('projB', true)).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('项目级隔离:appendEnvChangeLog projA 不影响 projB', () => {
    svc.addProject({
      id: 'projB',
      slug: 'proj-b',
      name: 'B',
      kind: 'git',
      dockerNetwork: 'cds-b',
      legacyFlag: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    svc.appendEnvChangeLog('projA', { op: 'set', keys: ['A_KEY'] });
    svc.appendEnvChangeLog('projB', { op: 'set', keys: ['B_KEY'] });
    expect(svc.getEnvChangeLog('projA').map((e) => e.keys[0])).toEqual(['A_KEY']);
    expect(svc.getEnvChangeLog('projB').map((e) => e.keys[0])).toEqual(['B_KEY']);
  });

  it('移除说明里带入的配置值并保留单独的安全说明', () => {
    const before = { FIXTURE_KEY: 'synthetic-before-bxqz' };
    const after = { FIXTURE_KEY: 'synthetic-after-bxqz' };
    const request = (note: string) => ({ headers: { 'x-cds-operation-reason': note } }) as unknown as Request;
    appendEnvironmentAudit(svc, request(`Change ${before.FIXTURE_KEY} to ${after.FIXTURE_KEY}`), 'projA', 'set', before, after);
    appendEnvironmentAudit(svc, request('Move to the planned configuration'), 'projA', 'set', before, after);
    const entries = svc.getEnvChangeLog('projA');
    expect(JSON.stringify(entries)).not.toContain(before.FIXTURE_KEY);
    expect(JSON.stringify(entries)).not.toContain(after.FIXTURE_KEY);
    expect(entries[1].facts?.[0].note).toBe('Move to the planned configuration');
  });

  it('不存在的项目静默 noop(不 throw)', () => {
    expect(() => svc.appendEnvChangeLog('nope', { op: 'set', keys: ['X'] })).not.toThrow();
    expect(svc.getEnvChangeLog('nope')).toEqual([]);
  });

  it('入口 entry 不带 ts(由方法自动加),输出 entry 必带 ts', () => {
    const before = Date.now();
    svc.appendEnvChangeLog('projA', { op: 'bulk-replace', keys: ['K1', 'K2'] });
    const log = svc.getEnvChangeLog('projA');
    const ts = new Date(log[0].ts).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
