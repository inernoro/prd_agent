import { createHash } from 'node:crypto';

export const workload = {
  version: 1, stores: 6, documentsPerStore: 20, contentBytes: 8192,
  rateLimit: { maxRequestsPerMinute: 100000, maxConcurrentRequests: 1024 },
  normal: { users: 2, seconds: 20, intervalMs: 1000 },
  ramp: { users: [2, 4, 8, 16, 32, 64, 128], seconds: 15, intervalMs: 0 },
  soak: { users: 2, seconds: 120, intervalMs: 1000 },
};
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { n: values.length, p50: quantile(.5), p95: quantile(.95), p99: quantile(.99),
    max: sorted.at(-1) ?? 0, mean: values.reduce((a, b) => a + b, 0) / (values.length || 1) };
}
export function summarize(samples, seconds) {
  return Object.fromEntries([...new Set(samples.map(s => s.name))].sort().map(name => {
    const rows = samples.filter(s => s.name === name);
    const ok = rows.filter(s => s.ok);
    return [name, { attempts: rows.length, errors: rows.length - ok.length,
      errorRate: (rows.length - ok.length) / rows.length, throughput: ok.length / seconds,
      client: stats(ok.map(s => s.ms)), app: stats(ok.filter(s => s.app !== undefined).map(s => s.app)),
      externalHttp: stats(ok.filter(s => s.external !== undefined).map(s => s.external)) }];
  }));
}
export function calibrate(results) {
  if (results.length < 3 || new Set(results.map(r => r.environmentId)).size !== results.length)
    throw new Error('基线需要至少三次独立干净环境的结果');
  const contract = results[0].contract;
  for (const r of results) {
    if (r.failure || digest(r.contract) !== digest(contract)) throw new Error('基线结果失败或运行契约不一致');
    if (r.commit !== results[0].commit) throw new Error('基线提交必须一致');
  }
  const limits = {};
  for (const [name] of Object.entries(results[0].phases.find(p => p.name === 'normal').metrics)) {
    const rows = results.map(r => r.phases.find(p => p.name === 'normal')?.metrics[name]);
    const transaction = ['journey', 'write'].includes(name);
    if (rows.some(r => !r || r.attempts < 30 || r.errors || (!transaction && r.app.n < 30)))
      throw new Error(`基线场景样本不足或存在错误: ${name}`);
    const bound = key => {
      const values = rows.map(r => r[key].p95);
      const high = Math.max(...values), low = Math.min(...values);
      return Math.max(high * 1.3, high + (high - low) * 3);
    };
    limits[name] = { clientP95: bound('client'), appP95: transaction ? null : bound('app'),
      errorRate: 3 / rows.reduce((n, r) => n + r.attempts, 0),
      minThroughput: Math.min(...rows.map(r => r.throughput)) * .7 };
  }
  return { schema: 1, commit: results[0].commit, contract, limits,
    sourceRuns: results.map(r => ({ environmentId: r.environmentId, commit: r.commit, startedAt: r.startedAt })),
    policy: 'p95上限=max(三次最大值*1.3, 最大值+3*极差); 错误率上限=3/总样本数(零错误95%上界); 吞吐下限=最小值*0.7' };
}
export function compare(result, baseline) {
  const failures = [];
  if (digest(result.contract) !== digest(baseline.contract)) return { pass: false, failures: ['运行契约不一致，须在同机重新校准'] };
  for (const phase of result.phases.filter(p => p.name === 'normal' || p.name === 'soak')) {
    for (const [name, limit] of Object.entries(baseline.limits)) {
      const m = phase.metrics[name];
      if (!m || m.attempts < 30) { failures.push(`${phase.name}/${name}: 样本不足`); continue; }
      if (m.errorRate > limit.errorRate) failures.push(`${phase.name}/${name}: errorRate ${m.errorRate} > ${limit.errorRate}`);
      if (m.client.p95 > limit.clientP95) failures.push(`${phase.name}/${name}: client p95 ${m.client.p95.toFixed(2)} > ${limit.clientP95.toFixed(2)} ms`);
      if (limit.appP95 !== null && (!m.app.n || m.app.p95 > limit.appP95)) failures.push(`${phase.name}/${name}: app p95 ${m.app.p95.toFixed(2)} > ${limit.appP95.toFixed(2)} ms`);
      if (m.throughput < limit.minThroughput) failures.push(`${phase.name}/${name}: 吞吐 ${m.throughput} < ${limit.minThroughput}`);
    }
  }
  if (!result.phases.some(p => p.name === 'normal')) failures.push('缺少正常负载阶段');
  if (result.failure) failures.push(result.failure);
  return { pass: failures.length === 0, failures };
}
export function capacity(phases) {
  const normal = phases.find(p => p.name === 'normal');
  if (!normal) return null;
  const stages = phases.filter(p => p.name.startsWith('ramp-'));
  const first = stages.find(p => Object.entries(p.metrics).some(([name, m]) =>
    m.errorRate > .01 || m.client.p95 > normal.metrics[name].client.p95 * 2));
  return { criterion: '任一场景错误率>1% 或 client p95>正常负载两倍；仅为本隔离配置的相对退化边界',
    firstDegradedUsers: first?.users ?? null,
    lastTestedUsers: stages.at(-1)?.users ?? null,
    stages: stages.map(p => ({ users: p.users, journeyP95: p.metrics.journey?.client.p95,
      journeysPerSecond: p.metrics.journey?.throughput, errorRate: p.metrics.journey?.errorRate })) };
}
