import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const page = readFileSync(fileURLToPath(new URL('../../web/src/pages/ReportsPage.tsx', import.meta.url)), 'utf8');
const viewer = page.slice(page.indexOf('function ReportViewer('), page.indexOf('function ShareControl('));

describe('authenticated report body rendering', () => {
  it('fetches HTML and Markdown through the authenticated API before an opaque sandbox', () => {
    expect(viewer).toContain('fetchReportRaw(report.id)');
    expect(viewer).not.toContain("report.format !== 'md'");
    expect(viewer).toContain("if (report.format === 'html')");
    expect(viewer).toContain('srcDoc={mdHtml} sandbox="allow-scripts"');
    expect(viewer).not.toContain('src={reportRawUrl');
    expect(viewer).not.toContain('allow-same-origin');
  });
  it('shows loading errors with an explicit retry instead of a blank frame', () => {
    expect(viewer).toContain('正在加载报告正文');
    expect(viewer).toContain('重新加载报告');
    expect(viewer).toContain('setLoadAttempt((value) => value + 1)');
    expect(viewer).toContain('[report, theme, loadAttempt]');
    expect(viewer.indexOf('const token = ++reqRef.current')).toBeLessThan(viewer.indexOf('if (!report) return'));
  });
});
