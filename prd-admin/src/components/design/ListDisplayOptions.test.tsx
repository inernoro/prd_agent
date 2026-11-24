// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListDisplayOptions } from './ListDisplayOptions';
import { useListDisplayPreferences } from '@/hooks/useListDisplayPreferences';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sorts = [{ value: 'hot', label: '热门' }, { value: 'new', label: '最新' }] as const;
const sizes = [{ value: 'small', label: '小' }, { value: 'medium', label: '中' }, { value: 'large', label: '大' }] as const;

function Fixture({ page }: { page: string }) {
  const { sort, setSort, cardSize, setCardSize } = useListDisplayPreferences({
    sortKey: `${page}.sort`, cardSizeKey: `${page}.size`, sortOptions: sorts, cardSizeOptions: sizes,
    defaultSort: 'hot', defaultCardSize: 'medium',
  });
  return <section data-page={page}>
    <ListDisplayOptions sortOptions={sorts} sort={sort} onSortChange={setSort}
      cardSizeOptions={sizes} cardSize={cardSize} onCardSizeChange={setCardSize}
      sortTourId={`${page}-sort`} cardSizeTourId={`${page}-size`} rememberPreferences>
      <div>本页附加筛选</div>
    </ListDisplayOptions>
  </section>;
}

function pressed(host: Element, text: string) {
  return [...host.querySelectorAll('button')].find(button => button.textContent === text)!;
}

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); document.body.innerHTML = ''; });

describe('共享显示面板与偏好', () => {
  it('两页独立恢复偏好，失效值回退；切换后重挂载仍保留，教程锚点与扩展区可用', async () => {
    localStorage.setItem('web.size', 'large');
    localStorage.setItem('market.sort', 'retired-sort');
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      const render = () => <><Fixture page="market" /><Fixture page="web" /></>;
      await act(async () => root.render(render()));
      const market = container.querySelector('[data-page="market"]')!;
      const web = container.querySelector('[data-page="web"]')!;
      expect(pressed(market, '热门').getAttribute('aria-pressed')).toBe('true');
      expect(pressed(web, '大').getAttribute('aria-pressed')).toBe('true');
      expect(market.querySelector('[data-tour-id="market-sort"]')).not.toBeNull();
      expect(market.textContent).toContain('本页附加筛选');
      await act(async () => { pressed(market, '最新').click(); pressed(market, '小').click(); });
      expect(pressed(web, '大').getAttribute('aria-pressed')).toBe('true');
      expect(pressed(web, '热门').getAttribute('aria-pressed')).toBe('true');
      await act(async () => root.render(null));
      await act(async () => root.render(render()));
      const restored = container.querySelector('[data-page="market"]')!;
      expect(pressed(restored, '最新').getAttribute('aria-pressed')).toBe('true');
      expect(pressed(restored, '小').getAttribute('aria-pressed')).toBe('true');
    } finally { await act(async () => root.unmount()); }
  });

  it('浏览器禁用存储时仍能选择尺寸和排序', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage disabled'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage disabled'); });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Fixture page="market" />));
      await act(async () => { pressed(container, '最新').click(); pressed(container, '大').click(); });
      expect(pressed(container, '最新').getAttribute('aria-pressed')).toBe('true');
      expect(pressed(container, '大').getAttribute('aria-pressed')).toBe('true');
    } finally { await act(async () => root.unmount()); }
  });
});
