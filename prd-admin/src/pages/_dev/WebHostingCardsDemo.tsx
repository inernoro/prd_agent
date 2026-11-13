import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Link2, Moon, RotateCcw, Sun } from 'lucide-react';
import { SiteCard, SITE_CARD_SIZES, type SiteCaps } from '@/components/web-hosting/SiteCard';
import { Dialog } from '@/components/ui/Dialog';
import { AskMarkdown } from '@/components/web-hosting/ask/AskMarkdown';
import type { HostedSite, HostedSiteActivity, HostedSiteTraffic } from '@/services/real/webPages';
import '@/components/web-hosting/RelatedDocumentsBar.css';

function cover(title: string, index: number) {
  const rows = Array.from({ length: 6 }, (_, i) => `<rect x="44" y="${108 + i * 22}" width="${330 - (i % 3) * 55}" height="4" rx="2" fill="#64748b" opacity=".3"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="528" height="280" viewBox="0 0 528 280"><rect width="528" height="280" fill="${index === 6 ? '#e6ecf4' : '#f4f7fa'}"/><text x="44" y="64" font-size="17" font-weight="600" fill="#172c3f" font-family="sans-serif">${title.slice(0, 18)}</text><rect x="44" y="84" width="400" height="1" fill="#ccd4dc"/>${rows}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
const fullCaps: SiteCaps = { canEdit: true, canDelete: true, canShare: true, canSetVisibility: true };
const readCaps: SiteCaps = { canEdit: false, canDelete: false, canShare: false, canSetVisibility: false };
type Scenario = { id: string; label: string; hint: string; site: HostedSite; related: number; shared?: boolean; selected?: boolean; activity?: HostedSiteActivity; traffic?: HostedSiteTraffic; readOnly?: boolean };
function sample(id: string, label: string, hint: string, changes: Partial<HostedSite> = {}, options: Partial<Omit<Scenario, 'id' | 'label' | 'hint' | 'site'>> = {}): Scenario {
  const site: HostedSite = { id, title: '项目发布指南', sourceType: 'upload', cosPrefix: '', entryFile: 'index.html', siteUrl: '', pdfAssetUrl: undefined,
    files: [{ path: 'index.html', cosKey: '', size: 34201, mimeType: 'text/html' }], coverImageUrl: cover(changes.title || '项目发布指南', 0),
    totalSize: 34201, tags: ['发布', '示例'], folderCanonicalName: '', ownerUserId: 'demo', viewCount: 50, visibility: 'private',
    createdAt: '2026-11-12T08:00:00Z', updatedAt: '2026-11-12T08:00:00Z', ...changes };
  return { id, label, hint, site, related: 0, activity: { editCount: 0, isNew: false },
    traffic: { all: { visits: 50, visitors: 19 }, external: { visits: 21, visitors: 8 }, activeShareLinks: 0 }, ...options };
}
const scenarios: Scenario[] = [
  sample('plain', '01 / 普通 HTML', '无关联 · 零编辑 · 隐藏格式'),
  sample('related', '02 / 关联与新内容', '关联 2 份 · 已分享 · 新标记', { title: '团队会议纪要' }, { related: 2, shared: true, activity: { editCount: 3, isNew: true } }),
  sample('pdf', '03 / 已选择 PDF', '无封面回退 · 格式避让选择框', { title: '年度研究报告', wrappedAssetType: 'pdf', sourceType: 'api', coverImageUrl: undefined }, { selected: true, related: 2 }),
  sample('crowded', '04 / 密集极限', '长标题 · 多状态 · 大数字', { title: '超长标题与LongUnbrokenEnglishTitle：跨团队项目交付与设计验收总览', visibility: 'public', sharedTeamIds: ['design', 'product'],
    description: '长描述仅在大卡补充展示；完整说明与标签均可在详情查看。'.repeat(3), tags: ['产品', '交付', '审阅', 'LongUnbrokenTagNameForOverflowVerification'], files: Array.from({ length: 103 }, (_, i) => ({ path: i ? `page-${i}.html` : 'index.html', cosKey: '', size: 1024, mimeType: 'text/html' })), totalSize: 9876543210 },
    { related: 128, shared: true, activity: { editCount: 987654321, isNew: true }, traffic: { all: { visits: 987654321, visitors: 876543210 }, external: { visits: 1000, visitors: 800 }, activeShareLinks: 12 } }),
  sample('markdown', '05 / 只读 MD', '没有写权限 · 保留查看入口', { title: '团队知识手册', wrappedAssetType: 'markdown', sourceType: 'workflow' }, { readOnly: true, related: 1 }),
  sample('video', '06 / 视频', '非 HTML 类型常驻右上', { title: '新品演示视频', wrappedAssetType: 'video', sourceType: 'api' }),
  sample('image', '07 / 图片', '分享与团队状态同时存在', { title: '品牌视觉规范', wrappedAssetType: 'image', sharedTeamIds: ['design'], coverImageUrl: cover('品牌视觉规范', 6) }, { shared: true }),
  sample('deck', '08 / 幻灯片', '格式 · 关联 · 已公开', { title: '季度产品发布会', isSlideDeck: true, visibility: 'public' }, { related: 8 }),
  sample('unknown', '09 / 统计未返回', '未知显示横线 · 零值不混淆', { title: '尚未生成统计的网页', sourceType: 'saved-share' }, { activity: undefined, traffic: undefined }),
  sample('zero', '10 / 全部为零', '没有访问 · 没有访客', { title: '新建的空白项目', totalSize: 0 }, { traffic: { all: { visits: 0, visitors: 0 }, external: { visits: 0, visitors: 0 }, activeShareLinks: 0 } }),
];
const columns = [...SITE_CARD_SIZES].reverse();
const initialSelected = () => scenarios.filter(item => item.selected).map(item => item.id);
const initialShared = () => scenarios.filter(item => item.shared).map(item => item.id);
const answer = `- **周二至周五： **14:00—19:00[^1]\n- **周六至周日：**09:30—17:30[^2]\n\n[^1]: 周二至周五开放。\n[^2]: 周末开放。`;

/** 全部样本仅在本页内存中交互；不读取、写入或生成业务记录。 */
export default function WebHostingCardsDemo() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  useEffect(() => {
    const previous = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = theme;
    return () => { if (previous) document.documentElement.dataset.theme = previous; else delete document.documentElement.dataset.theme; };
  }, [theme]);
  const [tab, setTab] = useState<'cards' | 'markdown'>('cards');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(initialSelected);
  const [shared, setShared] = useState(initialShared);
  const [opened, setOpened] = useState<string[]>([]);
  const [batch, setBatch] = useState(false);
  const [message, setMessage] = useState('悬浮查看选择与操作；右键或点击更多，点击空白关闭菜单。');
  const [dialog, setDialog] = useState<{ title: string; scenario: Scenario } | null>(null);
  const toggle = (values: string[], id: string) => values.includes(id) ? values.filter(value => value !== id) : [...values, id];
  const action = (title: string, scenario: Scenario) => { setMessage(`${title}：${scenario.site.title}（仅演示）`); setDialog({ title, scenario }); };
  const reset = () => { setSelected(initialSelected()); setShared(initialShared()); setOpened([]); setBatch(false); setMessage('演示已重置'); setDialog(null); };
  return <main data-theme={theme} data-card-demo className="h-full min-h-0 flex flex-col overflow-auto" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
    <div className="mx-auto w-full max-w-[1220px] px-4 py-7 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="text-[10px] tracking-[.18em] text-token-muted">网页托管 / 组件演示</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">同一张卡片，三种尺寸。</h1>
          <p className="mt-2 text-xs text-token-secondary">10 种场景 · 真实卡片组件 · 所有操作仅影响示例数据</p></div>
        <div className="flex items-center gap-2">
          <button className="inline-flex items-center gap-2 rounded-lg border border-token-default px-3 py-2 text-xs" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="切换演示主题">{theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}{theme === 'dark' ? '浅色' : '深色'}</button>
          <button className="inline-flex items-center gap-2 rounded-lg border border-token-default px-3 py-2 text-xs" onClick={reset}><RotateCcw size={13} />重置演示</button>
        </div>
      </header>
      <nav className="mt-6 flex flex-wrap items-center gap-3 border-b border-token-subtle pb-3" aria-label="演示选项">
        <button className="text-xs" aria-pressed={tab === 'cards'} onClick={() => setTab('cards')}>三档对照</button>
        <button className="text-xs text-token-muted" aria-pressed={tab === 'markdown'} onClick={() => setTab('markdown')}>Markdown 修复示例</button>
        {tab === 'cards' && <><label className="ml-auto inline-flex items-center gap-2 text-xs text-token-secondary">场景<select aria-label="筛选演示场景" className="max-w-[180px] rounded-md border border-token-default px-2 py-1" style={{ background: 'var(--bg-elevated)' }} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部场景</option>{scenarios.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <button className="inline-flex items-center gap-1 rounded-md border border-token-default px-2 py-1 text-xs" aria-pressed={batch} onClick={() => setBatch(value => !value)}><Check size={12} />批量选择 {batch ? '开' : '关'}</button></>}
      </nav>
      <p role="status" className="my-3 text-xs text-token-secondary">{message}</p>
      {tab === 'cards' ? <div className="overflow-x-auto pb-3" aria-label="大中小卡片对照">
        <div className="min-w-[1030px]">
          <div className="grid items-center gap-4 border-b border-token-subtle pb-3 text-xs text-token-muted" style={{ gridTemplateColumns: '166px 360px 264px 176px' }}><span>场景 / 观察点</span>{columns.map(item => <span key={item.value}>{item.label}卡片 <span className="ml-2 font-mono text-[10px]">{item.width} px</span></span>)}</div>
          {scenarios.filter(item => filter === 'all' || item.id === filter).map(item => <section key={item.id} data-demo-scenario={item.id} className="grid items-start gap-4 border-b border-token-subtle py-5" style={{ gridTemplateColumns: '166px 360px 264px 176px' }}>
            <div className="pt-1"><h2 className="text-xs font-medium">{item.label}</h2><p className="mt-2 text-[11px] leading-5 text-token-muted">{item.hint}</p></div>
            {columns.map(size => <div key={size.value} data-demo-size={size.value} style={{ width: size.width }}><SiteCard site={{ ...item.site, id: `${item.id}-${size.value}` }} size={size.value}
              selected={selected.includes(item.id)} selectionMode={batch} shared={shared.includes(item.id)} caps={item.readOnly ? readCaps : fullCaps}
              activity={item.activity ? { ...item.activity, isNew: item.activity.isNew && !opened.includes(item.id) } : undefined} traffic={item.traffic}
              shareStats={{ activeLinks: shared.includes(item.id) ? item.traffic?.activeShareLinks || 1 : 0 }}
              relatedNavigation={item.related ? <div className="related-documents-bar related-variant-badge" data-no-drag><button className="related-trigger" type="button" aria-label={`查看 ${item.related} 份关联文档（演示）`} onClick={() => action('关联文档', item)}><Link2 size={12} /><span className="related-count">{item.related}</span></button></div> : null}
              onSelect={() => { setSelected(values => toggle(values, item.id)); setMessage(`已切换「${item.site.title}」的选择状态，三档同步。`); }}
              onVisit={() => { setOpened(values => [...values, item.id]); action('预览', item); }}
              onShare={() => { setShared(values => toggle(values, item.id)); setMessage(`已切换「${item.site.title}」的演示分享状态。`); }}
              onTogglePublic={() => action('公开设置', item)} onEdit={() => action('编辑信息', item)} onDelete={() => action('删除确认', item)}
              onQrCode={() => action('二维码', item)} onTransferToLibrary={() => action('转存到知识库', item)} onReplaceFile={() => action('替换内容', item)}
              onViewers={item.readOnly ? undefined : () => action('查看访客', item)} onMove={item.readOnly ? undefined : () => action('移动到空间或文件夹', item)}
              onComments={item.readOnly ? undefined : () => action('评论管理', item)} onAskConfig={item.readOnly ? undefined : () => action('提问设置', item)}
              onAiEdit={item.readOnly ? undefined : () => action('帮我修改', item)} /></div>)}
          </section>)}
        </div>
      </div> : <section className="max-w-2xl rounded-xl border border-token-default p-6"><AskMarkdown content={answer} sourceTitle="青岚社区图书角" /></section>}
    </div>
    {dialog && <Dialog open title={`${dialog.title} · 示例`} onOpenChange={value => { if (!value) setDialog(null); }} maxWidth={520} content={<div className="space-y-4 text-sm text-token-secondary">
      <h2 className="font-medium text-token-primary">{dialog.scenario.site.title}</h2>
      {dialog.title === '预览' ? <img src={dialog.scenario.site.coverImageUrl} alt="示例文档内容" className="w-full rounded-lg" /> : dialog.title === '关联文档' ? <div className="space-y-2">{['项目主文档', '补充阅读资料', '交付验收说明'].slice(0, Math.min(dialog.scenario.related, 3)).map(title => <button key={title} className="flex w-full items-center justify-between rounded border border-token-default p-3" onClick={() => setMessage(`已选择示例关联：${title}`)}>{title}<ArrowUpRight size={14} /></button>)}<p className="text-xs">共 {dialog.scenario.related} 份关联，仅展示示例条目。</p></div> : <p>已触发{dialog.title}，业务记录不会改变。</p>}
      <button className="rounded-lg border border-token-default px-3 py-2 text-xs" onClick={() => setDialog(null)}>关闭演示</button>
    </div>} />}
  </main>;
}
