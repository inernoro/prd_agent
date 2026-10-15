import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const specification = readFileSync(new URL('../../e2e/specs/stable-smoke.spec.ts', import.meta.url), 'utf8');
const scopedCreations = [
  ['COMMON-001', 'title'],
  ['FILE-001][FILE-002][FILE-006][FILE-007][FILE-009][FILE-010', 'runKey'],
  ['FILE-004', 'runKey'],
  ['FILE-005][REG-file-001', 'runKey'],
  ['LIT-001', 'title'],
  ['LIT-008', 'title'],
];

function creationExpression(caseIds) {
  const start = specification.indexOf(`test('[${caseIds}]`);
  assert.notEqual(start, -1, `原caseId必须仍有实际执行入口：${caseIds}`);
  const end = specification.indexOf('\n  test(', start + 1);
  return specification.slice(start, end < 0 ? undefined : end);
}

for (const [caseIds, variable] of scopedCreations) {
  test(`本轮资源归属 ${caseIds} 的真实创建名称使用runId且保留retry`, () => {
    const body = creationExpression(caseIds);
    const expression = body.match(new RegExp(`const ${variable} = ([^;]+);`))?.[1];
    assert.ok(expression, `缺少实际创建名称表达式：${caseIds}/${variable}`);
    const names = [];
    for (const runId of ['stsmk-20261015-approved-a', 'stsmk-20261015-approved-b']) {
      for (const retry of [0, 1]) {
        const value = vm.runInNewContext(expression, {
          requiredEnv: name => {
            assert.equal(name, 'STABLE_SMOKE_RUN_ID');
            return runId;
          },
          test: { info: () => ({ retry }) },
          Date: { now: () => 1792062000000 },
        });
        assert.equal(typeof value, 'string');
        assert.ok(value.startsWith(`${runId}-`), `${caseIds}越出本轮前缀：${value}`);
        assert.ok(value.includes(`-r${retry}`), `${caseIds}丢失重试归属：${value}`);
        names.push(value);
      }
    }
    assert.equal(new Set(names).size, 4, '不同轮次和唯一重试不能复用同一个创建名称');
  });
}

test('本轮资源归属 不允许再用时间戳另造stsmk轮次代替当前runId', () => {
  assert.equal(/\bconst\s+(?:runKey|title)\s*=\s*`stsmk-\$\{Date\.now\(\)/.test(specification), false,
    '创建名称不能重新生成另一个时间戳轮次');
});
