import { useState } from 'react';
import { Clock3, RotateCcw, ArrowUpRight } from 'lucide-react';
import { SiteCard, SITE_CARD_SIZES, type SiteCardSize } from '@/components/web-hosting/SiteCard';
import { AskMarkdown } from '@/components/web-hosting/ask/AskMarkdown';
import type { HostedSite, HostedSiteActivity } from '@/services/real/webPages';

function cover(title: string, index: number) {
  const rows = Array.from({ length: 7 }, (_, i) => `<rect x="${index === 0 ? 132 : 40}" y="${96 + i * 24}" width="${290 - (i % 3) * 45}" height="5" rx="2" fill="#a9b6c3" opacity="${i % 2 ? '.4' : '.7'}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="528" height="280" viewBox="0 0 528 280"><rect width="528" height="280" fill="#f4f7fa"/>${index === 0 ? '<rect width="108" height="280" fill="#142a40"/><rect x="22" y="38" width="64" height="7" rx="3" fill="#8aa4ba"/>' : ''}<text x="${index === 0 ? 132 : 40}" y="54" font-size="15" font-weight="600" fill="#172c3f" font-family="sans-serif">${title}</text><rect x="${index === 0 ? 132 : 40}" y="70" width="340" height="1" fill="#ccd4dc"/>${rows}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const titles = ['米多项目缺陷复发根因审查报告', '#1679 内容去向与需求保全审计', '米多项目缺陷审查 · MD-REVIEW', '青岚社区图书角 · 活动指南'];
const sites: HostedSite[] = titles.map((title, i) => ({
  id: `demo-${i}`, title, sourceType: 'upload', cosPrefix: '', entryFile: 'index.html', siteUrl: '', pdfAssetUrl: undefined,
  files: [{ path: 'index.html', cosKey: '', size: 1024, mimeType: 'text/html' }],
  coverImageUrl: cover(title, i), totalSize: [349901, 242278, 591872, 45056][i], tags: [], folderCanonicalName: '',
  ownerUserId: 'demo', viewCount: [8, 0, 3, 0][i], visibility: 'private',
  createdAt: '2026-11-04T08:00:00Z', updatedAt: '2026-11-04T08:00:00Z',
}));
const initialActivity: Record<string, HostedSiteActivity> = {
  'demo-0': { editCount: 3, isNew: false }, 'demo-1': { editCount: 0, isNew: true },
  'demo-2': { editCount: 2, isNew: false }, 'demo-3': { editCount: 0, isNew: true },
};
const answer = `- **周二至周五： **14:00—19:00[^1]
- **周六至周日：**09:30—17:30[^2]
- **每周一： **闭馆整理[^3]
- **节假日： **开放安排尚未确定，请勿以本页为准。[^4]

[^1]: 周二至周五开放时间为 14:00—19:00。
[^2]: 周六至周日开放时间为 09:30—17:30。
[^3]: 每周一闭馆整理。
[^4]: 节假日开放安排尚未确定。`;
const noop = () => {};

/** 示例数据与真实卡片组件共用；交互只修改本页内存，不请求或修改用户站点。 */
export default function WebHostingCardsDemo() {
  const [size, setSize] = useState<SiteCardSize>('medium');
  const [tab, setTab] = useState<'cards' | 'markdown'>('cards');
  const [activity, setActivity] = useState(initialActivity);
  const [shared, setShared] = useState(['demo-0', 'demo-3']);
  const [opened, setOpened] = useState<HostedSite | null>(null);
  const width = SITE_CARD_SIZES.find(item => item.value === size)!.width;
  const toggleShare = (id: string) => setShared(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id]);
  const open = (site: HostedSite) => {
    setOpened(site);
    setActivity(previous => ({ ...previous, [site.id]: { ...previous[site.id], isNew: false } }));
  };
  return <main data-theme="light" className="min-h-screen px-6 py-10 sm:px-12" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
    <div className="mx-auto max-w-5xl">
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div><p className="text-xs tracking-widest" style={{ color: 'var(--text-tertiary)' }}>网页托管 · 设计演示</p>
          <h1 className="mt-2 text-2xl font-semibold">让状态一眼可读</h1>
          <p className="mt-3 text-sm" style={{ color: 'var(--text-secondary)' }}>仅标记已分享；新内容独立提示；编辑次数留在底部。</p>
        </div>
        <button className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)' }} onClick={() => { setActivity(initialActivity); setShared(['demo-0', 'demo-3']); setOpened(null); }}><RotateCcw size={13} />重置演示</button>
      </header>
      <nav className="mt-8 flex flex-wrap items-center justify-between gap-4 border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex gap-5">{(['cards', 'markdown'] as const).map(value => <button key={value} aria-pressed={tab === value} className="text-sm" style={{ color: tab === value ? 'var(--text-primary)' : 'var(--text-tertiary)', fontWeight: tab === value ? 600 : 400 }} onClick={() => setTab(value)}>{value === 'cards' ? '卡片设计' : 'Markdown 修复示例'}</button>)}</div>
        {tab === 'cards' && <div className="flex gap-1">{SITE_CARD_SIZES.map(item => <button key={item.value} aria-label={`${item.label}卡片`} aria-pressed={size === item.value} className="rounded-md px-3 py-1 text-xs" style={{ background: size === item.value ? 'var(--bg-elevated)' : 'transparent', color: 'var(--text-secondary)' }} onClick={() => setSize(item.value)}>{item.label}</button>)}</div>}
      </nav>
      {tab === 'cards' ? <>
        <div className="my-6 flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}><Clock3 size={15} />今天 · 4</div>
        <div className="grid items-start gap-5" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${width}px), ${width}px))` }}>
          {sites.map(site => <SiteCard key={site.id} site={site} size={size} selected={false} shared={shared.includes(site.id)}
            shareStats={{ activeLinks: shared.includes(site.id) ? 1 : 0 }} activity={activity[site.id]} visitorCount={site.viewCount}
            caps={{ canEdit: false, canDelete: false, canShare: true, canSetVisibility: false }}
            onVisit={() => open(site)} onShare={() => toggleShare(site.id)} onSelect={noop} onTogglePublic={noop} onEdit={noop} onDelete={noop}
            onQrCode={noop} onTransferToLibrary={noop} onReplaceFile={noop} />)}
        </div>
        <p className="mt-7 text-xs leading-6" style={{ color: 'var(--text-tertiary)' }}>示例数据。点击标题或预览，“新”标记消失；点击分享可切换状态。不会改动你的网页。</p>
        {opened && <section className="mt-5 rounded-xl border p-5" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }} aria-label="模拟打开网页">
          <div className="flex items-center gap-2 text-sm font-medium"><ArrowUpRight size={16} />已打开：{opened.title}</div>
          <p className="mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>已移除这张卡片的“新”标记，分享状态和编辑次数不受影响。</p>
        </section>}
      </> : <section className="mt-6 max-w-2xl rounded-2xl border p-6" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
        <p className="mb-6 text-sm font-medium">图书角每周什么时候开放？</p>
        <AskMarkdown content={answer} sourceTitle="青岚社区图书角" />
      </section>}
    </div>
  </main>;
}
