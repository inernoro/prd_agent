import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dialog = readFileSync(path.resolve(__dirname, 'PersonalStyleDialog.tsx'), 'utf8');

// 接线守卫：只读第一页时，第 51 张之后的网页永远选不到，首页全是 PDF / 视频时还会误说「没有可提取的网页」。
describe('我的风格：网页选择器可以翻到第一页之后', () => {
  it('按标题搜索会带进列表请求', () => {
    expect(dialog).toContain('listSites({ limit: SITE_PAGE_SIZE, keyword: debouncedQuery || undefined })');
  });

  it('继续加载按已看过的条数往后翻，而不是重复读第一页', () => {
    expect(dialog).toContain('listSites({ limit: SITE_PAGE_SIZE, skip, keyword: query || undefined })');
    expect(dialog).toContain('const hasMoreSites = sites.status === \'ready\' && sites.scanned < sites.total;');
  });

  it('本页过滤后为空但后面还有网页时，不说「你还没有可以提取的网页」', () => {
    expect(dialog).toMatch(/hasMoreSites\s*\?\s*`已看过/);
  });

  it('搜索条件变化时撤销已选网页，不会从看不见的来源提取', () => {
    expect(dialog).toContain('useEffect(() => { setSiteId(null); }, [debouncedQuery]);');
  });

  it('迟到的翻页响应搜索词对不上就丢掉，不混进当前列表', () => {
    expect(dialog).toContain('current.query !== query');
  });
});
