import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Server, Cpu, Tags, Shuffle, KeyRound } from 'lucide-react';
import { bulkClaimConfigAuthority, getPlatforms, getModels, getGatewayAppCallers, getExchanges, getKeyHealth, getConfigAuthorityReport, getProtocolCoverage } from '@/lib/api';
import type { PlatformItem, ModelItem, ExchangeItem, KeyHealthSummary, ConfigAuthoritySummary, ProtocolCoverageData } from '@/lib/types';
import { Button, Card, Chip, InlineAlert, ReadOnlyNotice, SectionLoader } from '@/components/ui';
import { HelpPopover, PageBody, PageHeader, PageShell } from '@/components/PageShell';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';
import { CARD_BODY, GAP } from '@/lib/surface';
import { BODY_TEXT, METRIC_CAPTION, METRIC_VALUE, SECTION_TITLE } from '@/lib/typography';

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
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // 每个 slice 失败也置空数组（而非留 null）→ loading 一定会收敛、不卡 spinner；成功的部分照常渲染局部数据。
    // 「success 但 body 缺字段」也要兜：否则 setX(undefined) 会绕过 `=== null` 的 loading 判定，
    // 直接渲染并在 keyHealth!.status 上抛错，整页白屏。
    Promise.all([getPlatforms(), getModels(), getExchanges(), getKeyHealth(), getConfigAuthorityReport(), getProtocolCoverage({ sinceHours: 24 }), getGatewayAppCallers({ page: 1, pageSize: 1 })]).then(
      ([platformsRes, modelsRes, exchangesRes, keyHealthRes, authorityRes, protocolCoverageRes, appCallersRes]) => {
        if (!alive) return;
        if (platformsRes.success) setPlatforms(platformsRes.data.items); else { setPlatforms([]); setError((e) => e || platformsRes.error?.message || '加载失败'); }
        if (modelsRes.success) setModels(modelsRes.data.items); else { setModels([]); setError((e) => e || modelsRes.error?.message || '加载失败'); }
        if (exchangesRes.success) setExchanges(exchangesRes.data.items); else { setExchanges([]); setError((e) => e || exchangesRes.error?.message || '加载失败'); }
        if (keyHealthRes.success) setKeyHealth(keyHealthRes.data.summary ?? emptyKeyHealth()); else { setKeyHealth(emptyKeyHealth()); setError((e) => e || keyHealthRes.error?.message || '加载失败'); }
        if (authorityRes.success) setConfigAuthority(authorityRes.data.summary ?? emptyConfigAuthority()); else { setConfigAuthority(emptyConfigAuthority()); setError((e) => e || authorityRes.error?.message || '加载失败'); }
        if (protocolCoverageRes.success) setProtocolCoverage(protocolCoverageRes.data); else { setProtocolCoverage(emptyProtocolCoverage()); setError((e) => e || protocolCoverageRes.error?.message || '加载失败'); }
        if (appCallersRes.success) setAppCallerTotal(appCallersRes.data.total); else { setAppCallerTotal(0); setError((e) => e || appCallersRes.error?.message || '加载失败'); }
      },
    ).catch((err) => {
      // Promise.all/then 里抛错也要收敛 loading（否则永远转圈）。
      if (!alive) return;
      setPlatforms((p) => p ?? []); setModels((p) => p ?? []); setExchanges((p) => p ?? []); setKeyHealth((p) => p ?? emptyKeyHealth()); setConfigAuthority((p) => p ?? emptyConfigAuthority()); setProtocolCoverage((p) => p ?? emptyProtocolCoverage()); setAppCallerTotal((p) => p ?? 0);
      setError((e) => e || (err instanceof Error ? err.message : '加载失败'));
    });
    return () => { alive = false; };
  }, []);

  async function claimMapOnlyConfig() {
    setBusyAction('bulk-claim-authority');
    setActionMessage(null);
    const res = await bulkClaimConfigAuthority({ overwrite: false });
    if (!res.success) {
      setBusyAction(null);
      setActionMessage(res.error?.message || '导入失败');
      return;
    }
    const [platformsRes, modelsRes, exchangesRes, authorityRes] = await Promise.all([
      getPlatforms(),
      getModels(),
      getExchanges(),
      getConfigAuthorityReport(),
    ]);
    if (platformsRes.success) setPlatforms(platformsRes.data.items);
    if (modelsRes.success) setModels(modelsRes.data.items);
    if (exchangesRes.success) setExchanges(exchangesRes.data.items);
    if (authorityRes.success) setConfigAuthority(authorityRes.data.summary ?? emptyConfigAuthority());
    setBusyAction(null);
    setActionMessage(`已导入 ${res.data.claimedTotal} 个配置，跳过 ${res.data.skippedTotal} 个已存在配置`);
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
      <PageHeader title="系统运维" subtitle="查看配置、密钥和协议请求状态。" />

      <PageBody>
        {/* 部分接口失败：明示故障，避免「计数为 0」被误读为网关健康 */}
        {error ? <InlineAlert tone="error">部分接口加载失败，计数可能不完整：{error}</InlineAlert> : null}
        {actionMessage ? <InlineAlert tone="info">{actionMessage}</InlineAlert> : null}

        <ProtocolCoveragePanel coverage={protocolCoverage!} />

        {/* 配置概览计数 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: GAP.section }}>
          <StatCard icon={<Server size={16} />} label="平台" value={`${enabledPlatforms}/${platforms!.length}`} sub="启用/总数" to="/platforms" />
          <StatCard icon={<Tags size={16} />} label="调用方" value={`${appCallerTotal}`} sub="GW 已发现注册项" to="/app-callers" />
          <StatCard icon={<Cpu size={16} />} label="模型" value={`${enabledModels}/${models!.length}`} sub="启用/总数" to="/models" />
          <StatCard icon={<Shuffle size={16} />} label="Exchange" value={`${enabledExchanges}/${exchanges!.length}`} sub="启用/总数" to="/exchanges" />
          <StatCard
            icon={<KeyRound size={16} />}
            label="密钥自检"
            value={keyHealthLabel(keyHealth!)}
            sub={`${keyHealth!.ok} 可解 · ${keyHealth!.unreadable} 不可解 · ${keyHealth!.missing} 缺省`}
            to="/platforms"
            color={keyHealthTone}
          />
        </div>

        <Card style={{ ...CARD_BODY, display: 'flex', alignItems: 'center', gap: GAP.section, flexWrap: 'wrap' }}>
          <span style={SECTION_TITLE}>调用方路由</span>
          <span style={BODY_TEXT}>{configAuthority!.status === 'unknown' ? '调用方路由状态暂不可用' : `${configAuthority!.activeMissingGatewayPool} 个活跃调用方尚无可用模型`}</span>
          <Link to="/app-callers?status=active" style={{ textDecoration: 'none' }}><Button size="sm" variant="secondary">查看调用方</Button></Link>
          <Link to="/logical-models" style={{ textDecoration: 'none' }}><Button size="sm" variant="secondary">设置模型与默认项</Button></Link>
          {mapOnlyTotal > 0 ? <>
            <span style={BODY_TEXT}>有 {mapOnlyTotal} 项已有 MAP 配置可导入</span>
            <HelpPopover label="导入已有配置">将已有上游、模型与转接配置复制到网关；保留密钥，跳过已存在的配置。</HelpPopover>
            {canWrite ? <Button size="sm" variant="secondary" disabled={busyAction !== null} onClick={() => void claimMapOnlyConfig()}>{busyAction ? '导入中…' : '导入已有配置'}</Button> : null}
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
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius)',
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

function ProtocolCoveragePanel({ coverage }: { coverage: ProtocolCoverageData }) {
  return (
    <Card style={CARD_BODY}>
      <div style={cardHeadStyle}>
        <h2 style={{ ...SECTION_TITLE, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Shuffle size={16} /> 协议请求
          <HelpPopover label="协议请求">
            显示最近 24 小时的请求与失败数量。没有请求表示暂无流量，不代表协议不可用；需要排查时打开日志。
          </HelpPopover>
        </h2>
        <span style={{ ...BODY_TEXT, marginLeft: 'auto' }}>最近 {coverage.sinceHours} 小时</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: GAP.normal }}>
        {coverage.items.map((item) => (
          <div key={item.ingressProtocol} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: 12, background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: GAP.normal }}>
              <span style={{ fontSize: 'var(--fs-secondary)', fontWeight: 650, color: 'var(--text-primary)' }}>{item.label}</span>
              <Chip label={item.logRequests > 0 ? '有请求' : '暂无请求'} color="var(--text-muted)" bg="var(--bg-elevated)" />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: GAP.tight }}>
              <MiniMetric label="请求" value={`${item.logRequests}`} />
              <MiniMetric label="HTTP" value={`${item.httpRequests}`} />

              <MiniMetric label="失败/参数未采用" value={`${item.failedRequests}/${item.droppedParameterRequests}`} />
            </div>
            <div style={{ minHeight: 18, fontSize: 'var(--fs-micro)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.requestTypes.length > 0 ? item.requestTypes.join(', ') : '暂无 requestType 样本'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.tight }}>
              <Link to={item.logsLink} style={miniLinkStyle}>日志</Link>
              <Link to={item.appCallersLink} style={miniLinkStyle}>调用方</Link>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

const miniLinkStyle: CSSProperties = {
  textDecoration: 'none',
  fontSize: 'var(--fs-micro)',
  color: 'var(--accent)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  padding: '4px 7px',
  background: 'var(--bg-surface)',
};

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 0, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: '6px 7px', background: 'var(--bg-surface)' }}>
      <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-secondary)', fontWeight: 650, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );
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
