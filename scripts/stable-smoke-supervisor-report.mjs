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
    intervention: row.status === 'pass' ? '否' : '是',
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

function resultCell(rows, environment) {
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
  productionUrl = 'https://map.ebcone.net',
}) {
  const matrix = parseTestMatrix(matrixMarkdown);
  const gapByKey = new Map(notRunLedger.map((row) => [`${row.environment}:${row.caseId}`, row]));
  const metadata = rows.map((row) => buildMetadata(plan, matrix, row));
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
  const verdict = counts.fail > 0 ? '不通过' : counts.notRun > 0 ? '部分通过' : '通过';
  const methods = [...new Map(metadata.map((row) => [row.caseId, row])).values()];

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
    `| 通过 | ${counts.pass}/${counts.total} | 可抽查逐项账本中的证据与方法 |`,
    `| 不通过 | ${counts.fail}/${counts.total} | 必须修复并在 CDS 与正式环境复测 |`,
    `| 未执行 | ${counts.notRun}/${counts.total} | 必须补齐身份或自动化步骤，不能用入口截图代替 |`,
    '',
    '## 需干预事项',
    '',
    '| 优先级 | 环境 | 影响项 | 当前结果 | 负责人 | 关闭条件 |',
    '|---|---|---:|---|---|---|',
    ...(counts.fail > 0 ? [`| P1 | CDS | ${counts.fail} 项 | 真实业务失败 | 相关业务负责人 | 修复后相同 caseId 通过，永久回归入账 |`] : []),
    ...(immediate.filter((row) => row.status === 'not-run').length > 0 ? [`| P1 | CDS | ${immediate.filter((row) => row.status === 'not-run').length} 项 | 自动化步骤未执行 | 质量负责人和相关业务负责人 | 下方每项均获得真实通过或失败证据 |`] : []),
    ...(productionNotRun.length > 0 ? [`| P1 | 正式环境 | ${productionNotRun.length} 项 | 正式合成身份未就绪 | 身份与权限负责人 | 正式身份预检通过并完成同一套 caseId |`] : []),
    ...(abnormal.length === 0 ? ['| 无 | 双环境 | 0 项 | 全部通过 | 无需干预 | 保持每 48 小时复测 |'] : []),
    '',
    '## 业务功能线与面包屑',
    '',
    '| 模块 | 真实业务路径 | CDS | 正式环境 | 是否需干预 |',
    '|---|---|---|---|---|',
    ...moduleRows(metadata).map((module) => {
      const needsIntervention = module.rows.some((row) => row.status !== 'pass') ? '是' : '否';
      return `| ${escapeCell(module.label)} | ${escapeCell(module.breadcrumb)} | ${resultCell(module.rows, 'cds')} | ${resultCell(module.rows, 'production')} | ${needsIntervention} |`;
    }),
    '',
    '## 未通过与未执行逐项清单',
    '',
    '本节只提前列异常项；完整通过项仍保留在“逐项验收账本”。',
    '',
    '| 环境 | 模块 | caseId | 类型 | 详细测试路径 | 结果 | 原因或断言 | 负责人 | 测试方法 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...frontAbnormal.map((row) => {
      const gap = gapByKey.get(`${row.environment}:${row.caseId}`);
      const reason = row.status === 'not-run' ? gap?.reason || '没有获得真实执行证据' : readableReason(row.error || row.assertion);
      return `| ${environmentLabel(row.environment)} | ${escapeCell(row.featureLabel)} | ${row.caseId} | ${row.testType} | ${escapeCell(row.breadcrumb)} | ${row.statusLabel} | ${escapeCell(reason)} | ${row.owner} | [查看](#${row.methodAnchor}) |`;
    }),
    ...(productionNotRun.length > 0 ? [`| 正式环境 | 全部计划模块 | ${productionNotRun.length} 项 | 冒烟、功能与回归 | 正式合成身份 → 同一 caseId 账本 → 真实业务路径 | 未执行 | 共用身份前置未完成；每项明细保留在下方完整账本 | 身份与权限负责人 | [查看正式环境方法](#正式环境统一执行方法) |`] : []),
    ...(abnormal.length === 0 ? ['| 双环境 | 全部模块 | 无 | 无 | 全部业务路径 | 通过 | 无异常项 | 无需干预 | [查看完整方法](#关联测试方法) |'] : []),
    '',
    '## 逐项验收账本',
    '',
    '| 环境 | 模块 | caseId | 类型 | 详细测试路径 | 结果 | 是否需干预 | 测试方法 |',
    '|---|---|---|---|---|---|---|---|',
    ...metadata.map((row) => `| ${environmentLabel(row.environment)} | ${escapeCell(row.featureLabel)} | ${row.caseId} | ${row.testType} | ${escapeCell(row.breadcrumb)} | ${row.statusLabel} | ${row.intervention} | [查看](#${row.methodAnchor}) |`),
    '',
    '## 关联测试方法',
    '',
    '<a id="正式环境统一执行方法"></a>',
    '### 正式环境统一执行方法',
    '',
    '- 使用独立、最低权限的正式合成身份完成预检。',
    '- 使用与 CDS 完全相同的 caseId 账本，按每项正式环境策略执行。',
    '- 每项必须得到通过或不通过的真实证据，身份缺失和未执行均不能算通过。',
    '',
    ...methods.flatMap((row) => [
      `<a id="${row.methodAnchor}"></a>`,
      `### ${row.caseId} · ${row.scenario}`,
      '',
      `- 类型：${row.testType}`,
      `- 面包屑：${row.breadcrumb}`,
      `- 验收断言：${row.assertion}`,
      `- CDS 策略：${matrix.get(row.caseId)?.cdsPolicy || '按永久回归账本执行'}`,
      `- 正式环境策略：${matrix.get(row.caseId)?.productionPolicy || '按永久回归账本执行'}`,
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
    '| 每项能判断是否通过 | 逐项验收账本覆盖双环境全部 caseId |',
    '| 区分冒烟、功能、视觉和回归 | 稳定冒烟账本标记冒烟、功能、回归；视觉证据由独立视觉报告和截图门禁判定 |',
    '| 测试路径足够翔实 | 每项包含模块面包屑和具体场景 |',
    '| 关联方法可点击 | 每个 caseId 跳转到对应验收断言和双环境策略 |',
    '| 代码不干扰主管 | 命令、接口、日志和 requestId 仅进入技术附录 |',
    '',
  ];
  return lines.join('\n');
}
