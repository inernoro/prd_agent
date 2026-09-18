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
import { HINT_TEXT } from '@/lib/typography';
import { GAP } from '@/lib/surface';

type UpstreamKind = 'provider' | 'exchange';

const KINDS: Array<{ id: UpstreamKind; label: string; hint: string }> = [
  { id: 'provider', label: '自有上游', hint: '说 OpenAI / Claude 协议的供应方，填密钥即可接入' },
  { id: 'exchange', label: '转接上游', hint: '协议不标准的供应方，由 Exchange 转接成网关能调度的形态' },
];

export function UpstreamsPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  // 旧地址 /exchanges 直接落到转接上游那一段，不做 302——保住页内锚点（#image-layering）
  const fromExchangeRoute = location.pathname.endsWith('/exchanges');
  const raw = params.get('kind');
  const kind: UpstreamKind = raw === 'exchange' || (raw === null && fromExchangeRoute) ? 'exchange' : 'provider';

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: GAP.section }}>
      <div role="tablist" aria-label="上游类型" data-testid="upstream-kind-tabs" style={{ display: 'flex', alignItems: 'center', gap: GAP.tight, flexWrap: 'wrap' }}>
        {KINDS.map((item) => {
          const active = kind === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              title={item.hint}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set('kind', item.id);
                setParams(next, { replace: true });
              }}
              style={{
                /* 刻意做成紧凑的段选择器而不是带说明的大卡：
                   两段各自的页面自己会交代它是什么，这里只负责切换。
                   （大卡还会给这一屏多引入一种卡片内边距，被排版漂移检测判红。） */
                padding: '5px 12px', cursor: 'pointer',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
                background: active ? 'var(--accent-soft)' : 'transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontSize: 'var(--fs-secondary)',
                fontWeight: active ? 600 : 400,
              }}
            >
              {item.label}
            </button>
          );
        })}
        <span style={{ ...HINT_TEXT, fontSize: 'var(--fs-caption)' }}>{KINDS.find((x) => x.id === kind)?.hint}</span>
      </div>
      {kind === 'exchange' ? <ExchangesPage /> : <PlatformsPage />}
    </div>
  );
}
