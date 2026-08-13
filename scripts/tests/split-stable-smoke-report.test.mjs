import assert from 'node:assert/strict';
import test from 'node:test';
import { splitStableSmokeReport, supervisorReportErrors } from '../split-stable-smoke-report.mjs';

const source = `
> Verdict: 不通过

## 主管先看

当前不能发布。

## 主管验收总览

| 模块 | 结论 |
|---|---|
| 视觉创作 | 部分通过 |

## 需干预事项

恢复模型服务。

## 未通过与未执行逐项清单

| caseId | 结果 |
|---|---|
| VIS-003 | 未执行 |

## 逐项验收账本

| caseId | 结果 |
|---|---|
| VIS-003 | 未执行 |

## 业务功能线与面包屑

首页 → 视觉创作 → 生成进度 → 图片结果

## 关联测试方法

[视觉方法](#视觉方法)

## 需求一一对应表

| 需求 | 状态 |
|---|---|
| 主管可读 | 通过 |

## 验收地址

[视觉创作](https://preview.example.test/visual-agent)

## 技术命令

\`node scripts/stable-smoke-run.mjs --cds-only\`

## 步骤 1 视觉创作

打开视觉创作并生成图片。
`;

test('主管报告与技术附录分离', () => {
  const result = splitStableSmokeReport(source, { technicalUrl: 'https://example.test/technical' });
  assert.match(result.supervisor, /主管验收总览/);
  assert.match(result.supervisor, /首页 → 视觉创作 → 生成进度 → 图片结果/);
  assert.match(result.supervisor, /未通过与未执行逐项清单/);
  assert.match(result.supervisor, /逐项验收账本/);
  assert.doesNotMatch(result.supervisor, /node scripts/);
  assert.match(result.technical, /node scripts/);
  assert.match(result.supervisor, /https:\/\/example\.test\/technical/);
});

test('主管报告门禁拒绝命令和源代码路径', () => {
  const clean = splitStableSmokeReport(source, { technicalUrl: 'https://example.test/technical' }).supervisor;
  assert.deepEqual(supervisorReportErrors(clean), []);
  assert.ok(supervisorReportErrors(`${clean}\nnode scripts/run.mjs`).length > 0);
  assert.ok(supervisorReportErrors(`${clean}\nprd-api/src/A.cs`).length > 0);
});
