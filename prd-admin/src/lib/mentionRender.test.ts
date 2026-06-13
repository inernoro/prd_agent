import { describe, expect, it } from 'vitest';
import {
  enrichContentWithMentions,
  enrichHtmlWithMentions,
  wrapMentionsInPlainText,
} from './mentionRender';

describe('mentionRender', () => {
  it('wraps @ names in plain text', () => {
    const out = wrapMentionsInPlainText('请 @张三 和 @李四 评审');
    expect(out).toContain('class="pa-mention"');
    expect(out).toContain('data-mention="张三"');
    expect(out).toContain('@李四');
  });

  it('enriches html paragraph text nodes', () => {
    const out = enrichHtmlWithMentions('<p>请 @王五 处理</p>');
    expect(out).toContain('<span class="pa-mention"');
    expect(out).toContain('@王五');
  });

  it('converts plain import description to mention html', () => {
    const out = enrichContentWithMentions('复现步骤\n@张三 请确认');
    expect(out).toContain('<p>');
    expect(out).toContain('pa-mention');
    expect(out).toContain('张三');
  });

  it('does not double-wrap existing mentions', () => {
    const html = '<p><span class="pa-mention" data-mention="张三">@张三</span></p>';
    expect(enrichHtmlWithMentions(html)).toBe(html);
  });
});
