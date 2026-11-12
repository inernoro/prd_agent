import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrate, compare, capacity, summarize, stats } from './metrics.mjs';

function run(id, ms = 20) {
  const samples = Array.from({ length: 100 }, () => ({ name: 'home', ok: true, ms, app: ms - 2, external: 0 }));
  return { environmentId: id, commit: 'base', contract: { schema: 1 }, startedAt: id,
    phases: [{ name: 'normal', metrics: summarize(samples, 20) }] };
}
test('零错误、足量、三次独立运行才允许校准', () => {
  assert.throws(() => calibrate([run('a'), run('b')]));
  assert.throws(() => calibrate([run('a'), run('a'), run('c')]));
  const bad = run('c'); bad.phases[0].metrics.home.errors = 1;
  assert.throws(() => calibrate([run('a'), run('b'), bad]));
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
