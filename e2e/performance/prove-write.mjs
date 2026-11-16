import fs from 'node:fs';
import path from 'node:path';
import { executionErrors } from './metrics.mjs';

const dir = process.argv[2];
if (!dir) throw new Error('用法: node prove-write.mjs RESULT_DIRECTORY');
const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
const fixture = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'));
const workload = result.contract?.workload;
const failures = executionErrors(result);
if (![2, 3].includes(workload?.version) || workload.writeFlow !== 'edit-existing-document')
  failures.push('核心写入必须对应实际页面的已有文档编辑保存');
if (fixture.writers?.length !== workload?.writerDocuments
    || new Set(fixture.writers).size !== fixture.writers?.length
    || fixture.writers?.length < Math.max(...(workload?.ramp?.users ?? [Infinity])))
  failures.push('所有并发用户必须有足量且互不重复的独立文档');
if (fixture.totalDocuments !== workload?.stores * workload?.documentsPerStore + workload?.writerDocuments)
  failures.push('文档规模与合同不符');
const phases = new Set(result.phases.map(phase => phase.name));
const rows = fs.readFileSync(path.join(dir, 'requests.ndjson'), 'utf8').trim().split('\n')
  .filter(Boolean).map(line => JSON.parse(line)).filter(row => phases.has(row.phase));
const allowed = new Set(['home', 'knowledge-list', 'document-open', 'write-save', 'write-readback', 'write-versions', 'write', 'journey']);
for (const row of rows) if (!allowed.has(row.name)) failures.push(`计时流程混入非核心写入步骤: ${row.name}`);
for (const phase of result.phases) {
  for (const name of allowed) {
    const observed = rows.filter(row => row.phase === phase.name && row.name === name);
    const metric = phase.metrics[name];
    if (!metric || !observed.length || observed.length !== metric.attempts
        || observed.filter(row => !row.ok).length !== metric.errors)
      failures.push(`${phase.name}/${name}: 原始请求与成功失败统计不一致`);
  }
  if (phase.metrics.write?.attempts !== phase.metrics['write-save']?.attempts)
    failures.push(`${phase.name}: 写入失败必须计入写入事务，不能仅统计成功`);
}
if (failures.length) throw new Error([...new Set(failures)].join('; '));
console.log(JSON.stringify({ verified: true, flow: workload.writeFlow, independentWriterDocuments: fixture.writers.length,
  phases: [...phases], observedRows: rows.length, cleanup: '销毁本轮隔离容器、卷与网络；不在计时流程中删除文档' }, null, 2));
