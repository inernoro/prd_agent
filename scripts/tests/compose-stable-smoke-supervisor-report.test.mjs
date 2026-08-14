import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectBusinessFailureGroups,
  composeSupervisorReport,
  parseFunctionalExecutionCounts,
  renderBusinessDecisionPage,
} from '../compose-stable-smoke-supervisor-report.mjs';

test('结论与处理顺序使用用例级守恒口径并解释截图证明力', () => {
  const lead = '> 主管结论：不通过。共 191 项，48 项通过、31 项不通过、112 项未执行。';
  const failureSection = `## 未通过与未执行逐项清单

| 环境 | 模块 | 验收项 | 类型 | 详细测试路径 | 结果 | 问题或关闭条件 | 负责人 | 查看方法 |
|---|---|---|---|---|---|---|---|---|
| CDS | 录音转笔记 | 结束转录 | 功能 | 首页 → 知识库 → 录音转笔记 → 上传音频 → 等待转录 | 不通过 | ASR 默认池必须处于就绪状态 expect(received).toBe(expected) | 录音负责人 | [查看](#method-rec-003) |
| CDS | 模型治理 | 默认池 | 功能 | 首页 → 开放平台 → 模型网关 → 默认池 | 不通过 | ASR 默认池必须处于就绪状态 Expected: true Received: false | 网关负责人 | [查看](#method-gw-001) |
| CDS | 视频创作 | 成片 | 功能 | 首页 → 视频创作 → 提交脚本 → 等待成片 | 不通过 | 没有可用的视频生成模型 | 视频负责人 | [查看](#method-video-004) |`;
  const visualLead = `## 主管先看

| 项目 | 结果 | 说明 |
|---|---|---|
| 可审核证据 | 148/148 | 字段完整 |
| 状态结果 | 通过 36，不通过 0，需补证 0，需干预 112 | 严格结论 |`;
  const counts = parseFunctionalExecutionCounts(lead);
  assert.deepEqual(counts, {
    planned: 191,
    completed: 79,
    passed: 48,
    failed: 31,
    notRun: 112,
    completionRate: 79 / 191 * 100,
    executedPassRate: 48 / 79 * 100,
    balanced: true,
  });
  const groups = collectBusinessFailureGroups(failureSection);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[0].caseIds.sort(), ['GW-001', 'REC-003']);
  const page = renderBusinessDecisionPage(lead, failureSection, visualLead, {
    runId: 'stsmk-20260813-1021-2f5a4329',
    environmentCoverage: [
      { environment: 'cds', planned: 103, completed: 78, passed: 47, failed: 31, notRun: 25 },
      { environment: 'production', planned: 88, completed: 1, passed: 1, failed: 0, notRun: 87 },
    ],
  });
  assert.match(page, /## 结论与处理顺序/);
  assert.match(page, /\| 已完成 \| 79 \|/);
  assert.match(page, /\| 完成率 \| 41\.4% \|/);
  assert.match(page, /\| 已执行通过率 \| 60\.8% \|/);
  assert.match(page, /\| 已采集且可审核 \| 148 \| 图片、路径、时间和方法字段齐全，不等于验收通过 \|/);
  assert.match(page, /\| 能直接证明通过 \| 36 \|/);
  assert.match(page, /功能未执行 112 项与截图不能证明业务结果 112 张是两个独立维度/);
  assert.match(page, /## 双环境覆盖差异/);
  assert.match(page, /\| CDS \| 103 \| 78 \| 47 \| 31 \| 25 \|/);
  assert.match(page, /CDS 本轮完成 78\/103，仍有 25 项未执行/);
  assert.match(page, /\| 正式环境 \| 88 \| 1 \| 1 \| 0 \| 87 \|/);
  assert.match(page, /录音无法转写（语音识别资源不可用） \| 2 \|/);
  assert.match(page, /GW-001、REC-003|REC-003、GW-001/);
  assert.doesNotMatch(page, /expect\(|Expected:|Received:/);
  assert.match(page, /准备一段有清晰中文语音的音频/);
  assert.match(page, /2026-08-15 18:21（北京时间）前/);
  assert.match(page, /补齐语音识别成员，交付一条可打开且刷新仍存在的转录笔记/);
  assert.match(page, /查看逐项失败结果/);
});

test('执行汇总覆盖旧报告口径并同步首屏所有数字', () => {
  const functional = `# 功能报告

> 主管结论：不通过。共 206 项，47 项通过、31 项不通过、128 项未执行。

## 主管先看

| 决策项 | 结论 | 主管动作 |
|---|---|---|
| 功能验收 | 47/206 通过，31 不通过，128 未执行 | 查看失败清单 |

## 未通过与未执行逐项清单

| 环境 | 模块 | 验收项 | 类型 | 详细测试路径 | 结果 | 问题或关闭条件 | 负责人 | 查看方法 |
|---|---|---|---|---|---|---|---|---|
| CDS | 视觉创作 | 文生图 | 功能 | 首页 → 视觉创作 → 生成 | 不通过 | 模型不可用 | 视觉负责人 | [查看](#method-vis-002) |`;
  const summary = { coverage: { total: 191, passed: 48, failed: 31, notRun: 112 } };
  const report = composeSupervisorReport(functional, '# 视觉', '', '', '', summary);
  assert.match(report, /共 191 项，48 项通过、31 项不通过、112 项未执行/);
  assert.match(report, /功能验收 \| 48\/191 通过，31 不通过，112 未执行/);
  assert.match(report, /\| 已完成 \| 79 \|/);
  assert.doesNotMatch(report, /47\/206|共 206 项/);
});

test('失败日志包含未转义竖线时仍能还原负责人、编号并按业务根因归组', () => {
  const failures = `## 未通过与未执行逐项清单

| 环境 | 模块 | 验收项 | 类型 | 详细测试路径 | 结果 | 问题或关闭条件 | 负责人 | 查看方法 |
|---|---|---|---|---|---|---|---|---|
| CDS | 录音转笔记 | 结束转录 | 功能 | 首页 → 知识库 → 上传音频 → 等待转录 | 不通过 | expect(locator).toBeVisible failed Locator: getByText(/录音和原文已保存|查看转录笔记/) Timeout: 180000ms | 录音负责人 | [查看](#method-rec-003) |
| CDS | 视觉创作 | 文生图 | 功能 | 首页 → 视觉创作 → 输入描述 → 生成 | 不通过 | SSE 中断必须发生在任务仍处于活跃状态时 Expected pattern: /Queued|Running/i Received string: Failed | 视觉负责人 | [查看](#method-vis-002) |`;
  const groups = collectBusinessFailureGroups(failures);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.flatMap((group) => group.caseIds).sort(), ['REC-003', 'VIS-002']);
  assert.deepEqual(groups.flatMap((group) => group.owners).sort(), ['录音负责人', '视觉负责人']);
  assert.match(groups.map((group) => group.reason).join('\n'), /录音上传后未在 180 秒内进入转录完成状态/);
  assert.match(groups.map((group) => group.reason).join('\n'), /任务已提前失败/);
});

test('功能账本与视觉截图合成为单份报告且不带入旧结论', () => {
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
  assert.match(composed, /2 条 验收项编号 中有 1 条不通过/);
  assert.equal((composed.match(/## 模块验收总览/g) || []).length, 1);
  assert.equal((composed.match(/## 处理流程/g) || []).length, 1);
  assert.doesNotMatch(composed, /老板先看|主管先看|主管报告|主管结论|主管动作/);
  assert.match(composed, /截图证据 \| 已采集 0\/148 张可审核证据；0\/10 个模块有直接通过证据/);
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

test('功能报告缺少处理流程时自动生成双账本首屏', () => {
  const functional = '# 功能报告\n\n> 主管结论：不通过。共 20 项，12 项通过、2 项不通过、6 项未执行。\n\n## 主管验收总览\n\n模块总览';
  const visual = '# 视觉报告';
  const gate = `# 门禁\n\n## 主管先看\n\n| 项目 | 结果 | 说明 |\n|---|---|---|\n| 能否发布 | 不可以 | 有异常 |\n| 状态结果 | 通过 125，不通过 9，需补证 7，需干预 7 | 严格结论 |\n| 可审核证据 | 148/148 | 已核销 |`;
  const report = composeSupervisorReport(functional, visual, gate);
  assert.match(report, /## 处理流程/);
  assert.match(report, /## 结论与处理顺序/);
  assert.match(report, /\| 已完成 \| 14 \|/);
  assert.match(report, /功能验收 \| 12\/20 通过，2 不通过，6 未执行/);
  assert.match(report, /截图证据 \| 已采集 148\/148；状态判定为 通过 125，不通过 9，需补证 7，需干预 7/);
  assert.ok(report.indexOf('## 处理流程') < report.indexOf('## 模块验收总览'));
  assert.doesNotMatch(report, /老板先看|主管先看|主管报告|主管结论|主管动作/);
});

test('功能通过但视觉门禁未通过时验收报告不得判通过', () => {
  const functional = '# 功能报告\n\n> 主管结论：通过。共 2 项，2 项通过、0 项不通过、0 项未执行。\n\n## 主管验收总览\n\n功能均通过';
  const visualGate = '# 视觉门禁\n\n结论：不通过\n\n## 主管先看\n\n| 项目 | 结果 | 说明 |\n|---|---|---|\n| 能否发布 | 不可以 | 缺少证据 |';
  const report = composeSupervisorReport(functional, visualGate, visualGate);
  assert.match(report, /Verdict: fail/);
  assert.match(report, /\| 能否发布 \| 不可以 \|/);
  assert.match(report, /当前只能有条件放行/);
  assert.doesNotMatch(report, /当前可以放行/);
});

test('视觉需干预时即使功能全部通过也不得显示可以放行', () => {
  const lead = '> 主管结论：通过。共 2 项，2 项通过、0 项不通过、0 项未执行。';
  const visualGate = `## 主管先看

| 项目 | 结果 | 说明 |
|---|---|---|
| 可审核证据 | 2/2 | 字段完整 |
| 状态结果 | 通过 1，不通过 0，需补证 0，需干预 1 | 一项需人工干预 |`;
  const page = renderBusinessDecisionPage(lead, '', visualGate, { runId: 'stsmk-20260813-1021-abcd' });

  assert.match(page, /当前不能放行/);
  assert.doesNotMatch(page, /当前可以放行/);
});

test('正式环境结论依据安全门与实际覆盖而不是固定归因给 CDS', () => {
  const lead = '> 主管结论：通过。共 2 项，2 项通过、0 项不通过、0 项未执行。';
  const successful = renderBusinessDecisionPage(lead, '', '', {
    runId: 'stsmk-20260813-1021-abcd',
    productionSafetyGate: { restricted: false, reasons: [] },
    environmentCoverage: [
      { environment: 'production', planned: 2, completed: 2, passed: 2, failed: 0, notRun: 0 },
    ],
  });
  const identityMissing = renderBusinessDecisionPage(lead, '', '', {
    runId: 'stsmk-20260813-1021-abcd',
    productionSafetyGate: { restricted: false, reasons: [] },
    environmentCoverage: [
      { environment: 'production', planned: 2, completed: 0, passed: 0, failed: 0, notRun: 2 },
    ],
  });
  const restricted = renderBusinessDecisionPage(lead, '', '', {
    runId: 'stsmk-20260813-1021-abcd',
    productionSafetyGate: { restricted: true, reasons: ['CDS 视觉门禁未通过'] },
    environmentCoverage: [
      { environment: 'production', planned: 2, completed: 1, passed: 1, failed: 0, notRun: 1 },
    ],
  });

  assert.match(successful, /正式环境 2 项已全部完成且通过/);
  assert.doesNotMatch(successful, /CDS 失败触发/);
  assert.match(identityMissing, /正式环境完成 0\/2，仍有 2 项未执行/);
  assert.match(restricted, /安全门已限制为只读检查：CDS 视觉门禁未通过/);
});

test('视觉只有缺证而没有产品失败时验收报告判为有条件通过', () => {
  const functional = '# 功能报告\n\n> 主管结论：通过。共 2 项，2 项通过、0 项不通过、0 项未执行。\n\n## 主管验收总览\n\n功能均通过';
  const visualGate = '# 视觉门禁\n\n结论：不通过\n\n## 主管先看\n\n| 项目 | 结果 | 说明 |\n|---|---|---|\n| 能否发布 | 不可以 | 缺少证据 |\n| 状态结果 | 通过 0，不通过 0，需补证 0，需干预 0 | 尚未取证 |';
  const report = composeSupervisorReport(functional, visualGate, visualGate);
  assert.match(report, /Verdict: conditional/);
});

test('验收报告把技术术语翻译为审核人可读文案', () => {
  const functional = `# 报告\n\n共 1 项，1 项通过、0 项不通过、0 项未执行。\n\n## 逐项验收账本\n\n| 路径 | 断言 |\n|---|---|\n| SSE → Offering → Provider → Endpoint | requestId 可追踪，token 有效，未出现 HTTP2 协议错误 |`;
  const visual = '# 视觉\n';
  const report = composeSupervisorReport(functional, visual);
  assert.doesNotMatch(report, /requestId|Provider|Offering|Endpoint|HTTP2|\bSSE\b|\btoken\b/);
  assert.match(report, /实时连接 → 可用模型通道 → 上游服务 → 服务入口/);
  assert.match(report, /诊断编号可追踪，登录凭据有效，未出现实时活动辅助链路偶发中断/);
});

test('验收报告使用真实技术附录链接替换占位地址', () => {
  const functional = '# 报告\n\n## 关联测试方法\n\n- 技术附录：[查看](https://example.invalid/technical)';
  const report = composeSupervisorReport(functional, '# 视觉\n', '', '', 'https://cds.example/reports?id=1');
  assert.doesNotMatch(report, /example\.invalid/);
  assert.match(report, /https:\/\/cds\.example\/reports\?id=1/);
});

test('视觉门禁报告会合成满足归档准入字段的模块总览', () => {
  const functional = `# 功能报告

> 主管结论：部分通过。共 4 项，2 项通过、0 项不通过、2 项未执行。

## 主管验收总览

| 项目 | 结果 | 主管动作 |
|---|---|---|
| 总体结论 | 部分通过 | 补测 |

## 业务功能线与面包屑

| 模块 | 真实业务路径 | CDS | 正式环境 | 是否需干预 |
|---|---|---|---|---|
| 视觉创作 | 首页 → 视觉创作 → 结果 | 通过（2 通过，0 失败，0 未执行） | 部分通过（0 通过，0 失败，2 未执行） | 是 |
`;
  const gate = `# 视觉门禁

结论：不通过

## 模块覆盖

| 模块 | 视觉结论 | 真实面包屑 | 采集文件 | 可审核证据 | 状态结果 | 关键状态 | 缺口 | 查看全部截图 | 测试方法 |
|---|---|---|---:|---:|---:|---|---|---|---|
| 视觉创作 | 部分通过 | 首页 → 视觉创作 → 结果 | 2 | 2/4 | 通过 2 | 2/4 | 正式环境缺证 | [查看](#visual-ledger-visual) | [查看](#visual-method-visual) |
`;
  const report = composeSupervisorReport(functional, gate, gate);
  const overview = report.match(/^## 模块验收总览\n(?:(?!^##\s)[\s\S])*/m)?.[0] || '';
  for (const header of ['模块', '真实面包屑', '冒烟', '功能', '视觉', '最高问题', '是否需干预', '查看步骤', '查看截图', '查看缺陷', '关联测试方法']) {
    assert.match(overview, new RegExp(header));
  }
  assert.match(overview, /\| 视觉创作 \| 首页 → 视觉创作 → 结果 \| 部分通过 \| 部分通过 \| 部分通过 \| P2 \| 是 \|/);
  assert.equal((overview.match(/\[查看\]\(/g) || []).length, 4);
});
