import { describe, expect, it } from 'vitest';
import { businessProjects, catalogProjects, explainTarget, homeState, readStatusLocation, sortHomeTargets } from '../../web/src/lib/statusHome.js';
import type { UptimeTargetSummary } from '../../web/src/lib/monitorCenter.js';
const now = 1_700_000_000_000;
function target(over: Partial<UptimeTargetSummary> = {}): UptimeTargetSummary {
  return { id: 'monitor@a', name: '任务检查', source: 'custom', branchId: '', projectId: 'one', projectName: '项目一', profileId: 'a', probeKind: 'url', status: 'up', measured: true, lastSample: { t: now, up: true, ms: 10 }, availability24h: 1, availability7d: 1, avgLatencyMs24h: 10, sampleCount24h: 244, buckets: [], openIncidentSince: null, statusSince: now, incidentCount: 1, probeDescription: '', intervalSeconds: 300, timeoutMs: 5000, environment: 'production', environmentLabel: '生产', observeMode: 'active', ...over };
}
describe('业务总览的结论与真实证据一致', () => {
  it('无样本、无检查、暂停、逾期不显示正常；无数据不解除已有故障', () => {
    expect(homeState(target(), now)).toBe('up');
    expect(homeState(target({ observeMode: 'passive', sampleCount: 0 }), now)).toBe('unknown');
    expect(homeState(target({ lastSample: null }), now)).toBe('unknown');
    expect(homeState(target({ lastSample: { t: now, ms: 0, up: false, noData: true } }), now)).toBe('unknown');
    expect(homeState(target({ status: 'down', lastSample: { t: now, ms: 0, up: false, noData: true } }), now)).toBe('down');
    expect(homeState(target({ enabled: false }), now)).toBe('paused');
    expect(homeState(target({ lastSample: { t: now - 1_000_000, up: true, ms: 10 } }), now)).toBe('overdue');
  });
  it('同名业务按项目隔离，分支与生产存活目标不混入业务卡', () => {
    const projects = businessProjects([target(), target({ id: 'b', projectId: 'two', projectName: '项目二', status: 'down' }), target({ id: 'branch', source: 'branch' }), target({ id: 'release', source: 'release' })], now);
    expect(projects.map((p) => p.id)).toEqual(['two', 'one']);
    expect(projects.map((p) => p.targets.length)).toEqual([1, 1]);
    expect(projects[0].counts.down).toBe(1);
  });
  it('列表项目名称不被缺少名称的基础设施记录覆盖', () => {
    expect(catalogProjects([target(), target({ source: 'release', projectName: undefined })]).get('one')).toBe('项目一');
  });
  it('异常优先，已暂停异常不会继续制造待处理项', () => {
    expect(sortHomeTargets([target(), target({ id: 'down', status: 'down' }), target({ id: 'paused', status: 'down', enabled: false })], now).map((t) => t.id)).toEqual(['down', 'paused', 'monitor@a']);
  });
});
describe('通知落点与指标解释', () => {
  it('通知准确定位包含特殊字符的目标；无目标默认总览', () => {
    const id = 'monitor@任务/a&b';
    expect(readStatusLocation(new URLSearchParams({ target: id }))).toEqual({ view: 'detail', targetId: id });
    expect(readStatusLocation(new URLSearchParams())).toEqual({ view: 'home', targetId: null });
    expect(readStatusLocation(new URLSearchParams('view=invalid')).view).toBe('home');
    expect(readStatusLocation(new URLSearchParams('view=history')).view).toBe('history');
  });
  it('积压不是新故障数量；不从可任意编辑的名字猜测指标', () => {
    const t = target({ healthCheck: { componentId: 'webhook.dispatch-unresolved', field: 'observedValue', op: 'eq', value: '0' } });
    expect(explainTarget(t).meaning).toContain('同一批积压');
    expect(explainTarget(t).impact).toContain('不能断言');
    expect(explainTarget(target({ name: 'Webhook 派发' })).meaning).not.toContain('积压');
  });
});
