/*
 * 守卫：监控自发现。
 *
 * 用户 2026-09-11 的原话：「需要通过 yml 倒入吗？不应该由实现了该协议的接口
 * 动态配置吗？就像 usb 一样，用的时候连上即可。」
 *
 * 于是声明从「仓库里的一个文件」变成「服务自己回答的一段 JSON」。
 * 这么做的风险集中在三处，三处各有用例，删掉实现就红：
 *
 *   1. 自描述只决定「判什么」，不决定「打哪」——否则一个写错（或被攻陷）的
 *      服务就能把 CDS 变成内网扫描器；
 *   2. 端点打不通 ≠ 这些监控不需要了——一次网络抖动删光一个项目的监控，
 *      比故障本身更糟；
 *   3. 一条写坏不连累其它条，也不许拿默认值蒙混成一条永远绿的假判据。
 */
import { describe, expect, it } from 'vitest';

import { discoverMonitors, discoveryKey, DISCOVERY_KEY } from '../../src/services/monitor-discovery.js';
import { reconcileDiscoveredMonitors, DISCOVERED_ID_PREFIX } from '../../src/services/monitor-reconcile.js';
import type { UptimeCustomMonitor } from '../../src/types.js';

const ENDPOINT = 'https://gw.example.test/gw/v1/healthz/deep';

function doc(checks: Record<string, unknown>): unknown {
  return { status: 'pass', version: '1', serviceId: 'x', checks };
}

const fullSpec = {
  name: '网关 serving 近期未处理异常数',
  field: 'observedValue',
  op: 'eq',
  value: 0,
  intervalSeconds: 21600,
  failuresToAlarm: 1,
  severity: 'P0',
  observeMode: 'passive',
  sampleComponentId: 'serving.requests',
  publicVisible: true,
  publicName: '网关稳定度',
};

describe('解析自描述', () => {
  it('读出一条完整声明', () => {
    const { monitors, rejected } = discoverMonitors(doc({
      'serving:unhandled-exceptions': [{
        componentId: 'serving.unhandled-exceptions', observedValue: 0, status: 'pass',
        [DISCOVERY_KEY]: fullSpec,
      }],
    }), ENDPOINT);
    expect(rejected).toEqual([]);
    expect(monitors).toHaveLength(1);
    expect(monitors[0]).toMatchObject({
      key: discoveryKey(ENDPOINT, 'serving.unhandled-exceptions'),
      name: '网关 serving 近期未处理异常数',
      componentId: 'serving.unhandled-exceptions',
      field: 'observedValue', op: 'eq', value: '0',
      intervalSeconds: 21600, failuresToAlarm: 1, severity: 'P0',
      observeMode: 'passive', sampleComponentId: 'serving.requests',
      publicVisible: true, publicName: '网关稳定度',
    });
  });

  it('期望值 0 不能被当成「没填」—— 那正是最该写的那条判据', () => {
    const { monitors } = discoverMonitors(doc({
      a: [{ componentId: 'a', [DISCOVERY_KEY]: { op: 'eq', value: 0 } }],
    }), ENDPOINT);
    expect(monitors[0].value).toBe('0');
  });

  it('没报名的 check 不生成监控项，也不算被拒', () => {
    // 默认全抓会让服务加一条调试用 check 就凭空多出一条会叫人的告警。
    const { monitors, rejected } = discoverMonitors(doc({
      a: [{ componentId: 'a', observedValue: 1, status: 'pass' }],
    }), ENDPOINT);
    expect(monitors).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it('自描述里写地址一律无效 —— 判什么由它说，打哪不由它说', () => {
    // 命门 1：key 与后续探测地址都只来自 endpointUrl 参数。
    const { monitors } = discoverMonitors(doc({
      a: [{
        componentId: 'a',
        [DISCOVERY_KEY]: { op: 'eq', value: 1, url: 'http://169.254.169.254/latest/meta-data', endpoint: 'http://10.0.0.1' },
      }],
    }), ENDPOINT);
    expect(monitors[0].key).toBe(discoveryKey(ENDPOINT, 'a'));
    expect(JSON.stringify(monitors[0])).not.toContain('169.254');
    expect(JSON.stringify(monitors[0])).not.toContain('10.0.0.1');
  });

  it('三种 checks 写法都认（对象数组 / 单对象 / 数组）', () => {
    const spec = { op: 'eq', value: 1 };
    const shapes: unknown[] = [
      doc({ 'x:y': [{ componentId: 'a', [DISCOVERY_KEY]: spec }] }),
      doc({ 'x:y': { componentId: 'a', [DISCOVERY_KEY]: spec } }),
      { checks: [{ componentId: 'a', [DISCOVERY_KEY]: spec }] },
    ];
    for (const d of shapes) expect(discoverMonitors(d, ENDPOINT).monitors).toHaveLength(1);
  });
});

describe('一条写坏不连累其它条，也不拿默认值蒙混', () => {
  const bad = (spec: Record<string, unknown>) => discoverMonitors(doc({
    good: [{ componentId: 'good', [DISCOVERY_KEY]: { op: 'eq', value: 1 } }],
    bad: [{ componentId: 'bad', [DISCOVERY_KEY]: spec }],
  }), ENDPOINT);

  it('坏的被跳过并记下原因，好的照常生效', () => {
    const r = bad({ op: '差不多等于', value: 1 });
    expect(r.monitors.map((m) => m.componentId)).toEqual(['good']);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toContain('op 必须是');
  });

  it('缺期望值不许落默认值 —— 那会变成一条永远绿的假判据', () => {
    const r = bad({ op: 'eq' });
    expect(r.monitors.map((m) => m.componentId)).toEqual(['good']);
    expect(r.rejected[0].reason).toContain('必须给期望值');
  });

  it('被动观测缺样本量来源直接拒：零流量会被读成一切正常', () => {
    const r = bad({ op: 'eq', value: 0, observeMode: 'passive' });
    expect(r.monitors.map((m) => m.componentId)).toEqual(['good']);
    expect(r.rejected[0].reason).toContain('sampleComponentId');
  });

  it('间隔 / 去抖 / 严重度非法一律拒，不静默夹紧', () => {
    expect(bad({ op: 'eq', value: 1, intervalSeconds: 3 }).rejected[0].reason).toContain('intervalSeconds');
    expect(bad({ op: 'eq', value: 1, failuresToAlarm: 0 }).rejected[0].reason).toContain('failuresToAlarm');
    expect(bad({ op: 'eq', value: 1, severity: 'P9' }).rejected[0].reason).toContain('severity');
  });

  it('同一端点上重复 componentId 只认第一条，第二条记原因', () => {
    const r = discoverMonitors({
      checks: [
        { componentId: 'dup', [DISCOVERY_KEY]: { op: 'eq', value: 1 } },
        { componentId: 'dup', [DISCOVERY_KEY]: { op: 'eq', value: 2 } },
      ],
    }, ENDPOINT);
    expect(r.monitors).toHaveLength(1);
    expect(r.rejected[0].reason).toContain('重复');
  });
});

describe('对账：插上与拔出', () => {
  const hash = (s: string) => Buffer.from(s).toString('hex');
  const now = () => '2026-09-11T00:00:00.000Z';
  const base = { endpointUrl: ENDPOINT, projectId: 'proj-a', hash, now };

  const declared = discoverMonitors(doc({
    a: [{ componentId: 'a', [DISCOVERY_KEY]: { op: 'eq', value: 0, name: 'A' } }],
    b: [{ componentId: 'b', [DISCOVERY_KEY]: { op: 'gt', value: 0, name: 'B' } }],
  }), ENDPOINT).monitors;

  it('第一次插上：两条都新建，id 带自发现前缀', () => {
    const plan = reconcileDiscoveredMonitors({ ...base, discovered: declared, existing: [] });
    expect(plan.upsert).toHaveLength(2);
    expect(plan.remove).toEqual([]);
    for (const m of plan.upsert) {
      expect(m.id.startsWith(DISCOVERED_ID_PREFIX)).toBe(true);
      expect(m.origin).toBe('discovered');
      expect(m.kind).toBe('health-json');
      expect(m.url).toBe(ENDPOINT);
    }
  });

  it('声明没变就不重写 —— 每轮无脑刷会把台账的「最近改动」变成噪音', () => {
    const first = reconcileDiscoveredMonitors({ ...base, discovered: declared, existing: [] }).upsert;
    const again = reconcileDiscoveredMonitors({ ...base, discovered: declared, existing: first });
    expect(again.upsert).toEqual([]);
    expect(again.remove).toEqual([]);
  });

  it('端点改了判据 → 跟着改，且保留历史观测证据', () => {
    const first = reconcileDiscoveredMonitors({ ...base, discovered: declared, existing: [] }).upsert;
    const withObs = first.map((m) => ({ ...m, observations: [{ at: 'x', ok: true, elapsedMs: 1, results: [] }] })) as UptimeCustomMonitor[];
    const changed = discoverMonitors(doc({
      a: [{ componentId: 'a', [DISCOVERY_KEY]: { op: 'eq', value: 5, name: 'A' } }],
      b: [{ componentId: 'b', [DISCOVERY_KEY]: { op: 'gt', value: 0, name: 'B' } }],
    }), ENDPOINT).monitors;
    const plan = reconcileDiscoveredMonitors({ ...base, discovered: changed, existing: withObs });
    expect(plan.upsert).toHaveLength(1);
    expect(plan.upsert[0].healthValue).toBe('5');
    expect(plan.upsert[0].observations).toHaveLength(1);
  });

  it('端点通、某条 check 不在了 → 那条下线（拔出）', () => {
    const existing = reconcileDiscoveredMonitors({ ...base, discovered: declared, existing: [] }).upsert;
    const onlyA = declared.filter((m) => m.componentId === 'a');
    const plan = reconcileDiscoveredMonitors({ ...base, discovered: onlyA, existing });
    expect(plan.remove).toHaveLength(1);
    expect(plan.heldBecauseUnreachable).toBe(false);
  });

  it('端点整个打不通 → 一条都不下线（命门 2）', () => {
    // 一次网络抖动把一整个项目的监控删干净，比故障本身更糟：
    // 删完之后连「谁不见了」都没人知道。
    const existing = reconcileDiscoveredMonitors({ ...base, discovered: declared, existing: [] }).upsert;
    const plan = reconcileDiscoveredMonitors({ ...base, discovered: undefined, existing });
    expect(plan.remove).toEqual([]);
    expect(plan.upsert).toEqual([]);
    expect(plan.heldBecauseUnreachable).toBe(true);
  });

  it('「读到了但一条都不报」与「打不通」必须区分得开', () => {
    const existing = reconcileDiscoveredMonitors({ ...base, discovered: declared, existing: [] }).upsert;
    const empty = reconcileDiscoveredMonitors({ ...base, discovered: [], existing });
    expect(empty.remove).toHaveLength(2);
    expect(empty.heldBecauseUnreachable).toBe(false);
  });

  it('同一条 check 的 id 跨轮稳定 —— 否则每轮都是「删一条加一条」，历史全断', () => {
    const a = reconcileDiscoveredMonitors({ ...base, discovered: declared, existing: [] }).upsert;
    const b = reconcileDiscoveredMonitors({ ...base, discovered: declared, existing: [] }).upsert;
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
  });
});
