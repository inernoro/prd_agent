import assert from 'node:assert/strict';
import test from 'node:test';
import { composeSupervisorReport } from '../compose-stable-smoke-supervisor-report.mjs';

test('主管功能账本与视觉截图合成为单份报告且不带入旧结论', () => {
  const functional = `# 新主管报告

> 主管结论：2 条 caseId 中有 1 条不通过。

## 主管先看

| 决策项 | 结论 | 主管动作 |
|---|---|---|
| 视觉证据 | 旧口径 124 张 | 查看旧报告 |

## 主管验收总览

新结论

## 需干预事项

需先处理

## 未通过与未执行逐项清单

31 项缺口

## 逐项验收账本

206 项账本
`;
  const visual = `# 旧视觉报告

## 主管验收总览

| 模块 | 真实面包屑 | 冒烟 | 功能 | 视觉 | 最高问题 | 是否需干预 | 查看步骤 | 查看截图 | 查看缺陷 | 关联测试方法 |
|---|---|---|---|---|---|---|---|---|---|---|
| 视觉创作 | 首页 → 视觉创作 → 结果 | 通过 | 通过 | 部分通过 | P2 | 是 | [步骤](#步骤-1-视觉创作) | [截图](#fig-001-visual) | [缺陷](#缺陷清单) | [方法](#关联测试方法) |

## 视觉证据预算

124 张

## 缺陷清单

视觉缺陷

## 改动断言表

| 改动断言 | 必要证明 | 当前结果 |
|---|---|---|
| 视觉结果 | 截图 | 部分通过 |

## 页面优先证据分层

| 用户可见页面 | 内部佐证 |
|---|---|
| 结果页 | 回读 |

## 改动断言到证据表

| 改动断言 | 必要证明 | 实际证据 | 关联性 |
|---|---|---|---|
| 视觉结果 | 截图 | 图001 | 直接 |

## 步骤 1 视觉创作

{{IMG:001-visual}}
`;
  const visualGate = `# 视觉门禁

## 主管先看

| 项目 | 结果 | 说明 |
|---|---|---|
| 可审核证据 | 0/148 | 逐项核销 |
| 模块通过 | 0/10 | 缺口未关闭 |

## 模块覆盖

| 模块 | 视觉结论 | 真实面包屑 |
|---|---|---|
| 视觉创作 | 不通过 | 首页 → 视觉创作 → 结果 |

## 需处理的 1 项异常

| 模块 | 结果 |
|---|---|
| 视觉创作 | 不通过 |

## 视觉异常证据索引

124 张逐图判定

## 逐张视觉证据账本

| 序号 | 测试结果 |
|---:|---|
| 1 | 需干预 |

## 视觉证据图片

![视觉证据](/tmp/visual-evidence.png)

## 视觉测试方法

逐状态核对
`;
  const visualPlan = `# 视觉取证执行清单

## 逐模块视觉取证任务

148 项逐项清单
`;
  const composed = composeSupervisorReport(functional, visual, visualGate, visualPlan);
  assert.match(composed, /2 条 验收项 中有 1 条不通过/);
  assert.equal((composed.match(/## 主管验收总览/g) || []).length, 1);
  assert.equal((composed.match(/## 主管先看/g) || []).length, 1);
  assert.match(composed, /视觉验收 \| 0\/148 张可审核证据，0\/10 个模块通过/);
  assert.doesNotMatch(composed, /旧口径 124 张|caseId/);
  assert.match(composed, /Verdict: fail/);
  assert.doesNotMatch(composed, /## 视觉证据预算/);
  assert.match(composed, /206 项账本/);
  assert.doesNotMatch(composed, /\{\{IMG:001-visual\}\}/);
  assert.match(composed, /## 缺陷清单/);
  assert.equal((composed.match(/## 改动断言表/g) || []).length, 1);
  assert.match(composed, /124 张逐图判定/);
  assert.match(composed, /## 逐张视觉证据账本/);
  assert.match(composed, /## 需处理的 1 项异常/);
  assert.match(composed, /## 视觉证据图片/);
  assert.match(composed, /!\[视觉证据\]\(\/tmp\/visual-evidence\.png\)/);
  assert.match(composed, /## 视觉测试方法/);
  assert.match(composed, /148 项逐项清单/);
  assert.match(composed, /\| 视觉创作 \| 首页 → 视觉创作 → 结果 \| 通过 \| 通过 \| 不通过 \| P2 \| 是 \|/);
  assert.doesNotMatch(composed, /\| 视觉创作 \| 首页 → 视觉创作 → 结果 \| 通过 \| 通过 \| 部分通过 \| P2 \| 是 \|/);
  assert.ok(composed.indexOf('模块覆盖') < composed.indexOf('未通过与未执行逐项清单'));
  assert.ok(composed.indexOf('148 项逐项清单') > composed.indexOf('未通过与未执行逐项清单'));
  assert.ok(composed.indexOf('逐项验收账本') < composed.indexOf('逐张视觉证据账本'));
});

test('功能报告缺少主管先看时自动生成双账本首屏', () => {
  const functional = '# 功能报告\n\n> 主管结论：不通过。共 20 项，12 项通过、2 项不通过、6 项未执行。\n\n## 主管验收总览\n\n模块总览';
  const visual = '# 视觉报告';
  const gate = `# 门禁\n\n## 主管先看\n\n| 项目 | 结果 | 说明 |\n|---|---|---|\n| 能否发布 | 不可以 | 有异常 |\n| 状态结果 | 通过 125，不通过 9，需补证 7，需干预 7 | 严格结论 |\n| 可审核证据 | 148/148 | 已核销 |`;
  const report = composeSupervisorReport(functional, visual, gate);
  assert.match(report, /## 主管先看/);
  assert.match(report, /功能验收 \| 12\/20 通过，2 不通过，6 未执行/);
  assert.match(report, /视觉验收 \| 148\/148；通过 125，不通过 9，需补证 7，需干预 7/);
  assert.ok(report.indexOf('## 主管先看') < report.indexOf('## 主管验收总览'));
});

test('主管报告把技术术语翻译为审核人可读文案', () => {
  const functional = `# 报告\n\n共 1 项，1 项通过、0 项不通过、0 项未执行。\n\n## 逐项验收账本\n\n| 路径 | 断言 |\n|---|---|\n| SSE → Offering → Provider → Endpoint | requestId 可追踪，token 有效，未出现 HTTP2 协议错误 |`;
  const visual = '# 视觉\n';
  const report = composeSupervisorReport(functional, visual);
  assert.doesNotMatch(report, /requestId|Provider|Offering|Endpoint|HTTP2|\bSSE\b|\btoken\b/);
  assert.match(report, /实时连接 → 可用模型通道 → 上游服务 → 服务入口/);
  assert.match(report, /诊断编号可追踪，登录凭据有效，未出现实时活动辅助链路偶发中断/);
});

test('主管报告使用真实技术附录链接替换占位地址', () => {
  const functional = '# 报告\n\n## 关联测试方法\n\n- 技术附录：[查看](https://example.invalid/technical)';
  const report = composeSupervisorReport(functional, '# 视觉\n', '', '', 'https://cds.example/reports?id=1');
  assert.doesNotMatch(report, /example\.invalid/);
  assert.match(report, /https:\/\/cds\.example\/reports\?id=1/);
});
