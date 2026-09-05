import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AI_STREAM_PREVIEW_CSP,
  AI_STREAM_PREVIEW_SANDBOX,
  activeSiteEditRunStorageKey,
  buildStrictAiPreviewDocument,
  buildStrictAiPreviewParserInput,
  canPublishRevision,
  extractCompleteAiPreviewHtml,
  isAllowedAiPreviewResource,
  revisionLabel,
  sanitizeAiPreviewCss,
} from './siteEditPreview';

const previewHelperSource = readFileSync(new URL('./siteEditPreview.ts', import.meta.url), 'utf8');
const generateDialogSource = readFileSync(new URL('./SiteGenerateDialog.tsx', import.meta.url), 'utf8');
const editPanelSource = readFileSync(new URL('./SiteEditPanel.tsx', import.meta.url), 'utf8');

describe('AI 流式网页严格预览', () => {
  it('页面起点出现前不把解释文字塞进 iframe', () => {
    expect(extractCompleteAiPreviewHtml('我先分析一下页面结构')).toBe('');
  });

  it('html 根未闭合时保持骨架，闭合后才截取页面', () => {
    expect(extractCompleteAiPreviewHtml('<html><body>仍在生成')).toBe('');
    expect(extractCompleteAiPreviewHtml('```html\n<!doctype html><html><body>新版</body></html>\n```'))
      .toBe('<!doctype html><html><body>新版</body></html>');
  });

  it('严格 sandbox 不授予脚本、表单、弹窗、模态框或同源权限', () => {
    expect(AI_STREAM_PREVIEW_SANDBOX).toBe('');
    expect(generateDialogSource).toContain('sandbox={AI_STREAM_PREVIEW_SANDBOX}');
    expect(editPanelSource).toContain('sandbox={AI_STREAM_PREVIEW_SANDBOX}');
    expect(generateDialogSource).not.toContain('SRCDOC_PREVIEW_SANDBOX');
    expect(editPanelSource).not.toContain('SRCDOC_PREVIEW_SANDBOX');
  });

  it('通过 DOM parser 移除脚本节点、事件属性和可导航属性', () => {
    expect(previewHelperSource).toContain("new DOMParser().parseFromString(parserInput, 'text/html')");
    expect(previewHelperSource).toContain("'script,meta,base,form,iframe,object,embed,link,noscript'");
    expect(previewHelperSource).toContain("name.startsWith('on') || NAVIGATION_ATTRIBUTES.has(name)");
    expect(previewHelperSource).toContain('element.removeAttribute(attribute.name)');
  });

  it('外链资源和 CSS 外链不会进入预览请求面', () => {
    const css = '@import url("https://evil.example/a.css"); .hero { background:url(https://evil.example/a.png); mask:url(data:image/png;base64,AA); }';
    const sanitized = sanitizeAiPreviewCss(css);
    expect(sanitized).not.toContain('@import');
    expect(sanitized).not.toContain('https://');
    expect(sanitized).toContain('data:image/png;base64,AA');
    expect(isAllowedAiPreviewResource('https://evil.example/a.png')).toBe(false);
    expect(isAllowedAiPreviewResource('data:image/png;base64,AA')).toBe(true);
    expect(AI_STREAM_PREVIEW_CSP).toContain("default-src 'none'");
    expect(AI_STREAM_PREVIEW_CSP).toContain("connect-src 'none'");
    expect(AI_STREAM_PREVIEW_CSP).toContain('img-src data:');
    expect(previewHelperSource).toContain("name === 'srcset' || !isAllowedAiPreviewResource(attribute.value)");
  });

  it('系统 CSP 固定写在任何模型 head 和 body 内容之前', () => {
    const parserInput = buildStrictAiPreviewParserInput(
      '<html data-note="root > marker"><head><title>parser-model-head</title></head><body><img src="https://evil.example/a.png"></body></html>',
    );
    expect(parserInput.indexOf('Content-Security-Policy')).toBeLessThan(parserInput.indexOf('parser-model-head'));
    expect(parserInput.indexOf('Content-Security-Policy')).toBeLessThan(parserInput.indexOf('https://evil.example'));

    const html = buildStrictAiPreviewDocument('<title>model-head</title>', '<main>model-body</main>');
    const cspPosition = html.indexOf('Content-Security-Policy');
    expect(cspPosition).toBeGreaterThan(0);
    expect(cspPosition).toBeLessThan(html.indexOf('model-head'));
    expect(cspPosition).toBeLessThan(html.indexOf('model-body'));
    expect(html.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
  });
});

describe('网页版本标签', () => {
  it('当前线上版本优先于来源类型', () => {
    expect(revisionLabel({ isCurrent: true, status: 'published', source: 'rollback' }))
      .toBe('当前线上版本');
  });

  it('草稿明确标记为未发布', () => {
    expect(revisionLabel({ isCurrent: false, status: 'draft', source: 'ai-edit' }))
      .toBe('未发布草稿');
  });

  it('中断的发布态保留明确的重试入口', () => {
    const publishing = { isCurrent: false, status: 'publishing' as const, source: 'ai-edit' as const };
    expect(revisionLabel(publishing)).toBe('发布未完成，可重试');
    expect(canPublishRevision(publishing)).toBe(true);
  });

  it('已发布版本不显示再次发布操作', () => {
    expect(canPublishRevision({ isCurrent: false, status: 'published' })).toBe(false);
  });
});

describe('网页微调任务恢复', () => {
  it('按站点隔离未完成任务，避免切换站点时串单', () => {
    expect(activeSiteEditRunStorageKey('site-a')).toBe('web-hosting-edit-active-run-v1:site-a');
    expect(activeSiteEditRunStorageKey('site-a')).not.toBe(activeSiteEditRunStorageKey('site-b'));
  });
});
