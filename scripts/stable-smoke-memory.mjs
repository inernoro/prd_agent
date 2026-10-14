import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultMemoryPath = resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'automations/stable-smoke-48h/pools.json');
export const cdsCoreFeatureIds = ['F01', 'F05', 'F08', 'F17', 'F18'];

// 阅读表和执行表共用现有 F 编号与原 caseId，不再维护一份手写映射。
export function readBusinessContract(checklist, methods) {
  const features = checklist.split('\n').filter(line => /^\| F\d{2} \|/.test(line)).map(line => {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    const id = cells[0];
    const section = methods.split(new RegExp(`^## ${id}\\s*$`, 'm'))[1]?.split(/^## F\d{2}\s*$/m)[0] || '';
    const original = section.match(/\*\*原用例\*\*：([^\n]+)/)?.[1] || '';
    if (!original) throw new Error(`${id} 缺少原用例映射`);
    return {
      id, module: cells[1], title: cells[2], expected: cells[3],
      caseIds: [...new Set(original.match(/(?:COMMON|CORE|REC|FILE|PARSE|VIDEO|LIT|VIS|MVIS|GW|WEB)-\d+|REG-[a-z0-9-]+/gi) || [])],
      method: `doc/guide.platform.core-business-acceptance.md#${id.toLowerCase()}`,
      history: [...cells[5].matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]),
      cdsCore: cdsCoreFeatureIds.includes(id),
    };
  });
  if (features.length !== 31 || new Set(features.map(feature => feature.id)).size !== 31) {
    throw new Error('核心业务阅读清单必须与 F01 至 F31 一一对应');
  }
  const commonMethods = methods.split('\n').filter(line => /^\| B\d{2} /.test(line)).map(line => {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    return { id: cells[0].slice(0, 3), title: cells[0].slice(4), expected: cells[1], category: '常见手段', status: '既有方法', source: 'doc/guide.platform.core-business-acceptance.md' };
  });
  return { version: '2026-10-13-v2', features, commonMethods, cdsCoreFeatureIds };
}

export function loadBusinessContract() {
  return readBusinessContract(
    readFileSync(resolve(root, 'doc/spec.platform.core-business-checklist.md'), 'utf8'),
    readFileSync(resolve(root, 'doc/guide.platform.core-business-acceptance.md'), 'utf8'),
  );
}

export function readPools(path = defaultMemoryPath) {
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  const state = { revision: 0, runs: [], events: [], defects: [], methods: [] };
  if (path === defaultMemoryPath) {
    const history = readFileSync(resolve(root, 'doc/guide.platform.core-business-history.md'), 'utf8');
    const contract = loadBusinessContract();
    for (const line of history.split('\n').filter(line => /^\| DEF-[A-Z0-9-]+ \|/.test(line))) {
      const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
      const status = cells[1].match(/\b(?:open|fix-in-progress|fixed-pending-targeted-retest|fixed-pending-full-regression|reopened|verified|blocked)\b/)?.[0];
      if (!status) continue;
      const topic = cells[2].match(/#(h\d+)/)?.[1];
      const features = contract.features.filter(feature => feature.history.some(link => link.includes('#' + topic)));
      state.defects.push({ defectId: cells[0], status, environment: /-NOTIFY-/.test(cells[0]) ? 'production' : /-CDS-/.test(cells[0]) ? 'cds' : 'unknown', caseIds: features.flatMap(feature => feature.caseIds), featureIds: features.map(feature => feature.id), firstRunId: '历史源未提供，禁止用导入轮次替代', rootCause: '沿用原历史诊断，未重新推断', history: cells[2], closingCondition: cells[3] });
    }
  }
  return state;
}

export function pendingRetests(state, environment) {
  return [...new Set((state.defects || []).filter(item => item.status !== 'verified' && item.environment === environment)
    .flatMap(item => item.caseIds || []))];
}

function verifiedUrl(archive) {
  if (archive?.verifyOpen !== 'passed') return '';
  try {
    const url = new URL(archive.reportUrl);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function caseStatus(row) {
  if (row?.status === 'fail' || row?.status === 'blocked') return row.status;
  if (row?.hadFailedAttempt || row?.retryCount > 0 || row?.status === 'flaky') return 'flaky';
  return ['pass', 'fail', 'blocked'].includes(row?.status) ? row.status : 'not-run';
}

function shanghaiDay(time) {
  return new Date(Date.parse(time) + 8 * 3600000).toISOString().slice(0, 10);
}

export function updatePools(previous, { runId, profile = 'routine', commit = '', rows = [], requiredCaseIdsByEnvironment, archive = {}, notification = {}, deployments = {}, completedAt = new Date().toISOString() }, contract = loadBusinessContract()) {
  if (!/^[a-z0-9._-]+$/i.test(runId || '')) throw new Error('经验回填缺少合法 runId');
  const reportUrl = verifiedUrl(archive);
  const previousRun = (previous.runs || []).find(run => run.runId === runId);
  const existingEvents = new Map((previous.events || []).map(event => [event.key, event]));
  const defects = new Map((previous.defects || []).map(defect => [defect.defectId, { ...defect }]));
  const run = { runId, profile, commit, deployments, completedAt, reportUrl, evidenceVerified: Boolean(reportUrl), results: [] };
  for (const feature of contract.features) for (const environment of ['production', 'cds']) {
    const selected = rows.filter(row => row.environment === environment && feature.caseIds.includes(row.caseId));
    // 映射聚合只是回读视图，缺少原子项不能被一条成功掩盖。
    const statuses = selected.map(caseStatus);
    const expectedCases = requiredCaseIdsByEnvironment?.[environment]
      ? feature.caseIds.filter(caseId => requiredCaseIdsByEnvironment[environment].includes(caseId)) : feature.caseIds;
    const missing = expectedCases.filter(caseId => !selected.some(row => row.caseId === caseId));
    const status = statuses.includes('fail') ? 'fail' : statuses.includes('flaky') ? 'flaky'
      : statuses.includes('blocked') ? 'blocked' : missing.length || !selected.length ? 'not-run' : 'pass';
    run.results.push({ featureId: feature.id, environment, status, missing, cases: selected.map(row => ({ caseId: row.caseId, status: caseStatus(row) })) });
    for (const row of selected) {
      const rowStatus = caseStatus(row);
      const key = `${runId}:${environment}:${row.caseId}:${rowStatus}`;
      existingEvents.set(key, { key, runId, environment, caseId: row.caseId, featureIds: contract.features.filter(item => item.caseIds.includes(row.caseId)).map(item => item.id), status: rowStatus, time: completedAt, commit, reportUrl, rootCause: '未知', cleanup: row.cleanupStatus || '未独立回读', requestId: row.requestId || '' });
      if (['fail', 'flaky', 'blocked'].includes(rowStatus)) {
        const matched = [...defects.values()].filter(item => item.environment === environment && item.caseIds?.includes(row.caseId) && item.status !== 'verified');
        const defectId = row.defectId || (row.caseId === 'REG-visual-mobile-entry-001' ? 'ACCEPTANCE-monitor-link-001' : matched.length === 1 ? matched[0].defectId : `DEF-STSMK-${environment.toUpperCase()}-${row.caseId}`);
        const old = defects.get(defectId);
        defects.set(defectId, { ...old, defectId, environment, caseIds: [...new Set([...(old?.caseIds || []), row.caseId])], firstRunId: old?.firstRunId || runId, latestRunId: runId, status: old?.status === 'verified' ? 'reopened' : old?.status || 'open', classification: row.classification || '待诊断', rootCause: old?.rootCause || '未知', reportUrl, nextAction: '按原 caseId 首轮定向复验，保留首次证据、真实产物和清理回读；不得放宽断言' });
      }
    }
  }
  if (notification.status === 'delivery-failed' || notification.status === 'blocked') {
    const old = defects.get('DEF-STSMK-NOTIFY-001');
    defects.set('DEF-STSMK-NOTIFY-001', { ...old, defectId: 'DEF-STSMK-NOTIFY-001', environment: 'production', caseIds: ['REG-stsmk-notify-evidence-001'], firstRunId: old?.firstRunId || runId, latestRunId: runId, status: 'blocked', classification: 'configuration', rootCause: old?.rootCause || '未知：通知交付未完成，客户端失败不等于固定目标配置错误', reportUrl, nextAction: '按本轮交付诊断恢复链路，以相同 runId 与已验真报告补发并核对原固定目标 inernoro；不改投' });
    const key = `${runId}:production:notification:blocked`;
    existingEvents.set(key, { key, runId, environment: 'production', caseId: 'REG-stsmk-notify-evidence-001', featureIds: ['F31'], status: 'blocked', time: completedAt, commit, reportUrl, rootCause: old?.rootCause || '未知', cleanup: '不适用' });
  }
  // 同轮阶段重跑更新该轮；不增加事故频次，不自动关闭缺陷或晋升方法。
  const runs = [...(previous.runs || []).filter(item => item.runId !== runId), run];
  const events = [...existingEvents.values()];
  const windowEnd = shanghaiDay(completedAt);
  const windowStart = shanghaiDay(new Date(Date.parse(completedAt) - 13 * 86400000).toISOString());
  const hotspots = contract.features.map(feature => {
    const recent = events.filter(event => event.featureIds.includes(feature.id)
      && shanghaiDay(event.time) <= windowEnd && shanghaiDay(event.time) >= windowStart
      && ['fail', 'flaky', 'blocked'].includes(event.status));
    return { featureId: feature.id, title: feature.title, permanent: true, method: feature.method, history: feature.history, window: { start: windowStart, end: windowEnd, timezone: 'Asia/Shanghai' }, recentFailureRuns: [...new Set(recent.filter(event => event.status !== 'blocked').map(event => `${event.environment}:${event.runId}`))].length, sustainedBlocked: recent.some(event => event.status === 'blocked'), recent: recent.length > 0, latest: run.results.filter(result => result.featureId === feature.id) };
  });
  const methods = [...(previous.methods || [])];
  for (const method of contract.commonMethods || []) if (!methods.some(item => item.id === method.id)) methods.push(method);
  for (const defect of defects.values()) if (!methods.some(method => method.defectId === defect.defectId)) {
    methods.push({ id: `C-${defect.defectId}`, defectId: defect.defectId, status: '待验证', basisRunId: defect.firstRunId, caseIds: defect.caseIds, prediction: '原失败输入与原断言能稳定变红，正常对照变绿', deadlineAt: new Date(Date.parse(completedAt) + 14 * 86400000).toISOString(), owner: '测试维护与对应模块负责人' });
  }
  return { revision: (previous.revision || 0) + 1, contractVersion: contract.version, updatedAt: completedAt, hotspots, methods, events, defects: [...defects.values()], runs, changes: { runId, newRun: !previousRun, reportVerified: Boolean(reportUrl), pendingRetests: { production: pendingRetests({ defects: [...defects.values()] }, 'production'), cds: pendingRetests({ defects: [...defects.values()] }, 'cds') } } };
}

export function renderExperienceSummary(state) {
  const recent = state.hotspots.filter(item => item.recent);
  const labels = { pass: '通过', fail: '失败', flaky: '重试通过，不稳定', blocked: '阻塞', 'not-run': '未完成或本轮未安排' };
  return [
    '## 三池经验回填', '',
    `本轮保留 ${state.hotspots.length} 项长期关注，近期重点 ${recent.length} 项；历史事件按轮次、环境、原用例去重。候选方法未验证前不作为根因或已生效能力。`, '',
    '| 重要功能 | 正式环境 | CDS | 最近重点 |', '|---|---|---|---|',
    ...state.hotspots.map(item => `| ${item.featureId} ${item.title} | ${labels[item.latest.find(row => row.environment === 'production')?.status] || '未执行'} | ${labels[item.latest.find(row => row.environment === 'cds')?.status] || '未执行'} | ${item.sustainedBlocked ? '持续阻塞，需恢复' : item.recent ? '优先复验原问题' : '长期关注'} |`), '',
    `常见手段 ${state.methods.filter(item => item.category === '常见手段').length} 项；待验证补充 ${state.methods.filter(item => item.status === '待验证').length} 项。未关闭问题 ${state.defects.filter(item => item.status !== 'verified').length} 项，下一轮仍按原编号复验，不自动关闭。`, '',
  ].join('\n');
}

export function persistRunExperience(input, { path = defaultMemoryPath, contract = loadBusinessContract(), expectedRevision } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let acquired = false;
  let temporary = '';
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
    acquired = true;
    const old = readPools(path);
    if (expectedRevision !== undefined && old.revision !== expectedRevision) throw new Error('三池版本已变化，拒绝覆盖另一轮经验');
    const state = updatePools(old, input, contract);
    temporary = `${path}.${process.pid}.next`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
    temporary = '';
    const readback = readPools(path);
    if (readback.revision !== state.revision || readback.changes.runId !== input.runId) throw new Error('三池回填回读失败');
    return { status: 'saved', revision: state.revision, features: state.hotspots.length, events: state.events.length, changes: state.changes };
  } finally {
    if (temporary && existsSync(temporary)) unlinkSync(temporary);
    if (acquired) unlinkSync(lockPath);
  }
}
