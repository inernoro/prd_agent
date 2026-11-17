import path from 'node:path';
import { manifest, writeManifest } from '../../.claude/skills/create-visual-test-to-kb/scripts/harness.mjs';
import { classifyPageHttpErrors } from './browser-path.mjs';

export function reconcilePageCases(cases) {
  const failures = [];
  for (const record of cases) {
    Object.assign(record, classifyPageHttpErrors(record.requests));
    if (record.unexpectedHttpErrors.length || record.pageErrors.length) {
      record.pass = false;
      record.error ??= '页面关闭后的完整记录包含非预期HTTP错误或运行异常';
      failures.push(`${record.id}: ${record.error}`);
    }
  }
  return failures;
}

export function finalizeEvidence(result, directory, metadata) {
  // writeManifest is the authoritative barrier: it attaches errors that arrived
  // after the final screenshot. Inspect that finalized evidence, not a snapshot.
  writeManifest(directory, { ...metadata, verdict: result.pass ? 'pass' : 'fail' });
  const rows = manifest();
  const blockers = rows.flatMap(row => row.warnings?.length
    ? row.warnings.map(warning => `${row.name}: ${warning}`)
    : row.automatedStatus === '不通过' ? [`${row.name}: 最终自动取证不通过`] : []);
  if (!rows.length) blockers.push('标准取证缺少截图');
  if (blockers.length) {
    result.evidenceBlockers = blockers;
    result.failure ??= `最终标准取证存在阻断: ${blockers.join('; ')}`;
    result.pass = false;
    result.state = 'failed';
    // Keep the errors and screenshots intact; correct the provisional verdict.
    writeManifest(directory, { ...metadata, verdict: 'fail' });
  }
  return { directory, manifest: path.join(directory, 'manifest.json') };
}
