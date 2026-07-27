/**
 * 复制集压测四个端点的 Activity Monitor 中文 label 守卫（2026-07-27）。
 *
 * 压测端点新增时漏登记 resolveApiLabel，启动会打 [api-label] warning，
 * 面板上只显示裸 URL，用户看不懂 AI 在干什么（见 cds/CLAUDE.md §0.1）。
 *
 * 额外锁住一条顺序陷阱：`/replica-loadtests/:runId/cancel` 必须能拿到自己的
 * label，不能被单段 `:runId` 的 pattern 吞掉。
 */

import { describe, it, expect } from 'vitest';
import { resolveApiLabel } from '../../src/server.js';

describe('resolveApiLabel — 复制集压测端点', () => {
  it('POST /branches/:id/replica-loadtests → 发起压测', () => {
    expect(resolveApiLabel('POST', '/branches/prd-agent-main/replica-loadtests')).toBe('发起压测');
  });

  it('GET /branches/:id/replica-loadtests → 列出压测记录', () => {
    expect(resolveApiLabel('GET', '/branches/prd-agent-main/replica-loadtests')).toBe('列出压测记录');
  });

  it('GET /branches/:id/replica-loadtests/:runId → 查看压测报告', () => {
    expect(resolveApiLabel('GET', '/branches/prd-agent-main/replica-loadtests/run-1')).toBe('查看压测报告');
  });

  it('POST /branches/:id/replica-loadtests/:runId/cancel → 取消压测（不被单段 runId 吞掉）', () => {
    const label = resolveApiLabel('POST', '/branches/prd-agent-main/replica-loadtests/run-1/cancel');
    expect(label).toBe('取消压测');
    expect(label).not.toBe('查看压测报告');
  });

  it('四个端点都必须有 label，不能落到空串（空串 = 面板显示裸 URL）', () => {
    const cases: Array<[string, string]> = [
      ['POST', '/branches/b1/replica-loadtests'],
      ['GET', '/branches/b1/replica-loadtests'],
      ['GET', '/branches/b1/replica-loadtests/r1'],
      ['POST', '/branches/b1/replica-loadtests/r1/cancel'],
    ];
    for (const [method, route] of cases) {
      expect(resolveApiLabel(method, route), `${method} ${route}`).not.toBe('');
    }
  });

  it('压测 label 不会误伤既有复制集端点', () => {
    expect(resolveApiLabel('GET', '/branches/b1/replica-sets')).toBe('查看复制集');
    expect(resolveApiLabel('POST', '/branches/b1/replica-plans')).toBe('保存执行计划');
  });
});
