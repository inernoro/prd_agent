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
            status,
            durationMs: results.reduce((sum, item) => sum + (item.duration || 0), 0),
            error: finalResult?.error?.message || '',
            retryCount: Math.max(0, results.length - 1),
          });
        }
      }
      collectSuites(suite.suites || []);
    }
  }

  collectSuites(report?.suites || []);
  return rows;
}

export function reconcileCaseCoverage(requiredCaseIds, environmentRows) {
  const rowsByKey = new Map(environmentRows.map((row) => [`${row.environment}:${row.caseId}`, row]));
  const environments = ['cds', 'production'];
  const reconciled = [];

  for (const caseId of requiredCaseIds) {
    for (const environment of environments) {
      reconciled.push(rowsByKey.get(`${environment}:${caseId}`) || {
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
