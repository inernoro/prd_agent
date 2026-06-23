import { describe, expect, it } from 'vitest';
import { enhanceDefectMarkdown, linkifyBareUrls } from './defectMarkdown';

describe('defectMarkdown', () => {
  it('keeps existing markdown links unchanged', () => {
    const input = '验收报告: [报告](https://map.ebcone.net/kb/report-1)';

    expect(enhanceDefectMarkdown(input)).toBe('**验收报告:** [报告](https://map.ebcone.net/kb/report-1)');
  });

  it('turns bare urls into visible markdown links', () => {
    const input = '验收地址: https://fix-demo.miduo.org/document-store?tab=team';

    expect(enhanceDefectMarkdown(input)).toBe(
      '**验收地址:** [https://fix-demo.miduo.org/document-store?tab=team](https://fix-demo.miduo.org/document-store?tab=team)'
    );
  });

  it('preserves normal markdown text while linkifying urls', () => {
    const input = '**已提交**\n- PR: PR #896\n- 地址 https://example.com/a.';

    expect(enhanceDefectMarkdown(input)).toBe(
      '**已提交**\n- **PR:** PR #896\n- 地址 [https://example.com/a](https://example.com/a).'
    );
  });

  it('does not linkify urls already inside markdown link syntax', () => {
    expect(linkifyBareUrls('[地址](https://example.com/a)')).toBe('[地址](https://example.com/a)');
  });
});
