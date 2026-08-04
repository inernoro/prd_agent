import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildVisualPlan } from './stable-smoke-visual-plan.mjs';

const DEFAULT_CATALOG = '.claude/skills/stable-smoke/reference/visual-evidence-catalog.json';

function readArg(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

function normalizeStates(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))] : [];
}

function evidenceAnchor(name) {
  const sequence = String(name).match(/^(\d{3})-/)?.[1];
  if (sequence) return `#fig-${sequence}`;
  return `#fig-${String(name).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')}`;
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function evidenceHash(row) {
  const declared = String(row.sha256 || '').trim();
  if (declared) return declared;
  const path = String(row.path || '').trim();
  if (!path || !existsSync(path)) return '';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
  const allowedThemes = new Set(catalog.allowedThemes || ['light', 'dark']);
  const allowedViewportClasses = new Set(catalog.allowedViewportClasses || ['desktop', 'mobile']);
  const rows = Array.isArray(manifest) ? manifest : [];
  const seenHashes = new Set();
  const uniqueRows = [];
  const duplicateNames = [];
  const plan = buildVisualPlan(catalog);

  for (const row of rows) {
    const hash = evidenceHash(row);
    if (hash && seenHashes.has(hash)) {
      duplicateNames.push(String(row.name || '未命名截图'));
      continue;
    }
    if (hash) seenHashes.add(hash);
    uniqueRows.push(row);
  }

  const modules = (catalog.modules || []).map((module) => {
    const evidence = uniqueRows.filter((row) => row.module === module.name || row.module === module.id);
    const plannedSlots = plan.slots.filter((slot) => slot.moduleId === module.id);
    const plannedSlotById = new Map(plannedSlots.map((slot) => [slot.slotId, slot]));
    const evidenceBySlot = new Map();
    const fieldErrors = [];
    const stateEvidence = new Map(module.requiredStates.map((state) => [state, []]));

    const evidenceRows = [];
    for (const item of evidence) {
      const itemErrors = [];
      for (const field of requiredFields) {
        const value = item[field];
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
          const message = `${item.name || '未命名截图'} 缺少 ${field}`;
          fieldErrors.push(message);
          itemErrors.push(message);
        }
      }
      const states = normalizeStates(item.coverageStates);
      const primaryState = String(item.primaryState || '').trim();
      const evidenceSlotId = String(item.slotId || '').trim();
      const plannedSlot = plannedSlotById.get(evidenceSlotId);
      if (evidenceSlotId && !plannedSlot) {
        const message = `${item.name || '未命名截图'} 使用了目录外验收位“${evidenceSlotId}”`;
        fieldErrors.push(message);
        itemErrors.push(message);
      }
      if (plannedSlot && evidenceBySlot.has(evidenceSlotId)) {
        const message = `${item.name || '未命名截图'} 与 ${evidenceBySlot.get(evidenceSlotId)} 重复占用验收位“${evidenceSlotId}”`;
        fieldErrors.push(message);
        itemErrors.push(message);
      }
      if (plannedSlot && !evidenceBySlot.has(evidenceSlotId)) {
        evidenceBySlot.set(evidenceSlotId, item.name || '未命名截图');
      }
      if (plannedSlot) {
        const expectedBindings = [
          ['primaryState', primaryState, plannedSlot.primaryState],
          ['testType', String(item.testType || ''), plannedSlot.testType],
          ['theme', String(item.theme || ''), plannedSlot.theme],
          ['viewportClass', String(item.viewportClass || ''), plannedSlot.viewportClass],
          ['methodAnchor', String(item.methodAnchor || ''), plannedSlot.methodAnchor],
          ['breadcrumb', String(item.breadcrumb || ''), plannedSlot.breadcrumb],
        ];
        for (const [field, actual, expected] of expectedBindings) {
          if (actual && actual !== expected) {
            const message = `${item.name || '未命名截图'} 的 ${field} 与验收位“${evidenceSlotId}”不一致`;
            fieldErrors.push(message);
            itemErrors.push(message);
          }
        }
      }
      if (primaryState && !stateEvidence.has(primaryState)) {
        const message = `${item.name || '未命名截图'} 的主状态“${primaryState}”不在模块目录中`;
        fieldErrors.push(message);
        itemErrors.push(message);
      }
      if (primaryState && !states.includes(primaryState)) {
        const message = `${item.name || '未命名截图'} 的 coverageStates 未包含主状态“${primaryState}”`;
        fieldErrors.push(message);
        itemErrors.push(message);
      }
      for (const state of states) {
        if (!stateEvidence.has(state)) {
          const message = `${item.name || '未命名截图'} 使用了目录外状态“${state}”`;
          fieldErrors.push(message);
          itemErrors.push(message);
          continue;
        }
      }
      if (item.testType && !allowedTypes.has(item.testType)) {
        const message = `${item.name || '未命名截图'} 的 testType 不合法`;
        fieldErrors.push(message);
        itemErrors.push(message);
      }
      if (item.status && !allowedStatuses.has(item.status)) {
        const message = `${item.name || '未命名截图'} 的 status 不合法`;
        fieldErrors.push(message);
        itemErrors.push(message);
      }
      if (item.theme && !allowedThemes.has(item.theme)) {
        const message = `${item.name || '未命名截图'} 的 theme 不合法`;
        fieldErrors.push(message);
        itemErrors.push(message);
      }
      if (item.viewportClass && !allowedViewportClasses.has(item.viewportClass)) {
        const message = `${item.name || '未命名截图'} 的 viewportClass 不合法`;
        fieldErrors.push(message);
        itemErrors.push(message);
      }
      if (itemErrors.length === 0 && primaryState) {
        stateEvidence.get(primaryState).push(item.name || '未命名截图');
      }
      evidenceRows.push({
        slotId: evidenceSlotId || '未绑定',
        scenario: plannedSlot?.scenario || '未绑定',
        name: item.name || '未命名截图',
        caption: item.caption || '未说明证明内容',
        coverageStates: states,
        primaryState: primaryState || '未绑定',
        testType: item.testType || '未绑定',
        declaredStatus: item.status || '未绑定',
        status: itemErrors.length > 0 ? '需干预' : item.status,
        breadcrumb: item.breadcrumb || '未绑定',
        theme: item.theme || '未绑定',
        viewportClass: item.viewportClass || '未绑定',
        methodAnchor: item.methodAnchor || '',
        evidenceAnchor: evidenceAnchor(item.name || '未命名截图'),
        errors: itemErrors,
      });
    }

    const missingStates = [...stateEvidence.entries()]
      .filter(([, names]) => names.length === 0)
      .map(([state]) => state);
    const missingSlots = plannedSlots
      .filter((slot) => !evidenceBySlot.has(slot.slotId))
      .map((slot) => ({ slotId: slot.slotId, scenario: slot.scenario, breadcrumb: slot.breadcrumb }));
    const failedEvidence = evidence.filter((item) => item.status === '不通过');
    const interventionEvidence = evidence.filter((item) => item.status === '需干预');
    const qualifiedEvidence = evidenceRows.filter((item) => item.errors.length === 0);
    const qualifiedThemes = new Set(qualifiedEvidence.map((item) => item.theme));
    const qualifiedViewportClasses = new Set(qualifiedEvidence.map((item) => item.viewportClass));
    const missingThemes = (module.requiredThemes || []).filter((theme) => !qualifiedThemes.has(theme));
    const missingViewportClasses = (module.requiredViewportClasses || []).filter((viewport) => !qualifiedViewportClasses.has(viewport));
    const floorPassed = qualifiedEvidence.length >= module.uniqueScreenshotFloor;
    const metadataPassed = fieldErrors.length === 0;
    const statePassed = missingStates.length === 0 && missingSlots.length === 0 && missingThemes.length === 0 && missingViewportClasses.length === 0;
    const verdict = qualifiedEvidence.length === 0
      ? '未执行'
      : failedEvidence.length > 0
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
      collectedScreenshotCount: evidence.length,
      screenshotCount: qualifiedEvidence.length,
      invalidEvidenceCount: evidenceRows.length - qualifiedEvidence.length,
      requiredStateCount: module.requiredStates.length,
      coveredStateCount: module.requiredStates.length - missingStates.length,
      missingStates,
      missingSlots,
      missingThemes,
      missingViewportClasses,
      fieldErrors,
      floorPassed,
      metadataPassed,
      statePassed,
      verdict,
      evidenceAnchor: firstEvidence ? evidenceAnchor(firstEvidence) : '',
      methodAnchor: evidence.find((item) => item.methodAnchor)?.methodAnchor || '',
      evidenceRows,
    };
  });

  const blockingModules = modules.filter((module) => module.verdict !== '通过');
  return {
    schemaVersion: '1.0',
    verdict: blockingModules.length === 0 && duplicateNames.length === 0 ? '通过' : '不通过',
    screenshotFloor: catalog.uniqueScreenshotFloor || modules.reduce((sum, module) => sum + module.screenshotFloor, 0),
    screenshotCount: modules.reduce((sum, module) => sum + module.screenshotCount, 0),
    collectedScreenshotCount: uniqueRows.length,
    rawScreenshotCount: rows.length,
    duplicateNames,
    passedModules: modules.filter((module) => module.verdict === '通过').length,
    blockingModules: blockingModules.length,
    modules,
  };
}

export function renderVisualGateReport(result) {
  const allEvidence = result.modules.flatMap((module) => module.evidenceRows.map((item) => ({
    ...item,
    moduleId: module.id,
    moduleName: module.name,
  })));
  const interventionEvidence = allEvidence.filter((item) => item.status !== '通过');
  const lines = [
    '# 视觉验收覆盖门禁',
    '',
    `结论：${result.verdict}`,
    '',
    '## 主管先看',
    '',
    '| 项目 | 结果 | 说明 |',
    '|---|---|---|',
    `| 采集文件 | ${result.collectedScreenshotCount} | 原始 ${result.rawScreenshotCount} 张，重复 ${result.duplicateNames.length} 张；采集文件不等于合格证据 |`,
    `| 合格证据 | ${result.screenshotCount}/${result.screenshotFloor} | 只有逐张绑定主状态、类型、结果、主题、设备、路径和方法后才计入 |`,
    `| 模块通过 | ${result.passedModules}/${result.modules.length} | 数量、关键状态、元数据和页面判定必须同时满足 |`,
    `| 需处理模块 | ${result.blockingModules} | 任一模块未通过时，全面视觉验收不得判通过 |`,
    '',
    '## 模块覆盖',
    '',
    '| 模块 | 视觉结论 | 真实面包屑 | 采集文件 | 合格证据 | 关键状态 | 缺口 | 查看全部截图 | 测试方法 |',
    '|---|---|---|---:|---:|---:|---|---|---|',
    ...result.modules.map((module) => {
      const gaps = [
        module.missingSlots.length ? `验收位：${module.missingSlots.map((slot) => slot.scenario).join('、')}` : '',
        module.missingStates.length ? `状态：${module.missingStates.join('、')}` : '',
        module.missingThemes.length ? `主题：${module.missingThemes.join('、')}` : '',
        module.missingViewportClasses.length ? `设备：${module.missingViewportClasses.join('、')}` : '',
      ].filter(Boolean).join('；') || '无';
      return `| ${module.name} | ${module.verdict} | ${module.breadcrumb} | ${module.collectedScreenshotCount} | ${module.screenshotCount}/${module.screenshotFloor} | ${module.coveredStateCount}/${module.requiredStateCount} | ${gaps} | [查看](#visual-ledger-${module.id}) | [查看](#visual-method-${module.id}) |`;
    }),
    '',
    '## 需处理事项',
    '',
    '| 模块 | 问题 | 关闭条件 |',
    '|---|---|---|',
    ...result.modules.filter((module) => module.verdict !== '通过').map((module) => {
      const issues = [
        !module.floorPassed ? `合格证据不足 ${module.screenshotCount}/${module.screenshotFloor}` : '',
        module.missingSlots.length > 0 ? `缺少验收位：${module.missingSlots.map((slot) => slot.scenario).join('、')}` : '',
        module.missingStates.length > 0 ? `缺少状态：${module.missingStates.join('、')}` : '',
        module.missingThemes.length > 0 ? `缺少主题：${module.missingThemes.join('、')}` : '',
        module.missingViewportClasses.length > 0 ? `缺少设备：${module.missingViewportClasses.join('、')}` : '',
        module.invalidEvidenceCount > 0 ? `有 ${module.invalidEvidenceCount} 张采集文件未形成合格证据` : '',
      ].filter(Boolean).join('；');
      return `| ${module.name} | ${issues || module.verdict} | 截图数量达标、全部关键状态有唯一证据、每张图绑定路径与方法且无失败 |`;
    }),
    ...(result.blockingModules === 0 ? ['| 无 | 无 | 已关闭 |'] : []),
    '',
    '## 视觉异常证据',
    '',
    '| 模块 | 截图 | 当前结果 | 需处理原因 | 查看截图 | 关联测试方法 |',
    '|---|---|---|---|---|---|',
    ...interventionEvidence.map((item) => `| ${escapeCell(item.moduleName)} | ${escapeCell(item.name)} | ${escapeCell(item.status)} | ${escapeCell(item.errors.join('；') || item.caption)} | [查看](${item.evidenceAnchor}) | ${item.methodAnchor ? `[查看](${item.methodAnchor})` : '未绑定'} |`),
    ...(interventionEvidence.length === 0 ? ['| 无 | 无 | 通过 | 无 | 已完成 | 已完成 |'] : []),
    '',
    '## 逐张视觉证据账本',
    '',
    ...result.modules.flatMap((module) => [
      `<a id="visual-ledger-${module.id}"></a>`,
      `### ${module.name} · ${module.screenshotCount}/${module.screenshotFloor} 张合格`,
      '',
      '| 序号 | 验收场景 | 截图 | 主验收状态 | 类型 | 结果 | 主题 | 设备 | 真实面包屑 | 证明内容 | 查看截图 | 测试方法 |',
      '|---:|---|---|---|---|---|---|---|---|---|---|---|',
      ...module.evidenceRows.map((item, index) => `| ${index + 1} | ${escapeCell(item.scenario)} | ${escapeCell(item.name)} | ${escapeCell(item.primaryState)} | ${escapeCell(item.testType)} | ${escapeCell(item.status)} | ${escapeCell(item.theme)} | ${escapeCell(item.viewportClass)} | ${escapeCell(item.breadcrumb)} | ${escapeCell(item.caption)} | [查看](${item.evidenceAnchor}) | ${item.methodAnchor ? `[查看](${item.methodAnchor})` : '未绑定'} |`),
      ...(module.evidenceRows.length === 0 ? ['| 0 | 无 | 无 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | 未采集证据 | 无 | [查看方法](#visual-method-' + module.id + ') |'] : []),
      '',
    ]),
    '',
    '## 视觉测试方法',
    '',
    ...result.modules.flatMap((module) => [
      `<a id="visual-method-${module.id}"></a>`,
      `### ${module.name}`,
      '',
      `- 面包屑：${module.breadcrumb}`,
      `- 判定方法：${module.screenshotFloor} 个计划验收位逐一由唯一截图核销；${module.requiredStateCount} 个关键状态逐项有唯一主证据；覆盖目录规定主题和设备；每张证据绑定测试类型、结果、页面路径和测试方法；存在缺位、重复占位、失败或需干预证据时不得判通过。`,
      `- 当前结果：${module.verdict}；已覆盖 ${module.coveredStateCount}/${module.requiredStateCount} 个关键状态。`,
      '',
    ]),
    '判定原则：采集文件数量不能直接形成结论；每个计划验收位必须由唯一截图核销，入口、输入、进度、结果、失败恢复、持久化和移动端等关键状态必须逐项绑定唯一主证据。复制图片、重复占位、缺少验收位、只有入口图、缺主题设备信息或未标注测试方法，均不能形成“通过”结论。',
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
