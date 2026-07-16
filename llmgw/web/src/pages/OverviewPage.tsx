// 治理运行状态：承载容器拓扑、发布 gate、配置权威迁移与协议运行证据。
// 这些内部运维信息从普通首页移入本页，避免干扰首次接入与日常观测。
import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, Server, GitCompare, ScrollText, Cpu, Layers, Database, Tags, Shuffle, KeyRound, ShieldCheck } from 'lucide-react';
import { bindActiveAppCallerPools, bulkClaimConfigAuthority, getPools, getPlatforms, getModels, getShadowComparisons, getGatewayAppCallers, getExchanges, getKeyHealth, getConfigAuthorityReport, getRuntimeGates, getProtocolCoverage } from '@/lib/api';
import type { ModelPool, PlatformItem, ModelItem, ShadowSummary, ExchangeItem, KeyHealthSummary, ConfigAuthoritySummary, RuntimeGatesData, ProtocolCoverageData } from '@/lib/types';
import { Button, Chip, ReadOnlyNotice, SectionLoader } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';

// 网关容器拓扑（SSOT：cds-compose.yml 的 services + .claude/rules/cds-dual-exit-topology.md）。
// 让用户一眼看懂「多只脚」：网关这套本就是 3 个独立容器（控制台后端 + serving 引擎 + 控制台前端），
// 加上 MAP 的 api/admin 与共享 mongo/redis，共 7 个容器，各司其职。
type TopoRole = {
  name: string;
  role: string;
  exposure: string;
  desc: string;
  group: 'gateway' | 'map' | 'infra';
};
const TOPOLOGY: TopoRole[] = [
  { name: 'llmgw-serve', role: 'serving 引擎', exposure: 'HTTPS 出口', desc: '独立可被调用的网关服务，/gw/v1/* 走 X-Gateway-Key 鉴权', group: 'gateway' },
  { name: 'llmgw', role: '控制台后端', exposure: 'HTTPS 出口', desc: '观测/管理后端（本控制台的 API），JWT 账号鉴权，读共享 Mongo', group: 'gateway' },
  { name: 'llmgw-web', role: '控制台前端', exposure: '经 llmgw 反代', desc: '你现在看的这个 SPA（nginx 托管，/gw/* 反代到 llmgw）', group: 'gateway' },
  { name: 'api', role: 'MAP 后端', exposure: 'HTTPS 出口', desc: 'PRD Agent 业务后端（LLM 调用方，Mode=http 时经 serving）', group: 'map' },
  { name: 'admin', role: 'MAP 前端', exposure: 'HTTPS 出口', desc: 'PRD Agent 管理后台 SPA', group: 'map' },
  { name: 'mongodb', role: '共享数据库', exposure: '内网', desc: '网关与 MAP 共享同一库（不分离），配置/日志/影子均落此', group: 'infra' },
  { name: 'redis', role: '共享缓存', exposure: '内网', desc: '网关与 MAP 共享缓存', group: 'infra' },
];

const GROUP_META: Record<TopoRole['group'], { label: string; color: string; bg: string; icon: JSX.Element }> = {
  gateway: { label: '网关', color: 'var(--accent)', bg: 'var(--accent-soft)', icon: <Cpu size={13} /> },
  map: { label: 'MAP 主应用', color: '#d29922', bg: 'rgba(210,153,34,0.14)', icon: <Layers size={13} /> },
  infra: { label: '共享基础设施', color: '#3fb950', bg: 'rgba(63,185,80,0.14)', icon: <Database size={13} /> },
};

export function GovernancePage() {
  const { tenant } = useAuth();
  const canWrite = canUseCapability(tenant?.role, 'configWrite');
  const [pools, setPools] = useState<ModelPool[] | null>(null);
  const [platforms, setPlatforms] = useState<PlatformItem[] | null>(null);
  const [models, setModels] = useState<ModelItem[] | null>(null);
  const [exchanges, setExchanges] = useState<ExchangeItem[] | null>(null);
  const [keyHealth, setKeyHealth] = useState<KeyHealthSummary | null>(null);
  const [configAuthority, setConfigAuthority] = useState<ConfigAuthoritySummary | null>(null);
  const [runtimeGates, setRuntimeGates] = useState<RuntimeGatesData | null>(null);
  const [protocolCoverage, setProtocolCoverage] = useState<ProtocolCoverageData | null>(null);
  const [appCallerTotal, setAppCallerTotal] = useState<number | null>(null);
  const [shadow, setShadow] = useState<ShadowSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const protocolReleaseCommit = new URLSearchParams(window.location.search).get('releaseCommit')?.trim() || undefined;
    // 每个 slice 失败也置空数组（而非留 null）→ loading 一定会收敛、不卡 spinner；成功的部分照常渲染局部数据。
    Promise.all([getPools(), getPlatforms(), getModels(), getExchanges(), getKeyHealth(), getConfigAuthorityReport(), getRuntimeGates(), getProtocolCoverage({ releaseCommit: protocolReleaseCommit, sinceHours: 24 }), getGatewayAppCallers({ page: 1, pageSize: 1 }), getShadowComparisons({ limit: 1 })]).then(
      ([poolsRes, platformsRes, modelsRes, exchangesRes, keyHealthRes, authorityRes, runtimeGatesRes, protocolCoverageRes, appCallersRes, shadowRes]) => {
        if (!alive) return;
        if (poolsRes.success) setPools(poolsRes.data.items); else { setPools([]); setError((e) => e || poolsRes.error?.message || '加载失败'); }
        if (platformsRes.success) setPlatforms(platformsRes.data.items); else { setPlatforms([]); setError((e) => e || platformsRes.error?.message || '加载失败'); }
        if (modelsRes.success) setModels(modelsRes.data.items); else { setModels([]); setError((e) => e || modelsRes.error?.message || '加载失败'); }
        if (exchangesRes.success) setExchanges(exchangesRes.data.items); else { setExchanges([]); setError((e) => e || exchangesRes.error?.message || '加载失败'); }
        if (keyHealthRes.success) setKeyHealth(keyHealthRes.data.summary); else { setKeyHealth(emptyKeyHealth()); setError((e) => e || keyHealthRes.error?.message || '加载失败'); }
        if (authorityRes.success) setConfigAuthority(authorityRes.data.summary); else { setConfigAuthority(emptyConfigAuthority()); setError((e) => e || authorityRes.error?.message || '加载失败'); }
        if (runtimeGatesRes.success) setRuntimeGates(runtimeGatesRes.data); else { setRuntimeGates(emptyRuntimeGates()); setError((e) => e || runtimeGatesRes.error?.message || '加载失败'); }
        if (protocolCoverageRes.success) setProtocolCoverage(protocolCoverageRes.data); else { setProtocolCoverage(emptyProtocolCoverage()); setError((e) => e || protocolCoverageRes.error?.message || '加载失败'); }
        if (appCallersRes.success) setAppCallerTotal(appCallersRes.data.total); else { setAppCallerTotal(0); setError((e) => e || appCallersRes.error?.message || '加载失败'); }
        if (shadowRes.success) setShadow(shadowRes.data.summary); else setShadow({ total: 0, allMatch: 0, critical: 0, httpFail: 0 });
      },
    ).catch((err) => {
      // Promise.all/then 里抛错也要收敛 loading（否则永远转圈）。
      if (!alive) return;
      setPools((p) => p ?? []); setPlatforms((p) => p ?? []); setModels((p) => p ?? []); setExchanges((p) => p ?? []); setKeyHealth((p) => p ?? emptyKeyHealth()); setConfigAuthority((p) => p ?? emptyConfigAuthority()); setRuntimeGates((p) => p ?? emptyRuntimeGates()); setProtocolCoverage((p) => p ?? emptyProtocolCoverage()); setAppCallerTotal((p) => p ?? 0);
      setShadow((s) => s ?? { total: 0, allMatch: 0, critical: 0, httpFail: 0 });
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
      setActionMessage(res.error?.message || '批量认领失败');
      return;
    }
    const [poolsRes, platformsRes, modelsRes, exchangesRes, authorityRes, runtimeGatesRes] = await Promise.all([
      getPools(),
      getPlatforms(),
      getModels(),
      getExchanges(),
      getConfigAuthorityReport(),
      getRuntimeGates(),
    ]);
    if (poolsRes.success) setPools(poolsRes.data.items);
    if (platformsRes.success) setPlatforms(platformsRes.data.items);
    if (modelsRes.success) setModels(modelsRes.data.items);
    if (exchangesRes.success) setExchanges(exchangesRes.data.items);
    if (authorityRes.success) setConfigAuthority(authorityRes.data.summary);
    if (runtimeGatesRes.success) setRuntimeGates(runtimeGatesRes.data);
    setBusyAction(null);
    setActionMessage(`已认领 ${res.data.claimedTotal} 个配置，跳过 ${res.data.skippedTotal} 个已存在配置`);
  }

  async function bindActiveCallers() {
    setBusyAction('bind-active-callers');
    setActionMessage(null);
    const res = await bindActiveAppCallerPools();
    if (!res.success) {
      setBusyAction(null);
      setActionMessage(res.error?.message || 'active 调用方绑定失败');
      return;
    }
    const [authorityRes, runtimeGatesRes, appCallersRes] = await Promise.all([
      getConfigAuthorityReport(),
      getRuntimeGates(),
      getGatewayAppCallers({ page: 1, pageSize: 1 }),
    ]);
    if (authorityRes.success) setConfigAuthority(authorityRes.data.summary);
    if (runtimeGatesRes.success) setRuntimeGates(runtimeGatesRes.data);
    if (appCallersRes.success) setAppCallerTotal(appCallersRes.data.total);
    setBusyAction(null);
    setActionMessage(`已绑定 ${res.data.bound} 个 active 调用方，跳过 ${res.data.skipped} 个，缺默认池 ${res.data.missingDefaultPool} 个`);
  }

  const loading = pools === null || platforms === null || models === null || exchanges === null || keyHealth === null || configAuthority === null || runtimeGates === null || protocolCoverage === null || appCallerTotal === null;
  // 完全没加载出来（都还 null）时才整屏报错/转圈；有部分数据则进入下方渲染，用顶部横幅提示失败（不掩盖故障）。
  if (loading && error) return <Empty text={error} />;
  if (loading) return <SectionLoader text="正在加载网关概览…" />;

  const enabledPlatforms = platforms!.filter((p) => p.enabled).length;
  const defaultPools = pools!.filter((p) => p.isDefaultForType).length;
  const enabledModels = models!.filter((m) => m.enabled).length;
  const enabledExchanges = exchanges!.filter((x) => x.enabled).length;
  const matchRate = shadow && shadow.total > 0 ? Math.round((shadow.allMatch / shadow.total) * 100) : null;
  const keyHealthTone = keyHealth!.status === 'ok' ? '#3fb950' : keyHealth!.status === 'unreadable' ? '#f85149' : '#d29922';
  const authorityTone = configAuthority!.status === 'ready' ? '#3fb950' : configAuthority!.status === 'blocked' ? '#f85149' : '#d29922';
  const mapOnlyTotal = configAuthority!.mapOnlyPools + configAuthority!.mapOnlyPlatforms + configAuthority!.mapOnlyModels + configAuthority!.mapOnlyExchanges;
  const unusableActivePools = configAuthority!.activeBoundPoolWithoutUsableMember ?? 0;
  const activeFallbackStatus = configAuthority!.activeAppCallerMapFallbackReady
    ? 'active fallback 可关闭'
    : `${configAuthority!.activeMissingGatewayPool} 未绑池 · ${unusableActivePools} 不可用池`;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* 部分接口失败：顶部横幅明示故障，避免「计数为 0」被误读为网关健康 */}
      {error ? (
        <div style={{ fontSize: 12, color: '#f85149', padding: '8px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(248,81,73,0.35)', background: 'rgba(248,81,73,0.08)' }}>
          部分配置接口加载失败（下方计数可能不完整）：{error}
        </div>
      ) : null}
      {actionMessage ? (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '8px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)' }}>
          {actionMessage}
        </div>
      ) : null}
      <RuntimeGatePanel gates={runtimeGates!} />
      <ProtocolCoveragePanel coverage={protocolCoverage!} />
      {/* 配置概览计数 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <StatCard icon={<Server size={16} />} label="平台" value={`${enabledPlatforms}/${platforms!.length}`} sub="启用/总数" to="/platforms" />
        <StatCard icon={<Boxes size={16} />} label="模型池" value={`${pools!.length}`} sub={`${defaultPools} 个默认池`} to="/pools" />
        <StatCard icon={<Tags size={16} />} label="调用方" value={`${appCallerTotal}`} sub="GW 已发现注册项" to="/app-callers" />
        <StatCard icon={<Cpu size={16} />} label="模型" value={`${enabledModels}/${models!.length}`} sub="启用/总数" to="/models" />
        <StatCard icon={<Shuffle size={16} />} label="Exchange" value={`${enabledExchanges}/${exchanges!.length}`} sub="启用/总数" to="/exchanges" />
        <StatCard
          icon={<Database size={16} />}
          label="权威迁移"
          value={`${configAuthority!.readinessPercent}%`}
          sub={`${configAuthority!.mapFallbackObjectsRemaining ?? mapOnlyTotal} 个 MAP-only · ${activeFallbackStatus}`}
          to="/pools"
          color={authorityTone}
        />
        <StatCard
          icon={<ShieldCheck size={16} />}
          label="发布 Gate"
          value={runtimeGates!.readyForHttpFull ? 'Ready' : runtimeGateLabel(runtimeGates!)}
          sub={`${runtimeGates!.passed} 通过 · ${runtimeGates!.blocked} 阻塞 · ${runtimeGates!.waiting} 等待`}
          to="/governance"
          color={runtimeGateColor(runtimeGates!.status)}
        />
        <StatCard
          icon={<KeyRound size={16} />}
          label="密钥自检"
          value={keyHealthLabel(keyHealth!)}
          sub={`${keyHealth!.ok} 可解 · ${keyHealth!.unreadable} 不可解 · ${keyHealth!.missing} 缺省`}
          to="/platforms"
          color={keyHealthTone}
        />
        <StatCard
          icon={<GitCompare size={16} />}
          label="影子比对"
          value={shadow && shadow.total > 0 ? `${matchRate}%` : '暂无'}
          sub={shadow && shadow.total > 0 ? `${shadow.total} 样本 · ${shadow.critical} 严重差异` : '未开启 shadow 模式'}
          to="/shadow"
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: 12, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', background: 'var(--bg-surface)' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>配置权威迁移</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>将 MAP-only 配置复制到 llm_gateway，并把 active 调用方绑定到同类型 GW 默认池。</span>
        <Link to="/app-callers?status=active" style={{ textDecoration: 'none' }}>
          <Chip label={`未绑池 ${configAuthority!.activeMissingGatewayPool}`} color={configAuthority!.activeMissingGatewayPool > 0 ? '#d29922' : '#3fb950'} bg={configAuthority!.activeMissingGatewayPool > 0 ? 'rgba(210,153,34,0.14)' : 'rgba(63,185,80,0.14)'} />
        </Link>
        <Link to="/pools" style={{ textDecoration: 'none' }}>
          <Chip label={`不可用池 ${unusableActivePools}`} color={unusableActivePools > 0 ? '#f85149' : '#3fb950'} bg={unusableActivePools > 0 ? 'rgba(248,81,73,0.12)' : 'rgba(63,185,80,0.14)'} />
        </Link>
        {canWrite ? <Button size="sm" variant="secondary" disabled={busyAction !== null || mapOnlyTotal === 0} onClick={() => void claimMapOnlyConfig()} style={{ marginLeft: 'auto' }}>
          {busyAction === 'bulk-claim-authority' ? '处理中…' : '认领 MAP-only 配置'}
        </Button> : null}
        {canWrite ? <Button size="sm" variant="secondary" disabled={busyAction !== null || configAuthority!.activeMissingGatewayPool === 0} onClick={() => void bindActiveCallers()}>
          {busyAction === 'bind-active-callers' ? '处理中…' : '绑定 active 调用方'}
        </Button> : null}
      </div>
      {!canWrite ? <ReadOnlyNotice>当前角色可以查看运行状态、配置权威和容器拓扑，但不能执行配置认领或绑定。</ReadOnlyNotice> : null}

      {/* 容器拓扑 */}
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>容器拓扑</span>
          <Chip label={`${TOPOLOGY.length} 个容器`} color="var(--text-secondary)" bg="var(--bg-elevated)" />
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          网关是 3 个独立容器（serving 引擎 + 控制台后端 + 控制台前端），与 MAP 的 api/admin、共享 mongo/redis 各司其职。
          这就是你在 CDS 面板看到「多只脚」的原因——不是异常，是剥离后的正常形态。
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {TOPOLOGY.map((t) => {
            const g = GROUP_META[t.group];
            return (
              <div
                key={t.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                  padding: '10px 12px',
                  background: 'var(--bg-elevated)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: g.color }}>{g.icon}<Chip label={g.label} color={g.color} bg={g.bg} /></span>
                <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', minWidth: 120 }}>{t.name}</span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 84 }}>{t.role}</span>
                <Chip label={t.exposure} color={t.exposure.includes('HTTPS') ? '#3fb950' : 'var(--text-muted)'} bg={t.exposure.includes('HTTPS') ? 'rgba(63,185,80,0.14)' : 'var(--bg-surface)'} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1, minWidth: 180 }}>{t.desc}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 快速入口 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <QuickLink to="/logs" icon={<ScrollText size={16} />} label="调用日志" desc="每次 LLM 请求的模型/耗时/传输通道" />
        <QuickLink to="/app-callers" icon={<Tags size={16} />} label="调用方" desc="GW 被动发现的 appCaller 注册表" />
        <QuickLink to="/pools" icon={<Boxes size={16} />} label="模型池" desc="调度策略 + 池内模型健康" />
        <QuickLink to="/platforms" icon={<Server size={16} />} label="平台" desc="上游平台启用态 + 密钥状态" />
        <QuickLink to="/models" icon={<Cpu size={16} />} label="模型" desc="模型协议 + 能力 + 权威来源" />
        <QuickLink to="/exchanges" icon={<Shuffle size={16} />} label="Exchange" desc="非标准上游适配器与虚拟平台" />
        <QuickLink to="/shadow" icon={<GitCompare size={16} />} label="影子比对" desc="inproc vs http 一致性证据" />
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, sub, to, color }: { icon: JSX.Element; label: string; value: string; sub: string; to: string; color?: string }) {
  return (
    <Link
      to={to}
      style={{
        textDecoration: 'none',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>{icon}{label}</span>
      <span style={{ fontSize: 24, fontWeight: 700, color: color || 'var(--text-primary)', fontFamily: 'ui-monospace, monospace' }}>{value}</span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</span>
    </Link>
  );
}

function RuntimeGatePanel({ gates }: { gates: RuntimeGatesData }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
          <ShieldCheck size={16} /> 发布 Gate
        </span>
        <Chip label={runtimeGateLabel(gates)} color={runtimeGateColor(gates.status)} bg={runtimeGateBg(gates.status)} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {gates.readyForHttpFull ? '可以进入 full-http 发布流程' : '还不能宣称 full-http 完成'}
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        这些 gate 聚合控制台已有证据；它们不替代发布脚本和生产台账，只用于治理页定位当前阻塞点。
        {gates.releaseCommit ? <span style={{ fontFamily: 'ui-monospace, monospace' }}> commit={gates.releaseCommit}</span> : null}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
        {gates.items.map((item) => {
          const actions = item.links && item.links.length > 0 ? item.links : runtimeGateActionLinks(item, gates);
          return (
            <div key={item.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: 12, background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--text-primary)' }}>{item.label}</span>
                <Chip label={runtimeGateStatusLabel(item.status)} color={runtimeGateColor(item.status)} bg={runtimeGateBg(item.status)} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>{item.detail}</div>
              {item.facts && Object.keys(item.facts).length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {runtimeGateFactsForDisplay(item).map(([key, value]) => (
                    <span
                      key={key}
                      title={`${key}: ${value}`}
                      style={{
                        maxWidth: '100%',
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: 11,
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-xs)',
                        padding: '3px 6px',
                        background: 'var(--bg-surface)',
                      }}
                    >
                      <span style={{ color: 'var(--text-muted)' }}>{key}</span>: {value || 'empty'}
                    </span>
                  ))}
                </div>
              ) : null}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}>{item.evidence}</div>
              {actions.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {actions.map((action) => (
                    <Link
                      key={`${item.id}:${action.to}:${action.label}`}
                      to={action.to}
                      style={{
                        textDecoration: 'none',
                        fontSize: 11,
                        color: 'var(--accent)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-xs)',
                        padding: '4px 7px',
                        background: 'var(--bg-surface)',
                      }}
                    >
                      {action.label}
                    </Link>
                  ))}
                </div>
              ) : null}
              <div style={{ fontSize: 11, color: item.blocking ? '#d29922' : 'var(--text-muted)', lineHeight: 1.45 }}>{item.nextAction}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProtocolCoveragePanel({ coverage }: { coverage: ProtocolCoverageData }) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius)', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
          <Shuffle size={16} /> 协议入口覆盖
        </span>
        <Chip
          label={`${coverage.coveredProtocols}/${coverage.items.length} 有运行日志`}
          color={coverage.missingRuntimeProtocols === 0 ? '#3fb950' : '#d29922'}
          bg={coverage.missingRuntimeProtocols === 0 ? 'rgba(63,185,80,0.14)' : 'rgba(210,153,34,0.14)'}
        />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {coverage.releaseCommit ? `commit=${coverage.releaseCommit}` : `最近 ${coverage.sinceHours} 小时`}
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        这里只展示真实日志和 appCaller 注册表覆盖，不把“代码支持该协议”当作生产已通过。
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 8 }}>
        {coverage.items.map((item) => (
          <div key={item.ingressProtocol} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: 12, background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--text-primary)' }}>{item.label}</span>
              <Chip label={protocolCoverageLabel(item.status)} color={protocolCoverageColor(item.status)} bg={protocolCoverageBg(item.status)} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
              <MiniMetric label="请求" value={`${item.logRequests}`} />
              <MiniMetric label="HTTP" value={`${item.httpRequests}`} />
              <MiniMetric label="active 覆盖" value={`${item.coveredActiveAppCallers}/${item.activeAppCallers}`} />
              <MiniMetric label="失败/丢参" value={`${item.failedRequests}/${item.droppedParameterRequests}`} />
            </div>
            <div style={{ minHeight: 18, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.requestTypes.length > 0 ? item.requestTypes.join(', ') : '暂无 requestType 样本'}
            </div>
            {item.missingActiveAppCallerCodes.length > 0 ? (
              <div style={{ fontSize: 11, color: '#d29922', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.missingActiveAppCallerCodes.join(', ')}>
                缺样本：{item.missingActiveAppCallerCodes.join(', ')}
              </div>
            ) : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <Link to={item.logsLink} style={miniLinkStyle}>日志</Link>
              <Link to={item.appCallersLink} style={miniLinkStyle}>调用方</Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const miniLinkStyle: CSSProperties = {
  textDecoration: 'none',
  fontSize: 11,
  color: 'var(--accent)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-xs)',
  padding: '4px 7px',
  background: 'var(--bg-surface)',
};

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 0, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xs)', padding: '6px 7px', background: 'var(--bg-surface)' }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, fontWeight: 650, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );
}

function runtimeGateActionLinks(item: { id: string; facts?: Record<string, string> }, gates: RuntimeGatesData): Array<{ label: string; to: string }> {
  const facts = item.facts ?? {};
  const releaseCommit = (facts.releaseCommit || gates.releaseCommit || '').trim();
  const releaseQuery = releaseCommit ? `?releaseCommit=${encodeURIComponent(releaseCommit)}` : '';
  const missingCode = (facts.missingAppCallerCodes || '')
    .split(',')
    .map((x) => x.trim())
    .find(Boolean);
  switch (item.id) {
    case 'config_authority_objects':
      return [
        { label: '模型池', to: '/pools' },
        { label: '平台', to: '/platforms' },
        { label: '模型', to: '/models' },
        { label: 'Exchange', to: '/exchanges' },
      ];
    case 'config_authority_rollout_ledger':
      return [
        { label: '审计', to: '/audits?targetType=llmgw_config_authority' },
        { label: '概览', to: '/' },
      ];
    case 'active_appcaller_pool_binding':
      return [
        { label: 'active 调用方', to: '/app-callers?status=active' },
        { label: 'discovered 调用方', to: '/app-callers?status=discovered' },
        { label: '模型池', to: '/pools' },
      ];
    case 'appcaller_policy_drift':
      return [{ label: '漂移调用方', to: '/app-callers?drift=any' }];
    case 'appcaller_ingress_registry_coverage':
      return [
        { label: '协议覆盖', to: '/?protocolCoverage=1' },
        { label: '调用方', to: '/app-callers' },
      ];
    case 'gateway_pool_member_readiness':
      return [{ label: '检查模型池', to: '/pools' }];
    case 'active_appcaller_map_fallback_exit':
      return [
        { label: 'active 调用方', to: '/app-callers?status=active' },
        { label: '模型池', to: '/pools' },
        { label: '平台密钥', to: '/platforms' },
      ];
    case 'gateway_key_integrity':
      return [
        { label: '平台密钥', to: '/platforms' },
        { label: '模型密钥', to: '/models' },
        { label: 'Exchange 密钥', to: '/exchanges' },
      ];
    case 'current_commit_http_transport':
      return [{ label: '当前 commit 日志', to: `/logs${releaseQuery}` }];
    case 'dropped_parameter_runtime_evidence':
      return [{ label: '参数证据日志', to: `/logs${releaseQuery}` }];
    case 'appcaller_runtime_coverage':
      return [
        { label: 'active 调用方', to: missingCode ? `/app-callers?status=active&search=${encodeURIComponent(missingCode)}` : '/app-callers?status=active' },
        { label: '当前 commit 日志', to: `/logs${releaseQuery}` },
        { label: '当前 commit shadow', to: `/shadow${releaseQuery}` },
      ];
    case 'protocol_runtime_coverage':
      return [
        { label: '协议覆盖', to: `/${releaseCommit ? `?protocolCoverage=1&releaseCommit=${encodeURIComponent(releaseCommit)}` : '?protocolCoverage=1'}` },
        { label: '协议日志', to: `/logs${releaseQuery}` },
        { label: '调用方', to: '/app-callers' },
      ];
    case 'shadow_runtime_evidence': {
      const critical = Number(facts.critical || 0);
      const httpFail = Number(facts.httpFail || 0);
      const quick = critical > 0 ? '&quick=critical' : httpFail > 0 ? '&quick=httpFail' : '';
      return [{ label: 'shadow 样本', to: `/shadow${releaseQuery}${releaseQuery ? quick : quick.replace('&', '?')}` }];
    }
    case 'full_http_rollout_ledger':
      return [
        { label: '当前 commit 日志', to: `/logs${releaseQuery}` },
        { label: '当前 commit shadow', to: `/shadow${releaseQuery}` },
      ];
    default:
      return [];
  }
}

function runtimeGateFactsForDisplay(item: { id: string; facts?: Record<string, string> }): Array<[string, string]> {
  const facts = item.facts ?? {};
  const preferredByGate: Record<string, string[]> = {
    config_authority_rollout_ledger: [
      'sameCommit',
      'missing',
      'latestCommit',
      'recordedAt',
      'externalBackupJson',
      'configAuthorityJson',
      'rolloutLedger',
    ],
    full_http_rollout_ledger: [
      'sameCommit',
      'missing',
      'latestCommit',
      'recordedAt',
      'releaseGateJson',
      'protocolCanaryRequired',
      'protocolCanaryJson',
      'disableMapConfigFallbackForActiveAppCallers',
      'evidenceJson',
      'rolloutLedger',
    ],
    active_appcaller_map_fallback_exit: [
      'disableMapConfigFallbackForActiveAppCallers',
      'mapFallbackObjectsRemaining',
      'activeMissingGatewayPool',
      'discoveredAppCallers',
      'withoutUsableMember',
    ],
    appcaller_ingress_registry_coverage: [
      'registeredAppCallers',
      'coveredProtocols',
      'missingProtocols',
      'missingIngressProtocols',
    ],
    current_commit_http_transport: [
      'releaseCommit',
      'releaseLogTotal',
      'httpTransportLogs',
      'nonHttpTransportLogs',
    ],
    protocol_runtime_coverage: [
      'releaseCommit',
      'coveredProtocols',
      'missingProtocols',
      'missingIngressProtocols',
      'protocolLogTotal',
      'failedProtocolLogs',
      'droppedParameterProtocolLogs',
    ],
  };
  const preferred = preferredByGate[item.id] ?? [];
  const seen = new Set<string>();
  const ordered: Array<[string, string]> = [];
  for (const key of preferred) {
    if (Object.prototype.hasOwnProperty.call(facts, key)) {
      ordered.push([key, facts[key]]);
      seen.add(key);
    }
  }
  for (const entry of Object.entries(facts)) {
    if (!seen.has(entry[0])) ordered.push(entry);
  }
  return ordered.slice(0, 8);
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

function emptyRuntimeGates(): RuntimeGatesData {
  return {
    status: 'unknown',
    readyForHttpFull: false,
    passed: 0,
    blocked: 0,
    waiting: 0,
    retained: 0,
    generatedAt: '',
    releaseCommit: null,
    items: [],
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

function protocolCoverageLabel(status: string) {
  if (status === 'covered') return '已覆盖';
  if (status === 'runtime-seen') return '有日志';
  if (status === 'registry-only') return '仅注册';
  return '无证据';
}

function protocolCoverageColor(status: string) {
  if (status === 'covered') return '#3fb950';
  if (status === 'runtime-seen') return '#d29922';
  if (status === 'registry-only') return 'var(--accent)';
  return 'var(--text-muted)';
}

function protocolCoverageBg(status: string) {
  if (status === 'covered') return 'rgba(63,185,80,0.14)';
  if (status === 'runtime-seen') return 'rgba(210,153,34,0.14)';
  if (status === 'registry-only') return 'var(--accent-soft)';
  return 'var(--bg-surface)';
}

function runtimeGateLabel(gates: RuntimeGatesData) {
  if (gates.readyForHttpFull) return 'Ready';
  if (gates.status === 'blocked') return 'Blocked';
  if (gates.status === 'waiting') return 'Waiting';
  return 'Unknown';
}

function runtimeGateStatusLabel(status: string) {
  if (status === 'pass') return '通过';
  if (status === 'blocked') return '阻塞';
  if (status === 'waiting') return '等待';
  if (status === 'retained') return '保留';
  return '未知';
}

function runtimeGateColor(status: string) {
  if (status === 'ready' || status === 'pass') return '#3fb950';
  if (status === 'blocked') return '#f85149';
  if (status === 'retained') return 'var(--text-muted)';
  return '#d29922';
}

function runtimeGateBg(status: string) {
  if (status === 'ready' || status === 'pass') return 'rgba(63,185,80,0.14)';
  if (status === 'blocked') return 'rgba(248,81,73,0.14)';
  if (status === 'retained') return 'var(--bg-surface)';
  return 'rgba(210,153,34,0.14)';
}

function QuickLink({ to, icon, label, desc }: { to: string; icon: JSX.Element; label: string; desc: string }) {
  return (
    <Link
      to={to}
      style={{
        textDecoration: 'none',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius)',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>{icon}{label}</span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{desc}</span>
    </Link>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
      {text}
    </div>
  );
}
