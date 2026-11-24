import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { buildLogListHref } from '@/lib/logNavigation';
import './GovernancePage.css';
import { Server, Cpu, Tags, Shuffle, KeyRound } from 'lucide-react';
import { bulkClaimConfigAuthority, getPlatforms, getModels, getGatewayAppCallers, getExchanges, getKeyHealth, getConfigAuthorityReport, getProtocolCoverage } from '@/lib/api';
import type { ApiResponse, PlatformItem, ModelItem, ExchangeItem, KeyHealthSummary, ConfigAuthoritySummary, ProtocolCoverageData } from '@/lib/types';
import { Button, Card, InlineAlert, ReadOnlyNotice, SectionLoader } from '@/components/ui';
import { HelpPopover, PageBody, PageHeader, PageShell } from '@/components/PageShell';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';
import { CARD_BODY, GAP } from '@/lib/surface';
import { BODY_TEXT, METRIC_CAPTION, METRIC_VALUE, SECTION_TITLE } from '@/lib/typography';

async function readable<T>(request: Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
  return request.catch(() => ({ success: false, data: null, error: { code: 'NETWORK_ERROR', message: '状态读取中断，请重试' } }));
}

export function GovernancePage() {
  const { tenant } = useAuth();
  const canWrite = canUseCapability(tenant?.role, 'configWrite');
  const [platforms, setPlatforms] = useState<PlatformItem[] | null>(null);
  const [models, setModels] = useState<ModelItem[] | null>(null);
  const [exchanges, setExchanges] = useState<ExchangeItem[] | null>(null);
  const [keyHealth, setKeyHealth] = useState<KeyHealthSummary | null>(null);
  const [configAuthority, setConfigAuthority] = useState<ConfigAuthoritySummary | null>(null);
  const [protocolCoverage, setProtocolCoverage] = useState<ProtocolCoverageData | null>(null);
  const [appCallerTotal, setAppCallerTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importUncertain, setImportUncertain] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set());
  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRefreshing(true); setError(null);
    // 每个 slice 失败也置空数组（而非留 null）→ loading 一定会收敛、不卡 spinner；成功的部分照常渲染局部数据。
    // 「success 但 body 缺字段」也要兜：否则 setX(undefined) 会绕过 `=== null` 的 loading 判定，
    // 直接渲染并在 keyHealth!.status 上抛错，整页白屏。
    Promise.all([readable(getPlatforms()), readable(getModels()), readable(getExchanges()), readable(getKeyHealth()), readable(getConfigAuthorityReport()), readable(getProtocolCoverage({ sinceHours: 24 })), readable(getGatewayAppCallers({ page: 1, pageSize: 1 }))]).then(
      ([platformsRes, modelsRes, exchangesRes, keyHealthRes, authorityRes, protocolCoverageRes, appCallersRes]) => {
        if (!alive) return;
        const failed = new Set<string>();
        const unavailableSlice = (key: string, message?: string) => { failed.add(key); setError(current => current || message || '部分状态响应不完整'); };
        if (platformsRes.success && Array.isArray(platformsRes.data?.items)) setPlatforms(platformsRes.data.items); else { setPlatforms([]); unavailableSlice('platforms', platformsRes.error?.message); }
        if (modelsRes.success && Array.isArray(modelsRes.data?.items)) setModels(modelsRes.data.items); else { setModels([]); unavailableSlice('models', modelsRes.error?.message); }
        if (exchangesRes.success && Array.isArray(exchangesRes.data?.items)) setExchanges(exchangesRes.data.items); else { setExchanges([]); unavailableSlice('exchanges', exchangesRes.error?.message); }
        if (keyHealthRes.success && keyHealthRes.data?.summary) setKeyHealth(keyHealthRes.data.summary); else { setKeyHealth(emptyKeyHealth()); unavailableSlice('keys', keyHealthRes.error?.message); }
        if (authorityRes.success && authorityRes.data?.summary) setConfigAuthority(authorityRes.data.summary); else { setConfigAuthority(emptyConfigAuthority()); unavailableSlice('authority', authorityRes.error?.message); }
        if (protocolCoverageRes.success && Array.isArray(protocolCoverageRes.data?.items)) setProtocolCoverage(protocolCoverageRes.data); else { setProtocolCoverage(emptyProtocolCoverage()); unavailableSlice('protocols', protocolCoverageRes.error?.message); }
        if (appCallersRes.success && Number.isFinite(appCallersRes.data?.total)) setAppCallerTotal(appCallersRes.data.total); else { setAppCallerTotal(0); unavailableSlice('callers', appCallersRes.error?.message); }
        setUnavailable(failed);
        if (importUncertain && !['platforms', 'models', 'exchanges', 'authority'].some(key => failed.has(key))) { setImportUncertain(false); setActionMessage('已重新读取配置，请按当前状态核对导入结果。'); }
      },
    ).catch((err) => {
      // Promise.all/then 里抛错也要收敛 loading（否则永远转圈）。
      if (!alive) return;
      setPlatforms((p) => p ?? []); setModels((p) => p ?? []); setExchanges((p) => p ?? []); setKeyHealth((p) => p ?? emptyKeyHealth()); setConfigAuthority((p) => p ?? emptyConfigAuthority()); setProtocolCoverage((p) => p ?? emptyProtocolCoverage()); setAppCallerTotal((p) => p ?? 0);
      setUnavailable(new Set(['platforms', 'models', 'exchanges', 'keys', 'authority', 'protocols', 'callers']));
      setError((e) => e || (err instanceof Error ? err.message : '加载失败'));
    }).finally(() => { if (alive) setRefreshing(false); });
    return () => { alive = false; };
  }, [refresh]);

  async function claimMapOnlyConfig() {
    if (!canWrite || busyAction || importUncertain || refreshing) return;
    setBusyAction('bulk-claim-authority'); setActionMessage(null);
    try {
      const res = await bulkClaimConfigAuthority({ overwrite: false });
      if (!res.success) {
        if (['FORBIDDEN', 'UNAUTHORIZED', 'INVALID_INPUT'].includes(res.error.code)) setActionMessage(res.error.message || '导入被拒绝');
        else { setImportUncertain(true); setActionMessage('导入结果未确认，可能已有部分配置生效。请刷新状态核对，勿直接重复导入。'); }
        return;
      }
      setActionMessage(`已导入 ${res.data.claimedTotal} 个配置，跳过 ${res.data.skippedTotal} 个已存在配置`);
      setRefresh(value => value + 1);
    } catch { setImportUncertain(true); setActionMessage('导入结果未确认，请刷新状态核对，勿直接重复导入。'); }
    finally { setBusyAction(null); }
  }


  const loading = platforms === null || models === null || exchanges === null || keyHealth === null || configAuthority === null || protocolCoverage === null || appCallerTotal === null;
  // 完全没加载出来（都还 null）时才整屏报错/转圈；有部分数据则进入下方渲染，用顶部横幅提示失败（不掩盖故障）。
  if (loading && error) return <Empty text={error} />;
  if (loading) return <SectionLoader text="正在加载网关概览…" />;

  const enabledPlatforms = platforms!.filter((p) => p.enabled).length;
  const enabledModels = models!.filter((m) => m.enabled).length;
  const enabledExchanges = exchanges!.filter((x) => x.enabled).length;
  const keyHealthTone = keyHealth!.status === 'ok' ? 'var(--ok)' : keyHealth!.status === 'unreadable' ? 'var(--err)' : 'var(--warn)';
  const mapOnlyTotal = configAuthority!.mapOnlyPlatforms + configAuthority!.mapOnlyModels + configAuthority!.mapOnlyExchanges;
  return (
    <PageShell>
      <PageHeader title="系统运维" subtitle="查看配置、密钥和协议请求状态。" actions={<Button variant="ghost" disabled={refreshing || busyAction !== null} onClick={() => setRefresh(value => value + 1)}>{refreshing ? '正在读取…' : '刷新状态'}</Button>} />

      <PageBody>
        {/* 部分接口失败：明示故障，避免「计数为 0」被误读为网关健康 */}
        {error ? <InlineAlert tone="error">部分接口加载失败，计数可能不完整：{error}</InlineAlert> : null}
        {actionMessage ? <InlineAlert tone="info">{actionMessage}</InlineAlert> : null}

        <ProtocolCoveragePanel coverage={protocolCoverage!} unavailable={unavailable.has('protocols')} />

        {/* 配置概览计数 */}
        <div className="lg-governance-config-facts">
          <StatCard icon={<Server size={16} />} label="上游" value={unavailable.has('platforms') ? '未知' : `${enabledPlatforms}/${platforms!.length}`} sub="启用/总数" to="/platforms" />
          <StatCard icon={<Tags size={16} />} label="调用方" value={unavailable.has('callers') ? '未知' : `${appCallerTotal}`} sub="GW 已发现注册项" to="/app-callers" />
          <StatCard icon={<Cpu size={16} />} label="上游模型" value={unavailable.has('models') ? '未知' : `${enabledModels}/${models!.length}`} sub="启用/总数" to="/models" />
          <StatCard icon={<Shuffle size={16} />} label="Exchange" value={unavailable.has('exchanges') ? '未知' : `${enabledExchanges}/${exchanges!.length}`} sub="启用/总数" to="/exchanges" />
          <StatCard
            icon={<KeyRound size={16} />}
            label="密钥自检"
            value={keyHealthLabel(keyHealth!)}
            sub={unavailable.has('keys') ? '状态未读取，请刷新核实' : `${keyHealth!.ok} 可解 · ${keyHealth!.unreadable} 不可解 · ${keyHealth!.missing} 缺省`}
            to="/platforms"
            color={keyHealthTone}
          />
        </div>

        <Card style={{ ...CARD_BODY, display: 'flex', alignItems: 'center', gap: GAP.section, flexWrap: 'wrap' }}>
          <span style={SECTION_TITLE}>调用方路由</span>
          <span style={BODY_TEXT}>{configAuthority!.status === 'unknown' ? '调用方默认模型状态暂不可用' : configAuthority!.activeMissingGatewayPool > 0 ? `${configAuthority!.activeMissingGatewayPool} 个已登记为启用的调用方缺少可用默认模型（未指定 model 时无法解析）` : configAuthority!.activeAppCallers > 0 ? '已登记为启用的调用方默认模型可解析' : '当前没有登记为启用的调用方（不代表没有请求）'}</span>
          <Link to="/app-callers?status=active" className="lg-secondary-action">查看调用方</Link>
          <Link to="/logical-models" className="lg-secondary-action">{canWrite ? '设置模型与默认项' : '查看模型与默认项'}</Link>
          {mapOnlyTotal > 0 ? <>
            <span style={BODY_TEXT}>有 {mapOnlyTotal} 项已有 MAP 配置可导入</span>
            <HelpPopover label="导入已有配置">将已有上游、模型与转接配置复制到网关；保留密钥，跳过已存在的配置。</HelpPopover>
            {canWrite ? <Button size="sm" variant="secondary" disabled={refreshing || busyAction !== null || importUncertain} onClick={() => void claimMapOnlyConfig()}>{busyAction ? '导入中…' : '导入已有配置'}</Button> : null}
          </> : null}
        </Card>
        {!canWrite ? <ReadOnlyNotice>当前角色可以查看状态；修改配置需要管理员权限。</ReadOnlyNotice> : null}

      </PageBody>
    </PageShell>
  );
}

const cardHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: GAP.normal,
  flexWrap: 'wrap',
  marginBottom: GAP.normal,
};

function StatCard({ icon, label, value, sub, to, color }: { icon: JSX.Element; label: string; value: string; sub: string; to: string; color?: string }) {
  return (
    <Link
      to={to}
      style={{
        ...CARD_BODY,
        textDecoration: 'none',

        display: 'flex',
        flexDirection: 'column',
        gap: GAP.tight,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-caption)', color: 'var(--text-muted)' }}>{icon}{label}</span>
      <span style={{ ...METRIC_VALUE, color: color || 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{value}</span>
      <span style={METRIC_CAPTION}>{sub}</span>
    </Link>
  );
}

function ProtocolCoveragePanel({ coverage, unavailable }: { coverage: ProtocolCoverageData; unavailable: boolean }) {
  return <section className="lg-governance-protocols">
    <div style={cardHeadStyle}><h2 style={SECTION_TITLE}>协议请求<HelpPopover label="协议请求">显示最近 24 小时的请求与失败数量。没有请求表示暂无流量，不代表协议不可用；需要排查时打开日志。</HelpPopover></h2><span style={{ ...BODY_TEXT, marginLeft: 'auto' }}>最近 {coverage.sinceHours} 小时</span></div>
    {unavailable ? <div role="status">协议请求状态暂不可用。请刷新状态核实，或<Link to="/logs">查看请求记录</Link>。</div> : coverage.items.length ? coverage.items.map(item => <article key={item.ingressProtocol}>
      <div><h3>{item.label}</h3>{item.logRequests === 0 ? <span>暂无请求</span> : null}{item.requestTypes.length ? <div className="lg-protocol-types">{item.requestTypes.join('、')}</div> : null}</div>
      <dl><div><dt>请求</dt><dd>{item.logRequests}</dd></div><div><dt>HTTP</dt><dd>{item.httpRequests}</dd></div><div><dt>失败</dt><dd>{item.failedRequests}</dd></div><div><dt>参数未采用</dt><dd>{item.droppedParameterRequests}</dd></div></dl>
      <div className="lg-protocol-task-links"><Link to={item.logsLink}>查看请求</Link>{item.failedRequests > 0 ? <Link to={buildLogListHref({ ingressProtocol: item.ingressProtocol, status: 'failed', range: '1d' })}>排查失败</Link> : null}<Link to={item.appCallersLink}>调用方</Link></div>
    </article>) : <div role="status">当前范围没有协议记录。</div>}
  </section>;
}

function emptyKeyHealth(): KeyHealthSummary {
  return {
    primaryConfigured: false,
    legacySecretCount: 0,
    total: 0,
    ok: 0,
    missing: 0,
    unreadable: 0,
    legacyReadable: 0,
    stubUnreadable: 0,
    status: 'unknown',
  };
}

function emptyConfigAuthority(): ConfigAuthoritySummary {
  return {
    mapPools: 0,
    gatewayPools: 0,
    mapOnlyPools: 0,
    mapPlatforms: 0,
    gatewayPlatforms: 0,
    mapOnlyPlatforms: 0,
    mapModels: 0,
    gatewayModels: 0,
    mapOnlyModels: 0,
    mapExchanges: 0,
    gatewayExchanges: 0,
    mapOnlyExchanges: 0,
    appCallersTotal: 0,
    activeAppCallers: 0,
    activeWithGatewayPool: 0,
    activeWithUsableGatewayPool: 0,
    activeMissingGatewayPool: 0,
    activeBoundPoolWithoutUsableMember: 0,
    discoveredAppCallers: 0,
    configuredAppCallers: 0,
    disabledAppCallers: 0,
    mapFallbackObjectsRemaining: 0,
    activeAppCallerMapFallbackReady: false,
    activeAppCallerMapFallbackPolicy: 'configurable',
    readinessPercent: 0,
    status: 'unknown',
  };
}

function emptyProtocolCoverage(): ProtocolCoverageData {
  return {
    releaseCommit: null,
    sinceHours: 24,
    generatedAt: '',
    totalLogRequests: 0,
    totalRegisteredAppCallers: 0,
    totalActiveAppCallers: 0,
    coveredProtocols: 0,
    missingRuntimeProtocols: 4,
    items: ['gw-native', 'openai-compatible', 'claude-compatible', 'gemini-compatible'].map((protocol) => ({
      ingressProtocol: protocol,
      label: protocolCoverageTitle(protocol),
      status: 'no-evidence',
      registeredAppCallers: 0,
      activeAppCallers: 0,
      coveredActiveAppCallers: 0,
      missingActiveAppCallers: 0,
      logRequests: 0,
      httpRequests: 0,
      failedRequests: 0,
      droppedParameterRequests: 0,
      requestTypes: [],
      missingActiveAppCallerCodes: [],
      lastSeenAt: null,
      logsLink: `/logs?ingressProtocol=${encodeURIComponent(protocol)}`,
      appCallersLink: `/app-callers?ingressProtocol=${encodeURIComponent(protocol)}`,
    })),
  };
}

function keyHealthLabel(summary: KeyHealthSummary) {
  if (summary.status === 'ok') return 'OK';
  if (summary.status === 'legacy') return 'Legacy';
  if (summary.status === 'config-missing') return '缺配置';
  if (summary.status === 'unreadable') return '不可解';
  return '未知';
}

function protocolCoverageTitle(protocol: string) {
  if (protocol === 'gw-native') return 'GW Native';
  if (protocol === 'openai-compatible') return 'OpenAI-compatible';
  if (protocol === 'claude-compatible') return 'Claude-compatible';
  if (protocol === 'gemini-compatible') return 'Gemini-compatible';
  return protocol;
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-secondary)' }}>
      {text}
    </div>
  );
}
