import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrate, compare, capacity, summarize, stats, workload, browserScenarios } from './metrics.mjs';

function run(id, ms = 20) {
  const samples = Array.from({ length: 100 }, () => ({ name: 'home', ok: true, ms, app: ms - 2, external: 0 }));
  return { environmentId: id, commit: 'base', contract: { schema: 1 }, startedAt: id,
    buildIdentity: { api: { actualCommit: 'base', expectedCommit: 'base', commitMatch: 'match' }, webEntries: ['/assets/index-base.js'] },
    finishedAt: '2026-11-13T00:00:00.000Z', execution: { profile: 'normal', state: 'complete' },
    browser: { pass: true, samples: Object.fromEntries(browserScenarios.map(name => [name, [100, 110, 105]])) },
    phases: [{ name: 'normal', metrics: summarize(samples, 20) }] };
}
test('零错误、足量、三次独立运行才允许校准', () => {
  assert.throws(() => calibrate([run('a'), run('b')]));
  assert.throws(() => calibrate([run('a'), run('a'), run('c')]));
  const bad = run('c'); bad.phases[0].metrics.home.errors = 1;
  assert.throws(() => calibrate([run('a'), run('b'), bad]));
});
test('短时40样本不能替代至少100样本的正常负载基线', () => {
  const short = run('short');
  short.phases[0].metrics.home.attempts = 40;
  short.phases[0].metrics.home.app.n = 40;
  assert.throws(() => calibrate([run('a'), run('b'), short]), /基线场景样本不足/);
});
test('运行快照不能复评通过，也不能进入三次基线', () => {
  const complete = run('complete');
  const baseline = calibrate([run('a'), run('b'), run('c')]);
  const checkpoint = { ...complete, execution: { profile: 'all', state: 'running' } };
  delete checkpoint.finishedAt;
  assert.equal(compare(checkpoint, baseline).pass, false);
  assert.throws(() => calibrate([checkpoint, run('b'), run('c')]), /基线执行不完整/);
  const legacy = { ...complete }; delete legacy.execution;
  assert.equal(compare(legacy, baseline).pass, false);
});
test('标为完成的all档位缺少持续运行或并发阶段仍拒绝', () => {
  const baseline = calibrate([run('a'), run('b'), run('c')]);
  const all = run('all'); all.execution.profile = 'all';
  assert.equal(compare(all, baseline).pass, false);
  const stage = name => ({ ...structuredClone(all.phases[0]), name });
  all.phases.push(...workload.ramp.users.map(n => stage(`ramp-${n}`)), stage('soak'));
  assert.equal(compare(all, baseline).pass, true);
  all.phases.splice(2, 1);
  assert.equal(compare(all, baseline).pass, false);
});
test('并发阶段仅达到既定错误率停止条件时允许提前结束，再执行恢复负载', () => {
  const baseline = calibrate([run('a'), run('b'), run('c')]);
  const all = run('all'); all.execution.profile = 'all';
  const stage = name => ({ ...structuredClone(all.phases[0]), name });
  all.phases.push(stage('ramp-2'), stage('soak'));
  assert.equal(compare(all, baseline).pass, false);
  all.phases[1].metrics.journey = { ...all.phases[1].metrics.home, errorRate: .2 };
  assert.equal(compare(all, baseline).pass, true);
});
test('终态缺失、浏览器失败和执行失败都不能形成性能通过结论', () => {
  const baseline = calibrate([run('a'), run('b'), run('c')]);
  const failed = run('failed'); failed.execution.state = 'failed';
  assert.equal(compare(failed, baseline).pass, false);
  const browser = run('browser'); browser.browser.pass = false;
  assert.equal(compare(browser, baseline).pass, false);
  const missingTime = run('time'); delete missingTime.finishedAt;
  assert.equal(compare(missingTime, baseline).pass, false);
});
test('声明SHA不能替代API编译SHA，Web也必须是同一目标提交', () => {
  const baseline = calibrate([run('a'), run('b'), run('c')]);
  const wrongApi = run('api'); wrongApi.buildIdentity.api.actualCommit = 'harness';
  assert.equal(compare(wrongApi, baseline).pass, false);
  const wrongWeb = run('web'); wrongWeb.buildIdentity.webEntries = ['/assets/index-harness.js'];
  assert.equal(compare(wrongWeb, baseline).pass, false);
  assert.throws(() => calibrate([wrongApi, run('b'), run('c')]), /编译实际SHA/);
});
test('实测基线接受同速运行，拒绝应用变慢、错误、吞吐下降和契约变化', () => {
  const baseline = calibrate([run('a', 20), run('b', 22), run('c', 21)]);
  assert.equal(compare(run('good', 21), baseline).pass, true);
  assert.equal(compare(run('slow', 350), baseline).pass, false);
  const bad = run('error'); bad.phases[0].metrics.home.errorRate = .1;
  assert.equal(compare(bad, baseline).pass, false);
  const low = run('low'); low.phases[0].metrics.home.throughput = 1;
  assert.equal(compare(low, baseline).pass, false);
  const other = run('other'); other.contract.schema = 2;
  assert.equal(compare(other, baseline).pass, false);
});
test('上游慢只增加客户端耗时，不伪装成应用耗时', () => {
  const baseline = calibrate([run('a'), run('b'), run('c')]);
  const dependency = run('dependency', 300);
  dependency.phases[0].metrics.home.app.p95 = 18;
  const result = compare(dependency, baseline);
  assert.equal(result.pass, false);
  assert.equal(result.failures.some(f => f.includes('app p95')), false);
});
test('短基线已出现的p99长尾进入噪声包络，大幅退化仍被拒绝', () => {
  const bases = ['a', 'b', 'c'].map(id => run(id, 17));
  bases[0].phases[0].metrics.home.client.p99 = 25;
  const baseline = calibrate(bases);
  const jitter = run('jitter', 23);
  jitter.phases[0].metrics.home.app.p95 = 15;
  assert.equal(baseline.limits.home.clientP95, 25);
  assert.equal(compare(jitter, baseline).pass, true);
  assert.equal(compare(run('regression', 350), baseline).pass, false);
});
test('容量阶段报告首个退化点并保留未测到边界的情况', () => {
  const normal = run('a').phases[0];
  const stage = (users, ms) => ({ ...run('x', ms).phases[0], name: `ramp-${users}`, users });
  assert.equal(capacity([normal, stage(2, 25), stage(8, 60)]).firstDegradedUsers, 8);
  assert.equal(capacity([normal, stage(2, 25)]).firstDegradedUsers, null);
});
test('错误不计入成功吞吐，保留长尾和空样本', () => {
  const summary = summarize([{ name: 'home', ok: true, ms: 7, app: 5, external: 1 },
    { name: 'home', ok: false, ms: 30000 }], 2).home;
  assert.equal(summary.errorRate, .5);
  assert.equal(summary.throughput, .5);
  assert.equal(summary.client.p95, 7);
  assert.equal(stats([]).n, 0);
});
test('API正常而用户可用时间退化时，四条浏览器主路径都会触发门禁', () => {
  const baseline = calibrate([run('a'), run('b'), run('c')]);
  assert.equal(compare(run('normal'), baseline).pass, true);
  for (const name of browserScenarios) {
    const slow = run('slow-ui'); slow.browser.samples[name] = [10000, 10000, 10000];
    const verdict = compare(slow, baseline);
    assert.equal(verdict.pass, false);
    assert.ok(verdict.failures.some(line => line.startsWith(`browser/${name}: ready p95`)));
    assert.equal(verdict.failures.some(line => line.includes('app p95')), false);
  }
});
test('用户可用时间不能缺样本，也不能沿用没有浏览器阈值的旧基线', () => {
  const baseline = calibrate([run('a'), run('b'), run('c')]);
  const partial = run('partial-ui'); partial.browser.samples.home = [100];
  assert.equal(compare(partial, baseline).pass, false);
  assert.throws(() => calibrate([partial, run('b'), run('c')]), /可用耗时/);
  const legacy = structuredClone(baseline); delete legacy.browserLimits;
  assert.equal(compare(run('normal'), legacy).pass, false);
});
