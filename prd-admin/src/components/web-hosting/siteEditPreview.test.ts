import { describe, expect, it } from 'vitest';
import { previewableEditHtml, revisionLabel } from './siteEditPreview';

describe('网页微调即时预览', () => {
  it('页面起点出现前不把解释文字塞进 iframe', () => {
    expect(previewableEditHtml('我先分析一下页面结构')).toBe('');
  });

  it('从完整 HTML 起点开始预览并去掉尾部围栏', () => {
    expect(previewableEditHtml('```html\n<!doctype html><html><body>新版</body></html>\n```'))
      .toBe('<!doctype html><html><body>新版</body></html>');
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
});
