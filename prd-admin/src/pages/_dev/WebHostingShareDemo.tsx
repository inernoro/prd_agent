import { useEffect, useState } from 'react';
import type { CommentThreadCounts } from '@/components/web-hosting/CommentsSection';
import type { CollectionThreadKind } from '@/components/web-hosting/HostedCollectionReader';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, Link2, SlidersHorizontal } from 'lucide-react';
import HostedShareCollection, { type LedgerCollectionData, type LedgerSite } from '@/components/web-hosting/HostedShareCollection';
import { HostedCollectionEditor } from '@/components/web-hosting/HostedCollectionManager';

const topics = ['Agent 任务编排', '灰度发布', '离线评估', '多模态解析', '插件市场', '合规审查', '成本看板', '提示词版本', '长文档摘要', '知识库同步', '埋点规范', '评测基线', 'API 网关', '检索增强召回', '对话记忆', '用户访谈', '权限中心', '安全审计'];
const kinds = ['技术方案', '调研报告', '复盘', '需求说明', '数据周报', '评审纪要'];
const authors = ['林舟', '何川', '周以宁', '宋叶', '陈墨'];
const chapters = ['背景与目标', '方案评审', '实验与数据', '上线与运营'];
const toc = ['结论摘要', '评审范围与议程', '各方向阅读顺序', '待决问题', '附录说明'];
const allSites: LedgerSite[] = Array.from({ length: 90 }, (_, i) => ({
  id: i === 0 ? 'demo-overview' : `demo-document-${i + 1}`,
  title: i === 0 ? '2026 Q4 Agent 平台评审 · 总览与阅读指引' : i === 4 ? 'Agent 任务编排在跨部门知识库场景下的权限继承、版本冲突与离线评估方案（含 2026 Q3 灰度结论与后续计划）' : `${topics[(i >= 18 ? i + 11 : i) % topics.length]} ${kinds[((i >= 18 ? i + 11 : i) % topics.length + 5) % kinds.length]}${i >= 18 ? ` · 第 ${Math.floor(i / 18) + 1} 轮` : ''}`,
  description: i === 0 ? '明确本期目标、非目标与验收口径，附三条关键假设。 建议先阅读第 1 节的结论摘要，再按章节顺序查看各方向的技术方案与数据。' : i === 2 ? undefined : '对比两套方案的延迟、成本与维护负担，给出推荐。',
  documentTypeLabel: i === 0 ? '总览' : kinds[(i - 1) % kinds.length],
  displayMeta: `${authors[i % authors.length]} · ${i === 0 ? '总览' : kinds[(i - 1) % kinds.length]} · 11-${String(10 - i % 9).padStart(2, '0')}`,
  section: i === 0 ? undefined : chapters[Math.min(3, Math.floor((i - 1) / 8))],
  unavailable: i === 9,
  readingMeta: i === 0 ? '批注 12　讨论 4　约 18 分钟读完' : undefined,
  toc: i === 0 ? toc : undefined,
  siteUrl: '', entryFile: 'index.html', entrySize: 1024, fileCount: 1, totalSize: 39859,
}));
export default function WebHostingShareDemo() {
  const [params, setParams] = useSearchParams();
  const count = [1, 3, 12, 30, 90].includes(Number(params.get('count'))) ? Number(params.get('count')) : 30;
  const currentId = params.get('siteId');
  const current = allSites.find(site => site.id === currentId);
  const [sampleVersion, setSampleVersion] = useState('v3');
  const [sampleVersionOpen, setSampleVersionOpen] = useState(false);
  const [sampleAnnotationsOpen, setSampleAnnotationsOpen] = useState(false);
  const [manager, setManager] = useState<'edit' | 'share' | null>(null);
  useEffect(() => {
    const previous = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = 'light';
    return () => { if (previous === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = previous; };
  }, []);
  const sites = allSites.slice(0, count).map(site => ({ ...site, section: count > 3 ? site.section : undefined }));
  const data: LedgerCollectionData = { title: count <= 3 ? '长文档摘要 · 评审包' : '2026 Q4 Agent 平台评审资料',
    description: count <= 3 ? '评审会前请先读主文档，其余文档作为补充材料按顺序阅读。' : '面向 11 月平台评审会的完整资料。主文档给出阅读顺序与结论摘要；各章节由作者按评审议程排列，附录收录历次会议纪要。',
    mobileDescription: '面向 11 月平台评审会的完整资料，先读主文档。',
    mainSiteId: allSites[0].id, createdByName: '林舟', updatedLabel: '11-08', sites: sites.map((site, index) => index === 0 ? { ...site, title: count <= 3 ? '长文档摘要 · 评审总览' : site.title, description: `本合集收录 ${count} 份评审资料。${site.description}` } : site) };
  const select = (id: string | null) => { const next = new URLSearchParams(params); if (id) next.set('siteId', id); else next.delete('siteId'); setParams(next); };
  return <><HostedShareCollection key={count} data={data} collectionPath={`/_dev/web-hosting-share?count=${count}`} sample selectedSiteId={currentId} onSelect={select}
    controls={<div className="ledger-sample-controls"><span>示例规模</span><div className="ledger-scale" role="group" aria-label="示例文档数量">{[1, 3, 12, 30, 90].map(value => <button key={value} aria-pressed={value === count} onClick={() => setParams({ count: String(value) })}>{value}</button>)}</div><label className="ledger-scale-select"><select aria-label="示例文档数量" value={count} onChange={event => setParams({ count: event.target.value })}>{[1, 3, 12, 30, 90].map(value => <option key={value} value={value}>{value} 份</option>)}</select></label></div>}
    action={<><button className="ledger-button" aria-label="分享" onClick={() => setManager('share')}><Link2 size={14} /><span>分享</span></button><button className="ledger-button" aria-label="管理合集" onClick={() => setManager('edit')}><SlidersHorizontal size={14} /><span>管理合集</span></button></>}
    reader={current ? render => render({
      content: <>{sampleVersion !== 'v3' && <p className="ledger-update-note">正在查看历史版本 {sampleVersion}，批注按该版本定位。<button onClick={() => setSampleVersion('v3')}>回到 v3</button></p>}<article className="ledger-demo-body"><p>本文为示例数据，用于展示网页托管阅读页的排版。合集只决定“这些文档放在一起阅读”的目录关系，不改变每份文档自身的访问权限、版本与批注。</p><h2>1. 背景与问题</h2><p>过去两个季度，评审资料散落在多个托管链接中。读者拿到其中一份，很难判断它在整套资料中的位置，<mark role="button" tabIndex={0} className="ledger-demo-annotation" onClick={() => setSampleAnnotationsOpen(true)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSampleAnnotationsOpen(true); } }}>也无法确认哪一份才是作者希望先读的总览</mark>。这直接导致评审会前的准备时间被拉长。</p><h2>2. 本次评审的范围</h2><p>评审覆盖任务编排、检索增强与权限中心三个方向，每个方向提供一份技术方案和一份数据周报。附录收录历次会议纪要，按时间排序。</p></article></>,
      metadata: <><span>{authors[allSites.findIndex(site => site.id === current.id) % authors.length]}</span><span>更新于</span><span>{`11-${String(10 - allSites.findIndex(site => site.id === current.id) % 9).padStart(2, '0')}`}</span></>,
      controls: <div className="ledger-demo-version"><button className="ledger-button" aria-expanded={sampleVersionOpen} aria-label="示例文档版本" onClick={() => setSampleVersionOpen(value => !value)}><span>版本</span><span>{sampleVersion}</span><ChevronDown size={12} /></button>{sampleVersionOpen && <div className="ledger-demo-version-menu" role="menu" aria-label="示例版本历史">{['v3', 'v2', 'v1'].map((version, index) => <button key={version} role="menuitem" onClick={() => { setSampleVersion(version); setSampleVersionOpen(false); }}>{version} · {['11-08 · 当前版本', '10-29 · 补充评审议程', '10-20 · 初稿'][index]}</button>)}</div>}</div>,
      comments: (kind, onCounts) => <DemoComments kind={kind} onCounts={onCounts} />,
      annotationsOpen: sampleAnnotationsOpen,
      onDismissAnnotations: () => setSampleAnnotationsOpen(false),
      related: () => <><section className="ledger-relation-group"><h2>也收录于</h2><div className="ledger-relation-item">检索增强召回 · 技术评审包<small>第 3 / 8 篇 · 主文档为《检索增强召回 · 技术方案》</small></div><div className="ledger-relation-item">新人入职 · 平台阅读清单<small>第 12 / 20 篇 · 作者 周以宁</small></div></section>
        <section className="ledger-relation-group"><h2>手动关联</h2>{['权限中心 · 技术方案（2026 Q3）', '评测基线 · 指标定义'].map(title => <div className="ledger-relation-item" key={title}><span className="ledger-tag is-manual">手动</span>{title}</div>)}</section>
        <section className="ledger-relation-group"><h2>评论引用 · 最近优先</h2>{['成本看板 · 数据周报 第 3 期', '灰度发布 · 复盘'].map((title, index) => <div className="ledger-relation-item" key={title}><span className="ledger-tag is-reference">引用</span>{title}<small>{index === 0 ? '11-10 14:22 · 何川' : '11-07 09:15 · 宋叶'}</small></div>)}</section></>,
    }) : undefined}
    related={<div className="ledger-related-list">{['权限中心 · 技术方案（2026 Q3）', '成本看板 · 数据周报 第 3 期', '评测基线 · 指标定义', '灰度发布 · 复盘'].map((title, index) => <div key={title}><span className={`ledger-tag${index % 2 ? ' is-reference' : ''}`}>{index % 2 ? '评论引用' : '手动关联'}</span><span>{title}</span><small>{authors[index]} {index % 2 ? '引用' : '添加'}</small></div>)}</div>} />
    {manager && <HostedCollectionEditor initialSites={sites.map(site => ({ id: site.id, title: site.title }))} demo initialTitle={data.title} initialSharing={manager === 'share'} onClose={() => setManager(null)} />}
  </>;
}

function DemoComments({ kind, onCounts }: { kind: CollectionThreadKind; onCounts: (counts: CommentThreadCounts) => void }) {
  const notes = [
    { quote: '也无法确认哪一份才是作者希望先读的总览', text: '建议在合集页把主文档置顶，并给出“从这里开始”的入口。', by: '周以宁', at: '11-09' },
    { quote: '评审覆盖任务编排、检索增强与权限中心', text: '对话记忆是否纳入本次范围？', by: '何川', at: '11-08' },
    { quote: '附录收录历次会议纪要', text: '纪要请按时间倒序。', by: '宋叶', at: '11-06' },
  ];
  const discussions = [
    { text: '权限中心方案的跨作者文档怎么处理？需要在分享前看到差异。', by: '陈墨', at: '11-09 · 3 条回复', quote: '' },
    { text: '评审会改到周四下午，资料周三前冻结。', by: '林舟', at: '11-07 · 1 条回复', quote: '' },
  ];
  useEffect(() => { onCounts({ annotations: notes.length, discussions: discussions.length }); }, [onCounts, notes.length, discussions.length]);
  return <div className="ledger-demo-comments">{(kind === 'annotation' ? notes : discussions).map(item => <div key={item.text}>{item.quote && <blockquote>{item.quote}</blockquote>}<p>{item.text}</p><small>{item.by} · {item.at}</small></div>)}</div>;
}
