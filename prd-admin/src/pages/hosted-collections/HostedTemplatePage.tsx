import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, Minus, Plus, X } from 'lucide-react';
import { getHostedCollectionCandidates } from '@/services/real/hostedCollections';
import { createFromContent } from '@/services/real/webPages';
import type { WritingTemplate } from '@/services/contracts/writing';
import type { HostedCollectionItem } from '@/services/contracts/hostedCollections';
import { useAuthStore } from '@/stores/authStore';
import { WritingLogo } from '../document-store/writing/WritingLogo';
import { WritingThemeButton } from '../document-store/writing/WritingWorkspacePage';
import { WritingThreads } from '../document-store/writing/WritingThreads';
import '../document-store/writing/writing.css';
import './template.css';

type Draft = { templateId: string; type: string; title: string; summary: string; headings: string[]; body: string };
const empty: Draft = { templateId: 'overview', type: '总览', title: '', summary: '', headings: [], body: '' };
// 桌面与手机共用字段规则，避免说明缺项。
const FIELD_RULES = [
  [
    "1",
    "文档类型",
    "选模版时确定，可改",
    "7 种之一",
    "类型标签、目录副标题、按类型筛选",
    "显示「文档」，不参与筛选"
  ],
  [
    "2",
    "标题",
    "必填",
    "建议不超过 32 字",
    "主文档卡、目录、继续阅读、阅读页、分享卡片",
    "不能发布；过长时合集页截为两行，阅读页显示全文"
  ],
  [
    "3",
    "摘要",
    "建议填写",
    "1–3 句，不超过 120 字",
    "主文档卡、小合集列表、搜索结果、阅读页导语",
    "取正文开头 60 字并标注「正文开头」；小合集列表不显示"
  ],
  [
    "4",
    "正文小标题",
    "建议 3–7 节",
    "二级标题，单行",
    "主文档目录、阅读页目录、批注定位",
    "不显示目录，阅读页只能整篇滚动"
  ],
  [
    "5",
    "自动字段",
    "不用填",
    "—",
    "版本、作者、更新时间、批注与讨论数、阅读时长",
    "—"
  ]
] as const;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export default function HostedTemplatePage() {
  const userId = useAuthStore(s => s.user?.userId);
  return <HostedTemplateEditor key={userId} />;
}

function HostedTemplateEditor() {
  const user = useAuthStore(s => s.user);
  const key = `hosted-template-draft:${user?.userId ?? ''}`;
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(() => { try { return { ...empty, ...JSON.parse(localStorage.getItem(key) ?? 'null') }; } catch { return empty; } });
  const [templates, setTemplates] = useState<WritingTemplate[]>([]);
  const [neighbor, setNeighbor] = useState<HostedCollectionItem>();
  const [neighborStatus, setNeighborStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [focus, setFocus] = useState('');
  const [mobilePreview, setMobilePreview] = useState(false);
  const [preview, setPreview] = useState('collection');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { let current = true; void getHostedCollectionCandidates().then(r => { if (!current) return; if (r.success) { setTemplates(r.data.templates); setNeighbor(r.data.items.find(item => !item.unavailable)); setNeighborStatus('ready'); setDraft(d => d.headings.length || d.title || d.body ? d : { ...d, headings: r.data.templates.find(t => t.id === d.templateId)?.headings.map(h => h.title) ?? [] }); } else { setError(r.error.message); setNeighborStatus('failed'); } }); return () => { current = false; }; }, []);
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(draft)); setSaved(true); } catch { setSaved(false); } }, [key, draft]);
  const template = templates.find(t => t.id === draft.templateId);
  const patch = (values: Partial<Draft>) => setDraft(d => ({ ...d, ...values }));
  const field = (id: string) => `fb ${focus === id ? 'on' : ''}`;
  const target = (id: string, extra = '') => `tg ${focus === id ? 'on' : ''} ${extra}`;
  const title = draft.title.trim() || '未命名文档';
  const excerpt = draft.summary.trim() || draft.body.trim().slice(0, 60);
  const neighborDate = neighbor?.updatedAt && Number.isFinite(Date.parse(neighbor.updatedAt))
    ? new Date(neighbor.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }).replace('/', '-') : '更新时间未提供';
  async function publish() {
    if (busy) return;
    if (!draft.title.trim()) { setError('请填写文档标题'); setMobilePreview(false); return; }
    if (!draft.body.trim()) { setError('请填写正文后再发布'); setMobilePreview(false); return; }
    setBusy(true); setError('');
    try {
      const paragraphs = draft.body.split(/\n\s*\n/).map(text => `<p>${esc(text).replace(/\n/g, '<br>')}</p>`).join('\n');
      const htmlContent = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(draft.title)}</title><style>body{margin:0 auto;max-width:760px;padding:32px 24px 80px;font:16px/1.85 system-ui;color-scheme:light dark;color:CanvasText;background:Canvas}h1{font:600 30px/1.35 serif}h2{font:600 20px/1.5 serif;margin-top:32px}p{white-space:normal}small{color:GrayText}summary{cursor:pointer}</style><article><small>${esc(draft.type)}</small><h1>${esc(draft.title)}</h1>${draft.summary.trim() ? `<p>${esc(draft.summary)}</p>` : ''}${draft.headings.length ? `<nav>${draft.headings.map((h, i) => `<a href="#section-${i}">${esc(h)}</a> `).join('')}</nav>` : ''}${draft.headings.map((h, i) => `<section id="section-${i}"><h2>${esc(h)}</h2>${i === 0 ? paragraphs : ''}</section>`).join('') || paragraphs}</article></html>`;
      const result = await createFromContent({ htmlContent, title: draft.title.trim(), description: draft.summary.trim(), writingTemplateId: draft.templateId, documentType: draft.type, sourceType: 'writing-template', tags: [draft.type] });
      if (!result.success) throw new Error(result.error.message);
      try { localStorage.removeItem(key); } catch { /* 发布结果已保存在服务器 */ }
      navigate(`/web-pages?openSite=${encodeURIComponent(result.data.id)}`);
    } catch (e) { setError(e instanceof Error ? e.message : '发布失败，请重试'); }
    finally { setBusy(false); }
  }
  const toc = <div className={target('head')} data-k="4">{draft.headings.map((h, i) => <div className="ht-toc-row" key={i}><span className="mono">{String(i + 1).padStart(2, '0')}</span><span className="cl1">{h}</span></div>)}</div>;
  return <div className="writing-root hcol-template" data-template-page><WritingThreads />
    <header className="ht-header"><div className="ht-breadcrumb"><Link to="/web-pages" aria-label="返回网页托管"><span className="ht-desktop-logo"><WritingLogo /></span><ChevronLeft className="ht-mobile-back" size={20} /></Link><Link to="/web-pages">网页托管</Link><span>/</span><span>新建文档</span><span>/</span><strong>写作模版</strong></div><strong className="ht-mobile-title">新建文档</strong><div className="ht-actions"><span className="mono">{saved ? '本机草稿已保存' : '本机草稿未保存'}</span><WritingThemeButton /><button className="btn ht-publish" disabled={busy} onClick={() => void publish()}>{busy ? '发布中…' : '发布'}</button></div></header>
    <div className="ht-toolbar"><div className="seg ht-template-tabs" role="group" aria-label="模版">{templates.map(t => <button key={t.id} aria-pressed={t.id === draft.templateId} onClick={() => patch({ templateId: t.id, type: t.type, headings: t.headings.map(h => h.title) })}>{t.type}</button>)}</div><div className="seg ht-mobile-switch"><button aria-pressed={!mobilePreview} onClick={() => setMobilePreview(false)}>填写</button><button aria-pressed={mobilePreview} onClick={() => setMobilePreview(true)}>预览</button></div></div>
    {error && <div className="ht-error" role="alert">{error}<button className="ib" aria-label="关闭错误" onClick={() => setError('')}><X size={14} /></button></div>}
    <main className={`ht-layout ${mobilePreview ? 'show-preview' : ''}`}>
      <section className="panel scroll ht-editor" aria-label="模版编辑器"><div className="ht-editor-heading"><div><strong>{template?.name ?? '写作模版'}</strong><span className="hint">{template?.useWhen}</span></div><span className="mono">草稿 · 自动保存</span></div>
        <div className={field('type')} onMouseEnter={() => setFocus('type')} onMouseLeave={() => setFocus('')}><span className="fk">1</span><div className="lbl"><b>文档类型</b><span className="hint"><span className="ht-desktop-copy">选模版时确定，</span>可改</span></div><div className="ht-types">{templates.map(t => <button className="btn sm" key={t.id} aria-pressed={t.type === draft.type} onFocus={() => setFocus('type')} onClick={() => patch({ type: t.type })}>{t.type}</button>)}</div></div>
        <div className={field('title')} onMouseEnter={() => setFocus('title')} onMouseLeave={() => setFocus('')}><span className="fk">2</span><label className="lbl" htmlFor="template-title"><b>标题</b><span className={`cnt ${draft.title.length > 32 ? 'warn' : ''}`}>{draft.title.length} / 32{draft.title.length > 32 && ' · 合集页截为两行'}</span></label><input id="template-title" aria-label="标题" className="field fi-t" value={draft.title} onChange={e => patch({ title: e.target.value })} onFocus={() => setFocus('title')} placeholder="一句话说清这份文档是什么" /><span className="hint"><span className="ht-desktop-copy">放在最前面的词决定读者能不能在目录里一眼认出它。</span><span className="ht-mobile-copy">最能区分这份文档的词放在最前面。</span></span></div>
        <div className={field('sum')} onMouseEnter={() => setFocus('sum')} onMouseLeave={() => setFocus('')}><span className="fk">3</span><label className="lbl" htmlFor="template-summary"><b>摘要</b><span className={`cnt ${draft.summary.length > 120 ? 'warn' : ''}`}>{draft.summary.length} / 120</span></label><textarea id="template-summary" aria-label="摘要" className="field fi-s" value={draft.summary} onChange={e => patch({ summary: e.target.value })} onFocus={() => setFocus('sum')} placeholder="用 1–3 句说明结论、范围或读者能获得什么" />{draft.summary.trim() ? <span className="hint ht-summary-hint">1–3 句。显示在主文档卡、小合集列表、搜索结果和阅读页导语。</span> : <div className="note">没有摘要时，合集页会显示正文开头，并标注「正文开头」。</div>}</div>
        <div className={field('head')} onMouseEnter={() => setFocus('head')} onMouseLeave={() => setFocus('')}><span className="fk">4</span><div className="lbl"><b>正文小标题</b><span className={`cnt ${draft.headings.length < 3 || draft.headings.length > 7 ? 'warn' : ''}`}>{draft.headings.length} 节<span className="ht-desktop-copy"> · 建议 3–7 节</span></span></div>{draft.headings.map((h, i) => <div className="hrow" key={i}><span className="mono">{String(i + 1).padStart(2, '0')}</span><input className="field fi-h" aria-label={`小标题${i + 1}`} value={h} onFocus={() => setFocus('head')} onChange={e => patch({ headings: draft.headings.map((v, j) => i === j ? e.target.value : v) })} /><button className="ib" aria-label={`删除小标题${i + 1}`} onClick={() => patch({ headings: draft.headings.filter((_, j) => i !== j) })}><Minus size={14} /></button><span className="hh">{template?.headings[i]?.hint}</span></div>)}{!draft.headings.length && <div className="note">没有小标题：合集页不显示目录，读者只能整篇滚动。<button className="btn sm" onClick={() => patch({ headings: template?.headings.map(h => h.title) ?? [] })}>插入模版小标题</button></div>}<div><button className="btn ghost sm ht-add-heading" onClick={() => patch({ headings: [...draft.headings, '新小节'] })}><Plus size={13} />添加小标题</button></div></div>
        <div className={field('auto')} onMouseEnter={() => setFocus('auto')} onMouseLeave={() => setFocus('')}><span className="fk">5</span><div className="lbl"><b>自动生成</b><span className="hint">不用填写</span></div><div className="ht-types">{['版本','作者','更新时间','批注 / 讨论数','阅读时长'].map(t => <span className="chipx" key={t}>{t}</span>)}</div></div>
        <details className="ht-body"><summary>填写正文</summary><p className="hint">正文随文档一起发布；小标题编辑不会删除已输入的正文。</p><textarea className="field fi-s" aria-label="正文" value={draft.body} onChange={e => patch({ body: e.target.value })} placeholder="填写正文，段落之间留空行" /></details>
      </section>
      <section className="scroll ht-previews" aria-label="显示效果"><div className="seg ht-preview-tabs" role="group" aria-label="预览位置">{[['collection','合集页'],['directory','目录'],['read','阅读页']].map(([id,name]) => <button key={id} aria-pressed={preview === id} onClick={() => setPreview(id)}>{name}</button>)}</div>
        <div className={`ht-preview-block ${preview === 'collection' ? 'current' : ''}`}><div className="pv-l"><span>在合集页 · 设为主文档时</span><span>宽 960</span></div><div className="panel ht-primary"><div className={draft.headings.length ? 'pcA' : 'pcB'}><div className="ht-primary-copy"><div className="ht-types"><span className="tag t-m">主文档</span><span className="hint mono ht-primary-meta"><span className={target('type','in')} data-k="1">{draft.type}</span><span aria-hidden="true"> · </span><span className={target('auto','in')} data-k="5">待发布</span></span></div><div className={target('title')} data-k="2"><h2 className="cl2">{title}</h2></div><div className={target('sum')} data-k="3">{!draft.summary.trim() && <span className="tag t-l">正文开头</span>}<span className="serif ht-excerpt">{excerpt || '填写正文后显示开头'}</span></div><div className={target('auto','ht-metrics')} data-k="5"><span>批注 —</span><span>讨论 —</span><span>发布后统计阅读时长</span></div></div>{draft.headings.length > 0 && <div className="ht-outline ht-desktop-outline"><div className="mono">主文档目录</div>{toc}</div>}{draft.headings.length > 0 && <div className={`ht-mobile-outline ${target('head')}`} data-k="4"><div className="mono">主文档目录 · {draft.headings.length} 节</div>{draft.headings.slice(0,3).map((h,i) => <div className="ht-toc-row" key={i}><span className="mono">{String(i+1).padStart(2,'0')}</span><span className="cl1">{h}</span></div>)}{draft.headings.length > 3 && <div className="mono ht-toc-more">还有 {draft.headings.length-3} 节</div>}</div>}</div><button className="btn ht-primary-action ht-start-reading" onClick={e => { setMobilePreview(true); setPreview('read'); e.currentTarget.closest('.ht-layout')?.scrollTo?.({ top: 0 }); }}>从主文档开始阅读</button></div></div>
        <div className={`ht-preview-secondary ht-preview-block ${preview === 'directory' ? 'current' : ''}`}><div><div className="pv-l">目录栏 · 相邻效果</div><div className="panel ht-directory-panel"><div className="ht-directory"><span className="mono">当前</span><div><div className={target('title','in')} data-k="2"><span className="cl2">{title}</span></div><span className="hint">{user?.displayName} · {draft.type} · 发布后更新</span></div></div><div className="ht-neighbor" aria-label="相邻文档预览">{neighbor ? <><span className="mono">相邻</span><div><div className="cl2" title={neighbor.title}>{neighbor.title}</div><div className="hint">{neighbor.author || '作者未提供'} · {neighbor.type || '类型未提供'} · {neighborDate}</div></div></> : <p className="hint">{neighborStatus === 'loading' ? '正在读取相邻资料…' : neighborStatus === 'failed' ? '相邻资料暂时无法读取，请刷新重试' : '暂无可用于相邻预览的可见文档'}</p>}</div></div></div><div><div className="pv-l">继续阅读 · 列表效果</div><div className="panel ht-directory"><span className="mono">当前</span><div><strong className={target('title','in')} data-k="2">{title}</strong><p className={target('sum','in')} data-k="3">{excerpt || '正文开头：尚未填写'}</p><span className="hint">{user?.displayName} · {draft.type}</span></div></div></div></div>
        <div className={`ht-preview-block ${preview === 'read' ? 'current' : ''}`}><div className="pv-l">阅读页 · 字段映射</div><div className="panel ht-read"><div className="ht-read-meta"><span className={`tag t-l ${target('type','in')}`} data-k="1">{draft.type}</span><span className={target('auto','in')} data-k="5"><span className="mono">版本、作者与更新时间由发布生成</span></span></div><h1 className={target('title')} data-k="2">{title}</h1><div className="rdA"><aside>{draft.headings.length > 0 && <><div className="hint">本文目录</div>{toc}</>}</aside><article><div className={`ht-read-lead ${target('sum')}`} data-k="3">{excerpt}</div>{!draft.headings.length && <div className="hint">{draft.body || '填写正文后预览内容。'}</div>}{draft.headings.map((h,i) => <section key={i}><h2 className={target('head')} data-k="4">{h}</h2>{i === 0 && <div className="ht-read-body">{draft.body || '填写正文后预览内容。'}</div>}</section>)}</article></div></div></div>
      </section>
    </main><section className="ht-desktop-rules"><div className="lbl"><strong>字段规则</strong><span className="hint">所有模版共用 · 模版只决定默认类型和小标题</span></div><div className="ht-rule-row mono"><span>#</span><span>字段</span><span>填写</span><span>限制</span><span>显示在</span><span>缺失时</span></div>{FIELD_RULES.map(row => <div className="ht-rule-row" key={row[0]}>{row.map((cell,i) => <span key={i}>{cell}</span>)}</div>)}</section><footer className="ht-mobile-footer"><button className="btn" onClick={() => mobilePreview ? setMobilePreview(false) : setRules(true)}>{mobilePreview ? '返回填写' : '字段规则'}</button><button className="btn ht-primary-action" disabled={busy} onClick={() => mobilePreview ? void publish() : setMobilePreview(true)}>{mobilePreview ? busy ? '发布中…' : '发布' : '预览'}</button></footer>
    {rules && <div className="ht-rules-scrim" onClick={() => setRules(false)}><section className="panel ht-rules" role="dialog" aria-modal="true" aria-label="字段规则" onClick={e => e.stopPropagation()}><div className="ht-rules-heading"><strong>字段规则</strong><button className="ib" aria-label="关闭字段规则" onClick={() => setRules(false)}><X size={16} /></button></div><div className="scroll ht-rules-content">{FIELD_RULES.map(([number,name,fill,limit,shows,missing]) => <article className="ht-rule-card" key={number}><b><span className="fk">{number}</span>{name}<span className="hint">{fill}</span></b>{[['限制',limit],['显示在',shows],['缺失时',missing]].map(([label,value]) => <div key={label}><span className="ht-rule-key">{label}</span><span>{value}</span></div>)}</article>)}</div></section></div>}
  </div>;
}
