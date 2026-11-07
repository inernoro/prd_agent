import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  linkedReportId, listedReportTarget, reportNavigationMessage, reportNavigationScript,
} from '../../web/src/lib/reportNavigation';

const origin = 'https://cds.example.test';
const project = 'prd-agent';
const id = '9414a3d273e740a9bba856c198b5ace1';
const link = `${origin}/reports?project=${project}&folder=cf962c13bfaa4dacb5da67023c6cafa5&report=${id}`;

describe('REG-stsmk-report-external-link-001 authenticated same-project navigation', () => {
  it('accepts the existing protected supervisor-to-appendix deep link', () => {
    expect(linkedReportId(link, origin, project)).toBe(id);
    expect(linkedReportId(`/reports?project=${project}&report=${id}`, origin, project)).toBe(id);
  });

  it('resolves the current project slug from trusted metadata without admitting another project', () => {
    expect(linkedReportId(link, origin, 'canonical-project-id', project)).toBe(id);
    expect(linkedReportId(link, origin, 'canonical-project-id', 'another-project')).toBeNull();
    expect(listedReportTarget('canonical-project-id', id, [{ id, projectId: 'other-project' }])).toBeUndefined();
  });

  it.each([
    `https://outside.example/reports?project=${project}&report=${id}`,
    `${origin}/reports?project=another-project&report=${id}`,
    `${origin}/reports?project=${project}&report=${id}&report=${id}`,
    `${origin}/reports?project=${project}&project=${project}&report=${id}`,
    `${link}&redirect=https://outside.example`,
    `${origin}/reports?project=${project}&report=unknown`,
    `${origin}/api/reports/${id}/raw`,
    `${origin}/r/${id}`,
    'javascript:alert(1)',
    '#technical-details',
    `${link}#technical-details`,
  ])('keeps unsupported or out-of-scope links outside the bridge: %s', (href) => {
    expect(linkedReportId(href, origin, project)).toBeNull();
  });

  it('requires a real current frame source, opaque origin and valid report ID', () => {
    const frame = {};
    const data = { type: 'cds:authenticated-report-navigation', reportId: id };
    expect(reportNavigationMessage({ source: frame, origin: 'null', data }, frame)).toBe(id);
    expect(reportNavigationMessage({ source: {}, origin: 'null', data }, frame)).toBeNull();
    expect(reportNavigationMessage({ source: null, origin: 'null', data }, null)).toBeNull();
    expect(reportNavigationMessage({ source: frame, origin, data }, frame)).toBeNull();
    expect(reportNavigationMessage({ source: frame, origin: 'null', data: { ...data, reportId: '../other' } }, frame)).toBeNull();
    expect(reportNavigationMessage({ source: frame, origin: 'null', data: ['unexpected'] }, frame)).toBeNull();
  });

  it('only selects reports already in the authenticated same-project list', () => {
    const report = { id, projectId: project, folderId: 'authoritative-folder' };
    expect(listedReportTarget(project, id, [report])).toBe(report);
    expect(listedReportTarget(project, id, [{ ...report, projectId: 'other' }])).toBeUndefined();
    expect(listedReportTarget(project, id, [])).toBeUndefined();
    expect(listedReportTarget(null, id, [report])).toBeUndefined();
  });

  function clickScript(href: string, trusted = true) {
    let handler: ((event: unknown) => void) | undefined;
    const postMessage = vi.fn();
    // Execute the exact script inserted into the opaque frame, without outer module constants.
    runInNewContext(reportNavigationScript(origin, project), {
      URL,
      document: { addEventListener: (_type: string, callback: typeof handler) => { handler = callback; } },
      window: { parent: { postMessage } },
    });
    const event = {
      isTrusted: trusted, button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      target: { closest: () => ({ getAttribute: () => href }) },
      preventDefault: vi.fn(), stopPropagation: vi.fn(),
    };
    handler!(event);
    return { event, postMessage };
  }

  it('replaces a same-project popup with a parent selection message, without credentials', () => {
    const { event, postMessage } = clickScript(link);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(postMessage).toHaveBeenCalledWith({ type: 'cds:authenticated-report-navigation', reportId: id }, origin);
  });

  it('does not intercept other projects, external links or synthetic clicks', () => {
    for (const href of [link.replace(project, 'another-project'), 'https://outside.example/', '#chapter']) {
      const { event, postMessage } = clickScript(href);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();
    }
    expect(clickScript(link, false).postMessage).not.toHaveBeenCalled();
  });

  it('keeps the opaque sandbox and routes both HTML and Markdown through the bridge', () => {
    const source = readFileSync(new URL('../../web/src/pages/ReportsPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain('ref={iframeRef}');
    expect(source).toContain('sandbox="allow-scripts"');
    expect(source).not.toMatch(/sandbox="[^"]*allow-(?:popups|same-origin|top-navigation)/);
    expect(source).toContain('withReportNavigation(raw, window.location.origin, report.projectId, report.projectSlug)');
    expect(source).toContain('withReportNavigation(doc, window.location.origin, report.projectId, report.projectSlug)');
    expect(source).toContain('listedReportTarget(selected?.projectId, id, allReports)');
  });
});
