import { expect, it } from 'vitest';
import { monitorReportUrl } from '../../src/services/monitor-incident-link.js';

it.each(['https://example.invalid/status', 'https://example.invalid/cds/status'])('报告直达保持部署路径前缀：%s', board => {
  const link = new URL(monitorReportUrl(board + '?target=old#anchor', 'report / 中文'));
  expect(link.pathname).toBe(new URL(board).pathname.replace(/status$/, 'reports'));
  expect([...link.searchParams]).toEqual([['report', 'report / 中文']]);
  expect(link.hash).toBe('');
});
