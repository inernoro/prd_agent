import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagnosticUrl, diagnosticValue, publicUptimeSample, publicMonitorObservation } from '../../src/services/monitor-evidence.js';
import { probeCustomMonitor } from '../../src/services/uptime-custom-monitor.js';
afterEach(() => vi.restoreAllMocks());
const monitor = { id: 'evidence', name: '订单读数', kind: 'health-json' as const, enabled: true, url: 'https://orders.example/health?api_key=private-value', healthComponentId: 'orders', healthField: 'observedValue' as const, healthOp: 'lte' as const, healthValue: '10', createdAt: '', updatedAt: '' };
describe('近期真实请求／响应摘录', () => {
  it('超过4KB的JSON证据仍是可读且脱敏的文本，标量读数不返回对象', () => {
    const large = JSON.stringify({ password: 'hidden-big-secret', marker: '诊断可读', rows: Array.from({ length: 20 }, () => '中'.repeat(800)) });
    const observation = publicMonitorObservation({ at: '', ok: false, elapsedMs: 1, err: large,
      results: [{ path: 'data', op: 'eq', ok: false, actual: large, expected: large, err: large }] });
    const sample = publicUptimeSample({ t: 1, up: false, ms: 1, err: large, finding: large,
      measurement: { name: '读数', field: 'observedValue', actual: large, expected: '0', op: 'eq' } });
    for (const text of [observation.err, observation.results[0].actual, observation.results[0].expected, observation.results[0].err, sample.err, sample.finding, sample.measurement?.actual]) {
      expect(typeof text).toBe('string');
      expect(text).toContain('预览');
      expect(text).not.toMatch(/hidden-big-secret|\[object Object\]/);
      expect(Buffer.byteLength(String(text))).toBeLessThanOrEqual(4096);
    }
  });
  it('真实判据错误拼入JSON时隐藏非结构化内容，实际值仍单独提供脱敏预览', () => {
    const actual = JSON.stringify({ password: 'hidden-assert-secret', count: 12 });
    const err = `实际 ${actual}，期望等于 10`;
    const observation = publicMonitorObservation({ at: '', ok: false, elapsedMs: 1,
      results: [{ path: 'payload', op: 'eq', actual, expected: '10', ok: false, err }] });
    const sample = publicUptimeSample({ t: 1, up: false, ms: 1, err, finding: err });
    expect(JSON.stringify([observation, sample])).not.toContain('hidden-assert-secret');
    expect(observation.results[0].actual).toContain('12');
    expect(observation.results[0].err).toContain('已隐藏');
    expect(sample.err).toContain('已隐藏');
  });
  it('HTTP200但实际指标越界保留收到响应与阈值证据，不把目标错误叫采集失败', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ checks: { orders: [{ componentId: 'orders', observedValue: 12, status: 'fail', password: 'not-for-evidence' }] } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const outcome = await probeCustomMonitor(monitor, 1000);
    expect(outcome.up).toBe(false); expect(outcome.measurement).toMatchObject({ actual: 12, expected: '10' });
    expect(outcome.exchange).toMatchObject({ request: { method: 'GET' }, response: { status: 200, excerpt: { observedValue: 12 } } });
    expect(JSON.stringify(outcome.exchange)).not.toMatch(/private-value|not-for-evidence/);
  });
  it('没有收到响应时不捏造HTTP或正文', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection reset'));
    const outcome = await probeCustomMonitor(monitor, 1000);
    expect(outcome.up).toBe(false); expect(outcome.exchange?.response).toBeUndefined(); expect(outcome.code).toBeUndefined();
  });
  it('观测JSON请求、嵌套actual和地址查询值脱敏，MCP调用回执保留', () => {
    const safe = publicMonitorObservation({ at: '2026-11-10T00:00:00Z', ok: false, elapsedMs: 22,
      requestBody: JSON.stringify({ password: 'hidden-password', nested: { token: 'hidden-token', count: 1 } }),
      results: [{ path: 'data', op: 'eq', ok: false, actual: JSON.stringify({ api_key: 'hidden-key', count: 2 }) }],
      upstreamCalls: [{ requestId: 'r1', operation: 'tools/call', endpoint: 'https://mcp.example/?token=opaque-secret', startedAt: '', elapsedMs: 20, received: true, status: 200, verdict: 'invalid-response', snapshot: { bodySha256: 'abc', contentOmitted: '工具正文未保留' } }],
    });
    expect(JSON.stringify(safe)).not.toMatch(/hidden-password|hidden-token|hidden-key|opaque-secret/);
    expect(safe.requestBody).toContain('count'); expect(safe.upstreamCalls?.[0]).toMatchObject({ requestId: 'r1', received: true, status: 200 });
    expect(diagnosticUrl('https://user:password@example.com/health?foo=secret')).not.toMatch(/password|user:|secret/);
  });
  it('敏感点路径、Cookie、顶层判据错误与嵌套签名地址均不能绕过脱敏', () => {
    const safe = publicMonitorObservation({ at: '', ok: false, elapsedMs: 1, err: 'data.password 实际 hidden-path-value', requestBody: JSON.stringify({ Cookie: 'hidden-cookie', sourceUrl: 'https://assets.example/image?Signature=hidden-signature', prompt: '查看 https://assets.example/image?Signature=hidden-embedded-signature' }), results: [{ path: 'data.password', op: 'eq', expected: 'hidden-expected', actual: 'hidden-path-value', err: 'hidden-path-value', ok: false }], artifactUrl: 'https://assets.example/image?Signature=hidden-signature' });
    expect(JSON.stringify(safe)).not.toMatch(/hidden-path-value|hidden-cookie|hidden-signature|hidden-expected|hidden-embedded-signature/);
    expect(safe.artifactUrl).toBeUndefined(); expect(safe.artifactProtected).toBe(true);
    expect(diagnosticUrl('data:text/plain,hidden-body')).not.toContain('hidden-body');
  });
  it('宽深数组的整个摘录硬限4KB，旧样本只公开声明的脱敏字段', () => {
    const large = Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => '中'.repeat(1000)));
    expect(Buffer.byteLength(JSON.stringify(diagnosticValue(large)))).toBeLessThanOrEqual(4096);
    const sample = publicUptimeSample({ t: 1, up: false, ms: 1, err: 'data.password 实际 hidden-path-value', observation: { at: '', ok: false, elapsedMs: 1, requestBody: '{"password":"hidden-body"}', results: [{ path: 'data.password', actual: 'hidden-path-value', op: 'eq', ok: false }] }, exchange: { request: { method: 'GET', url: 'https://user:password@example.test/?token=hidden-token' }, response: { status: 200, excerpt: { password: 'hidden-response' } }, note: '' } } as any);
    expect(JSON.stringify(sample)).not.toMatch(/hidden-|observation|user:password/);
    expect(sample.exchange?.response?.status).toBe(200);
  });

});
