import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PrebuiltRuntimeIcon } from '../../web/src/components/branch/PrebuiltRuntimeIcon';

describe('express runtime visual contract', () => {
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
