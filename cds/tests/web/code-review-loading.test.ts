import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CodeReviewsSkeleton } from '../../web/src/components/skeletons/CodeReviewsSkeleton.js';
import { pageSkeletonForPath } from '../../web/src/components/skeletons/PageSkeletons.js';

describe('代码审查首屏只有一副骨架', () => {
  it('路由等待直接渲染数据等待共用的组件，不再使用通用横条', () => {
    expect(pageSkeletonForPath('/code-reviews').type).toBe(CodeReviewsSkeleton);
    expect(renderToStaticMarkup(pageSkeletonForPath('/code-reviews')))
      .toBe(renderToStaticMarkup(createElement(CodeReviewsSkeleton)));
  });

  it('等待轮廓包括概览与紧凑列表，使用无交互的共享动画骨架', () => {
    const html = renderToStaticMarkup(createElement(CodeReviewsSkeleton));
    expect(html).toContain('data-code-reviews-skeleton');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/<section/g)).toHaveLength(2);
    expect(html).toContain('cds-loading-skeleton-panel');
    expect(html).toContain('cds-loading-skeleton-line');
    expect(html).not.toMatch(/<(?:input|button|select|textarea)\b/);
    expect(html).not.toContain('animate-pulse');
  });
});
