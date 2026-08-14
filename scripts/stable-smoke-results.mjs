const CASE_ID_PATTERN = /\[((?:COMMON|CORE|REC|FILE|PARSE|VIDEO|LIT|VIS|MVIS|GW|REG-[a-z0-9-]+)-\d+)\]/gi;

export function collectPlaywrightCases(report, environment) {
  const rows = [];

  function collectSuites(suites = []) {
    for (const suite of suites) {
      for (const spec of suite.specs || []) {
        const matches = [...spec.title.matchAll(CASE_ID_PATTERN)];
        if (matches.length === 0) continue;
        const results = (spec.tests || []).flatMap((item) => item.results || []);
        const finalResult = results.at(-1);
        const rawStatus = finalResult?.status || 'not-run';
        const priorResults = results.slice(0, -1);
        const attemptErrors = results
          .map((item) => item?.error?.message || '')
          .filter(Boolean);
        const status = rawStatus === 'passed'
          ? 'pass'
          : rawStatus === 'skipped' || rawStatus === 'not-run'
            ? 'not-run'
            : 'fail';
        for (const match of matches) {
          rows.push({
            caseId: match[1].toUpperCase(),
            environment,
            title: spec.title,
            tags: Array.isArray(spec.tags) ? [...spec.tags] : [],
            status,
            durationMs: results.reduce((sum, item) => sum + (item.duration || 0), 0),
            error: finalResult?.error?.message || '',
            retryCount: Math.max(0, results.length - 1),
            hadFailedAttempt: priorResults.some((item) => !['passed', 'skipped'].includes(item?.status)),
            attemptErrors,
          });
        }
      }
      collectSuites(suite.suites || []);
    }
  }

  collectSuites(report?.suites || []);
  return rows;
}

export function selectRequiredCaseIds(requiredCaseIds, grepExpression = '', discoveredRows = []) {
  if (!grepExpression) return [...requiredCaseIds];
  const normalizedExpression = String(grepExpression).replaceAll('\\', '');
  const requested = [...normalizedExpression.matchAll(CASE_ID_PATTERN)]
    .map((match) => match[1].toUpperCase());

  const requiredByNormalizedId = new Map(requiredCaseIds.map((caseId) => [
    String(caseId).toUpperCase(),
    caseId,
  ]));
  if (requested.length > 0) {
    return [...new Set(requested)].map((caseId) => requiredByNormalizedId.get(caseId) || caseId);
  }

  const discovered = discoveredRows
    .map((row) => String(row?.caseId ?? '').toUpperCase())
    .filter((caseId) => requiredByNormalizedId.has(caseId));
  return [...new Set(discovered)].map((caseId) => requiredByNormalizedId.get(caseId));
}

export function environmentResultLabel(rows, selected = true) {
  if (!selected) return 'not-selected';
  if (rows.length === 0) return 'conditional';
  if (rows.some((row) => row.status === 'fail')) return 'fail';
  if (rows.some((row) => row.status === 'not-run')) return 'conditional';
  return 'pass';
}

export function reconcileCaseCoverage(
  requiredCaseIds,
  environmentRows,
  environments = ['cds', 'production'],
) {
  const rowsByKey = new Map();
  const statusSeverity = new Map([['pass', 0], ['not-run', 1], ['fail', 2]]);
  for (const row of environmentRows) {
    const key = `${row.environment}:${String(row.caseId).toUpperCase()}`;
    const existing = rowsByKey.get(key);
    if (!existing) {
      rowsByKey.set(key, { ...row });
      continue;
    }
    const strictest = (statusSeverity.get(row.status) ?? -1) > (statusSeverity.get(existing.status) ?? -1)
      ? row
      : existing;
    const messages = [...new Set([
      existing.error,
      row.error,
      ...(existing.attemptErrors || []),
      ...(row.attemptErrors || []),
    ].filter(Boolean))];
    rowsByKey.set(key, {
      ...strictest,
      title: [...new Set([existing.title, row.title].filter(Boolean))].join(' / '),
      tags: [...new Set([...(existing.tags || []), ...(row.tags || [])])],
      durationMs: (existing.durationMs || 0) + (row.durationMs || 0),
      error: messages.join('；'),
      retryCount: (existing.retryCount || 0) + (row.retryCount || 0),
      hadFailedAttempt: existing.hadFailedAttempt === true
        || row.hadFailedAttempt === true
        || existing.status === 'fail'
        || row.status === 'fail',
      attemptErrors: messages,
    });
  }
  const reconciled = [];

  for (const environment of environments) {
    const environmentCaseIds = Array.isArray(requiredCaseIds)
      ? requiredCaseIds
      : requiredCaseIds?.[environment] || [];
    for (const caseId of environmentCaseIds) {
      const evidence = rowsByKey.get(`${environment}:${String(caseId).toUpperCase()}`);
      reconciled.push(evidence ? { ...evidence, caseId } : {
        caseId,
        environment,
        title: `${caseId} 未获得执行证据`,
        status: 'not-run',
        durationMs: 0,
        error: '计划要求本用例，但本环境的执行报告中没有同 caseId 证据。',
        retryCount: 0,
      });
    }
  }

  return reconciled;
}

export function buildNotRunLedger(rows, reportAvailability = {}) {
  return rows
    .filter((row) => row.status === 'not-run')
    .map((row) => {
      const reportAvailable = reportAvailability[row.environment] === true;
      const isProduction = row.environment === 'production';
      const productionRestricted = isProduction && reportAvailability.productionRestricted === true;
      const productionRestrictionReason = [
        ...(reportAvailability.productionSafetyGate?.reasons || []),
        reportAvailability.productionRestrictionReason,
      ].filter(Boolean).join('；') || '本轮 CDS 验证未满足正式环境写入安全门要求';
      const reasonCode = productionRestricted
        ? 'production-safety-restricted'
        : reportAvailable ? 'automation-case-missing' : 'environment-report-missing';
      const reason = productionRestricted
        ? `正式环境安全门限制为只读检查，写入旅程未运行。原因：${productionRestrictionReason}。`
        : reportAvailable
        ? '本环境已有执行报告，但没有该 caseId 的真实步骤或执行证据。'
        : isProduction
          ? '正式环境专用合成身份未通过预检，因此没有生成正式环境执行报告。'
          : 'CDS 环境执行报告缺失，无法判断该 caseId 是否实际运行。';
      const environmentFlag = isProduction ? '' : '--cds-only';
      const command = productionRestricted
        ? '先按安全门原因完成 CDS 全量复测与覆盖闭环，再运行 node scripts/stable-smoke-run.mjs 完成正式环境安全矩阵'
        : reportAvailable
        ? `先在 e2e/specs/stable-smoke.spec.ts 实现 [${row.caseId}]，再运行 node scripts/stable-smoke-run.mjs${environmentFlag ? ` ${environmentFlag}` : ''} --grep "\\[${row.caseId}\\]"`
        : isProduction
          ? '在 Keychain 配齐双环境凭据后运行 node scripts/stable-smoke-run.mjs；正式环境写入旅程必须先通过同轮 CDS 验证'
          : '修复 CDS 身份或部署预检后运行 node scripts/stable-smoke-run.mjs --cds-only';
      return {
        ...row,
        reasonCode,
        reason,
        sourcePath: productionRestricted ? 'scripts/stable-smoke-run.mjs' : 'e2e/specs/stable-smoke.spec.ts',
        command,
        closeCondition: productionRestricted
          ? `正式环境安全门解除，且报告中 production:${row.caseId} 出现 pass 或 fail 的真实执行证据`
          : `报告中 ${row.environment}:${row.caseId} 出现 pass 或 fail 的真实执行证据`,
      };
    });
}

export function summarizeCoverage(rows, planVerdict = 'pass') {
  const failed = rows.filter((row) => row.status === 'fail');
  const notRun = rows.filter((row) => row.status === 'not-run');
  const flaky = rows.filter((row) => row.status === 'pass' && row.retryCount > 0);
  const verdict = failed.length > 0 || planVerdict === 'fail'
    ? 'fail'
    : notRun.length > 0 || flaky.length > 0 || planVerdict === 'conditional'
      ? 'conditional'
      : 'pass';
  return {
    verdict,
    total: rows.length,
    passed: rows.filter((row) => row.status === 'pass').length,
    failed: failed.length,
    notRun: notRun.length,
    flaky: flaky.length,
  };
}

export function userReadableError(message) {
  if (!message) return '';
  return String(message)
    .replace(/https?:\/\/\S+/gi, '[地址已隐藏]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:token|provider|stack trace|http\s*\d{3})\b/gi, '[技术细节已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}
