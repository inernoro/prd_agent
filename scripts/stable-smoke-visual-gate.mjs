import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { buildVisualPlan, normalizeVisualEnvironments } from './stable-smoke-visual-plan.mjs';

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

function interventionLabel(status) {
  if (status === '通过') return '否';
  if (status === '需补证' || status === '未执行') return '是：质量负责人补齐证据';
  if (status === '需干预') return '是：模块负责人确认产品能力或补齐入口';
  return '是：模块负责人修复后复测';
}

function environmentLabel(environment) {
  if (environment === 'cds') return 'CDS 环境';
  if (environment === 'production') return '正式环境';
  return '未区分环境';
}

const VISUAL_STATUS_SEVERITY = new Map([
  ['通过', 0],
  ['部分通过', 1],
  ['需补证', 2],
  ['未执行', 3],
  ['需干预', 4],
  ['不通过', 5],
]);

function strictestVisualStatus(...statuses) {
  return statuses.reduce((strictest, status) => (
    (VISUAL_STATUS_SEVERITY.get(status) ?? -1) > (VISUAL_STATUS_SEVERITY.get(strictest) ?? -1)
      ? status
      : strictest
  ), '通过');
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_DECODED_BYTES = 256 * 1024 * 1024;
const PNG_CHANNELS = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]);
const PNG_BIT_DEPTHS = new Map([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);

function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodePngScreenshot(content) {
  if (content.length < 33 || !content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('截图必须是有效的 PNG 文件');
  }

  let offset = PNG_SIGNATURE.length;
  let ihdr = null;
  let sawIend = false;
  const idatChunks = [];
  while (offset < content.length) {
    if (offset + 12 > content.length) throw new Error('PNG 数据块不完整');
    const length = content.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > content.length) throw new Error('PNG 数据块长度无效');
    const type = content.subarray(offset + 4, offset + 8);
    const data = content.subarray(offset + 8, offset + 8 + length);
    const declaredCrc = content.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([type, data])) !== declaredCrc) throw new Error('PNG 数据块校验失败');
    const typeName = type.toString('ascii');
    if (typeName === 'IHDR') {
      if (ihdr || length !== 13 || offset !== PNG_SIGNATURE.length) throw new Error('PNG 图片头无效');
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (typeName === 'IDAT') {
      if (!ihdr || sawIend) throw new Error('PNG 像素数据顺序无效');
      idatChunks.push(data);
    } else if (typeName === 'IEND') {
      if (length !== 0 || !ihdr || idatChunks.length === 0) throw new Error('PNG 结束块无效');
      sawIend = true;
      offset = chunkEnd;
      break;
    }
    offset = chunkEnd;
  }

  if (!ihdr || !sawIend || offset !== content.length) throw new Error('PNG 文件未完整结束');
  const allowedDepths = PNG_BIT_DEPTHS.get(ihdr.colorType);
  if (!ihdr.width || !ihdr.height || !allowedDepths?.has(ihdr.bitDepth)
      || ihdr.compression !== 0 || ihdr.filter !== 0 || ihdr.interlace !== 0) {
    throw new Error('PNG 图片参数不受支持');
  }
  const channels = PNG_CHANNELS.get(ihdr.colorType);
  const rowBytes = Math.ceil((ihdr.width * channels * ihdr.bitDepth) / 8);
  const expectedBytes = (rowBytes + 1) * ihdr.height;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > MAX_PNG_DECODED_BYTES) {
    throw new Error('PNG 解码尺寸超过验收上限');
  }
  const decoded = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expectedBytes + 1 });
  if (decoded.length !== expectedBytes) throw new Error('PNG 像素数据长度无效');
  for (let row = 0; row < ihdr.height; row += 1) {
    if (decoded[row * (rowBytes + 1)] > 4) throw new Error('PNG 行过滤器无效');
  }
}

function inspectEvidenceFile(row) {
  const declared = String(row.sha256 || '').trim();
  const path = String(row.path || '').trim();
  if (!path) return { hash: '', error: `${row.name || '未命名截图'} 缺少可读取的截图文件` };
  let content;
  try {
    content = readFileSync(path);
  } catch {
    return { hash: '', error: `${row.name || '未命名截图'} 的截图文件不存在或无法读取` };
  }
  const hash = createHash('sha256').update(content).digest('hex');
  if (declared && declared.toLowerCase() !== hash) {
    return { hash, error: `${row.name || '未命名截图'} 的 sha256 与实际截图文件不一致` };
  }
  try {
    decodePngScreenshot(content);
  } catch {
    return { hash, error: `${row.name || '未命名截图'} 不是可解码的 PNG 截图，请重新采集` };
  }
  return { hash, error: '' };
}

export function validateVisualEvidence(catalog, manifest, requestedEnvironments = []) {
  const environments = normalizeVisualEnvironments(requestedEnvironments);
  const requiredFields = [...(catalog.evidenceItemRequiredFields || [
    'coverageStates',
    'testType',
    'status',
    'methodAnchor',
    'breadcrumb',
  ])];
  for (const field of ['automatedStatus', 'manualStatus']) {
    if (!requiredFields.includes(field)) requiredFields.push(field);
  }
  if (environments.length > 0 && !requiredFields.includes('environment')) requiredFields.push('environment');
  const allowedTypes = new Set(catalog.allowedTestTypes || ['冒烟', '功能', '视觉', '回归']);
  const allowedStatuses = new Set(catalog.statusVocabulary || ['通过', '不通过', '部分通过', '未执行', '需补证', '需干预']);
  const allowedThemes = new Set(catalog.allowedThemes || ['light', 'dark']);
  const allowedViewportClasses = new Set(catalog.allowedViewportClasses || ['desktop', 'mobile']);
  const rows = Array.isArray(manifest) ? manifest : [];
  const fileIntegrity = new Map(rows.map((row) => [row, inspectEvidenceFile(row)]));
  const seenHashes = new Set();
  const uniqueRows = [];
  const duplicateNames = [];
  const plan = buildVisualPlan(catalog, environments);

  for (const row of rows) {
    const integrity = fileIntegrity.get(row);
    const hash = integrity?.error ? '' : integrity?.hash || '';
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
    const stateEvidence = new Map((environments.length > 0 ? environments : ['']).flatMap((environment) => (
      module.requiredStates.map((state) => [`${environment}:${state}`, []])
    )));

    const evidenceRows = [];
    for (const item of evidence) {
      const itemErrors = [];
      const integrityError = fileIntegrity.get(item)?.error;
      if (integrityError) {
        fieldErrors.push(integrityError);
        itemErrors.push(integrityError);
      }
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
      const evidenceEnvironment = String(item.environment || '').trim();
      const evidenceSlotId = String(item.slotId || '').trim();
      const plannedSlot = plannedSlotById.get(evidenceSlotId);
      if (environments.length > 0 && evidenceEnvironment && !environments.includes(evidenceEnvironment)) {
        const message = `${item.name || '未命名截图'} 的 environment 不在本轮验收环境中`;
        fieldErrors.push(message);
        itemErrors.push(message);
      }
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
          ['environment', evidenceEnvironment, plannedSlot.environment || ''],
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
      const stateEvidenceKey = `${environments.length > 0 ? evidenceEnvironment : ''}:${primaryState}`;
      if (primaryState && !stateEvidence.has(stateEvidenceKey)) {
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
        if (!stateEvidence.has(`${environments.length > 0 ? evidenceEnvironment : ''}:${state}`)) {
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
      for (const field of ['automatedStatus', 'manualStatus']) {
        if (item[field] && !allowedStatuses.has(item[field])) {
          const message = `${item.name || '未命名截图'} 的 ${field} 不合法`;
          fieldErrors.push(message);
          itemErrors.push(message);
        }
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
        stateEvidence.get(stateEvidenceKey).push(item.name || '未命名截图');
      }
      const effectiveStatus = strictestVisualStatus(
        String(item.status || ''),
        String(item.automatedStatus || ''),
        String(item.manualStatus || ''),
      );
      evidenceRows.push({
        slotId: evidenceSlotId || '未绑定',
        scenario: plannedSlot?.scenario || '未绑定',
        name: item.name || '未命名截图',
        environment: evidenceEnvironment,
        caption: item.caption || '未说明证明内容',
        coverageStates: states,
        primaryState: primaryState || '未绑定',
        testType: item.testType || '未绑定',
        declaredStatus: item.status || '未绑定',
        status: itemErrors.length > 0 ? '需干预' : effectiveStatus,
        automatedStatus: item.automatedStatus || '未记录',
        manualStatus: item.manualStatus || '未记录',
        breadcrumb: item.breadcrumb || '未绑定',
        theme: item.theme || '未绑定',
        viewportClass: item.viewportClass || '未绑定',
        methodAnchor: item.methodAnchor || '',
        evidenceAnchor: evidenceAnchor(item.name || '未命名截图'),
        path: item.path || '',
        errors: itemErrors,
      });
    }

    const missingStates = [...stateEvidence.entries()]
      .filter(([, names]) => names.length === 0)
      .map(([state]) => {
        const [environment, ...stateParts] = state.split(':');
        const stateName = stateParts.join(':');
        return environments.length > 0 ? `${environmentLabel(environment)}：${stateName}` : stateName;
      });
    const missingSlots = plannedSlots
      .filter((slot) => !evidenceBySlot.has(slot.slotId))
      .map((slot) => ({ slotId: slot.slotId, scenario: slot.scenario, breadcrumb: slot.breadcrumb }));
    const qualifiedEvidence = evidenceRows.filter((item) => item.errors.length === 0);
    const failedEvidence = evidenceRows.filter((item) => item.status === '不通过');
    const interventionEvidence = evidenceRows.filter((item) => item.status === '需干预');
    const incompleteEvidence = evidenceRows.filter((item) => item.status !== '通过');
    const statusCounts = Object.fromEntries(
      [...new Set(qualifiedEvidence.map((item) => item.status))]
        .map((status) => [status, qualifiedEvidence.filter((item) => item.status === status).length]),
    );
    const evidenceEnvironments = environments.length > 0 ? environments : [''];
    const missingThemes = evidenceEnvironments.flatMap((environment) => {
      const qualifiedThemes = new Set(qualifiedEvidence
        .filter((item) => !environment || item.environment === environment)
        .map((item) => item.theme));
      return (module.requiredThemes || [])
        .filter((theme) => !qualifiedThemes.has(theme))
        .map((theme) => environment ? `${environmentLabel(environment)}：${theme}` : theme);
    });
    const missingViewportClasses = evidenceEnvironments.flatMap((environment) => {
      const qualifiedViewportClasses = new Set(qualifiedEvidence
        .filter((item) => !environment || item.environment === environment)
        .map((item) => item.viewportClass));
      return (module.requiredViewportClasses || [])
        .filter((viewport) => !qualifiedViewportClasses.has(viewport))
        .map((viewport) => environment ? `${environmentLabel(environment)}：${viewport}` : viewport);
    });
    const moduleScreenshotFloor = module.uniqueScreenshotFloor * evidenceEnvironments.length;
    const floorPassed = qualifiedEvidence.length >= moduleScreenshotFloor;
    const metadataPassed = fieldErrors.length === 0;
    const statePassed = missingStates.length === 0 && missingSlots.length === 0 && missingThemes.length === 0 && missingViewportClasses.length === 0;
    const verdict = qualifiedEvidence.length === 0
      ? '未执行'
      : failedEvidence.length > 0
      ? '不通过'
      : interventionEvidence.length > 0
        ? '需干预'
        : incompleteEvidence.length > 0
          ? '部分通过'
        : floorPassed && metadataPassed && statePassed
          ? '通过'
          : '部分通过';
    const firstEvidence = evidence[0]?.name;

    return {
      id: module.id,
      name: module.name,
      breadcrumb: module.breadcrumb,
      screenshotFloor: moduleScreenshotFloor,
      collectedScreenshotCount: evidence.length,
      screenshotCount: qualifiedEvidence.length,
      invalidEvidenceCount: evidenceRows.length - qualifiedEvidence.length,
      requiredStateCount: module.requiredStates.length * evidenceEnvironments.length,
      coveredStateCount: module.requiredStates.length * evidenceEnvironments.length - missingStates.length,
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
      statusCounts,
      evidenceRows,
    };
  });

  const blockingModules = modules.filter((module) => module.verdict !== '通过');
  const allQualifiedEvidence = modules.flatMap((module) => module.evidenceRows.filter((item) => item.errors.length === 0));
  const statusCounts = Object.fromEntries(
    [...new Set(allQualifiedEvidence.map((item) => item.status))]
      .map((status) => [status, allQualifiedEvidence.filter((item) => item.status === status).length]),
  );
  return {
    schemaVersion: environments.length > 0 ? '2.0' : '1.0',
    environments,
    verdict: blockingModules.length === 0 && duplicateNames.length === 0 ? '通过' : '不通过',
    screenshotFloor: catalog.uniqueScreenshotFloor
      ? catalog.uniqueScreenshotFloor * (environments.length > 0 ? environments.length : 1)
      : modules.reduce((sum, module) => sum + module.screenshotFloor, 0),
    screenshotCount: modules.reduce((sum, module) => sum + module.screenshotCount, 0),
    collectedScreenshotCount: uniqueRows.length,
    rawScreenshotCount: rows.length,
    duplicateNames,
    statusCounts,
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
  const abnormalStateCount = allEvidence.filter((item) => item.status !== '通过').length;
  const failedStateCount = result.statusCounts?.['不通过'] || 0;
  const missingEvidenceCount = (result.statusCounts?.['需补证'] || 0) + (result.statusCounts?.['未执行'] || 0);
  const interventionStateCount = result.statusCounts?.['需干预'] || 0;
  const lines = [
    '# 视觉验收覆盖门禁',
    '',
    `结论：${result.verdict}`,
    '',
    '## 主管先看',
    '',
    '| 项目 | 结果 | 说明 |',
    '|---|---|---|',
    `| 能否发布 | ${result.verdict === '通过' ? '可以' : '不可以'} | ${result.verdict === '通过' ? '全部视觉状态均已严格通过' : '存在失败、缺证据或需干预项，关闭前不得对外宣称全面通过'} |`,
    `| 严格结论 | ${result.verdict} | 自动检查与人工视觉采用更严格的一方作为最终结论 |`,
    `| 状态结果 | 通过 ${result.statusCounts?.['通过'] || 0}，不通过 ${failedStateCount}，需补证 ${missingEvidenceCount}，需干预 ${interventionStateCount} | 审核者优先处理下方 ${abnormalStateCount} 项异常，其余通过项可按模块抽查 |`,
    `| 采集文件 | ${result.collectedScreenshotCount} | 原始 ${result.rawScreenshotCount} 张，重复 ${result.duplicateNames.length} 张；采集文件不等于可审核证据，更不等于通过 |`,
    `| 可审核证据 | ${result.screenshotCount}/${result.screenshotFloor} | 只有逐张绑定主状态、类型、结果、主题、设备、路径和方法后才计入；可审核不等于通过 |`,
    `| 通过状态 | ${result.statusCounts?.['通过'] || 0}/${result.screenshotCount} | 其余 ${abnormalStateCount} 项分别列为不通过、需补证或需干预 |`,
    `| 模块通过 | ${result.passedModules}/${result.modules.length} | 数量、关键状态、元数据和页面判定必须同时满足 |`,
    `| 需处理模块 | ${result.blockingModules} | 任一模块未通过时，全面视觉验收不得判通过 |`,
    '',
    `## 需处理的 ${abnormalStateCount} 项异常`,
    '',
    '| 优先级 | 环境 | 模块 | 验收状态 | 测试类型 | 详细测试路径 | 严格结论 | 需要什么干预 | 查看截图 | 测试方法 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...interventionEvidence.map((item) => `| ${item.status === '不通过' ? 'P1' : 'P2'} | ${environmentLabel(item.environment)} | ${escapeCell(item.moduleName)} | ${escapeCell(item.primaryState)} | ${escapeCell(item.testType)} | ${escapeCell(item.breadcrumb)} | ${escapeCell(item.status)} | ${escapeCell(item.errors.join('；') || item.caption)}；${escapeCell(interventionLabel(item.status))} | [查看](${item.evidenceAnchor}) | ${item.methodAnchor ? `[查看](${item.methodAnchor})` : '未绑定'} |`),
    ...(interventionEvidence.length === 0 ? ['| 无 | 全部环境 | 全部模块 | 全部状态 | 视觉 | 全部路径 | 通过 | 无需干预 | 已完成 | 已完成 |'] : []),
    '',
    '## 模块覆盖',
    '',
    '| 模块 | 视觉结论 | 真实面包屑 | 采集文件 | 可审核证据 | 状态结果 | 关键状态 | 缺口 | 查看全部截图 | 测试方法 |',
    '|---|---|---|---:|---:|---:|---|---|---|',
    ...result.modules.map((module) => {
      const gaps = [
        module.missingSlots.length ? `验收位：${module.missingSlots.map((slot) => slot.scenario).join('、')}` : '',
        module.missingStates.length ? `状态：${module.missingStates.join('、')}` : '',
        module.missingThemes.length ? `主题：${module.missingThemes.join('、')}` : '',
        module.missingViewportClasses.length ? `设备：${module.missingViewportClasses.join('、')}` : '',
      ].filter(Boolean).join('；') || '无';
      const statusSummary = Object.entries(module.statusCounts).map(([status, count]) => `${status} ${count}`).join('，');
      return `| ${module.name} | ${module.verdict} | ${module.breadcrumb} | ${module.collectedScreenshotCount} | ${module.screenshotCount}/${module.screenshotFloor} | ${statusSummary} | ${module.coveredStateCount}/${module.requiredStateCount} | ${gaps} | [查看](#visual-ledger-${module.id}) | [查看](#visual-method-${module.id}) |`;
    }),
    '',
    '## 需处理事项',
    '',
    '| 模块 | 问题 | 关闭条件 |',
    '|---|---|---|',
    ...result.modules.filter((module) => module.verdict !== '通过').map((module) => {
      const issues = [
        !module.floorPassed ? `可审核证据不足 ${module.screenshotCount}/${module.screenshotFloor}` : '',
        module.missingSlots.length > 0 ? `缺少验收位：${module.missingSlots.map((slot) => slot.scenario).join('、')}` : '',
        module.missingStates.length > 0 ? `缺少状态：${module.missingStates.join('、')}` : '',
        module.missingThemes.length > 0 ? `缺少主题：${module.missingThemes.join('、')}` : '',
        module.missingViewportClasses.length > 0 ? `缺少设备：${module.missingViewportClasses.join('、')}` : '',
        module.invalidEvidenceCount > 0 ? `有 ${module.invalidEvidenceCount} 张采集文件未形成可审核证据` : '',
      ].filter(Boolean).join('；');
      return `| ${module.name} | ${issues || module.verdict} | 截图数量达标、全部关键状态有唯一证据、每张图绑定路径与方法且无失败 |`;
    }),
    ...(result.blockingModules === 0 ? ['| 无 | 无 | 已关闭 |'] : []),
    '',
    '## 视觉异常证据索引',
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
      `### ${module.name} · ${module.screenshotCount}/${module.screenshotFloor} 张可审核`,
      '',
      '| 序号 | 环境 | 验收场景 | 主验收状态 | 类型 | 自动检查 | 人工视觉 | 严格结论 | 是否需干预 | 主题 | 设备 | 真实面包屑 | 证明内容 | 查看截图 | 测试方法 |',
      '|---:|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
      ...module.evidenceRows.map((item, index) => `| ${index + 1} | ${environmentLabel(item.environment)} | ${escapeCell(item.scenario)} | ${escapeCell(item.primaryState)} | ${escapeCell(item.testType)} | ${escapeCell(item.automatedStatus)} | ${escapeCell(item.manualStatus)} | ${escapeCell(item.status)} | ${escapeCell(interventionLabel(item.status))} | ${escapeCell(item.theme)} | ${escapeCell(item.viewportClass)} | ${escapeCell(item.breadcrumb)} | ${escapeCell(item.caption)} | [查看](${item.evidenceAnchor}) | ${item.methodAnchor ? `[查看](${item.methodAnchor})` : '未绑定'} |`),
      ...(module.evidenceRows.length === 0 ? ['| 0 | 未取证 | 无 | 未执行 | 未执行 | 未记录 | 未记录 | 未执行 | 是：质量负责人补齐证据 | 未执行 | 未执行 | 未执行 | 未采集证据 | 无 | [查看方法](#visual-method-' + module.id + ') |'] : []),
      '',
    ]),
    '## 视觉证据图片',
    '',
    ...result.modules.flatMap((module) => module.evidenceRows.flatMap((item) => [
      `<a id="${item.evidenceAnchor.replace(/^#/, '')}"></a>`,
      `### ${module.name} · ${item.primaryState}`,
      '',
      `${item.caption}。严格结论：${item.status}。`,
      '',
      item.path ? `![${escapeCell(`${module.name}-${item.primaryState}`)}](<${item.path}>)` : '截图文件未绑定，需干预。',
      '',
      `[返回本模块逐项账本](#visual-ledger-${module.id})`,
      '',
    ])),
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

export function renderVisualTechnicalAppendix(result, { manifestPath = '', catalogPath = '' } = {}) {
  const lines = [
    '# 视觉验收技术附录',
    '',
    '本附录供开发与测试维护者定位使用；主管只需阅读独立主管报告。',
    '',
    '## 本轮输入与门禁',
    '',
    `- 视觉清单：${manifestPath || '未记录'}`,
    `- 状态目录：${catalogPath || '未记录'}`,
    `- 原始文件：${result.rawScreenshotCount}`,
    `- 去重后文件：${result.collectedScreenshotCount}`,
    `- 可审核证据：${result.screenshotCount}/${result.screenshotFloor}`,
    `- 严格结论：${result.verdict}`,
    '',
    '## 模块诊断',
    '',
    '| 模块 | 结论 | 无效证据 | 缺少验收位 | 缺少主题 | 缺少设备 | 元数据问题 |',
    '|---|---|---:|---|---|---|---|',
    ...result.modules.map((module) => `| ${escapeCell(module.name)} | ${module.verdict} | ${module.invalidEvidenceCount} | ${escapeCell(module.missingSlots.map((slot) => slot.slotId).join('、') || '无')} | ${escapeCell(module.missingThemes.join('、') || '无')} | ${escapeCell(module.missingViewportClasses.join('、') || '无')} | ${escapeCell(module.fieldErrors.join('；') || '无')} |`),
    '',
    '## 逐证据定位信息',
    '',
    '| 环境 | 模块 | 验收位 | 主状态 | 严格结论 | 图片文件 | 元数据错误 |',
    '|---|---|---|---|---|---|---|',
    ...result.modules.flatMap((module) => module.evidenceRows.map((item) => `| ${environmentLabel(item.environment)} | ${escapeCell(module.name)} | ${escapeCell(item.slotId)} | ${escapeCell(item.primaryState)} | ${escapeCell(item.status)} | ${escapeCell(item.path || '未绑定')} | ${escapeCell(item.errors.join('；') || '无')} |`)),
    '',
    '## 补跑方式',
    '',
    '1. 先按视觉计划逐验收位运行真实浏览器取证，禁止地址栏直达业务页。',
    '2. 每张图绑定唯一主状态、测试类型、主题、设备、完整面包屑与测试方法。',
    '3. 人工逐张回读后写入人工结论，自动检查与人工结论取更严格的一方。',
    '4. 重新执行标准化与视觉门禁；退出码非零时保持主管结论为不通过。',
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
  const environments = normalizeVisualEnvironments(readArg(argv, '--environments'));
  const result = validateVisualEvidence(catalog, manifest, environments);
  const outputJson = readArg(argv, '--output-json');
  const outputMd = readArg(argv, '--output-md');
  const outputTechnicalMd = readArg(argv, '--output-technical-md');
  if (outputJson) writeFileSync(resolve(outputJson), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (outputMd) writeFileSync(resolve(outputMd), renderVisualGateReport(result), 'utf8');
  if (outputTechnicalMd) {
    writeFileSync(resolve(outputTechnicalMd), renderVisualTechnicalAppendix(result, {
      manifestPath: resolve(manifestPath),
      catalogPath,
    }), 'utf8');
  }
  process.stdout.write(`${JSON.stringify({ verdict: result.verdict, screenshots: result.screenshotCount, floor: result.screenshotFloor, passedModules: result.passedModules, modules: result.modules.length })}\n`);
  if (result.verdict !== '通过') process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
