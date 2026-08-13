import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_CATALOG = '.claude/skills/stable-smoke/reference/visual-evidence-catalog.json';

function readArg(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

function stateViewport(module, state) {
  if (!(module.requiredViewportClasses || []).includes('mobile')) return 'desktop';
  return /移动端|窄屏/.test(state) ? 'mobile' : 'desktop';
}

function stateTheme(module, index) {
  const themes = module.requiredThemes || ['dark'];
  return themes[index % themes.length];
}

function mobileMetadata(module, label, primaryState, viewportClass) {
  if (viewportClass !== 'mobile') return {};
  const stageText = `${label || ''} ${primaryState || ''}`;
  return {
    mobilePathId: `${module.id}-mobile`,
    mobileStage: /结果|完成|保存|持久|回读|进度|状态|预览|失败|恢复|时间轴/.test(stageText)
      ? 'result'
      : 'action',
  };
}

function slotId(moduleId, sequence) {
  return `VISUAL-${moduleId.toUpperCase()}-${String(sequence).padStart(2, '0')}`;
}

export function normalizeVisualEnvironments(value = []) {
  const requested = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(requested
    .map((item) => String(item).trim())
    .filter((item) => item === 'cds' || item === 'production'))];
}

function environmentLabel(environment) {
  return environment === 'cds' ? 'CDS 环境' : '正式环境';
}

function normalizeOrigin(value) {
  if (!value) return '';
  try {
    return new URL(String(value)).origin;
  } catch {
    throw new Error(`视觉取证环境地址无效：${value}`);
  }
}

function resolveSlotBinding(module, state, environmentOrigins, gatewayEnvironmentOrigins, environment) {
  const binding = module.stateBindings?.[state] || {};
  const originKind = binding.originKind || module.originKind || 'app';
  return {
    pageOrigin: originKind === 'gateway'
      ? gatewayEnvironmentOrigins[environment]
      : environmentOrigins[environment],
    entryPath: binding.entryPath || module.entryPath,
  };
}

export function buildVisualPlan(catalog, requestedEnvironments = [], runIdentity = {}) {
  const environments = normalizeVisualEnvironments(requestedEnvironments);
  const scope = String(runIdentity.scope || 'full').trim() || 'full';
  const runId = String(runIdentity.runId || '').trim();
  const commit = String(runIdentity.commit || '').trim();
  const captureStartedAt = String(runIdentity.captureStartedAt || '').trim();
  const environmentOrigins = Object.fromEntries(environments.map((environment) => [
    environment,
    normalizeOrigin(runIdentity.environmentOrigins?.[environment]),
  ]).filter(([, origin]) => origin));
  const gatewayEnvironmentOrigins = Object.fromEntries(environments.map((environment) => [
    environment,
    normalizeOrigin(runIdentity.gatewayEnvironmentOrigins?.[environment]),
  ]).filter(([, origin]) => origin));
  const hasRunIdentity = Boolean(runId && commit && captureStartedAt);
  if (hasRunIdentity) {
    for (const environment of environments) {
      if (!environmentOrigins[environment]) {
        throw new Error(`${environmentLabel(environment)}主应用视觉取证地址未配置`);
      }
      if ((catalog.modules || []).some((module) => module.originKind === 'gateway')
          && !gatewayEnvironmentOrigins[environment]) {
        throw new Error(`${environmentLabel(environment)}模型网关视觉取证地址未配置`);
      }
    }
  }
  if (scope === 'production-read-only') {
    return {
      schemaVersion: hasRunIdentity ? '3.0' : environments.length > 0 ? '2.0' : '1.0',
      name: catalog.name,
      scope,
      scopeReason: '正式环境单独运行仅执行只读健康检查，不进入需要截图取证的业务创作页面',
      environments,
      runId: runId || undefined,
      commit: commit || undefined,
      captureStartedAt: captureStartedAt || undefined,
      environmentOrigins,
      gatewayEnvironmentOrigins,
      plannedScreenshotTarget: 0,
      modules: [],
      slots: [],
    };
  }
  if (scope !== 'full') throw new Error(`不支持的视觉取证范围：${scope}`);
  const planEnvironments = environments.length > 0 ? environments : [''];
  const slots = [];
  for (const environment of planEnvironments) {
    for (const module of catalog.modules || []) {
      let sequence = 1;
      const qualifySlotId = (id) => environment ? `${environment.toUpperCase()}-${id}` : id;
      const qualifyBreadcrumb = (breadcrumb) => environment
        ? `${environmentLabel(environment)} → ${breadcrumb}`
        : breadcrumb;
      for (const [index, state] of (module.requiredStates || []).entries()) {
        const viewportClass = stateViewport(module, state);
        const binding = resolveSlotBinding(
          module,
          state,
          environmentOrigins,
          gatewayEnvironmentOrigins,
          environment,
        );
        slots.push({
          slotId: qualifySlotId(slotId(module.id, sequence++)),
          environment: environment || undefined,
          moduleId: module.id,
          module: module.name,
          scenario: state,
          primaryState: state,
          coverageStates: [state],
          testType: index === 0 ? '冒烟' : '视觉',
          theme: stateTheme(module, index),
          viewportClass,
          ...mobileMetadata(module, state, state, viewportClass),
          breadcrumb: qualifyBreadcrumb(`${module.breadcrumb} → ${state}`),
          expectedProof: `页面处于“${state}”状态，关键内容和操作完整可见`,
          methodAnchor: `#visual-method-${module.id}`,
          status: '未执行',
          pageOrigin: binding.pageOrigin || undefined,
          entryPath: binding.entryPath,
          captureStartedAt: captureStartedAt || undefined,
        });
      }
      for (const extra of module.additionalEvidenceSlots || []) {
        const binding = resolveSlotBinding(
          module,
          extra.label,
          environmentOrigins,
          gatewayEnvironmentOrigins,
          environment,
        );
        slots.push({
          slotId: qualifySlotId(slotId(module.id, sequence++)),
          environment: environment || undefined,
          moduleId: module.id,
          module: module.name,
          scenario: extra.label,
          primaryState: extra.primaryState,
          coverageStates: [extra.primaryState],
          testType: '视觉',
          theme: extra.theme,
          viewportClass: extra.viewportClass,
          ...mobileMetadata(module, extra.label, extra.primaryState, extra.viewportClass),
          breadcrumb: qualifyBreadcrumb(`${module.breadcrumb} → ${extra.label}`),
          expectedProof: extra.expectedProof,
          methodAnchor: `#visual-method-${module.id}`,
          status: '未执行',
          pageOrigin: binding.pageOrigin || undefined,
          entryPath: binding.entryPath,
          captureStartedAt: captureStartedAt || undefined,
        });
      }
      const moduleSlots = slots.filter((slot) => slot.moduleId === module.id && slot.environment === (environment || undefined));
      if (moduleSlots.length !== module.uniqueScreenshotFloor) {
        throw new Error(`${environment ? `${environmentLabel(environment)}的` : ''}${module.name}逐项计划 ${moduleSlots.length} 与截图下限 ${module.uniqueScreenshotFloor} 不一致`);
      }
    }
  }
  const environmentMultiplier = planEnvironments.length;
  const expectedFloor = catalog.uniqueScreenshotFloor * environmentMultiplier;
  const expectedTarget = catalog.plannedScreenshotTarget * environmentMultiplier;
  if (slots.length !== expectedFloor || slots.length !== expectedTarget) {
    throw new Error(`视觉计划共 ${slots.length} 项，与双环境展开后的全局下限 ${expectedFloor} 或计划 ${expectedTarget} 不一致`);
  }
  return {
    schemaVersion: hasRunIdentity ? '3.0' : environments.length > 0 ? '2.0' : '1.0',
    name: catalog.name,
    scope,
    environments,
    runId: runId || undefined,
    commit: commit || undefined,
    captureStartedAt: captureStartedAt || undefined,
    environmentOrigins,
    gatewayEnvironmentOrigins,
    plannedScreenshotTarget: slots.length,
    modules: (catalog.modules || []).map((module) => ({
      id: module.id,
      name: module.name,
      breadcrumb: module.breadcrumb,
      entryPath: module.entryPath,
      planned: slots.filter((slot) => slot.moduleId === module.id).length,
    })),
    slots,
  };
}

export function renderVisualPlan(plan) {
  if (plan.scope === 'production-read-only') {
    return [
      '# 核心业务视觉取证执行清单',
      '',
      `运行标识：${plan.runId}`,
      `提交版本：${plan.commit}`,
      `取证开始：${plan.captureStartedAt}`,
      '',
      '计划：0 张。本轮为正式环境只读健康检查，不进入业务创作页面，完整视觉门禁不适用。',
      '',
      '## 主管覆盖摘要',
      '',
      '| 范围 | 当前状态 | 是否需干预 | 说明 |',
      '|---|---|---|---|',
      `| 正式环境只读健康检查 | 不适用 | 否 | ${plan.scopeReason}；本结论不代表完整视觉验收通过 |`,
      '',
      '## 逐模块视觉取证任务',
      '',
      `本轮无视觉取证任务。原因：${plan.scopeReason}。需要完整视觉结论时，执行 CDS 或双环境全量稳定冒烟。`,
      '',
    ].join('\n');
  }
  const lines = [
    '# 核心业务视觉取证执行清单',
    '',
    ...(plan.runId ? [
      `运行标识：${plan.runId}`,
      `提交版本：${plan.commit}`,
      `取证开始：${plan.captureStartedAt}`,
      '',
    ] : []),
    `计划：${plan.plannedScreenshotTarget} 张可审核证据。每一行必须得到一张唯一截图或明确标为不通过、未执行；不得合并核销。`,
    '',
    '## 主管覆盖摘要',
    '',
    '| 模块 | 计划截图 | 当前状态 | 是否需干预 | 完整面包屑 | 查看逐项清单 |',
    '|---|---:|---|---|---|---|',
    ...plan.modules.map((module) => `| ${module.name} | ${module.planned} | 未执行 | 是 | ${module.breadcrumb} | [查看](#visual-plan-${module.id}) |`),
    '',
    '## 逐模块视觉取证任务',
    '',
    ...plan.modules.flatMap((module) => {
      const moduleSlots = plan.slots.filter((slot) => slot.moduleId === module.id);
      return [
        `<a id="visual-plan-${module.id}"></a>`,
        `### ${module.name} · 0/${module.planned} 项完成`,
        '',
        '| 序号 | 验收场景 | 类型 | 主题 | 设备 | 完整测试路径 | 预期证明 | 当前状态 | 是否需干预 | 测试方法 |',
        '|---:|---|---|---|---|---|---|---|---|---|',
        ...moduleSlots.map((slot, index) => `| ${index + 1} | ${slot.scenario} | ${slot.testType} | ${slot.theme === 'dark' ? '暗色' : '亮色'} | ${slot.viewportClass === 'mobile' ? '真实触控移动端' : '桌面端'} | ${slot.breadcrumb} | ${slot.expectedProof} | ${slot.status} | 是，需要执行并取证 | [查看](${slot.methodAnchor}) |`),
        '',
      ];
    }),
    '判定原则：每一行必须得到一张唯一截图，并明确写为通过、不通过或需干预；未执行不能按通过计算。一张截图不能替代多项状态。',
    '',
  ];
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const catalog = JSON.parse(readFileSync(resolve(readArg(argv, '--catalog', DEFAULT_CATALOG)), 'utf8'));
  const environments = normalizeVisualEnvironments(readArg(argv, '--environments'));
  const plan = buildVisualPlan(catalog, environments, {
    runId: readArg(argv, '--run-id'),
    commit: readArg(argv, '--commit'),
    captureStartedAt: readArg(argv, '--capture-started-at'),
    scope: readArg(argv, '--scope', 'full'),
    environmentOrigins: {
      cds: readArg(argv, '--cds-origin'),
      production: readArg(argv, '--production-origin'),
    },
    gatewayEnvironmentOrigins: {
      cds: readArg(argv, '--cds-gateway-origin'),
      production: readArg(argv, '--production-gateway-origin'),
    },
  });
  const outputJson = readArg(argv, '--output-json');
  const outputMd = readArg(argv, '--output-md');
  if (outputJson) writeFileSync(resolve(outputJson), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  if (outputMd) writeFileSync(resolve(outputMd), `${renderVisualPlan(plan)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ planned: plan.plannedScreenshotTarget, modules: plan.modules.length })}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
