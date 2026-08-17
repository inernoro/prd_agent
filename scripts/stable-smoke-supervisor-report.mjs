const PRIMARY_FEATURE_BY_PREFIX = {
  CORE: 'identity-access',
  COMMON: 'knowledge-assets',
  REC: 'recording',
  FILE: 'file-parsing',
  PARSE: 'short-video-parsing',
  VIDEO: 'video-creation',
  LIT: 'literary-creation',
  VIS: 'visual-creation',
  MVIS: 'multi-image-creation',
  GW: 'llm-gateway',
};

const OWNER_BY_FEATURE = {
  'identity-access': '身份与权限负责人',
  'knowledge-assets': '知识库负责人',
  recording: '录音与转写负责人',
  'file-parsing': '文件解析负责人',
  'short-video-parsing': '短视频解析负责人',
  'video-creation': '视频创作负责人',
  'literary-creation': '文学创作负责人',
  'visual-creation': '视觉创作负责人',
  'multi-image-creation': '视觉创作负责人',
  'llm-gateway': '模型网关负责人',
};

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

function readableReason(value) {
  return String(value || '')
    .replace(/^Error:\s*/i, '')
    .replace(/https?:\/\/\S+/gi, '[地址已隐藏]')
    .replace(/\b(?:token|provider|stack trace|http\s*\d{3})\b/gi, '[技术细节已隐藏]')
    .replace(/\s+/g, ' ')
    .trim();
}

function statusLabel(status) {
  if (status === 'pass') return '通过';
  if (status === 'fail') return '不通过';
  return '未执行';
}

function environmentLabel(environment) {
  return environment === 'cds' ? 'CDS' : '正式环境';
}

function casePrefix(caseId) {
  if (caseId.startsWith('REG-')) return 'REG';
  return caseId.split('-')[0];
}

function testType(caseId) {
  if (caseId.startsWith('REG-')) return '回归';
  if (/^(?:CORE|COMMON)-/.test(caseId)) return '冒烟';
  return '功能';
}

export function parseTestMatrix(markdown) {
  const cases = new Map();
  for (const line of String(markdown || '').split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
    const caseId = cells[0] || '';
    if (!/^(?:COMMON|CORE|REC|FILE|PARSE|VIDEO|LIT|VIS|MVIS|GW)-\d+$/.test(caseId)) continue;
    cases.set(caseId, {
      caseId,
      scenario: cells[1] || '未命名场景',
      assertion: cells[2] || '完成业务结果断言',
      cdsPolicy: cells[3] || '按矩阵执行',
      productionPolicy: cells[4] || '按矩阵执行',
    });
  }
  return cases;
}

function resolveFeature(plan, caseId) {
  const features = plan?.featureLines || [];
  if (caseId.startsWith('REG-')) {
    return features.find((feature) => (feature.regressionCaseIds || []).includes(caseId)) || null;
  }
  const preferredId = PRIMARY_FEATURE_BY_PREFIX[casePrefix(caseId)];
  return features.find((feature) => feature.id === preferredId)
    || features.find((feature) => (feature.requiredCaseIds || []).includes(caseId))
    || null;
}

function buildMetadata(plan, matrix, row) {
  const feature = resolveFeature(plan, row.caseId);
  const method = matrix.get(row.caseId);
  const scenario = method?.scenario || (row.caseId.startsWith('REG-') ? '永久回归' : '业务验收');
  const breadcrumb = [...(feature?.breadcrumb || ['关键业务']), scenario].join(' → ');
  return {
    ...row,
    featureId: feature?.id || 'unmapped',
    featureLabel: feature?.label || '未映射功能线',
    breadcrumb,
    scenario,
    assertion: method?.assertion || '按永久回归账本验证问题不再出现',
    environmentPolicy: row.environment === 'cds' ? method?.cdsPolicy : method?.productionPolicy,
    testType: testType(row.caseId),
    statusLabel: statusLabel(row.status),
    intervention: row.status === 'pass' ? '无需' : row.status === 'fail' ? '团队修复并复测' : row.environment === 'production' ? '准备正式验收身份后补测' : '团队补齐自动化并补测',
    owner: OWNER_BY_FEATURE[feature?.id] || '质量负责人',
    methodAnchor: `method-${row.caseId.toLowerCase()}`,
  };
}

function moduleRows(metadata) {
  const modules = new Map();
  for (const row of metadata) {
    const values = modules.get(row.featureId) || { label: row.featureLabel, breadcrumb: row.breadcrumb.split(' → ').slice(0, -1).join(' → '), rows: [] };
    values.rows.push(row);
    modules.set(row.featureId, values);
  }
  return [...modules.values()];
}

function resultCell(rows, environment, selectedEnvironments) {
  if (!selectedEnvironments.has(environment)) return '未选择';
  const selected = rows.filter((row) => row.environment === environment);
  const failed = selected.filter((row) => row.status === 'fail').length;
  const notRun = selected.filter((row) => row.status === 'not-run').length;
  const passed = selected.filter((row) => row.status === 'pass').length;
  const verdict = failed > 0 ? '不通过' : notRun > 0 ? '部分通过' : '通过';
  return `${verdict}（${passed} 通过，${failed} 失败，${notRun} 未执行）`;
}

export function renderSupervisorReport({
  plan,
  rows,
  notRunLedger = [],
  matrixMarkdown = '',
  runId,
  technicalUrl = './report.md',
  cdsUrl = '',
  productionUrl = '',
  executionFailures = [],
  selectedEnvironments = [],
}) {
  const matrix = parseTestMatrix(matrixMarkdown);
  const gapByKey = new Map(notRunLedger.map((row) => [`${row.environment}:${row.caseId}`, row]));
  const metadata = rows.map((row) => buildMetadata(plan, matrix, row));
  const selectedEnvironmentSet = new Set(selectedEnvironments.length > 0
    ? selectedEnvironments
    : metadata.map((row) => row.environment));
  const environmentScopeLabel = [...selectedEnvironmentSet].map(environmentLabel).join('、') || '未选择环境';
  const abnormal = metadata.filter((row) => row.status !== 'pass');
  const immediate = abnormal.filter((row) => row.status === 'fail' || row.environment === 'cds');
  const productionNotRun = abnormal.filter((row) => row.environment === 'production' && row.status === 'not-run');
  const frontAbnormal = immediate;
  const counts = {
    total: metadata.length,
    pass: metadata.filter((row) => row.status === 'pass').length,
    fail: metadata.filter((row) => row.status === 'fail').length,
    notRun: metadata.filter((row) => row.status === 'not-run').length,
  };
  const verdict = executionFailures.length > 0 || counts.fail > 0
    ? '不通过'
    : counts.notRun > 0 ? '部分通过' : '通过';
  const managerIntervention = productionNotRun.length > 0 ? '需要：确认正式验收身份可用' : '不需要：由团队闭环剩余项';
  const methods = [...new Map(metadata.map((row) => [row.caseId, row])).values()];
  const environmentCoverage = [...selectedEnvironmentSet].map((environment) => {
    const environmentRows = metadata.filter((row) => row.environment === environment);
    const passed = environmentRows.filter((row) => row.status === 'pass').length;
    const failed = environmentRows.filter((row) => row.status === 'fail').length;
    const notRun = environmentRows.filter((row) => row.status === 'not-run').length;
    const blocker = notRun === 0
      ? '无'
      : environment === 'production' ? '正式环境专用身份或安全门槛' : '自动化步骤或依赖资源缺失';
    const command = environment === 'cds'
      ? 'node scripts/stable-smoke-run.mjs --cds-only'
      : 'node scripts/stable-smoke-run.mjs';
    const closeCondition = notRun === 0
      ? '保持周期复测'
      : '所有未执行项获得真实通过或失败结果，并完成清理回读';
    return { environment, rows: environmentRows, passed, failed, notRun, blocker, command, closeCondition };
  });

  const lines = [
    `# 核心业务稳定验收主管报告 · ${runId}`,
    '',
    `> 主管结论：${verdict}。共 ${counts.total} 项，${counts.pass} 项通过、${counts.fail} 项不通过、${counts.notRun} 项未执行。未执行不能按通过计算。`,
    '',
    '## 主管验收总览',
    '',
    '| 项目 | 结果 | 主管动作 |',
    '|---|---|---|',
    `| 总体结论 | ${verdict} | ${verdict === '通过' ? '无需干预' : '先处理下方“需干预事项”，关闭前不得对外宣称全面通过'} |`,
    `| 发布建议 | ${verdict === '通过' ? '可以发布' : '暂缓全面放行'} | 关键项全部通过且未执行清零后再变更结论 |`,
    `| 是否需要主管介入 | ${managerIntervention} | 技术修复和自动化补跑由对应负责人处理 |`,
    `| 通过 | ${counts.pass}/${counts.total} | 可抽查逐项账本中的证据与方法 |`,
    `| 不通过 | ${counts.fail}/${counts.total} | 必须修复并在 CDS 与正式环境复测 |`,
    `| 未执行 | ${counts.notRun}/${counts.total} | 必须补齐身份或自动化步骤，不能用入口截图代替 |`,
    '',
    '## 执行覆盖账本',
    '',
    '先看环境汇总，再按验收项补跑。补跑命令只包含安全的执行入口，不包含账号、密码或单次票据。',
    '',
    '| 环境 | 计划 | 已执行 | 通过 | 失败 | 未执行 | 阻塞类别 | 直接执行路径 | 关闭条件 |',
    '|---|---:|---:|---:|---:|---:|---|---|---|',
    ...environmentCoverage.map((coverage) => `| ${environmentLabel(coverage.environment)} | ${coverage.rows.length} | ${coverage.passed + coverage.failed} | ${coverage.passed} | ${coverage.failed} | ${coverage.notRun} | ${coverage.blocker} | \`${coverage.command}\` | ${coverage.closeCondition} |`),
    '',
    '| 验收项编号 | 环境 | 阻塞类别 | 具体原因 | 代码或页面入口 | 补跑命令 | 关闭条件 |',
    '|---|---|---|---|---|---|---|',
    ...metadata.filter((row) => row.status === 'not-run').map((row) => {
      const gap = gapByKey.get(`${row.environment}:${row.caseId}`);
      const command = gap?.command || (row.environment === 'cds'
        ? 'node scripts/stable-smoke-run.mjs --cds-only'
        : 'node scripts/stable-smoke-run.mjs');
      return `| ${row.caseId} | ${environmentLabel(row.environment)} | ${escapeCell(gap?.reasonCode || (row.environment === 'production' ? '正式身份或安全门槛' : '自动化或依赖缺口'))} | ${escapeCell(gap?.reason || '没有获得真实执行证据')} | ${escapeCell(gap?.sourcePath || row.breadcrumb)} | \`${escapeCell(command)}\` | ${escapeCell(gap?.closeCondition || '该项获得真实通过或失败结果，并完成清理回读')} |`;
    }),
    ...(counts.notRun === 0 ? ['| 无 | 全部环境 | 无 | 所有计划项均已执行 | 保持当前业务路径 | 无需补跑 | 保持周期复测 |'] : []),
    '',
    '## 需干预事项',
    '',
    '| 优先级 | 环境 | 影响项 | 当前结果 | 负责人 | 关闭条件 |',
    '|---|---|---:|---|---|---|',
    ...(counts.fail > 0 ? [`| P1 | CDS | ${counts.fail} 项 | 真实业务失败 | 相关业务负责人 | 修复后相同验收项通过，并加入永久回归 |`] : []),
    ...(executionFailures.length > 0 ? [`| P1 | ${executionFailures.map(environmentLabel).join('、')} | ${executionFailures.length} 个执行进程 | Playwright 进程异常退出 | 质量负责人 | 修复全局初始化、清理或报告器错误后整轮重跑通过 |`] : []),
    ...(immediate.filter((row) => row.status === 'not-run').length > 0 ? [`| P1 | CDS | ${immediate.filter((row) => row.status === 'not-run').length} 项 | 自动化步骤未执行 | 质量负责人和相关业务负责人 | 下方每项均获得真实通过或失败证据 |`] : []),
    ...(productionNotRun.length > 0 ? [`| P1 | 正式环境 | ${productionNotRun.length} 项 | 正式合成身份未就绪 | 身份与权限负责人 | 正式身份预检通过并完成同一套验收项 |`] : []),
    ...(abnormal.length === 0 && executionFailures.length === 0 ? [`| 无 | ${environmentScopeLabel} | 0 项 | 全部通过 | 无需干预 | 保持每 48 小时复测 |`] : []),
    '',
    '## 业务功能线与面包屑',
    '',
    '| 模块 | 真实业务路径 | CDS | 正式环境 | 是否需干预 |',
    '|---|---|---|---|---|',
    ...moduleRows(metadata).map((module) => {
      const needsIntervention = module.rows.some((row) => row.status !== 'pass') ? '是' : '否';
      return `| ${escapeCell(module.label)} | ${escapeCell(module.breadcrumb)} | ${resultCell(module.rows, 'cds', selectedEnvironmentSet)} | ${resultCell(module.rows, 'production', selectedEnvironmentSet)} | ${needsIntervention} |`;
    }),
    '',
    '## 未通过与未执行逐项清单',
    '',
    '本节只提前列异常项；完整通过项仍保留在“逐项验收账本”。',
    '',
    '| 环境 | 模块 | 验收项 | 类型 | 详细测试路径 | 结果 | 问题或关闭条件 | 负责人 | 查看方法 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...frontAbnormal.map((row) => {
      const gap = gapByKey.get(`${row.environment}:${row.caseId}`);
      const reason = row.status === 'not-run'
        ? String(gap?.reason || '没有获得真实执行证据').replace(/该 caseId/g, '该验收项').replace(/caseId/g, '验收项')
        : readableReason(row.error || row.assertion);
      return `| ${environmentLabel(row.environment)} | ${escapeCell(row.featureLabel)} | ${escapeCell(row.scenario)} | ${row.testType} | ${escapeCell(row.breadcrumb)} | ${row.statusLabel} | ${escapeCell(reason)} | ${row.owner} | [查看](#${row.methodAnchor}) |`;
    }),
    ...(productionNotRun.length > 0 ? [`| 正式环境 | 全部计划模块 | ${productionNotRun.length} 项 | 冒烟、功能与回归 | 正式合成身份 → 同一验收账本 → 真实业务路径 | 未执行 | 共用身份前置未完成；每项明细保留在下方完整账本 | 身份与权限负责人 | [查看正式环境方法](#正式环境统一执行方法) |`] : []),
    ...(abnormal.length === 0 ? [`| ${environmentScopeLabel} | 全部模块 | 无 | 无 | 全部业务路径 | 通过 | 无异常项 | 无需干预 | [查看完整方法](#关联测试方法) |`] : []),
    '',
    '## 逐项验收账本',
    '',
    '| 环境 | 模块 | 验收项 | 类型 | 详细测试路径 | 结果 | 干预动作 | 查看方法 |',
    '|---|---|---|---|---|---|---|---|',
    ...metadata.map((row) => `| ${environmentLabel(row.environment)} | ${escapeCell(row.featureLabel)} | ${escapeCell(row.scenario)} | ${row.testType} | ${escapeCell(row.breadcrumb)} | ${row.statusLabel} | ${row.intervention} | [查看](#${row.methodAnchor}) |`),
    '',
    '## 关联测试方法',
    '',
    '<a id="正式环境统一执行方法"></a>',
    '### 正式环境统一执行方法',
    '',
    '- 使用独立、最低权限的正式合成身份完成预检。',
    '- 使用与 CDS 完全相同的验收账本，按每项正式环境策略执行。',
    '- 每项必须得到通过或不通过的真实证据，身份缺失和未执行均不能算通过。',
    '',
    ...methods.flatMap((row) => [
      `<a id="${row.methodAnchor}"></a>`,
      `### ${row.scenario}`,
      '',
      `- 类型：${row.testType}`,
      `- 面包屑：${row.breadcrumb}`,
      `- 验收断言：${row.assertion}`,
      `- CDS 环境：${matrix.get(row.caseId)?.cdsPolicy || '按永久回归账本执行'}`,
      `- 正式环境：${matrix.get(row.caseId)?.productionPolicy || '按永久回归账本执行'}`,
      '',
    ]),
    '## 验收地址',
    '',
    `- CDS：${cdsUrl ? `[打开 CDS 验收入口](${cdsUrl})` : '当前报告未绑定 CDS 入口，需干预'}`,
    `- 正式环境：[打开正式环境](${productionUrl})`,
    `- 技术附录：[打开命令、日志和 requestId](${technicalUrl})`,
    '',
    '## 需求一一对应表',
    '',
    '| 需求 | 落地结果 |',
    '|---|---|',
    '| 审核人员先看结论和干预项 | 已在首屏给出总体结论、失败、未执行和责任人 |',
    '| 每项能判断是否通过 | 逐项验收账本覆盖双环境全部计划项 |',
    '| 区分冒烟、功能、视觉和回归 | 稳定冒烟账本标记冒烟、功能、回归；视觉证据由独立视觉报告和截图门禁判定 |',
    '| 测试路径足够翔实 | 每项包含模块面包屑和具体场景 |',
    '| 关联方法可点击 | 每个验收项跳转到对应验收断言和双环境策略 |',
    '| 技术信息不干扰结论阅读 | 命令、接口、日志和 requestId 仅进入技术附录 |',
    '',
  ];
  return lines.join('\n');
}
