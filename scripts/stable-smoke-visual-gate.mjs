import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_CATALOG = '.claude/skills/stable-smoke/reference/visual-evidence-catalog.json';

function readArg(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

function normalizeStates(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))] : [];
}

function evidenceAnchor(name) {
  return `#fig-${String(name).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')}`;
}

export function validateVisualEvidence(catalog, manifest) {
  const requiredFields = catalog.evidenceItemRequiredFields || [
    'coverageStates',
    'testType',
    'status',
    'methodAnchor',
    'breadcrumb',
  ];
  const allowedTypes = new Set(catalog.allowedTestTypes || ['冒烟', '功能', '视觉', '回归']);
  const allowedStatuses = new Set(catalog.statusVocabulary || ['通过', '不通过', '部分通过', '未执行', '需干预']);
  const rows = Array.isArray(manifest) ? manifest : [];
  const seenHashes = new Set();
  const uniqueRows = [];
  const duplicateNames = [];

  for (const row of rows) {
    const hash = String(row.sha256 || '').trim();
    if (hash && seenHashes.has(hash)) {
      duplicateNames.push(String(row.name || '未命名截图'));
      continue;
    }
    if (hash) seenHashes.add(hash);
    uniqueRows.push(row);
  }

  const modules = (catalog.modules || []).map((module) => {
    const evidence = uniqueRows.filter((row) => row.module === module.name || row.module === module.id);
    const fieldErrors = [];
    const stateEvidence = new Map(module.requiredStates.map((state) => [state, []]));

    for (const item of evidence) {
      for (const field of requiredFields) {
        const value = item[field];
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
          fieldErrors.push(`${item.name || '未命名截图'} 缺少 ${field}`);
        }
      }
      const states = normalizeStates(item.coverageStates);
      for (const state of states) {
        if (!stateEvidence.has(state)) {
          fieldErrors.push(`${item.name || '未命名截图'} 使用了目录外状态“${state}”`);
          continue;
        }
        stateEvidence.get(state).push(item.name || '未命名截图');
      }
      if (item.testType && !allowedTypes.has(item.testType)) {
        fieldErrors.push(`${item.name || '未命名截图'} 的 testType 不合法`);
      }
      if (item.status && !allowedStatuses.has(item.status)) {
        fieldErrors.push(`${item.name || '未命名截图'} 的 status 不合法`);
      }
    }

    const missingStates = [...stateEvidence.entries()]
      .filter(([, names]) => names.length === 0)
      .map(([state]) => state);
    const failedEvidence = evidence.filter((item) => item.status === '不通过');
    const interventionEvidence = evidence.filter((item) => item.status === '需干预');
    const floorPassed = evidence.length >= module.uniqueScreenshotFloor;
    const metadataPassed = fieldErrors.length === 0;
    const statePassed = missingStates.length === 0;
    const verdict = failedEvidence.length > 0
      ? '不通过'
      : interventionEvidence.length > 0
        ? '需干预'
        : floorPassed && metadataPassed && statePassed
          ? '通过'
          : '部分通过';
    const firstEvidence = evidence[0]?.name;

    return {
      id: module.id,
      name: module.name,
      breadcrumb: module.breadcrumb,
      screenshotFloor: module.uniqueScreenshotFloor,
      screenshotCount: evidence.length,
      requiredStateCount: module.requiredStates.length,
      coveredStateCount: module.requiredStates.length - missingStates.length,
      missingStates,
      fieldErrors,
      floorPassed,
      metadataPassed,
      statePassed,
      verdict,
      evidenceAnchor: firstEvidence ? evidenceAnchor(firstEvidence) : '',
      methodAnchor: evidence.find((item) => item.methodAnchor)?.methodAnchor || '',
    };
  });

  const blockingModules = modules.filter((module) => module.verdict !== '通过');
  return {
    schemaVersion: '1.0',
    verdict: blockingModules.length === 0 && duplicateNames.length === 0 ? '通过' : '不通过',
    screenshotFloor: catalog.uniqueScreenshotFloor || modules.reduce((sum, module) => sum + module.screenshotFloor, 0),
    screenshotCount: uniqueRows.length,
    rawScreenshotCount: rows.length,
    duplicateNames,
    passedModules: modules.filter((module) => module.verdict === '通过').length,
    blockingModules: blockingModules.length,
    modules,
  };
}

export function renderVisualGateReport(result) {
  const lines = [
    '# 视觉验收覆盖门禁',
    '',
    `结论：${result.verdict}`,
    '',
    '## 主管先看',
    '',
    '| 项目 | 结果 | 说明 |',
    '|---|---|---|',
    `| 有效截图 | ${result.screenshotCount}/${result.screenshotFloor} | 原始 ${result.rawScreenshotCount} 张，重复 ${result.duplicateNames.length} 张 |`,
    `| 模块通过 | ${result.passedModules}/${result.modules.length} | 数量、关键状态、元数据和页面判定必须同时满足 |`,
    `| 需处理模块 | ${result.blockingModules} | 任一模块未通过时，全面视觉验收不得判通过 |`,
    '',
    '## 模块覆盖',
    '',
    '| 模块 | 视觉结论 | 真实面包屑 | 截图 | 关键状态 | 未覆盖状态 | 查看截图 | 测试方法 |',
    '|---|---|---|---:|---:|---|---|---|',
    ...result.modules.map((module) => `| ${module.name} | ${module.verdict} | ${module.breadcrumb} | ${module.screenshotCount}/${module.screenshotFloor} | ${module.coveredStateCount}/${module.requiredStateCount} | ${module.missingStates.join('、') || '无'} | ${module.evidenceAnchor ? `[查看](${module.evidenceAnchor})` : '无证据'} | ${module.methodAnchor ? `[查看](${module.methodAnchor})` : '未绑定'} |`),
    '',
    '## 需处理事项',
    '',
    '| 模块 | 问题 | 关闭条件 |',
    '|---|---|---|',
    ...result.modules.filter((module) => module.verdict !== '通过').map((module) => {
      const issues = [
        !module.floorPassed ? `截图不足 ${module.screenshotCount}/${module.screenshotFloor}` : '',
        module.missingStates.length > 0 ? `缺少状态：${module.missingStates.join('、')}` : '',
        module.fieldErrors.length > 0 ? `有 ${module.fieldErrors.length} 条证据未绑定测试元数据` : '',
      ].filter(Boolean).join('；');
      return `| ${module.name} | ${issues || module.verdict} | 截图数量达标、全部关键状态有唯一证据、每张图绑定路径与方法且无失败 |`;
    }),
    ...(result.blockingModules === 0 ? ['| 无 | 无 | 已关闭 |'] : []),
    '',
    '判定原则：截图数量只是一道门槛；入口、输入、进度、结果、失败恢复、持久化和移动端等关键状态必须逐项绑定唯一证据。复制图片、只有入口图或未标注测试方法，均不能形成“通过”结论。',
    '',
  ];
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const catalogPath = resolve(readArg(argv, '--catalog', DEFAULT_CATALOG));
  const manifestPath = readArg(argv, '--manifest');
  if (!manifestPath) throw new Error('必须提供 --manifest <截图清单>');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));
  const result = validateVisualEvidence(catalog, manifest);
  const outputJson = readArg(argv, '--output-json');
  const outputMd = readArg(argv, '--output-md');
  if (outputJson) writeFileSync(resolve(outputJson), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (outputMd) writeFileSync(resolve(outputMd), renderVisualGateReport(result), 'utf8');
  process.stdout.write(`${JSON.stringify({ verdict: result.verdict, screenshots: result.screenshotCount, floor: result.screenshotFloor, passedModules: result.passedModules, modules: result.modules.length })}\n`);
  if (result.verdict !== '通过') process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
