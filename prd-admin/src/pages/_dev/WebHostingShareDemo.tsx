import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Link2, SlidersHorizontal } from 'lucide-react';
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
    reader={current && <article className="ledger-demo-body"><p>本文为示例数据，用于展示网页托管阅读页的排版。合集只决定“这些文档放在一起阅读”的目录关系，不改变每份文档自身的访问权限、版本与批注。</p><h2>1. 背景与问题</h2><p>过去两个季度，评审资料散落在多个托管链接中。读者拿到其中一份，很难判断它在整套资料中的位置，也无法确认哪一份才是作者希望先读的总览。</p><h2>2. 本次评审的范围</h2><p>评审覆盖任务编排、检索增强与权限中心三个方向，每个方向提供一份技术方案和数据周报。附录收录历次会议纪要，按时间排序。</p><p>本 Demo 使用示例内容。真实合集继续使用现有的版本、批注、讨论与权限校验。</p></article>}
    related={<div className="ledger-related-list">{['权限中心 · 技术方案（2026 Q3）', '成本看板 · 数据周报 第 3 期', '评测基线 · 指标定义', '灰度发布 · 复盘'].map((title, index) => <div key={title}><span className={`ledger-tag${index % 2 ? ' is-reference' : ''}`}>{index % 2 ? '评论引用' : '手动关联'}</span><span>{title}</span><small>{authors[index]} {index % 2 ? '引用' : '添加'}</small></div>)}</div>} />
    {manager && <HostedCollectionEditor initialSites={sites.map(site => ({ id: site.id, title: site.title }))} demo initialTitle={data.title} initialSharing={manager === 'share'} onClose={() => setManager(null)} />}
  </>;
}
