import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
export const defaultCatalogPath = resolve(repoRoot, '.claude/skills/stable-smoke/reference/business-function-catalog.json');
export const defaultLedgerPath = resolve(repoRoot, '.claude/skills/stable-smoke/reference/regression-ledger.md');

function readArg(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
}

function readRepeatedArgs(argv, name) {
  return argv.flatMap((value, index) => value === name && argv[index + 1] ? [argv[index + 1]] : []);
}

export function loadCatalog(path = defaultCatalogPath) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function parseActiveRegressions(markdown) {
  const rows = markdown.split('\n').filter((line) => /^\| REG-[^|]+\|/.test(line));
  return rows.flatMap((line) => {
    const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
    return cells.at(-1) === 'active' ? [cells[0]] : [];
  });
}

export function validateCatalog(catalog) {
  const errors = [];
  const ids = new Set();
  if (!catalog.catalogVersion) errors.push('缺少 catalogVersion');
  if (!Array.isArray(catalog.featureLines) || catalog.featureLines.length === 0) errors.push('featureLines 不能为空');

  for (const feature of catalog.featureLines || []) {
    if (!feature.id) errors.push('存在缺少 id 的功能线');
    if (ids.has(feature.id)) errors.push(`功能线 id 重复：${feature.id}`);
    ids.add(feature.id);
    if (!['P0', 'P1', 'P2'].includes(feature.criticality)) errors.push(`${feature.id} 的 criticality 不合法`);
    if (!Array.isArray(feature.breadcrumb) || feature.breadcrumb.length < 3) errors.push(`${feature.id} 缺少可追踪面包屑`);
    if (!feature.entryPath?.startsWith('/')) errors.push(`${feature.id} 缺少站内 entryPath`);
    if (!Array.isArray(feature.requiredCaseIds) || feature.requiredCaseIds.length === 0) errors.push(`${feature.id} 缺少 requiredCaseIds`);
    if (!Array.isArray(feature.sourcePrefixes) || feature.sourcePrefixes.length === 0) errors.push(`${feature.id} 缺少 sourcePrefixes`);
    if (!['planned', 'entry', 'contract', 'contract-and-entry', 'journey'].includes(feature.automationStatus)) errors.push(`${feature.id} 的 automationStatus 不合法`);
    if (!feature.cdsPolicy || !feature.productionPolicy) errors.push(`${feature.id} 缺少双环境策略`);
    if (!feature.rollback) errors.push(`${feature.id} 缺少回滚策略`);
  }
  return errors;
}

export function selectFeatureLines(catalog, changedFiles, activeRegressions, mode = 'scheduled') {
  const activeSet = new Set(activeRegressions);
  const selected = [];
  const mappedFiles = new Set();

  for (const feature of catalog.featureLines) {
    const matchedFiles = changedFiles.filter((file) => feature.sourcePrefixes.some((prefix) => file.startsWith(prefix)));
    const regressionMatch = (feature.regressionCaseIds || []).some((id) => activeSet.has(id));
    if (mode === 'scheduled' || matchedFiles.length > 0 || regressionMatch) {
      selected.push({ ...feature, matchedFiles, selectedByRegression: regressionMatch });
      matchedFiles.forEach((file) => mappedFiles.add(file));
    }
  }

  const watched = /^(prd-api\/src\/|prd-admin\/src\/|prd-desktop\/|prd-video\/|llmgw\/|cds\/src\/|\.github\/workflows\/)/;
  const unmappedFiles = changedFiles.filter((file) => watched.test(file) && !mappedFiles.has(file));
  return { selected, unmappedFiles };
}

function gitChangedFiles(base, head) {
  if (!base || !head) return [];
  const output = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { cwd: repoRoot, encoding: 'utf8' });
  return output.split('\n').map((item) => item.trim()).filter(Boolean);
}

function gitCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

export function buildPlan({ catalog, changedFiles, activeRegressions, mode, commit }) {
  const catalogErrors = validateCatalog(catalog);
  const { selected, unmappedFiles } = selectFeatureLines(catalog, changedFiles, activeRegressions, mode);
  const incomplete = selected.filter((feature) => feature.automationStatus === 'planned');
  const verdict = catalogErrors.length > 0 || unmappedFiles.length > 0
    ? 'fail'
    : incomplete.length > 0
      ? 'conditional'
      : 'pass';
  const requiredCaseIds = [...new Set(selected.flatMap((feature) => [...feature.requiredCaseIds, ...(feature.regressionCaseIds || [])]))].sort();
  return {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    mode,
    commit,
    catalogVersion: catalog.catalogVersion,
    verdict,
    catalogErrors,
    changedFiles,
    unmappedFiles,
    activeRegressions,
    requiredCaseIds,
    featureLines: selected,
  };
}

export function renderPlanMarkdown(plan) {
  const lines = [
    `# 核心业务稳定计划 · ${plan.catalogVersion}`,
    '',
    `Verdict: ${plan.verdict}`,
    '',
    `- 模式：${plan.mode}`,
    `- 固定版本：${plan.commit}`,
    `- 生成功能线：${plan.featureLines.length}`,
    `- 必跑用例：${plan.requiredCaseIds.length}`,
    '',
    '| 功能线 | 等级 | 面包屑 | CDS 环境 | 正式环境 | 自动化现状 | 回滚 |',
    '|---|---|---|---|---|---|---|',
    ...plan.featureLines.map((feature) => `| ${feature.label} | ${feature.criticality} | ${feature.breadcrumb.join(' → ')} | ${feature.cdsPolicy} | ${feature.productionPolicy} | ${feature.automationStatus} | ${feature.rollback} |`),
    '',
    '## 自动纳入依据',
    '',
    plan.mode === 'scheduled'
      ? '- 48 小时复测固定纳入全部功能线和全部 active 永久回归。'
      : '- 本次按代码路径映射受影响功能线，并追加全部 active 永久回归。',
    ...plan.featureLines.filter((feature) => feature.matchedFiles.length > 0).map((feature) => `- ${feature.label}：${feature.matchedFiles.join('、')}`),
    '',
    '## 未覆盖或阻断',
    '',
    ...(plan.catalogErrors.length > 0 ? plan.catalogErrors.map((item) => `- 目录错误：${item}`) : []),
    ...(plan.unmappedFiles.length > 0 ? plan.unmappedFiles.map((item) => `- 未映射代码变更：${item}`) : []),
    ...(!plan.catalogErrors.length && !plan.unmappedFiles.length ? ['- 无目录结构阻断。automationStatus 为 planned 的功能线仍使完整性结论保持 conditional。'] : []),
    '',
  ];
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const catalogPath = resolve(readArg(argv, '--catalog', defaultCatalogPath));
  const ledgerPath = resolve(readArg(argv, '--ledger', defaultLedgerPath));
  const mode = readArg(argv, '--mode', 'scheduled');
  const base = readArg(argv, '--base');
  const head = readArg(argv, '--head', 'HEAD');
  const explicitFiles = readRepeatedArgs(argv, '--changed-file');
  const changedFiles = explicitFiles.length > 0 ? explicitFiles : mode === 'changed' ? gitChangedFiles(base, head) : [];
  const catalog = loadCatalog(catalogPath);
  const activeRegressions = parseActiveRegressions(readFileSync(ledgerPath, 'utf8'));
  const plan = buildPlan({ catalog, changedFiles, activeRegressions, mode, commit: gitCommit() });
  const outputJson = readArg(argv, '--output-json');
  const outputMd = readArg(argv, '--output-md');
  if (outputJson) writeFileSync(outputJson, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  if (outputMd) writeFileSync(outputMd, renderPlanMarkdown(plan), 'utf8');
  process.stdout.write(`${JSON.stringify({ verdict: plan.verdict, catalogVersion: plan.catalogVersion, features: plan.featureLines.length, cases: plan.requiredCaseIds.length, unmapped: plan.unmappedFiles.length })}\n`);
  if (plan.catalogErrors.length > 0 || (argv.includes('--strict') && plan.unmappedFiles.length > 0)) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
