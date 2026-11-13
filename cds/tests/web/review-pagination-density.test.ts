import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReviewPagination } from '../../web/src/pages/code-reviews/ReviewUi.js';

describe('审查任务与问题的有效分页', () => {
  for (const noun of ['条', '项问题']) {
    it(`${noun}单页保留数量，空/少量/刚好一页不显示空转导航`, () => {
      for (const total of [0, 1, 2, 10]) {
        const html = renderToStaticMarkup(createElement(ReviewPagination, { offset: 0, limit: 10, total, noun, onOffset: () => undefined }));
        expect(html).toContain(`共 ${total} ${noun}`);
        expect(html).not.toContain('<nav');
        expect(html).not.toContain('<button');
      }
    });
    it(`${noun}多页末页仍保留完整到达能力和当前范围`, () => {
      const html = renderToStaticMarkup(createElement(ReviewPagination, { offset: 20, limit: 10, total: 25, noun, onOffset: () => undefined }));
      expect(html).toContain('21–25');
      expect(html).toContain('<nav');
      expect(html).toContain('第 1 页');
      expect(html).toContain('aria-current="page"');
    });
  }
});
