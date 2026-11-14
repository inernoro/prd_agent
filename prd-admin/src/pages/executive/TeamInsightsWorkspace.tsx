import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronDown, ChevronRight, Info, LayoutGrid, Search, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getRoleMeta } from '@/lib/roleConfig';
import type { ExecutiveWorkspaceMember, TeamInsightAttention, TeamInsightFlowNode, TeamInsights } from '@/services/contracts/executive';
import TeamInsightsPanel, { buildWindowLabel, fmt, maskName } from './TeamInsightsPanel';
import { executiveWorkspaceModel, MEMBER_STATE_REGISTRY, memberRecordState, workspaceSparkline } from './executiveWorkspaceModel';
import './executive-workspace.css';

type Density = 'auto' | 'cards' | 'rows' | 'line';
type RecordFilter = 'all' | 'record' | 'none';
type Place = { kind: 'root' } | { kind: 'group'; id: string } | { kind: 'member'; id: string } | { kind: 'attention'; key: string } | { kind: 'caller'; name: string } | { kind: 'report' } | { kind: 'notes' };
const DENSITIES: { key: Density; label: string }[] = [{ key: 'auto', label: '自动' }, { key: 'cards', label: '卡片' }, { key: 'rows', label: '两行' }, { key: 'line', label: '单行' }];
function outerScrollHost(element: HTMLElement) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return document.scrollingElement as HTMLElement | null;
}
const SEVERITY = { critical: { label: '待处理', className: 'failed' }, watch: { label: '观察', className: 'backlog' } } as const;

function StateGlyph({ state }: { state: ReturnType<typeof memberRecordState> }) {
  return <span className={`exec-glyph ${state}`} role="img" aria-label={MEMBER_STATE_REGISTRY[state].short} />;
}
function NumberText({ value, unit = '' }: { value: number | null; unit?: string }) {
  return <>{value === null ? '—' : fmt(value, unit)}{unit && <small>{unit}</small>}</>;
}
function OutputSpark({ values, label, large = false }: { values: number[]; label: string; large?: boolean }) {
  const path = workspaceSparkline(values, 300, large ? 130 : 30);
  if (!path) return <span className="exec-series-empty">{values.length ? '本序列范围暂无产出' : '未提供日序列'}</span>;
  return <svg viewBox={`0 0 300 ${large ? 130 : 30}`} preserveAspectRatio="none" className={large ? 'exec-large-spark' : 'exec-spark'} role="img" aria-label={label}><title>{label}</title><path d={path} /></svg>;
}
function MemberTile({ member, masked, seriesLabel, onOpen, anchor }: { member: ExecutiveWorkspaceMember; masked: boolean; seriesLabel: string; onOpen: () => void; anchor?: string }) {
  const state = memberRecordState(member);
  return (
    <button className={`exec-member ${state}`} data-exec-anchor={anchor ?? `member:${member.userId}`} onClick={onOpen} title={`${maskName(member.displayName, masked)} · ${MEMBER_STATE_REGISTRY[state].label}`}>
      <span className="exec-member-name"><StateGlyph state={state} /><span>{maskName(member.displayName, masked)}</span><span className="exec-inline-count">{member.hasActivity ? fmt(member.llmCalls, '次') : '—'}</span></span>
      <span className="exec-member-number"><NumberText value={member.hasActivity ? member.llmCalls : null} unit={member.hasActivity ? '次调用' : ''} /></span>
      <span className="exec-member-status">{MEMBER_STATE_REGISTRY[state].label}</span>
      <span className="exec-member-parts"><span>文档 <b>{member.docs}</b></span><span>图片 <b>{member.imagesDone}</b></span>{member.defectsBacklog > 0 && <span>积压 <b>{member.defectsBacklog}</b></span>}</span>
      {member.hasActivity && <span className="exec-member-series"><OutputSpark values={member.outputSeries} label={seriesLabel} /><span className="exec-series-caption">产出日序列</span></span>}
    </button>
  );
}

export default function TeamInsightsWorkspace({ data, loading, onOpenTab }: { data: TeamInsights | null; loading: boolean; onOpenTab?: (key: string) => void }) {
  const navigate = useNavigate();
  const [density, setDensity] = useState<Density>('auto');
  const [filter, setFilter] = useState<RecordFilter>('all');
  const [search, setSearch] = useState('');
  const masked = false;
  const [railOpen, setRailOpen] = useState(false);
  const [stack, setStack] = useState<Place[]>([{ kind: 'root' }]);
  const canvas = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef<number[]>([0]);
  const focusPositions = useRef<(string | undefined)[]>([]);
  const restoreFocus = useRef(false);
  const outerScrollPositions = useRef<number[]>([0]);
  const windowKey = data ? `${data.meta.from}:${data.meta.to}` : '';
  const [selectedWindow, setSelectedWindow] = useState(windowKey);
  // 将旧窗口的导航选择随已到达的新数据一起重置，不在请求期间冒用新窗口。
  const currentStack = selectedWindow === windowKey ? stack : [{ kind: 'root' } as Place];
  const place = currentStack[currentStack.length - 1];
  const model = useMemo(() => data ? executiveWorkspaceModel(data) : null, [data]);

  useEffect(() => {
    if (selectedWindow !== windowKey) {
      setSelectedWindow(windowKey);
      setStack([{ kind: 'root' }]);
      scrollPositions.current = [0];
      if (canvas.current) canvas.current.scrollTop = 0;
    }
  }, [windowKey, selectedWindow]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { restoreFocus.current = true; setStack(previous => previous.length > 1 ? previous.slice(0, -1) : previous); }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, []);
  useEffect(() => {
    if (!canvas.current) return;
    canvas.current.scrollTop = scrollPositions.current[currentStack.length - 1] ?? 0;
    const returning = restoreFocus.current;
    if (restoreFocus.current) {
      const anchor = focusPositions.current[currentStack.length - 1];
      Array.from(canvas.current.querySelectorAll<HTMLElement>('[data-exec-anchor]')).find(element => element.dataset.execAnchor === anchor)?.focus({ preventScroll: true });
      restoreFocus.current = false;
    } else if (currentStack.length > 1) {
      const heading = canvas.current.querySelector<HTMLElement>('.exec-view-heading h2');
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }
    if (window.innerWidth <= 760) {
      if (returning) {
        const host = outerScrollHost(canvas.current);
        if (host) host.scrollTop = outerScrollPositions.current[currentStack.length - 1] ?? 0;
      } else if (currentStack.length > 1) {
        canvas.current.closest('.exec-canvas-panel')?.scrollIntoView({ block: 'start', behavior: 'instant' });
      }
    }
  }, [place.kind, currentStack.length]);

  if (!data || !model) return <div className="exec-first-loading h-full min-h-0 flex flex-col" aria-busy={loading}>{loading ? <MapSectionLoader text="正在聚合团队洞察…" /> : <div className="exec-empty"><Users size={22} /><h2>暂无团队统计</h2><p>可调整时间范围，或使用刷新重新获取。</p></div>}</div>;

  const { members, byId, groups } = model;
  const windowLabel = buildWindowLabel(data.meta.days, data.meta.from, data.meta.to);
  const seriesLabel = data.workspace?.seriesLabel ?? '当前接口未提供成员日序列';
  const sourceNote = data.workspace?.groupNote ?? '当前接口未提供完整团队与无记录成员资料，仅展示已返回的成员。';
  const recordedCount = members.filter(member => member.hasActivity).length;
  const unavailableCount = data.workspace ? members.length - recordedCount : null;
  const attention = data.attention;
  const criticalCount = attention.filter(item => item.severity === 'critical').length;
  const summary = data.workspace?.summary ?? data.pulse.map(item => ({ key: item.key, label: item.label, value: item.value, unit: item.unit, note: item.note }));
  const query = search.trim().toLocaleLowerCase();
  const matches = (member: ExecutiveWorkspaceMember, groupName = '') => (filter === 'all' || (filter === 'record' ? member.hasActivity : !member.hasActivity)) && (!query || `${member.displayName} ${groupName} ${getRoleMeta(member.role).label}`.toLocaleLowerCase().includes(query));
  const labelFor = (entry: Place) => {
    if (entry.kind === 'group') return groups.find(group => group.id === entry.id)?.name ?? '团队';
    if (entry.kind === 'member') return maskName(byId.get(entry.id)?.displayName ?? '成员', masked);
    if (entry.kind === 'attention') return attention.find(item => item.key === entry.key)?.title ?? '关注事项';
    if (entry.kind === 'caller') return entry.name;
    return { root: '全部团队', report: '完整分析', notes: '数据口径' }[entry.kind];
  };
  const open = (next: Place) => {
    if (canvas.current) outerScrollPositions.current[currentStack.length - 1] = outerScrollHost(canvas.current)?.scrollTop ?? 0;
    focusPositions.current[currentStack.length - 1] = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-exec-anchor]')?.dataset.execAnchor;
    scrollPositions.current[currentStack.length - 1] = canvas.current?.scrollTop ?? 0;
    scrollPositions.current[currentStack.length] = 0;
    setStack([...currentStack, next]);
    setRailOpen(false);
  };
  const back = (index = currentStack.length - 2) => { if (index >= 0) { restoreFocus.current = true; setStack(currentStack.slice(0, index + 1)); } };
  const openMember = (member: ExecutiveWorkspaceMember, groupId?: string) => {
    if (groupId && place.kind === 'root') {
      if (canvas.current) outerScrollPositions.current[0] = outerScrollHost(canvas.current)?.scrollTop ?? 0;
      outerScrollPositions.current[1] = 0;
      focusPositions.current[0] = `member:${groupId}:${member.userId}`;
      focusPositions.current[1] = `member:${member.userId}`;
      scrollPositions.current[0] = canvas.current?.scrollTop ?? 0;
      scrollPositions.current[1] = 0; scrollPositions.current[2] = 0;
      setStack([{ kind: 'root' }, { kind: 'group', id: groupId }, { kind: 'member', id: member.userId }]);
    } else open({ kind: 'member', id: member.userId });
  };
  const openAttentionDestination = (item: TeamInsightAttention) => {
    if (item.linkTo === '/executive') { onOpenTab?.(item.key.startsWith('cost:') ? 'cost' : 'agents'); return; }
    if (item.linkTo.startsWith('/') && !item.linkTo.startsWith('//')) navigate(item.linkTo);
  };
  const renderMembers = (roster: ExecutiveWorkspaceMember[], groupId?: string) => roster.map(member => <MemberTile key={member.userId} member={member} masked={masked} seriesLabel={seriesLabel} anchor={groupId ? `member:${groupId}:${member.userId}` : undefined} onOpen={() => openMember(member, groupId)} />);
  const renderCaller = (node: TeamInsightFlowNode) => <button key={node.name} className="exec-caller" onClick={() => open({ kind: 'caller', name: node.name })}><span><span className="exec-glyph record" /><b>{node.name}</b><strong>{fmt(node.value, node.unit)}</strong></span><small>{node.hint ?? '平台调用方口径'} · {node.unit}</small></button>;

  const root = () => (
    <div className={`exec-root exec-density-${density}`}>
      <button className={`exec-headline ${data.headline.tone}`} title={data.headline.basis} onClick={() => attention.length ? open({ kind: 'attention', key: attention[0].key }) : open({ kind: 'report' })}><span>{windowLabel}速读</span><strong>{data.headline.text}</strong><ChevronRight size={15} /></button>
      <div className="exec-summary">{summary.slice(0, 6).map(item => <div key={item.key} title={item.note}><span>{item.label}</span><b><NumberText value={item.value} unit={item.unit} /></b></div>)}</div>
      <div className="exec-groups">{groups.map(group => {
        const roster = group.userIds.map(id => byId.get(id)).filter((member): member is ExecutiveWorkspaceMember => Boolean(member)).filter(member => matches(member, group.name));
        const limit = density === 'line' ? 24 : density === 'rows' ? 12 : 6;
        const visible = roster.slice(0, limit);
        return <section className="exec-group" key={group.id}><button className="exec-group-head" data-exec-anchor={`group:${group.id}`} onClick={() => open({ kind: 'group', id: group.id })}><strong>{group.name}</strong><small>{group.totalMembers} 人</small><span className="exec-group-counts"><span title="有产出或模型调用"><span className="exec-glyph record" />{group.activeMembers}</span><span title="暂无产出或模型调用"><span className="exec-glyph none" />{group.totalMembers - group.activeMembers}</span></span><ChevronRight size={15} /></button><div className="exec-tiles">{renderMembers(visible, group.id)}{!visible.length && <p className="exec-no-match">没有匹配成员</p>}</div><button className="exec-group-foot" onClick={() => open({ kind: 'group', id: group.id })}><span>{query || filter !== 'all' ? `匹配 ${roster.length} 人` : `分类共 ${group.totalMembers} 位成员`}</span><span>展开分类 →</span></button></section>;
      })}{!groups.length && <div className="exec-empty"><h2>尚无成员记录</h2><p>当前没有可展示的人工账号成员资料。</p></div>}</div>
      <section className="exec-callers"><header><h2>平台调用来源</h2><span>与成员调用口径不同</span><button onClick={() => onOpenTab?.('agents')}>Agent 明细 <ArrowUpRight size={13} /></button></header><div>{data.flow.mid.map(renderCaller)}{!data.flow.mid.length && <p className="exec-no-match">本窗暂无调用来源数据</p>}</div></section>
      <footer className="exec-source-note"><span>{sourceNote}</span><button onClick={() => open({ kind: 'notes' })}>数据口径与缺失项</button></footer>
    </div>
  );
  const groupView = (id: string) => {
    const group = groups.find(item => item.id === id);
    if (!group) return <div className="exec-empty">此团队已不在当前统计范围。</div>;
    const roster = group.userIds.map(userId => byId.get(userId)).filter((member): member is ExecutiveWorkspaceMember => Boolean(member)).filter(member => matches(member, group.name));
    return <div className="exec-category"><div className="exec-view-heading"><div><p>团队 · {group.totalMembers} 位成员 · {windowLabel}</p><h2>{group.name}</h2></div><span className="exec-state-pill record">{group.activeMembers} 人有产出或调用</span></div><div className="exec-category-grid">{renderMembers(roster)}</div>{!roster.length && <p className="exec-no-match">没有匹配成员，可清空搜索或切换“全部”。</p>}<p className="exec-source-note">{sourceNote}</p></div>;
  };
  const memberView = (id: string) => {
    const member = byId.get(id);
    if (!member) return <div className="exec-empty">此成员已不在当前统计范围。</div>;
    const state = memberRecordState(member);
    const profile = data.members.find(item => item.userId === id);
    const memberships = groups.filter(group => group.userIds.includes(id));
    const metrics = [{ label: '新增文档', value: member.docs }, { label: '创建站点', value: member.sites }, { label: '生成图片', value: member.imagesDone }, { label: '解决缺陷', value: member.defectsResolved }];
    return <div className="exec-detail"><div className="exec-view-heading"><div><p>{memberships.map(group => group.name).join(' / ')} · {windowLabel}</p><h2>{maskName(member.displayName, masked)}</h2></div><span className={`exec-state-pill ${state}`}><StateGlyph state={state} />{MEMBER_STATE_REGISTRY[state].short}</span></div><div className="exec-detail-main"><section className="exec-detail-card"><h3>模型调用</h3><div className="exec-detail-number"><NumberText value={member.llmCalls} unit="次" /></div><div className="exec-detail-metrics">{metrics.map(metric => <div key={metric.label}><span>{metric.label}</span><b>{fmt(metric.value, '')}</b></div>)}</div></section><section className="exec-detail-card"><h3>每日产出</h3><p className="exec-hint">{seriesLabel}</p><OutputSpark values={member.outputSeries} label={seriesLabel} large /></section><section className="exec-detail-card"><h3>内容与协作</h3><table className="exec-detail-table"><thead><tr><th>指标</th><th>数量</th><th>时间范围</th></tr></thead><tbody>{[{ label: '已提交周报', value: member.reports }, { label: '调用失败', value: member.llmErrors }, { label: '失败图片', value: member.imagesFailed }].map(metric => <tr key={metric.label}><td>{metric.label}</td><td>{fmt(metric.value, '')}</td><td>{windowLabel}</td></tr>)}<tr><td>缺陷积压（超过 7 天）</td><td>{member.defectsBacklog}</td><td>当前快照</td></tr></tbody></table></section></div><aside className="exec-detail-side"><section className="exec-detail-card"><h3>记录说明</h3><dl><dt>角色</dt><dd>{getRoleMeta(member.role).label}</dd><dt>Token</dt><dd>{fmt(member.tokens, 'tokens')}</dd><dt>成本</dt><dd>{member.pricedCalls === null ? '未提供定价覆盖资料' : member.pricedCalls === 0 ? '定价不足，暂不可计算' : `${fmt(member.cost, '元')} 元（${member.pricedCalls < member.llmCalls ? `部分估算：${member.pricedCalls}/${member.llmCalls} 次已定价` : '调用均已定价'}）`}</dd><dt>统计窗口</dt><dd>{windowLabel}</dd></dl></section>{profile && <section className="exec-detail-card"><h3>本窗要点</h3><ul>{profile.highlights.map(highlight => <li key={highlight}>{highlight}</li>)}</ul></section>}<section className="exec-detail-card"><h3>指标边界</h3><p>使用次数、产出数量和工作质量是不同概念。本视图不生成绩效评分。</p></section></aside></div>;
  };
  const attentionView = (key: string) => {
    const item = attention.find(entry => entry.key === key);
    if (!item) return <div className="exec-empty">当前窗口已没有这项关注事项。</div>;
    return <div className="exec-detail"><div className="exec-view-heading"><div><p>需要查看 · {windowLabel}</p><h2>{item.title}</h2></div><span className={`exec-state-pill ${SEVERITY[item.severity].className}`}>{SEVERITY[item.severity].label}</span></div><div className="exec-detail-main"><section className={`exec-detail-card exec-evidence ${SEVERITY[item.severity].className}`}><h3>事实与依据</h3><p>{item.evidence}</p></section><section className="exec-detail-card"><h3>建议下一步</h3><p>{item.suggestion}</p><button className="exec-action" onClick={() => openAttentionDestination(item)}>{item.linkLabel}<ArrowUpRight size={14} /></button></section></div><aside className="exec-detail-side"><section className="exec-detail-card"><h3>范围说明</h3><p>缺陷积压反映当前仍未关闭的状态；窗口内的生成、调用和产出按所选统计范围读取。</p></section></aside></div>;
  };
  const callerView = (name: string) => {
    const node = data.flow.mid.find(item => item.name === name);
    return <div className="exec-category"><div className="exec-view-heading"><div><p>平台调用来源 · {windowLabel}</p><h2>{name}</h2></div></div><section className="exec-detail-card"><h3>模型调用</h3><div className="exec-detail-number"><NumberText value={node?.value ?? null} unit={node?.unit ?? '次'} /></div><p>{node?.hint}</p><p className="exec-hint">按平台调用方聚合，可能包含非人工账号调用，与成员卡片和团队摘要的人工账号口径不同。</p><button className="exec-action" onClick={() => onOpenTab?.('agents')}>查看 Agent 明细<ArrowUpRight size={14} /></button></section></div>;
  };
  const notes = () => <div className="exec-category"><div className="exec-view-heading"><div><p>{windowLabel} · 数据来源与范围</p><h2>数据口径</h2></div></div><div className="exec-note-grid"><section className="exec-detail-card"><h3>团队与成员</h3><p>{sourceNote}</p><p className="exec-hint">“有记录”指本窗存在可统计产出或模型调用。暂无记录不表示系统异常，也不是绩效判断。</p></section><section className="exec-detail-card"><h3>每日产出</h3><p>{seriesLabel}。按文档创建、站点创建、周报提交、完成的生图任务与缺陷解决逐日计数。</p><p className="exec-hint">长窗口仅显示末尾最多 30 天的日序列，卡片累计值仍按完整统计窗口。</p></section><section className="exec-detail-card"><h3>尚未纳入的指标</h3>{data.meta.unavailable.map(item => <p key={item.metric}><b>{item.metric}：</b>{item.reason}</p>)}</section><section className="exec-detail-card"><h3>成本覆盖</h3><p>{data.workspace ? `${data.workspace.costCoverage.totalCalls.toLocaleString()} 条调用中，有 ${data.workspace.costCoverage.pricedCalls.toLocaleString()} 条可按已配置单价估算。` : '当前接口未提供完整定价覆盖情况。'}</p><p>缺失定价不显示为零成本。</p></section>{data.meta.sources.map(source => <section className="exec-detail-card" key={source.metric}><h3>{source.metric}</h3><p>{source.source}</p></section>)}</div></div>;
  const views = { root, group: () => place.kind === 'group' && groupView(place.id), member: () => place.kind === 'member' && memberView(place.id), attention: () => place.kind === 'attention' && attentionView(place.key), caller: () => place.kind === 'caller' && callerView(place.name), report: () => <div className="exec-report"><TeamInsightsPanel data={data} loading={loading} /></div>, notes };

  return <div className="exec-workspace h-full min-h-0 flex flex-col" aria-busy={loading}>
    <div className="exec-workspace-toolbar"><label className="exec-search"><Search size={16} /><input type="search" aria-label="搜索成员或团队" placeholder="搜索成员、团队" value={search} onChange={event => { setSearch(event.target.value); setStack([{ kind: 'root' }]); }} /></label><div className="exec-filters" role="group" aria-label="成员记录筛选"><button className={filter === 'all' ? 'on' : ''} onClick={() => { setFilter('all'); setStack([{ kind: 'root' }]); }}><b>{data.meta.totalMembers}</b>成员</button><button className={filter === 'record' ? 'on' : ''} onClick={() => { setFilter('record'); setStack([{ kind: 'root' }]); }}><span className="exec-glyph record" /><b>{recordedCount}</b>有记录</button><button className={filter === 'none' ? 'on' : ''} title={data.workspace ? '本窗没有可统计产出或模型调用' : '当前接口未提供无记录成员资料'} onClick={() => { setFilter('none'); setStack([{ kind: 'root' }]); }}><span className="exec-glyph none" /><b>{unavailableCount ?? '—'}</b>暂无</button></div><div className="exec-density"><span>密度</span><div role="group" aria-label="显示密度">{DENSITIES.map(option => <button key={option.key} className={density === option.key ? 'on' : ''} aria-pressed={density === option.key} onClick={() => setDensity(option.key)}>{option.label}</button>)}</div></div></div>
    <div className="exec-workspace-layout"><section className="exec-canvas-panel"><nav className="exec-crumbs" aria-label="团队洞察导航"><button disabled={currentStack.length === 1} onClick={() => back()}><ArrowLeft size={15} />返回</button>{currentStack.map((entry, index) => <span className="exec-crumb-item" key={`${entry.kind}:${index}`}><span>/</span>{index === currentStack.length - 1 ? <strong title={labelFor(entry)}>{labelFor(entry)}</strong> : <button onClick={() => back(index)}>{labelFor(entry)}</button>}</span>)}<span className="exec-canvas-window" title={`${data.meta.from ?? '历史起点'} 至 ${data.meta.to}`}>{windowLabel}</span><button className="exec-report-link" onClick={() => open({ kind: 'report' })}><LayoutGrid size={13} />完整分析</button></nav><div className="exec-canvas" ref={canvas} key={windowKey} style={{ overscrollBehavior: 'contain' }}><div className="exec-view" key={`${place.kind}:${labelFor(place)}`}>{views[place.kind]()}</div></div></section>
      <aside className={`exec-attention-rail ${railOpen ? 'open' : ''}`}><button className="exec-rail-heading" onClick={() => setRailOpen(previous => !previous)} aria-expanded={railOpen}><h2>需要查看</h2><span className="failed">{criticalCount} 项待处理</span><span className="backlog">{attention.length - criticalCount} 项观察</span><ChevronDown size={15} /></button><section className="exec-participation"><header><b>参与概览</b><span>当前窗口</span></header><div className="exec-participation-row"><span /><span>有记录</span><span>暂无</span></div>{groups.map(group => <button className="exec-participation-row" key={group.id} onClick={() => open({ kind: 'group', id: group.id })}><span>{group.name}</span><b>{group.activeMembers}</b><span className="exec-no-record-count">{group.totalMembers - group.activeMembers}</span></button>)}<p>成员可属于多个团队，分类人数不直接相加。</p></section><div className="exec-attention-list" style={{ overscrollBehavior: 'contain' }}>{attention.map(item => <button key={item.key} className={`exec-attention ${SEVERITY[item.severity].className} ${place.kind === 'attention' && place.key === item.key ? 'selected' : ''}`} onClick={() => open({ kind: 'attention', key: item.key })}><span><span className={`exec-glyph ${SEVERITY[item.severity].className}`} /><strong>{item.title}</strong></span><p>{masked ? '包含成员信息，展开详情查看；分享前请核对。' : item.evidence}</p><small>查看依据与下一步<ChevronRight size={12} /></small></button>)}{!attention.length && <div className="exec-rail-empty">当前窗口未触发关注规则。</div>}</div><footer className="exec-rail-foot"><Info size={14} /><p>所有数字来自实际统计。缺失项保留“—”，暂无产出或调用不标成异常。</p><button onClick={() => open({ kind: 'notes' })}>查看口径</button></footer></aside>
    </div>
  </div>;
}
