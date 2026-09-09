/**
 * health-json 探针（2026-09-09，规则 degradation-must-alarm 层 1/2）。
 *
 * 为什么现有三种 kind 不够：http 打根路径 200、tcp 端口通、keyword 找关键字——
 * 2026-09-09 那次 500 里，serving 表面全是好的，故障只在「带着特定 appCaller 走完
 * 鉴权路径」时才出现。所以需要一种探针，让**被监控方自己**跑一遍真链路并给出
 * 定量结论，CDS 只负责定时打它、按结构化判据判。
 *
 * 守四件事：
 *   1. checks 的三种形态（标准 object+数组 / object+单对象 / 顶层数组）都能定位；
 *   2. check 不存在必须判**失败**——判据指向一条不存在的 check 说明自检端点和监控
 *      声明已经对不上，那是接线断了，绝不能当「没问题」；
 *   3. 期望值 `0` 不许被真值判断吃掉（「未处理异常数 == 0」正是最该被监控的那条）；
 *   4. 接口 200 但结论是坏的时候，探测必须判 down。
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  findHealthCheck,
  evaluateHealthJson,
  normalizeUptimeMonitorInput,
  describeMonitorProbe,
  probeCustomMonitor,
  MONITOR_KINDS,
} from '../../src/services/uptime-custom-monitor.js';

const servers: http.Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()?.close();
});

function serveJson(payload: unknown, status = 200): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/health+json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz/deep`);
    });
  });
}

describe('health-json 已登记为一种探测方式', () => {
  it('在 MONITOR_KINDS 里', () => {
    expect(MONITOR_KINDS).toContain('health-json');
  });
});

describe('findHealthCheck', () => {
  const item = { componentId: 'serving.unhandled-exceptions', observedValue: 0, status: 'pass' };

  it('认标准形态：checks 是 object、值是数组', () => {
    expect(findHealthCheck({ checks: { 'serving:exceptions': [item] } }, 'serving.unhandled-exceptions'))
      .toEqual(item);
  });

  it('认 object + 单对象的简化形态', () => {
    expect(findHealthCheck({ checks: { 'serving:exceptions': item } }, 'serving.unhandled-exceptions'))
      .toEqual(item);
  });

  it('认顶层数组的简化形态', () => {
    expect(findHealthCheck({ checks: [item] }, 'serving.unhandled-exceptions')).toEqual(item);
  });

  it('没有 componentId 字段时退回用键名匹配', () => {
    const bare = { observedValue: 3 };
    expect(findHealthCheck({ checks: { 'intent-draft.roundtrip': [bare] } }, 'intent-draft.roundtrip'))
      .toEqual(bare);
  });

  it('找不到返回 undefined，不瞎猜一条', () => {
    expect(findHealthCheck({ checks: { a: [item] } }, 'not-there')).toBeUndefined();
    expect(findHealthCheck({}, 'x')).toBeUndefined();
    expect(findHealthCheck(null, 'x')).toBeUndefined();
  });
});

describe('evaluateHealthJson', () => {
  const doc = (checks: unknown) => JSON.stringify({ status: 'pass', checks });

  it('eq 命中判通过，并回读实际值', () => {
    const r = evaluateHealthJson(
      doc({ 'intent:src': [{ componentId: 'intent-draft.roundtrip', observedValue: 'model' }] }),
      'intent-draft.roundtrip', 'observedValue', 'eq', 'model',
    );
    expect(r.ok).toBe(true);
    expect(r.observed).toBe('model');
  });

  it('走了降级就判失败，且失败信息带实际值（排障不必再打一次端点）', () => {
    const r = evaluateHealthJson(
      doc({ 'intent:src': [{ componentId: 'intent-draft.roundtrip', observedValue: 'fallback' }] }),
      'intent-draft.roundtrip', 'observedValue', 'eq', 'model',
    );
    expect(r.ok).toBe(false);
    expect(r.observed).toBe('fallback');
    expect(r.err).toContain('fallback');
  });

  it('check 不存在必须判失败——那是接线断了，不是没问题', () => {
    const r = evaluateHealthJson(doc({ other: [{ componentId: 'x' }] }), 'missing.one', 'status', 'eq', 'pass');
    expect(r.ok).toBe(false);
    expect(r.err).toContain('对不上');
  });

  it('响应不是 JSON 判失败，不当成通过', () => {
    const r = evaluateHealthJson('<html>502</html>', 'a', 'status', 'eq', 'pass');
    expect(r.ok).toBe(false);
    expect(r.err).toContain('不是合法 JSON');
  });

  it('字段缺失判失败', () => {
    const r = evaluateHealthJson(
      doc({ a: [{ componentId: 'a', status: 'pass' }] }), 'a', 'observedValue', 'eq', '1',
    );
    expect(r.ok).toBe(false);
    expect(r.err).toContain('没有 observedValue');
  });

  it('0 与 "0" 判相等：类型差异不许制造假故障', () => {
    const asNumber = evaluateHealthJson(
      doc({ a: [{ componentId: 'a', observedValue: 0 }] }), 'a', 'observedValue', 'eq', '0',
    );
    const asString = evaluateHealthJson(
      doc({ a: [{ componentId: 'a', observedValue: '0' }] }), 'a', 'observedValue', 'eq', '0',
    );
    expect(asNumber.ok).toBe(true);
    expect(asString.ok).toBe(true);
  });

  it('未处理异常数从 0 变 1 立刻判失败', () => {
    const zero = evaluateHealthJson(
      doc({ a: [{ componentId: 'a', observedValue: 0 }] }), 'a', 'observedValue', 'eq', '0',
    );
    const one = evaluateHealthJson(
      doc({ a: [{ componentId: 'a', observedValue: 1 }] }), 'a', 'observedValue', 'eq', '0',
    );
    expect(zero.ok).toBe(true);
    expect(one.ok).toBe(false);
  });

  it('大小比较要求两边都是数字，否则明说无法比较而不是静默判过', () => {
    const ok = evaluateHealthJson(
      doc({ a: [{ componentId: 'a', observedValue: 120 }] }), 'a', 'observedValue', 'lt', '500',
    );
    const bad = evaluateHealthJson(
      doc({ a: [{ componentId: 'a', observedValue: 'slow' }] }), 'a', 'observedValue', 'lt', '500',
    );
    expect(ok.ok).toBe(true);
    expect(bad.ok).toBe(false);
    expect(bad.err).toContain('无法做大小比较');
  });

  it('ne 反向成立', () => {
    const r = evaluateHealthJson(
      doc({ a: [{ componentId: 'a', status: 'fail' }] }), 'a', 'status', 'ne', 'pass',
    );
    expect(r.ok).toBe(true);
  });
});

describe('输入校验', () => {
  const base = { kind: 'health-json', url: 'https://x.test/healthz/deep', healthComponentId: 'a.b' };

  it('componentId 必填', () => {
    const r = normalizeUptimeMonitorInput({ kind: 'health-json', url: 'https://x.test/h' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('healthComponentId');
  });

  it('期望值 0 不许被真值判断拒掉（最该被监控的那条正是 == 0）', () => {
    const r = normalizeUptimeMonitorInput({ ...base, healthValue: 0 });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) expect(r.monitor.healthValue).toBe('0');
  });

  it('期望值为空判错', () => {
    const r = normalizeUptimeMonitorInput({ ...base, healthValue: '  ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('healthValue');
  });

  it('字段与运算是有限枚举，越界判错', () => {
    const badField = normalizeUptimeMonitorInput({ ...base, healthValue: '1', healthField: 'whatever' });
    const badOp = normalizeUptimeMonitorInput({ ...base, healthValue: '1', healthOp: 'matches' });
    expect(badField.ok).toBe(false);
    expect(badOp.ok).toBe(false);
  });

  it('默认取 observedValue 与 eq', () => {
    const r = normalizeUptimeMonitorInput({ ...base, healthValue: 'model' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.monitor.healthField).toBe('observedValue');
      expect(r.monitor.healthOp).toBe('eq');
    }
  });

  it('HEAD 被拒——要读响应体', () => {
    const r = normalizeUptimeMonitorInput({ ...base, healthValue: '1', method: 'HEAD' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('method');
  });

  it('探测说明写清判据，用户不必去翻配置', () => {
    const r = normalizeUptimeMonitorInput({ ...base, healthValue: '0', healthOp: 'eq' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const desc = describeMonitorProbe(r.monitor);
      expect(desc).toContain('a.b');
      expect(desc).toContain('observedValue');
      expect(desc).toContain('0');
    }
  });
});

describe('真实 HTTP 探测', () => {
  it('接口 200 但判据不成立时判 down —— 这正是这类探针的存在意义', async () => {
    const url = await serveJson({
      status: 'pass',
      checks: { 'intent:src': [{ componentId: 'intent-draft.roundtrip', observedValue: 'fallback' }] },
    });
    const outcome = await probeCustomMonitor({
      kind: 'health-json', url, method: 'GET', expectedStatus: '200-399',
      healthComponentId: 'intent-draft.roundtrip', healthField: 'observedValue', healthOp: 'eq', healthValue: 'model',
    }, 5000);

    expect(outcome.code).toBe(200);     // 接口是通的
    expect(outcome.up).toBe(false);     // 但结论是坏的
    expect(outcome.err).toContain('fallback');
  });

  it('判据成立时判 up', async () => {
    const url = await serveJson({
      status: 'pass',
      checks: { 'serving:exc': [{ componentId: 'serving.unhandled-exceptions', observedValue: 0 }] },
    });
    const outcome = await probeCustomMonitor({
      kind: 'health-json', url, method: 'GET', expectedStatus: '200-399',
      healthComponentId: 'serving.unhandled-exceptions', healthField: 'observedValue', healthOp: 'eq', healthValue: '0',
    }, 5000);

    expect(outcome.up).toBe(true);
    expect(outcome.code).toBe(200);
  });

  it('响应体不是 JSON 时判 down 并说明原因', async () => {
    const url = await serveJson('not json at all');
    const outcome = await probeCustomMonitor({
      kind: 'health-json', url, method: 'GET', expectedStatus: '200-399',
      healthComponentId: 'a', healthField: 'status', healthOp: 'eq', healthValue: 'pass',
    }, 5000);

    expect(outcome.up).toBe(false);
    expect(outcome.err).toContain('不是合法 JSON');
  });
});
