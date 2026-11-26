import policy from './design-acceptance-policy.json' with { type: 'json' };

export const designAcceptancePolicy = policy;

const methodNames = new Map(policy.methods.map(method => [method.id, method.label]));
const dimensions = new Map(policy.dimensions.map(dimension => [dimension.id, dimension.label]));
const ruleNumber = /^A-\d{2,3}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const explanation = value => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 600
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);

/** The archive author supplies decisions and reasons. CDS derives coverage from rule dimensions. */
export function inspectDesignAcceptance(manifest) {
  const issues = [];
  const add = (field, code, message, ruleId) => issues.push({ field, code, message, ...(ruleId ? { ruleId } : {}) });
  const rules = Array.isArray(manifest.acceptance) ? manifest.acceptance : [];
  const plan = manifest.acceptancePlan;
  const required = new Set(['mece']);
  if (Array.isArray(manifest.screens) && manifest.screens.length) {
    required.add('compare');
    required.add('visual');
  }
  if (rules.some(rule => rule?.how === 'human')) required.add('human');
  if (rules.some(rule => rule?.interaction === true)) required.add('flow');
  if (!object(plan)) {
    add('acceptancePlan', 'missing_acceptance_plan', '请在验收计划声明每种手段是否适用。');
  } else {
    if (Object.keys(plan).some(key => !methodNames.has(key))) {
      add('acceptancePlan', 'invalid_method', '验收计划只能使用 CDS 支持的手段编号。');
    }
    for (const [id, label] of methodNames) {
      const field = 'acceptancePlan.' + id;
      const choice = plan[id];
      if (!Object.hasOwn(plan, id)) {
        add(field, 'missing_method', `请声明「${label}」是否适用。`);
      } else if (!object(choice) || typeof choice.applicable !== 'boolean'
        || (choice.enabled !== undefined && typeof choice.enabled !== 'boolean')
        || Object.keys(choice).some(key => !['applicable', 'enabled', 'reason'].includes(key))
        || (!choice.applicable && choice.enabled === true)) {
        add(field, 'invalid_method', `请检查「${label}」的适用和启用状态。`);
      } else {
        if (required.has(id) && (!choice.applicable || choice.enabled === false)) {
          add(field, 'required_method', `当前画面或规则需要执行「${label}」。`);
        }
        if ((!choice.applicable || choice.enabled === false || choice.reason !== undefined) && !explanation(choice.reason)) {
          add(field + '.reason', 'missing_reason', `请填写「${label}」的理由，最多 600 字。`);
        }
      }
    }
  }

  if (!rules.length) add('acceptance', 'missing_rule', '请声明至少一条可核对的验收项。');
  const ruleDimensions = new Map();
  const covered = new Set();
  let hasUnclassifiedRules = false;
  for (const [index, rule] of rules.slice(0, 60).entries()) {
    const id = typeof rule?.id === 'string' && rule.id === rule.id.trim() && ruleNumber.test(rule.id) ? rule.id : undefined;
    if (!dimensions.has(rule?.dimension)) {
      hasUnclassifiedRules = true;
      add(`acceptance[${index}].dimension`, 'invalid_dimension', '请为验收项选择一个覆盖维度。', id);
    } else {
      covered.add(rule.dimension);
      if (id) ruleDimensions.set(id, rule.dimension);
    }
  }

  const risks = manifest.risks;
  if (risks !== undefined && (!Array.isArray(risks) || risks.length > 60)) {
    add('risks', 'invalid_risk', '覆盖风险须为最多 60 项的列表。');
  } else if (Array.isArray(risks)) {
    const seenRisks = new Set();
    for (const [index, row] of risks.entries()) {
      const field = `risks[${index}]`;
      if (!object(row) || !dimensions.has(row.dimension) || !explanation(row.risk)
        || Object.keys(row).some(key => !['dimension', 'risk', 'ruleIds', 'reason'].includes(key))) {
        add(field, 'invalid_risk', '请为覆盖风险填写有效的维度和风险说明。');
        continue;
      }
      const key = JSON.stringify([row.dimension, row.risk.trim()]);
      if (seenRisks.has(key)) {
        add(field, 'invalid_risk', '同一维度的风险说明不可重复。');
        continue;
      }
      seenRisks.add(key);
      const ids = row.ruleIds === undefined ? [] : row.ruleIds;
      if (!Array.isArray(ids) || ids.length > 60 || new Set(ids).size !== ids.length
        || (row.reason !== undefined && !explanation(row.reason))
        || Boolean(ids.length) === Boolean(row.reason)) {
        add(field + '.ruleIds', 'invalid_risk', '覆盖风险须选用规则编号或填写不适用理由。');
      } else if (ids.some(id => ruleDimensions.get(id) !== row.dimension)) {
        add(field + '.ruleIds', 'coverage_conflict', '覆盖风险引用的规则须属于本稿件的同一维度。');
      } else {
        covered.add(row.dimension);
      }
    }
  }

  if (rules.length && !hasUnclassifiedRules) {
    for (const [id, label] of dimensions) {
      if (!covered.has(id)) add('risks.' + id, 'missing_coverage', `请为「${label}」添加验收项或说明为何不适用。`);
    }
  }
  return issues;
}
