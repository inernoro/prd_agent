import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AI_STREAM_PREVIEW_CSP,
  AI_STREAM_PREVIEW_SANDBOX,
  activeSiteEditRunStorageKey,
  buildStrictAiPreviewDocument,
  buildStrictAiPreviewParserInput,
  canPublishRevision,
  chooseDesignRuntime,
  displayedDesignRuntime,
  elapsedSecondsSince,
  extractCompleteAiPreviewHtml,
  isAllowedAiPreviewResource,
  revisionChangeSummary,
  revisionLabel,
  runningGenerationActivity,
  sanitizeAiPreviewCss,
  isLatestPreviewRequest,
  VERIFIED_PACKAGE_PREVIEW_SANDBOX,
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
    expect(editPanelSource).toContain('sandbox={previewUrl ? VERIFIED_PACKAGE_PREVIEW_SANDBOX : AI_STREAM_PREVIEW_SANDBOX}');
    expect(VERIFIED_PACKAGE_PREVIEW_SANDBOX).toContain('allow-scripts');
    expect(VERIFIED_PACKAGE_PREVIEW_SANDBOX).not.toContain('allow-same-origin');
    expect(VERIFIED_PACKAGE_PREVIEW_SANDBOX).not.toContain('allow-popups');
    expect(generateDialogSource).not.toContain('SRCDOC_PREVIEW_SANDBOX');
    expect(editPanelSource).not.toContain('SRCDOC_PREVIEW_SANDBOX');
  });

  it('快速切换版本时只接受最后一次请求', () => {
    const firstRequest = 1;
    const secondRequest = 2;
    expect(isLatestPreviewRequest(secondRequest, secondRequest)).toBe(true);
    expect(isLatestPreviewRequest(firstRequest, secondRequest)).toBe(false);
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

  it('已拒绝草稿有独立标签且不能再次发布', () => {
    const rejected = { isCurrent: false, status: 'rejected' as const, source: 'ai-edit' as const };
    expect(revisionLabel(rejected)).toBe('已拒绝草稿');
    expect(canPublishRevision(rejected)).toBe(false);
  });

  it('用人能扫读的摘要说明初始、AI 修改与回退', () => {
    expect(revisionChangeSummary({ source: 'baseline', instruction: null })).toBe('本次变更：建立初始页面');
    expect(revisionChangeSummary({ source: 'ai-edit', instruction: '把标题改得更直接' }))
      .toBe('本次修改：把标题改得更直接');
    expect(revisionChangeSummary(
      { source: 'rollback', instruction: null },
      { isCurrent: false, status: 'published', source: 'ai-edit' },
    )).toBe('本次变更：恢复到已发布版本');
  });
});

describe('网页微调任务恢复', () => {
  it('按站点隔离未完成任务，避免切换站点时串单', () => {
    expect(activeSiteEditRunStorageKey('site-a')).toBe('web-hosting-edit-active-run-v1:site-a');
    expect(activeSiteEditRunStorageKey('site-a')).not.toBe(activeSiteEditRunStorageKey('site-b'));
  });

  it('历史任务执行器与下一次可选执行器分开计算', () => {
    const runtimes = [
      { id: 'map-gateway', enabled: true },
      { id: 'open-design', enabled: false },
    ] as Parameters<typeof chooseDesignRuntime>[0];
    expect(chooseDesignRuntime(runtimes, 'map-gateway')).toBe('map-gateway');
    expect(displayedDesignRuntime(runtimes, 'map-gateway', 'open-design')?.id).toBe('open-design');
    expect(displayedDesignRuntime(runtimes, 'map-gateway')?.id).toBe('map-gateway');
  });

  it('恢复后的运行时长从服务端创建时间继续计算', () => {
    expect(elapsedSecondsSince('2026-09-06T10:00:00.000Z', Date.parse('2026-09-06T10:02:03.900Z')))
      .toBe(123);
    expect(elapsedSecondsSince('invalid', Date.now())).toBe(0);
  });

  it('运行态逐秒说明真实阶段，不伪造百分比', () => {
    expect(runningGenerationActivity('正在读取知识', 23))
      .toBe('当前步骤：正在读取知识。已运行 23 秒，任务仍在继续，页面会自动更新。');
    expect(runningGenerationActivity('', -4)).toContain('已运行 0 秒');
  });
});
