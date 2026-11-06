const validationOnlyPrefixes = [
  '.agents/skills/',
  '.claude/skills/create-visual-test-to-kb/',
  '.claude/skills/stable-smoke/',
  '.Codex/',
  'changelogs/',
  'doc/',
  'e2e/',
  'scripts/tests/',
];

const validationOnlyFiles = new Set([
  'scripts/compose-stable-smoke-supervisor-report.mjs',
  'scripts/prepare-stable-smoke-archive-report.mjs',
  'scripts/render-stable-smoke-report.mjs',
  'scripts/split-stable-smoke-report.mjs',
]);

export function isValidationOnlyPath(path) {
  const normalized = String(path || '').replaceAll('\\', '/');
  return validationOnlyFiles.has(normalized)
    || normalized.startsWith('scripts/stable-smoke-')
    || validationOnlyPrefixes.some((prefix) => normalized.startsWith(prefix));
}


const environments = ['cds', 'production'];

export function normalizeProductCommits(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('运行版本必须按环境声明');
  const normalized = {};
  for (const [environment, raw] of Object.entries(value)) {
    if (!environments.includes(environment)) throw new Error('运行版本包含未知环境');
    const commit = String(raw || '').trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${environment} 运行版本必须为完整提交`);
    normalized[environment] = commit;
  }
  return normalized;
}

export function productCommitForEnvironment(plan, environment) {
  return normalizeProductCommits(plan.productCommits || {})[environment] || String(plan.commit || '').trim();
}

export function sameProductCommits(plan, expected, selected = environments) {
  try {
    return selected.every(environment => productCommitForEnvironment(plan, environment) === productCommitForEnvironment(expected, environment));
  } catch {
    return false;
  }
}

export function validateInspectionSourceContext({ sourceCommit, productCommit, changedFiles = [] }) {
  if (![sourceCommit, productCommit].every(commit => /^[0-9a-f]{40}$/.test(String(commit || '')))) throw new Error('巡检源码和运行版本必须为完整提交');
  if (!Array.isArray(changedFiles) || (sourceCommit !== productCommit && changedFiles.some(path => !isValidationOnlyPath(path)))) {
    throw new Error('巡检源码与运行版本存在业务代码差异，拒绝复用该运行版本');
  }
  return { sourceCommit, productCommit, runtimeEquivalent: sourceCommit !== productCommit, validationOnlyChanges: sourceCommit === productCommit ? [] : changedFiles };
}
