import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowRight, BookOpen, ChevronRight, Copy, Plug, Plus, RefreshCw, Search, ShieldCheck, Settings2, Activity, SlidersHorizontal, Image, PenLine, Clock3, History } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { PrdLoader } from '@/components/ui/PrdLoader';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { getMcpConsoleOverview } from '@/services';
import type { McpCapabilityDto, McpClientDto, McpConsoleOverviewDto } from '@/services/contracts/mcpConsole';
import { toast } from '@/lib/toast';
import { ConnectAgentDialog } from './ConnectAgentDialog';
import { McpCallsPanel } from './McpCallsPanel';
import { MapAgentSkillPanel, useMapAgentSkillManifest } from './MapAgentSkillPanel';
import { QuotaEditorDialog } from './QuotaEditorDialog';
import { RevokeClientDialog } from './RevokeClientDialog';
import { copyToClipboard } from './clipboard';
import { capabilityVisual } from './capabilityRegistry';
import { grantableToolCount } from './scopePlan';
import { clientSignal } from './signalEncoding';
import { clientVisual } from './clientVisualRegistry';
import { McpSummaryRail } from './McpSummaryRail';
import { secureSameSiteEndpoint } from './endpointUrl';
import { McpCallTrendChart } from './McpCallTrendChart';
import './mcp-console.css';
import { accessLabel } from './editAuthorization';

type Tab = 'clients' | 'calls' | 'settings';
const TABS: Array<{ key: Tab; label: string; icon: typeof Plug }> = [{ key: 'clients', label: '客户端', icon: Plug }, { key: 'calls', label: '调用记录', icon: Activity }, { key: 'settings', label: '接入配置', icon: Settings2 }];

/** Reuses the authenticated app shell, backend capability catalog and key lifecycle. */
export default function McpConsolePage() {
  const [overview, setOverview] = useState<McpConsoleOverviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('clients');
  const [quotaTarget, setQuotaTarget] = useState<McpClientDto | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<McpClientDto | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [callsKeyId, setCallsKeyId] = useState('');
  const [callsStatus, setCallsStatus] = useState('');
  const [callsView, setCallsView] = useState(0);
  const [search, setSearch] = useState('');
  const [clientsExpanded, setClientsExpanded] = useState(true);
  const [filter, setFilter] = useState('all');
  const loadGenRef = useRef(0);
  const skillState = useMapAgentSkillManifest();

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current;
    try {
      const res = await getMcpConsoleOverview();
      if (gen !== loadGenRef.current) return;
      if (!res.success || !res.data) {
        setLoadError(res.error?.message || '未能加载接入数据，请稍后重试。');
        return;
      }
      setLoadError(null);
      setOverview({ ...res.data, endpointUrl: secureSameSiteEndpoint(res.data.endpointUrl, window.location.origin) });
    } catch {
      if (gen === loadGenRef.current) setLoadError('连接中断，请检查网络后重试。');
    } finally {
      if (gen === loadGenRef.current) setLoading(false);
    }
  }, []);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); setRefreshToken(n => n + 1); } finally { setRefreshing(false); }
  }, [load]);
  useEffect(() => { void load(); }, [load]);
  const clients = useMemo(() => overview?.clients ?? [], [overview]);
  const capabilities = useMemo(() => overview?.capabilities ?? [], [overview]);
  const visibleClients = useMemo(() => clients.filter(client => {
    const matches = `${client.name} ${client.keyPrefix}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
    return matches && (filter === 'all' || (filter === 'active' && client.isActive) || (filter === 'unavailable' && !client.isActive) || (filter === 'manual' && client.scopeMode === 'manual') || (filter.startsWith('cap:') && client.isActive && clientSignal(client, capabilities).dots.some(cap => cap.key === filter.slice(4) && cap.tier !== 'none')));
  }), [clients, search, filter, capabilities]);
  const viewCalls = (status = '', keyId = '') => { setCallsKeyId(keyId); setCallsStatus(status); setCallsView(n => n + 1); setTab('calls'); };

  if (loading) return <div className="flex h-full items-center justify-center"><PrdLoader size={44} /></div>;
  if (!overview) return <div className="mcp-load-error"><ShieldCheck size={26} aria-hidden /><h1>接入数据暂时不可用</h1><p>{loadError} 已有授权和调用记录不会因此丢失。</p><button className="mcp-button mcp-primary" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? '正在重试…' : '重新加载'}</button></div>;
  const today = overview.today;


  return <div className="mcp-console flex min-h-full flex-col lg:h-full lg:min-h-0">
    <header className="mcp-header">
      <h1 className="shrink-0 whitespace-nowrap"><Plug size={19} aria-hidden />智能体接入台</h1>
      <div className="mcp-tabs" role="tablist" aria-label="接入管理视图">{TABS.map(item => <button type="button" role="tab" key={item.key} aria-selected={tab === item.key} onClick={() => item.key === 'calls' ? viewCalls() : setTab(item.key)}>{<item.icon size={13} aria-hidden />}{item.label}{item.key === 'clients' && <span>{clients.length}</span>}</button>)}</div>
      <div className="mcp-header-actions">
        <Button size="sm" aria-label={refreshing ? '正在刷新' : '刷新'} disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden className={refreshing ? 'animate-spin' : undefined} /><span className="hidden lg:inline">刷新</span></Button>
        <Button size="sm" aria-label="接入指南" className="mcp-guide-button" onClick={() => setGuideOpen(true)}><BookOpen size={14} aria-hidden />接入指南</Button>
        <Button size="sm" variant="primary" onClick={() => setConnectOpen(true)}><Plus size={14} aria-hidden />接入客户端</Button>
      </div>
    </header>
    <section className="mcp-summary" aria-label="今日概览">
      <strong>已接入 {clients.length} 个客户端，今天调用 {today.calls} 次。</strong>
      <span>生图 {today.images} 张 · 写入 {today.writes} 次 · 今日统计与额度按 UTC 自然日计算</span>
      <McpCallTrendChart trend={overview.callTrend} />
    </section>
    {loadError && <div className="mcp-alert" role="alert"><AlertTriangle size={16} aria-hidden /><span>刷新失败：{loadError} 当前保留上次加载的数据。</span><button onClick={() => void refresh()} disabled={refreshing}>重试</button></div>}
    {(today.failed > 0 || today.denied > 0) && <div className="mcp-alert"><AlertTriangle size={17} aria-hidden /><span>{today.failed > 0 && <>今日有 <b>{today.failed} 次</b>调用失败</>}{today.failed > 0 && today.denied > 0 && '；'}{today.denied > 0 && <>{today.denied} 次被权限或额度限制拦截</>}</span>{today.failed > 0 && <button onClick={() => viewCalls('error')}>查看失败记录<ArrowRight size={14} aria-hidden /></button>}{today.denied > 0 && <button onClick={() => viewCalls('denied')}>查看被拦截记录<ChevronRight size={14} aria-hidden /></button>}</div>}
    {tab === 'calls' ? <div className="mcp-tab-content lg:min-h-0 lg:flex-1"><McpCallsPanel key={callsView} clients={clients} refreshToken={refreshToken} initialStatus={callsStatus} initialKeyId={callsKeyId} onAuthorized={() => void refresh()} /></div> : tab === 'settings' ? <div className="mcp-settings lg:min-h-0 lg:flex-1 lg:overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
      <section className="mcp-settings-section"><h2 className="shrink-0">连接地址</h2><p>所有客户端使用同一个 MCP 地址，每个客户端使用独立的接入凭证。</p><code>{overview.endpointUrl}</code><div className="mcp-inline-actions"><button className="mcp-button" onClick={async () => { if (await copyToClipboard(overview.endpointUrl)) toast.success('连接地址已复制'); else toast.error('复制失败，请手动复制连接地址'); }}><Copy size={14} aria-hidden />复制地址</button><button className="mcp-button mcp-primary" onClick={() => setConnectOpen(true)}><Plus size={14} aria-hidden />接入客户端</button></div><p>配置中的凭证仅在创建时显示一次。已有客户端无需重新配置。</p></section>
      <section className="mcp-settings-section"><h2 className="shrink-0">平台能力</h2><p>能力和可授权范围由你的系统权限决定。未拥有的权限无法授予客户端。</p><div className="mcp-capability-catalog">{capabilities.map(cap => { const Icon = capabilityVisual(cap.key).icon; return <details key={cap.key}><summary><Icon size={17} aria-hidden /><strong>{cap.title}</strong><span>{cap.availableToMe ? `${grantableToolCount(cap)} 个可授权工具` : '当前账号无权授权'}</span><ChevronRight size={14} aria-hidden /></summary><p>{cap.summary}</p>{cap.tools.map(tool => <div className="mcp-tool" key={tool.name}><code>{tool.name}</code><span>{tool.description}</span></div>)}</details>; })}</div></section>
      <MapAgentSkillPanel state={skillState} endpointUrl={overview.endpointUrl} />
      <section className="mcp-settings-section"><h2 className="shrink-0">配置说明</h2><p>点击“接入客户端”，填写名称后即可复制 Codex、WorkBuddy、Claude Code 或 Claude Desktop 配置。默认跟随你的权限，也可在高级设置中自定义授权。</p><p>在 AI 客户端发起任务后，可通过“调用记录”查看执行结果和产物。停止授权请在客户端的“管理”中撤销接入，历史记录会保留。</p><button className="mcp-button" onClick={() => setGuideOpen(true)}><BookOpen size={14} aria-hidden />查看接入指南</button></section>
    </div> : <div className="mcp-client-workspace lg:min-h-0 lg:flex-1"><div className="mcp-client-area lg:min-h-0 lg:overflow-y-auto"><div className="mcp-client-content lg:min-h-0">
      <div className="mcp-section-heading"><button type="button" aria-expanded={clientsExpanded} aria-controls="mcp-clients-list" onClick={() => setClientsExpanded(value => !value)}><ChevronRight size={14} className={clientsExpanded ? 'rotate-90' : undefined} aria-hidden />已接入客户端 <span>{clients.length}</span></button><button onClick={() => setClientsExpanded(value => !value)}>{clientsExpanded ? '收起客户端' : '展开客户端'}</button></div>
      <div id="mcp-clients-list" hidden={!clientsExpanded}>
      <div className="mcp-list-toolbar"><label className="mcp-search"><Search size={15} aria-hidden /><input aria-label="搜索客户端名称或凭证前缀" placeholder="搜索名称或凭证前缀" value={search} onChange={e => setSearch(e.target.value)} /></label><select aria-label="筛选客户端" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部客户端</option><option value="active">凭证可用</option><option value="unavailable">凭证不可用</option><option value="manual">自定义授权</option><optgroup label="按能力筛选">{capabilities.map(cap => <option key={cap.key} value={`cap:${cap.key}`}>{cap.title}授权</option>)}</optgroup></select><span className="mcp-list-hint">已接入不代表在线，工具调用以本环境日志为准</span></div>
      <div className="mcp-client-list" style={{ overscrollBehavior: 'contain' }} role="list" aria-label="已接入客户端">

        {visibleClients.length ? visibleClients.map(client => <ClientRow key={client.keyId} client={client} capabilities={capabilities} onEditQuota={() => setQuotaTarget(client)} onHistory={() => viewCalls('', client.keyId)} />) : <div className="mcp-empty"><Plug size={30} aria-hidden /><h2 className="shrink-0">{clients.length ? '没有匹配的客户端' : '当前没有已接入的客户端'}</h2><p>{clients.length ? '试试其他名称或调整筛选条件。' : overview.hasHistory ? '历史调用记录仍然保留，可以查看记录或重新接入。' : '接入 Codex 或 Claude Code，让 AI 使用你在平台上的能力。'}</p>{clients.length ? <button className="mcp-button" onClick={() => { setSearch(''); setFilter('all'); }}>清除筛选</button> : <div className="mcp-inline-actions"><button className="mcp-button mcp-primary" onClick={() => setConnectOpen(true)}>接入客户端</button>{overview.hasHistory && <button className="mcp-button" onClick={() => viewCalls()}>查看调用记录</button>}</div>}</div>}
      </div>
      <footer className="mcp-list-footer"><span>共 {visibleClients.length} 个客户端{filter !== 'all' || search ? `（全部 ${clients.length} 个）` : ''}</span><button onClick={() => setGuideOpen(true)}>首次使用 MCP？查看接入指南<ArrowRight size={13} aria-hidden /></button></footer>
      </div>
      </div>
    </div><McpSummaryRail overview={overview} onCalls={viewCalls} onCapability={key => { setClientsExpanded(true); setSearch(''); setFilter(`cap:${key}`); }} onSettings={() => setTab('settings')} /></div>}
    <QuotaEditorDialog client={quotaTarget} open={quotaTarget !== null} capabilities={capabilities} onOpenChange={next => { if (!next) setQuotaTarget(null); }} onSaved={load} onRevoke={() => { setRevokeTarget(quotaTarget); setQuotaTarget(null); }} />
    <RevokeClientDialog client={revokeTarget} open={revokeTarget !== null} onOpenChange={next => { if (!next) setRevokeTarget(null); }} onRevoked={() => void load()} />
    <ConnectAgentDialog skillState={skillState} open={connectOpen} onOpenChange={setConnectOpen} capabilities={capabilities} endpointUrl={overview.endpointUrl} onCreated={() => void load()} />
    <Dialog open={guideOpen} onOpenChange={setGuideOpen} title="接入 AI 客户端" maxWidth={520} content={<div className="mcp-guide"><p>让 Codex、Claude Code 等 AI 客户端通过 MCP 使用你在平台上的能力。</p>{[{ title: '创建客户端，复制配置', text: '点击“接入客户端”填写名称，系统会生成独立凭证及客户端配置。凭证仅显示一次，请及时保存。' }, { title: '将配置添加到 AI 客户端', text: '按接入窗口中的 Claude Code、Claude Desktop 或 Codex 配置说明操作。默认授权跟随你的系统权限，可随时在“管理”中调整。' }, { title: '发起任务，查看执行结果', text: '在客户端中发起任务，返回“调用记录”检查结果。失败或被拦截的调用会显示原因和后续操作。' }].map((step, index) => <div className="mcp-guide-step" key={step.title}><span>{index + 1}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></div>)}<button className="mcp-button mcp-primary" onClick={() => { setGuideOpen(false); setConnectOpen(true); }}>接入客户端<ArrowRight size={14} aria-hidden /></button></div>} />
  </div>;
}

export function ClientRow({ client, capabilities, onEditQuota, onHistory }: { client: McpClientDto; capabilities: McpCapabilityDto[]; onEditQuota: () => void; onHistory?: () => void }) {
  const signal = clientSignal(client, capabilities);
  const missing = client.missingCapabilities ?? [];
  const unavailable = !client.isActive ? client.unusableReason === 'expired' ? '已过期' : '已停用' : null;
  const identity = clientVisual(client.name);
  const IdentityIcon = identity.icon;
  const ModeIcon = signal.pinned ? SlidersHorizontal : ShieldCheck;
  return <div className="mcp-client-row" data-manual={signal.pinned} data-unavailable={!client.isActive} role="listitem" style={{ flexShrink: 0 }}>
    <div className="mcp-client-top">
      <div className="mcp-client-identity"><span className="mcp-client-avatar" style={{ color: identity.text, background: identity.soft }} title="按客户端名称匹配的图标"><IdentityIcon size={20} aria-hidden /></span><div className="mcp-client-heading"><strong>{client.name}</strong><span className="mcp-client-mode" data-manual={signal.pinned}><ModeIcon size={11} aria-hidden />{signal.pinned ? '自定义授权' : '跟随我的权限'}</span>{unavailable && <span className="mcp-unavailable">{unavailable}</span>}</div></div>
      <code className="mcp-key-prefix" title="凭证前缀：用于区分同名客户端">{client.keyPrefix}…</code>
      <Button size="sm" onClick={onEditQuota} aria-label={`管理 ${client.name} ${client.keyPrefix}`}><Settings2 size={13} aria-hidden />管理</Button>
    </div>
    <div className="mcp-client-capabilities" aria-label="授权范围">{signal.dots.map(cap => {
      const visual = capabilityVisual(cap.key);
      const Icon = visual.icon;
      const granted = cap.tier !== 'none';
      const definition = capabilities.find(item => item.key === cap.key);
      const label = cap.tier === 'full' ? '已开放' : accessLabel({ key: cap.key, writeScope: definition?.writeScope }, cap.tier);
      return <span className="mcp-capability-label" data-tier={cap.tier} key={cap.key} style={granted ? { color: visual.text, background: visual.soft, borderColor: visual.border } : undefined}><Icon size={12} aria-hidden />{cap.title}<span>{label}</span></span>;
    })}{signal.extraScopes.length > 0 && <span className="mcp-extra-scopes">另有 {signal.extraScopes.length} 项独立接口</span>}</div>
    <div className="mcp-client-bottom"><div className="mcp-client-usage"><span><Image size={12} aria-hidden />生图 <b>{client.todayImages}</b> / {client.dailyImageQuota} 张</span><span><PenLine size={12} aria-hidden />写入 <b>{client.todayWrites}</b> / {client.dailyWriteQuota} 次</span></div><div className="mcp-client-last">{onHistory && <button className="mcp-client-history" onClick={onHistory} aria-label={`查看 ${client.name} ${client.keyPrefix} 的历史`}><History size={13} aria-hidden />历史</button>}<Clock3 size={11} aria-hidden />今日 {client.todayCalls} 次 · {client.lastUsedAt ? <>凭证最近使用 <RelativeTime value={client.lastUsedAt} refreshIntervalMs={0} /></> : '凭证尚未使用'}</div></div>
    {missing.length > 0 && <p className="mcp-missing">另有 {missing.length} 项能力可在“管理”中开放。</p>}
  </div>;
}
