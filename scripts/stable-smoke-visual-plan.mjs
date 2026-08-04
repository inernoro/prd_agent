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

function slotId(moduleId, sequence) {
  return `VISUAL-${moduleId.toUpperCase()}-${String(sequence).padStart(2, '0')}`;
}

export function buildVisualPlan(catalog) {
  const slots = [];
  for (const module of catalog.modules || []) {
    let sequence = 1;
    for (const [index, state] of (module.requiredStates || []).entries()) {
      const viewportClass = stateViewport(module, state);
      slots.push({
        slotId: slotId(module.id, sequence++),
        moduleId: module.id,
        module: module.name,
        scenario: state,
        primaryState: state,
        coverageStates: [state],
        testType: index === 0 ? '冒烟' : '视觉',
        theme: stateTheme(module, index),
        viewportClass,
        breadcrumb: `${module.breadcrumb} → ${state}`,
        expectedProof: `页面处于“${state}”状态，关键内容和操作完整可见`,
        methodAnchor: `#visual-method-${module.id}`,
        status: '未执行',
      });
    }
    for (const extra of module.additionalEvidenceSlots || []) {
      slots.push({
        slotId: slotId(module.id, sequence++),
        moduleId: module.id,
        module: module.name,
        scenario: extra.label,
        primaryState: extra.primaryState,
        coverageStates: [extra.primaryState],
        testType: '视觉',
        theme: extra.theme,
        viewportClass: extra.viewportClass,
        breadcrumb: `${module.breadcrumb} → ${extra.label}`,
        expectedProof: extra.expectedProof,
        methodAnchor: `#visual-method-${module.id}`,
        status: '未执行',
      });
    }
    const moduleSlots = slots.filter((slot) => slot.moduleId === module.id);
    if (moduleSlots.length !== module.uniqueScreenshotFloor) {
      throw new Error(`${module.name} 的逐项计划 ${moduleSlots.length} 与截图下限 ${module.uniqueScreenshotFloor} 不一致`);
    }
  }
  if (slots.length !== catalog.uniqueScreenshotFloor || slots.length !== catalog.plannedScreenshotTarget) {
    throw new Error(`视觉计划共 ${slots.length} 项，与全局下限 ${catalog.uniqueScreenshotFloor} 或计划 ${catalog.plannedScreenshotTarget} 不一致`);
  }
  return {
    schemaVersion: '1.0',
    name: catalog.name,
    plannedScreenshotTarget: slots.length,
    modules: (catalog.modules || []).map((module) => ({
      id: module.id,
      name: module.name,
      breadcrumb: module.breadcrumb,
      planned: slots.filter((slot) => slot.moduleId === module.id).length,
    })),
    slots,
  };
}

export function renderVisualPlan(plan) {
  const lines = [
    '# 核心业务视觉取证执行清单',
    '',
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
  const plan = buildVisualPlan(catalog);
  const outputJson = readArg(argv, '--output-json');
  const outputMd = readArg(argv, '--output-md');
  if (outputJson) writeFileSync(resolve(outputJson), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  if (outputMd) writeFileSync(resolve(outputMd), `${renderVisualPlan(plan)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ planned: plan.plannedScreenshotTarget, modules: plan.modules.length })}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
