/**
 * 功能监控（2026-09-09）：把业务真跑一遍，再在响应上逐条判。
 *
 * 与 health-json 的分工：那个读服务自己给的自检结论（抓「后台在炸」），
 * 这个自己发一次真请求、按判据验收返回值（抓「后台没炸但产出不对」）。
 * 「生图接口通、返回的却是 512×512」只有后者抓得住。
 *
 * 守的几件事，每一件都是「写错了不会报错，只会让判据恒绿或恒红」：
 *   1. 比较只有一份实现，0 与 "0" 不制造假故障；
 *   2. 判据取不到字段必须判失败，不是当通过；
 *   3. 判据全部跑完不短路——一次要能看出四条里哪条挂了；
 *   4. 随机提示词展开后仍是合法 JSON（带引号的素材不能把请求体写坏）；
 *   5. 没有判据的功能监控存不进来（那是一条永远绿的假判据）；
 *   6. 判据不通过时产物地址照样留下——那张不该是 512² 的图正是要看的东西。
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { compareValue, evaluateAssertions, readPath } from '../../src/services/monitor-assertions.js';
import {
  expandRequestTemplate,
  normalizeUptimeMonitorInput,
  probeCustomMonitor,
  describeMonitorProbe,
  MONITOR_KINDS,
} from '../../src/services/uptime-custom-monitor.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const servers: http.Server[] = [];
afterEach(() => { while (servers.length) servers.pop()?.close(); });

function serve(handler: (body: string) => { status?: number; payload: unknown }): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push(body);
        const out = handler(body);
        res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
        res.end(typeof out.payload === 'string' ? out.payload : JSON.stringify(out.payload));
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/image/gen`, seen });
    });
  });
}

describe('取值与比较', () => {
  it('点分路径支持数组下标', () => {
    expect(readPath({ data: { images: [{ url: 'a' }, { url: 'b' }] } }, 'data.images.1.url')).toBe('b');
  });

  it('取不到返回 undefined，不瞎猜', () => {
    expect(readPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(readPath({ list: [1] }, 'list.5')).toBeUndefined();
  });

  it('0 与 "0" 判相等：类型差异不许制造假故障', () => {
    expect(compareValue(0, 'eq', '0').ok).toBe(true);
    expect(compareValue('0', 'eq', '0').ok).toBe(true);
  });

  it('字段缺失时 eq 判失败而不是通过', () => {
    const r = compareValue(undefined, 'eq', '1024');
    expect(r.ok).toBe(false);
    expect(r.err).toContain('不存在');
  });

  it('exists / absent 是两个方向', () => {
    expect(compareValue('x', 'exists', undefined).ok).toBe(true);
    expect(compareValue(undefined, 'exists', undefined).ok).toBe(false);
    expect(compareValue(undefined, 'absent', undefined).ok).toBe(true);
    expect(compareValue('x', 'absent', undefined).ok).toBe(false);
  });

  it('大小比较拒绝非数字，而不是静默判过', () => {
    const r = compareValue('slow', 'lt', '30000');
    expect(r.ok).toBe(false);
    expect(r.err).toContain('无法做大小比较');
  });

  it('判据全部跑完不短路：一次看出哪几条挂了', () => {
    const { ok, results } = evaluateAssertions(
      { status: 'succeeded', image: { width: 1024, height: 512 }, elapsedMs: 9140 },
      [
        { path: 'status', op: 'eq', value: 'succeeded' },
        { path: 'image.width', op: 'eq', value: '1024' },
        { path: 'image.height', op: 'eq', value: '1024' },
        { path: 'elapsedMs', op: 'lt', value: '30000' },
      ],
    );
    expect(ok).toBe(false);
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.ok)).toEqual([true, true, false, true]);
    expect(results[2].actual).toBe('512');
  });
});

describe('随机提示词', () => {
  it('每次展开成不同素材', () => {
    const a = expandRequestTemplate('{"prompt":"{{randomPrompt}}"}', () => 0);
    const b = expandRequestTemplate('{"prompt":"{{randomPrompt}}"}', () => 1);
    expect(a).not.toBe(b);
  });

  it('展开后仍是合法 JSON——固定提示词会被上游缓存，所以必须随机，但不能写坏请求体', () => {
    for (let i = 0; i < 8; i += 1) {
      const out = expandRequestTemplate('{"prompt":"{{randomPrompt}}","size":"1024x1024"}', () => i);
      expect(() => JSON.parse(out), out).not.toThrow();
    }
  });

  it('没有占位符时原样返回', () => {
    expect(expandRequestTemplate('{"a":1}')).toBe('{"a":1}');
  });
});

describe('输入校验', () => {
  const base = {
    kind: 'functional',
    url: 'https://x.test/api/image/gen',
    assertions: [{ path: 'status', op: 'eq', value: 'succeeded' }],
  };

  it('已登记为一种探测方式', () => {
    expect(MONITOR_KINDS).toContain('functional');
  });

  it('没有判据存不进来——那是一条永远绿的假判据', () => {
    const r = normalizeUptimeMonitorInput({ kind: 'functional', url: 'https://x.test/a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('assertions');
  });

  it('POST 能存（不被 GET/HEAD 那套挡住）', () => {
    const r = normalizeUptimeMonitorInput({ ...base, requestMethod: 'POST', requestBody: '{"a":1}' });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) expect(r.monitor.requestMethod).toBe('POST');
  });

  it('请求体按展开后的样子校验 JSON', () => {
    const good = normalizeUptimeMonitorInput({ ...base, requestBody: '{"prompt":"{{randomPrompt}}"}' });
    const bad = normalizeUptimeMonitorInput({ ...base, requestBody: '{"prompt":}' });
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.field).toBe('requestBody');
  });

  it('期望值 0 不被真值判断吃掉', () => {
    const r = normalizeUptimeMonitorInput({ ...base, assertions: [{ path: 'errors', op: 'eq', value: 0 }] });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (r.ok) expect(r.monitor.assertions?.[0].value).toBe('0');
  });

  it('exists 不必填期望值', () => {
    const r = normalizeUptimeMonitorInput({ ...base, assertions: [{ path: 'image.url', op: 'exists' }] });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
  });

  it('未知运算被拒', () => {
    const r = normalizeUptimeMonitorInput({ ...base, assertions: [{ path: 'a', op: 'matches', value: 'x' }] });
    expect(r.ok).toBe(false);
  });

  it('编辑判据不清空历史证据', () => {
    const existing = normalizeUptimeMonitorInput({ ...base, id: 'm1' });
    expect(existing.ok).toBe(true);
    if (!existing.ok) return;
    existing.monitor.observations = [{ at: '2026-09-09T00:00:00.000Z', ok: true, elapsedMs: 10, results: [] }];
    const edited = normalizeUptimeMonitorInput(
      { ...base, id: 'm1', assertions: [{ path: 'status', op: 'eq', value: 'done' }] },
      { existing: existing.monitor },
    );
    expect(edited.ok).toBe(true);
    if (edited.ok) expect(edited.monitor.observations).toHaveLength(1);
  });

  it('探测说明写清判据，用户不必翻配置', () => {
    const r = normalizeUptimeMonitorInput({
      ...base,
      requestBody: '{"prompt":"{{randomPrompt}}"}',
      assertions: [{ path: 'image.height', op: 'eq', value: '1024' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const d = describeMonitorProbe(r.monitor);
      expect(d).toContain('image.height eq 1024');
      expect(d).toContain('随机');
    }
  });
});

describe('真实探测', () => {
  const monitor = (url: string, overrides: Record<string, unknown> = {}) => ({
    kind: 'functional' as const,
    url,
    requestMethod: 'POST' as const,
    requestBody: '{"prompt":"{{randomPrompt}}","size":"1024x1024"}',
    artifactUrlPath: 'image.url',
    assertions: [
      { path: 'status', op: 'eq', value: 'succeeded' },
      { path: 'image.width', op: 'eq', value: '1024' },
      { path: 'image.height', op: 'eq', value: '1024' },
    ],
    ...overrides,
  });

  it('全部判据通过判 up，并留下产物与本次请求体', async () => {
    const { url, seen } = await serve(() => ({
      payload: { status: 'succeeded', image: { width: 1024, height: 1024, url: 'https://cdn.test/a.png' } },
    }));
    const r = await probeCustomMonitor(monitor(url), 8000);

    expect(r.up).toBe(true);
    expect(r.observation?.artifactUrl).toBe('https://cdn.test/a.png');
    expect(r.observation?.results).toHaveLength(3);
    expect(r.observation?.requestBody).toContain('"size":"1024x1024"');
    expect(JSON.parse(seen[0]).prompt).toBeTruthy();
  });

  it('尺寸不对判 down，但产物照样留下——那张图正是要看的东西', async () => {
    const { url } = await serve(() => ({
      payload: { status: 'succeeded', image: { width: 1024, height: 512, url: 'https://cdn.test/small.png' } },
    }));
    const r = await probeCustomMonitor(monitor(url), 8000);

    expect(r.up).toBe(false);
    expect(r.code).toBe(200);
    expect(r.err).toContain('image.height');
    expect(r.observation?.artifactUrl).toBe('https://cdn.test/small.png');
    expect(r.observation?.results.filter((x) => !x.ok)).toHaveLength(1);
  });

  it('响应不是 JSON 判 down 并说明原因', async () => {
    const { url } = await serve(() => ({ payload: 'not json' }));
    const r = await probeCustomMonitor(monitor(url), 8000);
    expect(r.up).toBe(false);
    expect(r.err).toContain('不是合法 JSON');
    expect(r.observation?.ok).toBe(false);
  });

  it('HTTP 500 也走判据，不靠状态码下结论', async () => {
    const { url } = await serve(() => ({ status: 500, payload: { status: 'failed' } }));
    const r = await probeCustomMonitor(monitor(url), 8000);
    expect(r.up).toBe(false);
    expect(r.code).toBe(500);
    expect(r.observation?.results.some((x) => !x.ok)).toBe(true);
  });
});

describe('接线守卫', () => {
  it('轮次必须把观测证据落账，否则详情页永远没有画廊', () => {
    const src = fs.readFileSync(path.join(REPO, 'cds/src/services/uptime-monitor.ts'), 'utf8');
    expect(src).toContain('recordMonitorObservation?.(target.monitor.id, observation)');
  });

  it('index.ts 必须注入落账实现', () => {
    const src = fs.readFileSync(path.join(REPO, 'cds/src/index.ts'), 'utf8');
    expect(src).toContain('recordMonitorObservation:');
    expect(src).toContain('stateService.recordMonitorObservation(');
  });
});
