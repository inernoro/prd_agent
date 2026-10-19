import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PrebuiltRuntimeIcon } from '../../web/src/components/branch/PrebuiltRuntimeIcon';
import { branchRuntimePresentation } from '../../web/src/lib/deploy-runtime-badge';

describe('express runtime visual contract', () => {
  it.each([
    { configured: 'all', actual: 'partial', color: 'text-express-partial', label: '部分极速 1/2' },
    { configured: 'partial', actual: 'all', color: 'text-express-full', label: '极速版' },
    { configured: 'all', actual: 'unknown', color: 'text-muted-foreground', label: '极速运行待核验' },
  ] as const)('renders card facts when configuration is $configured and actual runtime is $actual', ({ configured, actual, color, label }) => {
    const { badge, iconProps } = branchRuntimePresentation({ status: 'running', deployRuntime: {
      kind: 'release', activeProfiles: 2, prebuilt: true, prebuiltCoverage: configured,
      actualPrebuiltCoverage: actual, actualRuntimeProfiles: 2, actualPrebuiltProfileIds: ['api'],
      unknownRuntimeProfileIds: actual === 'all' ? [] : ['web'],
    } });
    expect(badge?.label).toContain(label);
    expect(iconProps).not.toBeNull();
    const html = renderToStaticMarkup(createElement(PrebuiltRuntimeIcon, iconProps!));
    expect(html).toContain(color);
    expect(html).toContain(actual === 'unknown' ? 'lucide-clock3' : 'lucide-zap');
    expect(html).not.toContain(actual === 'partial' ? 'text-express-full' : actual === 'all' ? 'text-express-partial' : 'lucide-zap');
  });
  it.each([false, true])('renders the actual %s coverage icon and its accessible label', partial => {
    const html = renderToStaticMarkup(createElement(PrebuiltRuntimeIcon, { partial, pending: false, label: partial ? '混合 · 极速 13/23' : '极速版' }));
    expect(html).toContain('lucide-zap');
    expect(html).toContain(partial ? 'text-express-partial' : 'text-express-full');
    expect(html).toContain(partial ? '混合 · 极速 13/23' : '极速版');
  });
  it.each([false, true])('never renders a completed express flash while pending (%s)', partial => {
    const html = renderToStaticMarkup(createElement(PrebuiltRuntimeIcon, { partial, pending: true, label: '待生效' }));
    expect(html).toContain('lucide-clock3');
    expect(html).not.toMatch(/lucide-zap|text-express-full|text-express-partial/);
    expect(html).toContain('待生效');
  });
});
