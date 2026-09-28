// 上游：一个入口，两种上游。
//
// 之前导航里 Provider 与 Exchange 是两条平级入口，用户得先知道「我要接的这家算哪一类」
// 才能点对地方——而这恰恰是他最不知道的事（fal.ai 算 Provider 还是 Exchange？）。
// 判据很简单：两者回答的是同一个问题——**模型从哪来**。所以它们该是同一个入口下的两段，
// 不是两个入口。选段的成本远低于选入口：选错了就在旁边，一眼能看见另一段。
//
// 旧地址不留死链：/exchanges 仍然可达，只是落到本页并自动选中「转接上游」那一段。
import { useLocation, useSearchParams } from 'react-router-dom';
import { PlatformsPage } from '@/pages/PlatformsPage';
import { ExchangesPage } from '@/pages/ExchangesPage';
import { TabBar } from '@/components/ui';
import { GAP } from '@/lib/surface';

type UpstreamView = 'provider' | 'exchange' | 'catalog' | 'imagegen';

const VIEWS: Array<{ key: UpstreamView; label: string }> = [
  { key: 'provider', label: 'Provider' },
  { key: 'exchange', label: '转接上游' },
  { key: 'catalog', label: '模型名录' },
  { key: 'imagegen', label: '生图契约' },
];

export function UpstreamsPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  // 旧地址 /exchanges 直接落到转接上游那一段，不做 302——保住页内锚点（#image-layering）
  const fromExchangeRoute = location.pathname.endsWith('/exchanges');
  const rawView = params.get('view');
  const legacyKind = params.get('kind');
  const view: UpstreamView = VIEWS.some((item) => item.key === rawView)
    ? rawView as UpstreamView
    : legacyKind === 'exchange' || (legacyKind === null && fromExchangeRoute)
      ? 'exchange'
      : 'provider';

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: GAP.section }}>
      <TabBar
        ariaLabel="上游配置分类"
        items={VIEWS}
        activeKey={view}
        onChange={(nextView) => {
          const next = new URLSearchParams(params);
          next.set('view', nextView);
          next.set('kind', nextView === 'exchange' ? 'exchange' : 'provider');
          setParams(next, { replace: true });
        }}
      />
      {view === 'exchange' ? <ExchangesPage /> : <PlatformsPage section={view} />}
    </div>
  );
}
