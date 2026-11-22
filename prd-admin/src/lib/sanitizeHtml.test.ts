// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cleanPastedHtml, sanitizeHtml } from './sanitizeHtml';

const attacks = [
  '<img src="/missing" onerror="window.__xssSentinel=1"><p onclick="window.__xssSentinel=1">正文</p>',
  '<a href="jav&#x09;ascript:window.__xssSentinel=1">链接</a>',
  '<a href="&#1;javascript:window.__xssSentinel=1">链接</a>',
  '<a href="data:text/html,<script>parent.__xssSentinel=1</script>">链接</a>',
  '<a href="vbscript:msgbox(1)">链接</a>',
  '<iframe srcdoc="<script>parent.__xssSentinel=1</script>"></iframe><object data="data:text/html,x"></object><embed src="x">',
  '<svg><a xlink:href="javascript:window.__xssSentinel=1">x</a><foreignObject><img src="x" onerror="window.__xssSentinel=1"></foreignObject></svg>',
  '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=window.__xssSentinel=1>">',
  '<template><img src=x onerror=window.__xssSentinel=1></template>',
  '<form><input autofocus onfocus="window.__xssSentinel=1"></form>',
  '<img src="data:image/svg+xml,<svg onload=parent.__xssSentinel=1></svg>" srcset="javascript:window.__xssSentinel=1 1x">',
];

describe.each([sanitizeHtml, cleanPastedHtml])('%s', (clean) => {
  it.each(attacks)('removes executable markup across serialization: %s', (dirty) => {
    const output = clean(dirty);
    const host = document.createElement('div');
    host.innerHTML = output;
    expect(host.querySelector('script,iframe,object,embed,svg,math,template,form,input')).toBeNull();
    for (const el of host.querySelectorAll('*')) {
      expect(el.namespaceURI).toBe('http://www.w3.org/1999/xhtml');
      for (const attr of el.attributes) {
        expect(attr.name).not.toMatch(/^on|:|srcdoc|srcset/i);
        if (['href', 'src'].includes(attr.name)) expect(attr.value).not.toMatch(/javascript|vbscript|data:text|data:image\/svg/i);
      }
    }
    expect(clean(output)).toBe(output);
  });
  it('keeps readable formatting, images, mentions and safe links', () => {
    const output = clean('<h3>标题</h3><p><strong>重点</strong><em>斜体</em><u>下划线</u><br><span data-mention="张三">@张三</span></p><ul><li>项目</li></ul><table><tbody><tr><td colspan="2">单元格</td></tr></tbody></table><img src="/local-assets/a.png" alt="截图" data-att="attachment-1"><a href="https://example.com" target="_blank">证据</a>');
    expect(output).toContain('<strong>重点</strong>');
    expect(output).toContain('data-mention="张三"');
    expect(output).toContain('data-att="attachment-1"');
    expect(output).toContain('colspan="2"');
    expect(output).toContain('rel="noopener noreferrer"');
    expect(output).toContain('src="/local-assets/a.png"');
  });
  it('fails closed without content', () => {
    expect(clean(null)).toBe('');
    expect(clean(undefined)).toBe('');
  });
});

it('preserves safe inline formatting only in display mode', () => {
  const dirty = '<p style="color:red;text-align:center;position:fixed;background-image:url(https://example.com/tracker)">正文</p>';
  const host = document.createElement('div');
  host.innerHTML = sanitizeHtml(dirty);
  expect(host.querySelector('p')?.style.color).toBe('red');
  expect(host.querySelector('p')?.style.textAlign).toBe('center');
  expect(host.querySelector('p')?.style.position).toBe('');
  expect(host.querySelector('p')?.style.backgroundImage).toBe('');
  expect(cleanPastedHtml(dirty)).toBe('<p>正文</p>');
});
