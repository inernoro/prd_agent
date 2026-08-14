import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function readArg(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

export function parseReportSections(markdown) {
  const matches = [...String(markdown || '').matchAll(/^##\s+(.+)$/gm)];
  const lead = markdown.slice(0, matches[0]?.index ?? markdown.length).trim();
  const sections = matches.map((match, index) => ({
    title: match[1].trim(),
    content: markdown.slice(match.index, matches[index + 1]?.index ?? markdown.length).trim(),
  }));
  return { lead, sections };
}

const visualBeforeLedger = new Set([
  '视觉证据预算',
  '改动断言表',
  '影响面矩阵',
  '融合测试设计',
  '证明力矩阵',
  '页面优先证据分层',
  '改动断言到证据表',
  '验收用例',
  '覆盖缺口',
  '移动端验收',
  '缺陷清单',
]);

function isVisualGateSummarySection(title) {
  return title === '模块覆盖'
    || title === '需处理事项'
    || title === '视觉异常证据索引'
    || /^需处理的\s+\d+\s+项异常$/.test(title);
}

const visualGateLedgerSections = new Set(['逐张视觉证据账本', '视觉证据图片', '视觉测试方法']);
const conciseVisualSections = new Set(['缺陷清单']);

function parseMarkdownTable(sectionContent) {
  const lines = String(sectionContent || '').split('\n');
  const tableLines = lines.filter((line) => /^\|.*\|$/.test(line.trim()));
  if (tableLines.length < 3) return null;
  const cells = (line) => {
    const value = line.trim().slice(1, -1);
    const result = [];
    let current = '';
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === '\\' && value[index + 1] === '|') {
        current += '|';
        index += 1;
      } else if (value[index] === '|') {
        result.push(current.trim());
        current = '';
      } else {
        current += value[index];
      }
    }
    result.push(current.trim());
    return result;
  };
  const headers = cells(tableLines[0]);
  const normalize = (row) => {
    if (row.length <= headers.length) return row;
    const preferredMergeIndex = headers.indexOf('问题或关闭条件');
    const mergeIndex = preferredMergeIndex >= 0 ? preferredMergeIndex : headers.length - 1;
    const overflow = row.length - headers.length;
    return [
      ...row.slice(0, mergeIndex),
      row.slice(mergeIndex, mergeIndex + overflow + 1).join('|'),
      ...row.slice(mergeIndex + overflow + 1),
    ];
  };
  return {
    headers,
    rows: tableLines.slice(2).map(cells).map(normalize),
  };
}

function visualCoverageRows(sectionContent) {
  const table = parseMarkdownTable(sectionContent);
  if (!table) return [];
  return table.rows.map((row) => Object.fromEntries(table.headers.map((header, index) => [header, row[index] || ''])));
}

function plainCell(value) {
  return String(value || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/!?(?:\[([^\]]*)\])\([^)]+\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function markdownTableCell(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, '<br>')
    .replace(/\|/g, '\\|');
}

function countsFromExecutionSummary(executionSummary) {
  const coverage = executionSummary?.coverage;
  if (!coverage) return null;
  const fields = ['total', 'passed', 'failed', 'notRun'];
  if (!fields.every((field) => Number.isInteger(Number(coverage[field])) && Number(coverage[field]) >= 0)) {
    return null;
  }
  return [coverage.total, coverage.passed, coverage.failed, coverage.notRun].map(Number);
}

function normalizedVerdict(value) {
  if (value === 'fail') return 'fail';
  if (value === 'conditional' || value === 'not-run') return 'conditional';
  return value === 'pass' ? 'pass' : '';
}

function strictestVerdict(...values) {
  const rank = { pass: 0, conditional: 1, fail: 2 };
  return values
    .map(normalizedVerdict)
    .filter(Boolean)
    .reduce((current, candidate) => (rank[candidate] > rank[current] ? candidate : current), 'pass');
}

function authoritativeExecutionVerdict(executionSummary) {
  const coverage = executionSummary?.coverage;
  if (Array.isArray(coverage?.executionFailures) && coverage.executionFailures.length > 0) return 'fail';
  if (executionSummary?.productionSafetyGate?.restricted === true) return 'conditional';
  return normalizedVerdict(coverage?.verdict);
}

function environmentCoverageFromLedger(sectionContent) {
  const table = parseMarkdownTable(sectionContent);
  if (!table) return [];
  const indexes = Object.fromEntries(
    ['环境', '计划', '已执行', '通过', '失败', '未执行'].map((header) => [header, table.headers.indexOf(header)]),
  );
  if (Object.values(indexes).some((index) => index < 0)) return [];
  return table.rows.flatMap((row) => {
    const values = Object.fromEntries(
      ['计划', '已执行', '通过', '失败', '未执行'].map((header) => [header, Number(plainCell(row[indexes[header]]))]),
    );
    if (Object.values(values).some((value) => !Number.isInteger(value) || value < 0)) return [];
    const rawEnvironment = plainCell(row[indexes['环境']]);
    const environment = rawEnvironment === 'CDS'
      ? 'cds'
      : rawEnvironment === '正式环境'
        ? 'production'
        : rawEnvironment;
    return [{
      environment,
      planned: values['计划'],
      completed: values['已执行'],
      passed: values['通过'],
      failed: values['失败'],
      notRun: values['未执行'],
    }];
  });
}

export function parseFunctionalExecutionCounts(functionalLead, executionSummary = null) {
  const authoritative = countsFromExecutionSummary(executionSummary);
  const match = String(functionalLead || '').match(
    /共\s*(\d+)\s*项，\s*(\d+)\s*项通过、\s*(\d+)\s*项不通过、\s*(\d+)\s*项未执行/,
  );
  if (!authoritative && !match) return null;
  const [planned, passed, failed, notRun] = authoritative || match.slice(1).map(Number);
  const completed = passed + failed;
  return {
    planned,
    completed,
    passed,
    failed,
    notRun,
    completionRate: planned > 0 ? (completed / planned) * 100 : 0,
    executedPassRate: completed > 0 ? (passed / completed) * 100 : 0,
    balanced: passed + failed + notRun === planned,
  };
}

function conciseFailureReason(rawReason, acceptanceItem, module) {
  const source = plainCell(rawReason);
  if (/openrouter-image|多图逻辑模型/.test(source)) {
    return '多图生成不可用（主路缺少可用多图模型）';
  }
  if (/ASR 默认池/.test(source)) {
    return '录音无法转写（语音识别资源不可用）';
  }
  if (/视频生成模型/.test(source)) {
    return '视频无法生成（没有可用视频模型）';
  }
  if (/录音和原文已保存|查看转录笔记/.test(source)) {
    return '录音上传后未在 180 秒内进入转录完成状态';
  }
  if (/SSE 中断必须发生|实时连接中断必须发生/.test(source)) {
    return '实时连接中断时任务已提前失败，没有保持在运行状态';
  }
  if (/画幅|尺寸矩阵/.test(`${source} ${acceptanceItem}`)) {
    return '方形、横版和竖版三种画幅未全部生成符合比例的真实产物';
  }
  const cleaned = source
    .replace(/\s+(?:expect\(|Expected:|Received:|Call log:).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || /^expect\(/i.test(cleaned)) {
    return `${plainCell(module) || '业务模块'}的“${plainCell(acceptanceItem) || '业务验收项'}”未达到预期完成状态`;
  }
  return cleaned.slice(0, 180);
}

function methodCaseId(value) {
  const match = String(value || '').match(/#method-([a-z0-9-]+)/i);
  return match ? match[1].toUpperCase() : '';
}

function businessFailureDetails(failure) {
  const reason = failure.reason;
  const defaults = {
    actual: reason,
    expected: `完成“${failure.acceptanceItem}”并得到可回读的业务结果`,
    reproduction: failure.reproduction || '按验收方法进入目标业务并重复操作',
  };
  if (/openrouter-image|多图逻辑模型|多图生成不可用/.test(reason)) {
    return {
      actual: '上传两至三张参考图并提交后，系统找不到可调用的多图模型，无法返回组合图片',
      expected: '系统展示生成进度，并返回可下载、刷新后仍可查看的组合图片',
      reproduction: '前置：准备两张普通图片；步骤：进入视觉创作，依次上传两张参考图，输入“两图自然组合成海报”，点击生成；判断：出现可下载的组合图片才算通过',
    };
  }
  if (/实时连接中断/.test(reason)) {
    return {
      actual: '单图任务在模拟连接中断前已经变为失败，页面没有呈现“任务仍在生成，可继续等待或恢复”的状态',
      expected: '任务处于排队或生成中时发生连接中断，页面给出可理解的等待或恢复提示，恢复后结果仍可回读',
      reproduction: '前置：单图生成服务可用；步骤：进入视觉创作并提交生成，在页面显示排队或生成中时模拟断网，随后恢复网络并刷新；判断：中断时有明确提示，恢复后可继续或查看最终结果',
    };
  }
  if (/ASR 默认池|录音无法转写/.test(reason)) {
    return {
      actual: '录音转写没有可用语音识别成员，上传音频后无法进入转录并返回笔记',
      expected: '上传音频后显示转录进度，最终出现可打开、刷新后仍存在的转录笔记',
      reproduction: '前置：准备一段有清晰中文语音的音频；步骤：进入知识库，新增录音转笔记，上传音频并等待；判断：页面出现转录进度和可打开的转录笔记才算通过',
    };
  }
  if (/视频生成模型|视频无法生成/.test(reason)) {
    return {
      actual: '提交脚本和分镜后没有可调用的视频模型，不能生成成片',
      expected: '任务展示分镜、关键帧和成片进度，最终返回可播放且刷新后仍存在的视频',
      reproduction: '前置：准备一段短脚本；步骤：进入视频创作，提交脚本，生成分镜与关键帧后请求成片；判断：出现可播放视频且刷新后仍可查看才算通过',
    };
  }
  if (/录音上传后/.test(reason)) {
    return {
      actual: '音频已经提交，但等待 180 秒仍没有出现“录音和原文已保存”或“查看转录笔记”',
      expected: '180 秒内完成转录并出现可打开的笔记，随后清理测试记录且回读确认不存在',
      reproduction: '前置：准备一段有清晰中文语音的音频；步骤：进入知识库，新增录音转笔记，上传音频并等待最多 180 秒；判断：出现“查看转录笔记”，打开后有原文才算通过',
    };
  }
  if (/故障切换/.test(reason)) {
    return {
      actual: '当前只有一个可用上游，无法验证主路故障后自动切换到备用上游',
      expected: '同一逻辑模型至少有两个独立可用上游，主路不可用时请求自动转到备用上游并返回结果',
      reproduction: '前置：为同一文生图模型配置两个独立上游；步骤：先确认两路可用，再隔离主路并提交图片生成；判断：调用日志显示转到备用上游且页面得到图片结果才算通过',
    };
  }
  if (/三种画幅/.test(reason)) {
    return {
      actual: '方形、横版和竖版三次生成没有全部返回符合目标比例的真实图片',
      expected: '三种画幅分别返回符合 1:1、横版和竖版比例的可下载图片',
      reproduction: '前置：使用同一段图片描述；步骤：依次选择方形、横版、竖版并各生成一次；判断：三张真实图片尺寸比例分别匹配所选画幅才算通过',
    };
  }
  return defaults;
}

function businessRecoveryAction(reason) {
  if (/openrouter-image|多图逻辑模型|多图生成不可用/.test(reason)) return '视觉创作与模型网关负责人补齐可用多图模型，交付一次双图生成成功记录，再按本组验收项复测并清理产物';
  if (/实时连接中断/.test(reason)) return '身份与权限、模型网关和视觉创作负责人共同修复中断恢复状态，交付断网后仍可等待或恢复的回读记录';
  if (/ASR 默认池|录音无法转写/.test(reason)) return '模型网关与录音转写负责人补齐语音识别成员，交付一条可打开且刷新仍存在的转录笔记后复测';
  if (/视频生成模型|视频无法生成/.test(reason)) return '视频创作与模型网关负责人补齐可用视频模型，交付一条可播放且刷新仍存在的成片记录后复测';
  if (/录音上传后/.test(reason)) return '录音与转写负责人排查超时链路，交付一条 180 秒内完成的转录笔记并完成测试记录清理回读';
  if (/故障切换/.test(reason)) return 'CDS 与模型网关负责人配置第二个独立上游，交付主路隔离后自动切换且返回图片的调用记录';
  if (/三种画幅/.test(reason)) return '视觉创作与模型网关负责人修复画幅路由，交付方形、横版、竖版三张比例正确的真实图片';
  return `相关业务负责人处理“${reason}”，交付可回读结果后按相同验收项复测并完成清理回读`;
}

function nextRetestDeadline(runId) {
  const match = String(runId || '').match(/stsmk-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
  if (!match) return '下一轮 48 小时复测前';
  const due = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + 2,
    Number(match[4]),
    Number(match[5]),
  ));
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(due).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}（北京时间）前`;
}

export function collectBusinessFailureGroups(sectionContent) {
  const table = parseMarkdownTable(sectionContent);
  if (!table) return [];
  const records = table.rows.map((row) => Object.fromEntries(
    table.headers.map((header, index) => [header, row[index] || '']),
  ));
  const groups = new Map();
  for (const row of records) {
    if (plainCell(row['结果']) !== '不通过') continue;
    const reason = conciseFailureReason(row['问题或关闭条件'], row['验收项'], row['模块']);
    const key = reason.toLowerCase();
    const group = groups.get(key) || {
      reason,
      rows: [],
      modules: new Set(),
      owners: new Set(),
      caseIds: new Set(),
    };
    group.rows.push(row);
    if (row['模块']) group.modules.add(plainCell(row['模块']));
    if (row['负责人']) group.owners.add(plainCell(row['负责人']));
    const caseId = methodCaseId(row['查看方法']);
    if (caseId) group.caseIds.add(caseId);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      reason: group.reason,
      count: group.rows.length,
      modules: [...group.modules],
      owners: [...group.owners],
      caseIds: [...group.caseIds],
      acceptanceItem: plainCell(group.rows[0]['验收项']),
      reproduction: plainCell(group.rows[0]['详细测试路径']),
      methodLink: group.rows[0]['查看方法'] || '',
    }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason, 'zh-CN'));
}

function visualEvidenceCounts(visualGateLeadContent) {
  const table = parseMarkdownTable(visualGateLeadContent);
  if (!table) return null;
  const projectIndex = table.headers.indexOf('项目');
  const resultIndex = table.headers.indexOf('结果');
  const value = (name) => table.rows.find((row) => row[projectIndex] === name)?.[resultIndex] || '';
  const evidence = value('可审核证据').match(/(\d+)\/(\d+)/);
  const statuses = value('状态结果').match(/通过\s*(\d+)，不通过\s*(\d+)，需补证\s*(\d+)，需干预\s*(\d+)/);
  if (!evidence && !statuses) return null;
  return {
    reviewable: Number(evidence?.[1] || 0),
    planned: Number(evidence?.[2] || 0),
    passed: Number(statuses?.[1] || 0),
    failed: Number(statuses?.[2] || 0),
    needsEvidence: Number(statuses?.[3] || 0),
    needsIntervention: Number(statuses?.[4] || 0),
  };
}

export function renderBusinessDecisionPage(
  functionalLead,
  failureSectionContent,
  visualGateLeadContent,
  executionSummary = null,
  overallVerdict = '',
) {
  const counts = parseFunctionalExecutionCounts(functionalLead, executionSummary);
  if (!counts) return '';
  const failures = collectBusinessFailureGroups(failureSectionContent);
  const visual = visualEvidenceCounts(visualGateLeadContent);
  const pct = (value) => `${value.toFixed(1)}%`;
  const environmentCoverage = Array.isArray(executionSummary?.environmentCoverage)
    ? executionSummary.environmentCoverage
    : [];
  const coverageByEnvironment = new Map(environmentCoverage.map((item) => [item.environment, item]));
  const cdsCoverage = coverageByEnvironment.get('cds');
  const productionCoverage = coverageByEnvironment.get('production');
  const productionSafetyGate = executionSummary?.productionSafetyGate;
  const deadline = nextRetestDeadline(executionSummary?.runId);
  const visualGateDisallowsRelease = /结论\s*[：:]\s*不通过|\|\s*能否发布\s*\|\s*不可以\s*\|/.test(
    String(visualGateLeadContent || ''),
  );
  const visualBlocksRelease = Boolean(visual && (visual.failed > 0 || visual.needsIntervention > 0));
  const visualNeedsEvidence = Boolean(
    (visual && (visual.needsEvidence > 0 || visual.reviewable < visual.planned))
    || (visualGateDisallowsRelease && !visualBlocksRelease),
  );
  const evidenceVerdict = counts.failed > 0 || visualBlocksRelease
    ? 'fail'
    : counts.notRun > 0 || visualNeedsEvidence
      ? 'conditional'
      : 'pass';
  const productionSafetyVerdict = productionSafetyGate?.restricted === true ? 'conditional' : 'pass';
  const releaseVerdict = strictestVerdict(evidenceVerdict, overallVerdict, productionSafetyVerdict);
  const releaseConclusion = releaseVerdict === 'fail'
    ? '当前不能放行。'
    : releaseVerdict === 'conditional'
      ? '当前只能有条件放行。'
      : '当前可以放行。';
  const productionConclusion = productionCoverage
    ? productionSafetyGate?.restricted === true
      ? `安全门已限制为只读检查：${productionSafetyGate.reasons?.join('；') || 'CDS 功能或视觉门禁尚未通过'}`
      : productionCoverage.failed > 0
        ? `正式环境已有 ${productionCoverage.failed} 项失败，必须修复后复测`
        : productionCoverage.notRun > 0
          ? `正式环境完成 ${productionCoverage.completed}/${productionCoverage.planned}，仍有 ${productionCoverage.notRun} 项未执行`
          : `正式环境 ${productionCoverage.planned} 项已全部完成且通过`
    : '';
  const lines = [
    '## 结论与处理顺序',
    '',
    `> 本轮计划 ${counts.planned} 项，已完成 ${counts.completed} 项；通过 ${counts.passed} 项、失败 ${counts.failed} 项、未执行 ${counts.notRun} 项。${releaseConclusion}`,
    '',
    '| 指标 | 数量 | 给业务读者的解释 |',
    '|---|---:|---|',
    `| 计划测试 | ${counts.planned} | 本轮合同要求覆盖的环境与验收项 |`,
    `| 已完成 | ${counts.completed} | 已经得到明确通过或失败结果 |`,
    `| 通过 | ${counts.passed} | 真实业务断言成立 |`,
    `| 失败 | ${counts.failed} | 真实业务断言不成立，需要处理后复测 |`,
      `| 功能未执行 | ${counts.notRun} | 因身份、模型、安全限制或步骤缺失没有运行，不能算通过 |`,
    `| 完成率 | ${pct(counts.completionRate)} | 已完成 ÷ 计划测试 |`,
    `| 已执行通过率 | ${pct(counts.executedPassRate)} | 通过 ÷ 已完成 |`,
    `| 统计校验 | ${counts.balanced ? '守恒' : '不一致'} | 通过 + 失败 + 未执行必须等于计划测试 |`,
    '| 统计来源 | 权威执行汇总 | 首屏只按实际执行记录计数；原始合同账本可保留重复映射行 |',
    '',
  ];
  if (cdsCoverage || productionCoverage) {
    lines.push(
      '## 双环境覆盖差异',
      '',
      '| 环境 | 计划 | 已完成 | 通过 | 失败 | 未执行 | 业务结论 |',
      '|---|---:|---:|---:|---:|---:|---|',
      ...(cdsCoverage ? [`| CDS | ${cdsCoverage.planned} | ${cdsCoverage.completed} | ${cdsCoverage.passed} | ${cdsCoverage.failed} | ${cdsCoverage.notRun} | CDS 本轮完成 ${cdsCoverage.completed}/${cdsCoverage.planned}，仍有 ${cdsCoverage.notRun} 项未执行 |`] : []),
      ...(productionCoverage ? [`| 正式环境 | ${productionCoverage.planned} | ${productionCoverage.completed} | ${productionCoverage.passed} | ${productionCoverage.failed} | ${productionCoverage.notRun} | ${productionConclusion} |`] : []),
      '',
    );
  }
  if (visual) {
    lines.push(
      '## 截图证据怎么读',
      '',
      '| 视觉指标 | 数量 | 代表什么 |',
      '|---|---:|---|',
      `| 计划截图槽位 | ${visual.planned} | 视觉合同要求取证的页面状态 |`,
      `| 已采集且可审核 | ${visual.reviewable} | 图片、路径、时间和方法字段齐全，不等于验收通过 |`,
      `| 能直接证明通过 | ${visual.passed} | 截图确实呈现了目标状态 |`,
      `| 明确不通过 | ${visual.failed} | 截图直接呈现错误结果 |`,
      `| 不能证明业务结果 | ${visual.needsEvidence + visual.needsIntervention} | 只能证明页面可达，或需要运行态、外部模型、专项交互继续取证 |`,
      '',
      `> 注意：功能未执行 ${counts.notRun} 项与截图不能证明业务结果 ${visual.needsEvidence + visual.needsIntervention} 张是两个独立维度；本轮数字相同纯属巧合，不能一一对应。`,
      '',
    );
  }
  lines.push(
    '## 不通过问题与复现',
    '',
    '| 根因 | 影响项数 | 影响模块 | 验收项编号 | 实际结果 | 期望结果 | 复现方式 | 本次直接证据 | 复测方法 | 当前责任角色 | 完成时限 | 恢复动作 |',
    '|---|---:|---|---|---|---|---|---|---|---|---|---|',
  );
  if (failures.length === 0) {
    lines.push('| 无 | 0 | 无 | 无 | 本轮没有业务失败 | 保持通过 | 无需复现 | 查看通过账本 | 无需复测 | 无 | 无 | 保持周期复测 |');
  } else {
    for (const failure of failures) {
      const details = businessFailureDetails(failure);
      const recovery = businessRecoveryAction(failure.reason);
      const cells = [
        failure.reason,
        failure.count,
        failure.modules.join('、') || '未标注',
        failure.caseIds.join('、') || '未标注',
        details.actual,
        details.expected,
        details.reproduction,
        '[查看逐项失败结果](#未通过与未执行逐项清单)',
        failure.methodLink || '查看逐项账本',
        failure.owners.join('、') || '待认领',
        deadline,
        recovery,
      ].map(markdownTableCell);
      lines.push(`| ${cells.join(' | ')} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function synchronizeExecutiveSummary(executiveContent, visualGateLeadContent, counts = null) {
  const gateTable = parseMarkdownTable(visualGateLeadContent);
  let synchronized = executiveContent;
  if (gateTable) {
    const projectIndex = gateTable.headers.indexOf('项目');
    const resultIndex = gateTable.headers.indexOf('结果');
    const evidenceRow = gateTable.rows.find((row) => ['可审核证据', '合格证据'].includes(row[projectIndex]));
    const moduleRow = gateTable.rows.find((row) => row[projectIndex] === '模块通过');
    if (evidenceRow && moduleRow && /^\|\s*(视觉证据|视觉验收|截图证据)\s*\|.*$/m.test(synchronized)) {
      const replacement = `| 截图证据 | 已采集 ${evidenceRow[resultIndex]} 张可审核证据；${moduleRow[resultIndex]} 个模块有直接通过证据 | 截图采集完成不等于业务验收通过；按“截图证据怎么读”理解证明范围 |`;
      synchronized = synchronized.replace(/^\|\s*(视觉证据|视觉验收|截图证据)\s*\|.*$/m, replacement);
    }
  }
  if (counts && /^\|\s*功能验收\s*\|.*$/m.test(synchronized)) {
    synchronized = synchronized.replace(
      /^\|\s*功能验收\s*\|.*$/m,
      `| 功能验收 | ${counts.passed}/${counts.planned} 通过，${counts.failed} 不通过，${counts.notRun} 未执行 | 优先查看失败和未执行清单，未执行不能按通过计算 |`,
    );
  }
  return synchronized;
}

function renderCombinedExecutiveSummary(
  functionalLead,
  visualGateLeadContent,
  overallVerdict = '',
  executionSummary = null,
) {
  const functionalMatch = String(functionalLead).match(/共\s*(\d+)\s*项，(\d+)\s*项通过、(\d+)\s*项不通过、(\d+)\s*项未执行/);
  const gateTable = parseMarkdownTable(visualGateLeadContent);
  const rowValue = (name) => {
    if (!gateTable) return '未记录';
    const projectIndex = gateTable.headers.indexOf('项目');
    const resultIndex = gateTable.headers.indexOf('结果');
    return gateTable.rows.find((row) => row[projectIndex] === name)?.[resultIndex] || '未记录';
  };
  const functionalSummary = functionalMatch
    ? `${functionalMatch[2]}/${functionalMatch[1]} 通过，${functionalMatch[3]} 不通过，${functionalMatch[4]} 未执行`
    : '详见逐项功能账本';
  const visualStatus = rowValue('状态结果');
  const visualEvidence = rowValue('可审核证据');
  const functionalPassed = functionalMatch
    ? Number(functionalMatch[3]) === 0 && Number(functionalMatch[4]) === 0
    : !/不通过|部分通过/.test(functionalLead);
  const canRelease = functionalPassed
    && rowValue('能否发布') === '可以'
    && normalizedVerdict(overallVerdict) === 'pass';
  const environmentCoverage = Array.isArray(executionSummary?.environmentCoverage)
    ? executionSummary.environmentCoverage
    : [];
  const environmentSummary = environmentCoverage.length > 0
    ? environmentCoverage.map((item) => {
      const name = item.environment === 'cds' ? 'CDS' : item.environment === 'production' ? '正式环境' : item.environment;
      return `${name}完成 ${item.completed}/${item.planned}，通过 ${item.passed}，失败 ${item.failed}，未执行 ${item.notRun}`;
    }).join('；')
    : '本轮未提供可计算的双环境执行汇总';
  return [
    '## 处理流程',
    '',
    '| 决策项 | 结论 | 下一步 |',
    '|---|---|---|',
    `| 能否发布 | ${canRelease ? '可以' : '不可以'} | ${canRelease ? '保持每 48 小时复测' : '失败、未执行、缺证据和需干预项关闭前，不得宣布全面通过'} |`,
    `| 功能验收 | ${functionalSummary} | 优先查看失败和未执行清单，未执行不能按通过计算 |`,
    `| 截图证据 | 已采集 ${visualEvidence}；状态判定为 ${visualStatus} | 截图采集完成不等于业务验收通过；按“截图证据怎么读”理解证明范围 |`,
    `| 环境覆盖 | ${environmentSummary} | 以本轮双环境执行账本为准，不沿用历史运行结论 |`,
    '| 阅读顺序 | 本页结论 → 需处理异常 → 模块总览 → 逐项账本 → 截图 | 命令、接口、日志只看独立技术附录 |',
    '',
  ].join('\n');
}

function synchronizeMethodSummary(methodContent, visualGateLeadContent) {
  const gateTable = parseMarkdownTable(visualGateLeadContent);
  if (!gateTable) return methodContent;
  const projectIndex = gateTable.headers.indexOf('项目');
  const resultIndex = gateTable.headers.indexOf('结果');
  const evidenceRow = gateTable.rows.find((row) => ['可审核证据', '合格证据'].includes(row[projectIndex]));
  if (!evidenceRow) return methodContent;
  const replacement = `| 视觉测试 | 每个关键页面状态是否完整、可操作、可理解 | ${evidenceRow[resultIndex]} 张可审核证据，异常状态单独核销 | [查看逐项视觉方法](#视觉测试方法) |`;
  if (/^\|\s*视觉测试\s*\|.*$/m.test(methodContent)) {
    return methodContent.replace(/^\|\s*视觉测试\s*\|.*$/m, replacement);
  }
  return methodContent;
}

export function renderHumanReadableAcceptanceDesign(gateModuleContent, executionSummary = null) {
  const rows = visualCoverageRows(gateModuleContent).map((row) => ({
    ...row,
    '视觉结论': row['视觉结论'] || '未执行',
    '采集文件': row['采集文件'] || '0',
    '可审核证据': row['可审核证据'] || row['合格证据'] || '0/待定',
    '缺口': row['缺口'] || '待补齐逐项证据',
    '查看全部截图': row['查看全部截图'] || '',
  }));
  if (rows.length === 0) return '';
  const evidenceTotals = rows.reduce((totals, row) => {
    const match = String(row['可审核证据']).match(/(\d+)\/(\d+)/);
    totals.actual += Number(match?.[1] || 0);
    totals.planned += Number(match?.[2] || 0);
    return totals;
  }, { actual: 0, planned: 0 });
  const allVisualPassed = rows.every((row) => row['视觉结论'] === '通过');
  const environmentCoverage = Array.isArray(executionSummary?.environmentCoverage)
    ? executionSummary.environmentCoverage
    : [];
  const environmentProof = environmentCoverage.length > 0
    ? environmentCoverage.map((item) => {
      const name = item.environment === 'cds' ? 'CDS' : item.environment === 'production' ? '正式环境' : item.environment;
      return `${name}完成 ${item.completed}/${item.planned}，通过 ${item.passed}，失败 ${item.failed}，未执行 ${item.notRun}`;
    }).join('；')
    : '本轮未提供可计算的双环境执行汇总，不能判定全面通过';
  const lines = [
    '## 改动断言表',
    '',
    '| 改动断言 | 必要证明 | 当前结果 |',
    '|---|---|---|',
    ...rows.map((row) => `| ${row['模块']}的关键用户旅程可用 | 冒烟或功能结果，加 ${String(row['可审核证据']).split('/')[1] || row['可审核证据']} 张逐项视觉证据，且关键状态无失败 | ${row['视觉结论']}；严格结论见逐张账本 |`),
    '',
    '## 影响面矩阵',
    '',
    '| 模块 | 用户可见范围 | 完整用户路径 | 当前风险 |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${row['模块']} | 入口、操作、等待、结果、失败恢复和适用设备 | ${row['真实面包屑']} | ${row['缺口']} |`),
    '',
    '## 融合测试设计',
    '',
    '| 用户旅程 | 融合范围 | 关键断点 | 当前判定 |',
    '|---|---|---|---|',
    ...rows.map((row) => {
      const status = row['视觉结论'];
      const statusCounts = plainCell(row['状态结果']);
      const declaredGap = plainCell(row['缺口']);
      const actionableGap = declaredGap && declaredGap !== '无'
        ? declaredGap
        : statusCounts
          ? `状态分布：${statusCounts}`
          : '按逐张账本完成剩余操作、结果回读和清理回读';
      const conclusion = status === '通过'
        ? '本轮视觉证据通过；功能结果仍以功能账本为准'
        : `${status}；${actionableGap}`;
      return `| ${row['模块']}关键用户旅程 | ${row['真实面包屑']} | 入口、操作、结果、失败恢复与刷新回读 | ${conclusion} |`;
    }),
    '',
    '## 证明力矩阵',
    '',
    '| 结论 | 用户可见页面 | 交互动作 | 内部佐证 | 失败条件 | 证明力 |',
    '|---|---|---|---|---|---|',
    '| 功能通过 | 真实入口、输入、进度和结果页 | 按面包屑完成点击、输入、上传与回读 | 接口结果和持久化只作补充 | 任一步未执行、失败或无法回读 | 仅对已执行功能项有效 |',
    `| 视觉通过 | 每个计划状态各有唯一截图 | 使用真实鼠标或触控完成用户操作 | 截图元数据和运行记录只作补充 | 数量不足、状态缺失、重复图或严格结论非通过 | ${evidenceTotals.actual}/${evidenceTotals.planned} 张可审核；${allVisualPassed ? '全部严格通过' : '仍有异常状态，当前不成立'} |`,
    `| 全面通过 | CDS 与正式环境同一套关键旅程均通过 | 两环境独立登录并完成全套 | 版本、回滚和报告记录 | 任一失败或未执行 | ${environmentProof} |`,
    '',
    '## 页面优先证据分层',
    '',
    '| 层级 | 用户可见页面 | 页面证据 | 内部佐证 | 使用原则 |',
    '|---|---|---|---|---|',
    '| 第一层 | 用户实际看到的入口、操作、进度、结果与错误 | 唯一截图和完整面包屑 | 无 | 先回答用户能否完成任务 |',
    '| 第二层 | 同一页面刷新后的持久化结果 | 前后状态截图 | 数据回读 | 证明结果不是临时假象 |',
    '| 第三层 | 页面无法解释的失败原因 | 用户可读错误截图 | 脱敏运行记录 | 只用于定位，不替代页面证据 |',
    '',
    '## 改动断言到证据表',
    '',
    '| 改动断言 | 必要证明 | 实际证据 | 关联性 |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${row['模块']}关键旅程可用 | ${row['可审核证据']} 张唯一证据、关键状态完整、结果无失败 | 已采集 ${row['采集文件']} 张，可审核证据 ${row['可审核证据']}；${row['查看全部截图']} | 证据与该模块唯一验收位逐项绑定，严格结论不能被数量覆盖 |`),
    '',
    '## 覆盖缺口',
    '',
    '| 模块 | 覆盖缺口 | 影响 | 补跑路径 | 当前状态 | 是否需干预 |',
    '|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row['模块']} | ${row['视觉结论'] === '通过' ? row['缺口'] : `${row['状态结果'] || row['视觉结论']}；${row['缺口']}`} | 严格结论非通过时不得判定全面视觉通过 | ${row['真实面包屑']} | ${row['视觉结论']} | ${row['视觉结论'] === '通过' ? '否' : '是'} |`),
    '',
    '## 移动端验收',
    '',
    '- 视口：使用清单记录的真实移动端逻辑视口；桌面浏览器仅改变宽度不能代替移动端证据。',
    '- 触控与入口路径：每条移动路径从登录或首页开始，以真实触控上下文沿完整面包屑进入目标状态。',
    '- 结果状态：入口或操作阶段与结果或状态阶段分别记录，严格结论以逐张账本为准。',
    '- 滚动：逐页检查纵向滚动能否到达全部操作，弹窗和长内容不得形成滚动死区。',
    '- 横向溢出：检查页面、画布、进度条和弹窗；出现横向溢出即判不通过。',
    '- 遮挡裁切：检查底部按钮、输入框、进度信息和结果区域；任何遮挡或裁切均判不通过。',
    '- 当前结论：移动端证据已纳入逐张账本；单图生成进度和多图移动操作仍有不通过项，不能宣布移动端全面通过。',
    '',
  ];
  return lines.join('\n');
}

export function synchronizeVisualOverview(overviewContent, gateModuleContent) {
  const overviewTable = parseMarkdownTable(overviewContent);
  const gateTable = parseMarkdownTable(gateModuleContent);
  if (!overviewTable || !gateTable) return overviewContent;

  const gateModuleIndex = gateTable.headers.indexOf('模块');
  const gateStatusIndex = gateTable.headers.indexOf('视觉结论');
  const overviewModuleIndex = overviewTable.headers.indexOf('模块');
  const overviewStatusIndex = overviewTable.headers.indexOf('视觉');
  const overviewSeverityIndex = overviewTable.headers.indexOf('最高问题');
  const overviewInterventionIndex = overviewTable.headers.indexOf('是否需干预');
  const overviewStepsIndex = overviewTable.headers.indexOf('查看步骤');
  const overviewScreenshotIndex = overviewTable.headers.indexOf('查看截图');
  const overviewDefectIndex = overviewTable.headers.indexOf('查看缺陷');
  const overviewMethodIndex = overviewTable.headers.indexOf('关联测试方法');
  if ([gateModuleIndex, gateStatusIndex, overviewModuleIndex, overviewStatusIndex].some((index) => index < 0)) {
    return overviewContent;
  }

  const gateRowsByModule = new Map(gateTable.rows.map((row) => [row[gateModuleIndex], row]));
  const gateScreensIndex = gateTable.headers.indexOf('查看全部截图');
  const gateMethodIndex = gateTable.headers.indexOf('测试方法');
  const rewrittenRows = overviewTable.rows.map((row) => {
    const gateRow = gateRowsByModule.get(row[overviewModuleIndex]);
    const rawStatus = gateRow?.[gateStatusIndex];
    const status = rawStatus === '需干预' ? '部分通过' : rawStatus;
    if (!status) return row;
    const next = [...row];
    next[overviewStatusIndex] = status;
    if (status !== '通过') {
      if (overviewSeverityIndex >= 0 && (!next[overviewSeverityIndex] || next[overviewSeverityIndex] === '无')) {
        next[overviewSeverityIndex] = 'P2';
      }
      if (overviewInterventionIndex >= 0) next[overviewInterventionIndex] = '是';
    }
    const screenshotsLink = gateRow?.[gateScreensIndex] || '';
    const methodLink = gateRow?.[gateMethodIndex] || '';
    if (overviewStepsIndex >= 0 && screenshotsLink) next[overviewStepsIndex] = screenshotsLink;
    if (overviewScreenshotIndex >= 0 && screenshotsLink) next[overviewScreenshotIndex] = screenshotsLink;
    if (overviewDefectIndex >= 0) next[overviewDefectIndex] = '[查看](#视觉异常证据索引)';
    if (overviewMethodIndex >= 0 && methodLink) next[overviewMethodIndex] = methodLink;
    return next;
  });
  const tableLines = [
    `| ${overviewTable.headers.join(' | ')} |`,
    `|${overviewTable.headers.map(() => '---').join('|')}|`,
    ...rewrittenRows.map((row) => `| ${row.join(' | ')} |`),
  ];
  return String(overviewContent).replace(/(?:^\|.*\|$\n?){3,}/m, `${tableLines.join('\n')}\n`);
}

function strictFunctionalStatus(row, headers) {
  const selected = ['CDS', '正式环境']
    .map((name) => row[headers.indexOf(name)] || '')
    .filter((value) => value && value !== '未选择');
  if (selected.some((value) => value.startsWith('不通过'))) return '不通过';
  if (selected.some((value) => value.startsWith('部分通过'))) return '部分通过';
  if (selected.length > 0 && selected.every((value) => value.startsWith('通过'))) return '通过';
  return '未执行';
}

export function synthesizeReviewerOverview(functionalModuleContent, gateModuleContent) {
  const functionalTable = parseMarkdownTable(functionalModuleContent);
  const gateTable = parseMarkdownTable(gateModuleContent);
  if (!gateTable) return '';
  const gateRows = visualCoverageRows(gateModuleContent);
  const functionalRows = functionalTable
    ? new Map(functionalTable.rows.map((row) => [row[functionalTable.headers.indexOf('模块')], row]))
    : new Map();
  const lines = [
    '## 模块验收总览',
    '',
    '| 模块 | 真实面包屑 | 冒烟 | 功能 | 视觉 | 最高问题 | 是否需干预 | 查看步骤 | 查看截图 | 查看缺陷 | 关联测试方法 |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...gateRows.map((gateRow) => {
      const module = gateRow['模块'];
      const functionalRow = functionalRows.get(module);
      const functionalStatus = functionalRow && functionalTable
        ? strictFunctionalStatus(functionalRow, functionalTable.headers)
        : '未执行';
      const rawVisualStatus = gateRow['视觉结论'] || '未执行';
      const visualStatus = rawVisualStatus === '需干预' ? '部分通过' : rawVisualStatus;
      const statuses = [functionalStatus, visualStatus];
      const severity = statuses.includes('不通过') ? 'P1' : statuses.some((status) => status !== '通过') ? 'P2' : '无';
      const intervention = severity === '无' ? '否' : '是';
      const screenshots = gateRow['查看全部截图'] || '[查看](#逐张视觉证据账本)';
      const method = gateRow['测试方法'] || '[查看](#视觉测试方法)';
      return `| ${module} | ${gateRow['真实面包屑']} | ${functionalStatus} | ${functionalStatus} | ${visualStatus} | ${severity} | ${intervention} | [查看](#逐模块视觉取证任务) | ${screenshots} | [查看](#视觉异常证据索引) | ${method} |`;
    }),
    '',
  ];
  return lines.join('\n');
}

export function composeSupervisorReport(functionalMarkdown, visualMarkdown, visualGateMarkdown = '', visualPlanMarkdown = '', technicalUrl = '', executionSummary = null) {
  const functional = parseReportSections(functionalMarkdown);
  const visual = parseReportSections(visualMarkdown);
  const visualGate = parseReportSections(visualGateMarkdown);
  const visualPlan = parseReportSections(visualPlanMarkdown);
  const visualSummary = visual.sections.filter((section) => (
    visualGateMarkdown ? conciseVisualSections.has(section.title) : visualBeforeLedger.has(section.title)
  ));
  const visualGateSummary = visualGate.sections.filter((section) => isVisualGateSummarySection(section.title));
  const visualGateLedger = visualGate.sections.filter((section) => visualGateLedgerSections.has(section.title));
  const visualGateLead = visualGate.sections.find((section) => ['处理流程', '主管先看'].includes(section.title));
  const hasFunctionalExecutive = functional.sections.some((section) => ['处理流程', '主管先看'].includes(section.title));
  const visualSteps = visual.sections.filter((section) => /^步骤\s+\d+/.test(section.title));
  const visualPlanSections = visualPlan.sections.filter((section) => section.title === '逐模块视觉取证任务');
  const visualOverview = visual.sections.find((section) => ['模块验收总览', '主管验收总览'].includes(section.title));
  const visualGateModules = visualGate.sections.find((section) => section.title === '模块覆盖');
  const functionalModules = functional.sections.find((section) => section.title === '业务功能线与面包屑');
  const functionalFailures = functional.sections.find((section) => section.title === '未通过与未执行逐项清单');
  const functionalCoverage = functional.sections.find((section) => section.title === '执行覆盖账本');
  const ledgerEnvironmentCoverage = environmentCoverageFromLedger(functionalCoverage?.content || '');
  const effectiveExecutionSummary = ledgerEnvironmentCoverage.length > 0
    && !Array.isArray(executionSummary?.environmentCoverage)
    ? { ...(executionSummary || {}), environmentCoverage: ledgerEnvironmentCoverage }
    : executionSummary;
  const reviewerOverview = visualOverview
    ? synchronizeVisualOverview(visualOverview.content, visualGateModules?.content)
    : synthesizeReviewerOverview(functionalModules?.content || '', visualGateModules?.content || '');
  const authoritativeCounts = parseFunctionalExecutionCounts(functional.lead, effectiveExecutionSummary);
  if (effectiveExecutionSummary && authoritativeCounts && !authoritativeCounts.balanced) {
    throw new Error('执行汇总统计不守恒：通过 + 失败 + 未执行必须等于计划测试');
  }
  const countVerdict = authoritativeCounts
    ? authoritativeCounts.failed > 0
      ? 'fail'
      : authoritativeCounts.notRun > 0 ? 'conditional' : 'pass'
    : /不通过/.test(functional.lead)
      ? 'fail'
      : /部分通过/.test(functional.lead)
        ? 'conditional'
        : 'pass';
  const functionalVerdict = strictestVerdict(countVerdict, authoritativeExecutionVerdict(effectiveExecutionSummary));
  const visualCounts = visualEvidenceCounts(visualGateLead?.content || '');
  const visualGateVerdict = !visualGateMarkdown
    ? 'pass'
    : visualCounts && (visualCounts.failed > 0 || visualCounts.needsIntervention > 0)
      ? 'fail'
      : visualCounts && (visualCounts.needsEvidence > 0 || visualCounts.reviewable < visualCounts.planned)
        ? 'conditional'
        : /结论：(通过|不适用)/.test(visualGate.lead)
          ? 'pass'
          : visualCounts
            ? 'conditional'
            : /结论：不通过/.test(visualGate.lead)
              ? 'fail'
              : 'conditional';
  const inferredVerdict = strictestVerdict(functionalVerdict, visualGateVerdict);
  const synchronizedLead = (authoritativeCounts
    ? functional.lead.replace(
      /共\s*\d+\s*项，\s*\d+\s*项通过、\s*\d+\s*项不通过、\s*\d+\s*项未执行/,
      `共 ${authoritativeCounts.planned} 项，${authoritativeCounts.passed} 项通过、${authoritativeCounts.failed} 项不通过、${authoritativeCounts.notRun} 项未执行`,
    )
    : functional.lead)
    .replace(/验收主管报告/g, '验收报告')
    .replace(/主管报告/g, '验收报告')
    .replace(/主管结论/g, '验收结论');
  const output = [synchronizedLead, '', `Verdict: ${inferredVerdict}`, ''];
  const businessDecisionPage = renderBusinessDecisionPage(
    synchronizedLead,
    functionalFailures?.content || '',
    visualGateLead?.content || '',
    effectiveExecutionSummary,
    inferredVerdict,
  );
  if (!hasFunctionalExecutive) {
    output.push(renderCombinedExecutiveSummary(
      synchronizedLead,
      visualGateLead?.content || '',
      inferredVerdict,
      effectiveExecutionSummary,
    ), '');
    if (businessDecisionPage) output.push(businessDecisionPage, '');
  }
  let businessDecisionInserted = !hasFunctionalExecutive && Boolean(businessDecisionPage);
  let visualSummaryInserted = false;
  let visualLedgerInserted = false;
  for (const section of functional.sections) {
    if (section.title === '视觉证据预算' || section.title === '业务功能线与面包屑' || /^步骤\s+\d+/.test(section.title)) {
      continue;
    }
    if (['处理流程', '主管先看'].includes(section.title)) {
      output.push(
        synchronizeExecutiveSummary(section.content, visualGateLead?.content || '', authoritativeCounts)
          .replace(/^##\s+主管先看$/m, '## 处理流程')
          .replace(/\|\s*决策项\s*\|\s*结论\s*\|\s*主管动作\s*\|/m, '| 决策项 | 结论 | 下一步 |'),
        '',
      );
      if (!businessDecisionInserted && businessDecisionPage) {
        output.push(businessDecisionPage, '');
        businessDecisionInserted = true;
      }
      continue;
    }
    if (['模块验收总览', '主管验收总览'].includes(section.title)) {
      output.push((reviewerOverview || section.content).replace(/^##\s+主管验收总览$/m, '## 模块验收总览'), '');
      continue;
    }
    if (section.title === '关联测试方法') {
      output.push(synchronizeMethodSummary(section.content, visualGateLead?.content || ''), '');
      continue;
    }
    output.push(section.content, '');
    if (!visualSummaryInserted && section.title === '需干预事项') {
      output.push(...visualGateSummary.flatMap((item) => [item.content, '']));
      visualSummaryInserted = true;
    }
    if (section.title === '未通过与未执行逐项清单') {
      output.push(...visualSummary.flatMap((item) => [item.content, '']));
    }
    if (!visualLedgerInserted && section.title === '逐项验收账本') {
      output.push(...visualGateLedger.flatMap((item) => [item.content, '']));
      visualLedgerInserted = true;
    }
  }
  if (!visualSummaryInserted) {
    output.push(...visualGateSummary.flatMap((item) => [item.content, '']));
  }
  const acceptanceDesign = visualGateModules
    ? renderHumanReadableAcceptanceDesign(visualGateModules.content, effectiveExecutionSummary)
    : '';
  if (acceptanceDesign) output.push(acceptanceDesign, '');
  output.push(...visualPlanSections.flatMap((item) => [item.content, '']));
  if (!visualLedgerInserted) output.push(...visualGateLedger.flatMap((item) => [item.content, '']));
  if (!visualGateMarkdown) output.push(...visualSteps.flatMap((item) => [item.content, '']));
  return output.join('\n')
    .replace(/https:\/\/example\.invalid\/technical/g, technicalUrl || '#技术附录尚未归档')
    .replace(/\bcaseId\b/g, '验收项编号')
    .replace(/\bflaky\b/gi, '重试后通过')
    .replace(/\b5xx\b/gi, '服务异常')
    .replace(/HTTP2\s*协议错误/gi, '实时活动辅助链路偶发中断')
    .replace(/\brequestId\b/gi, '诊断编号')
    .replace(/\bSSE\b/g, '实时连接')
    .replace(/\bProvider\b/gi, '上游服务')
    .replace(/\bLogical Model\b/gi, '逻辑模型')
    .replace(/\bModel\b/g, '模型')
    .replace(/\bOffering\b/gi, '可用模型通道')
    .replace(/\bEndpoint\b/gi, '服务入口')
    .replace(/\btoken\b/gi, '登录凭据')
    .replace(/Keychain/g, '本机安全凭据库')
    .replace(/(诊断编号|登录凭据|实时活动辅助链路偶发中断)\s+(?=[\u3400-\u9fff])/g, '$1')
    .replace(/未出现\s+实时活动辅助链路偶发中断/g, '未出现实时活动辅助链路偶发中断')
    .replace(/该\s+验收项编号/g, '该验收项')
    .replace(/验收项\s+的/g, '验收项的')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

async function main() {
  const argv = process.argv.slice(2);
  const functional = readArg(argv, '--functional');
  const visual = readArg(argv, '--visual');
  const visualGate = readArg(argv, '--visual-gate');
  const visualPlan = readArg(argv, '--visual-plan');
  const output = readArg(argv, '--output');
  const technicalUrl = readArg(argv, '--technical-url');
  const executionSummaryPath = readArg(argv, '--execution-summary');
  if (!functional || !visual || !output) {
    throw new Error('必须提供 --functional、--visual 和 --output');
  }
  writeFileSync(resolve(output), composeSupervisorReport(
    readFileSync(resolve(functional), 'utf8'),
    readFileSync(resolve(visual), 'utf8'),
    visualGate ? readFileSync(resolve(visualGate), 'utf8') : '',
    visualPlan ? readFileSync(resolve(visualPlan), 'utf8') : '',
    technicalUrl,
    executionSummaryPath ? JSON.parse(readFileSync(resolve(executionSummaryPath), 'utf8')) : null,
  ), 'utf8');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
