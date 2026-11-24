import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePlaywrightReports } from '../stable-smoke-merge-results.mjs';

test('分批 Playwright 报告可合并且保留统计', () => {
  const merged = mergePlaywrightReports([
    { suites: [{ title: 'a' }], errors: [], stats: { duration: 10, expected: 1, unexpected: 0, flaky: 0, skipped: 0 } },
    { suites: [{ title: 'b' }], errors: [{ message: 'x' }], stats: { duration: 20, expected: 0, unexpected: 1, flaky: 0, skipped: 0 } },
  ]);
  assert.deepEqual(merged.suites.map((suite) => suite.title), ['a', 'b']);
  assert.equal(merged.errors.length, 1);
  assert.equal(merged.stats.duration, 30);
  assert.equal(merged.stats.expected, 1);
  assert.equal(merged.stats.unexpected, 1);
});
