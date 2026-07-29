// 系统运维：运行闸门、协议入口覆盖、配置权威迁移与容器拓扑。
//
// 按「控制台风格调性 v1.2」原则 6 / 7 迁移（doc/rule.platform.llm-gateway.console-design-tonality.md）：
//   - 走 PageShell 骨架；页头 summary 用 runtimeGates 派生的「通过 / 阻塞 / 等待」，
//     让页面在标题下就回答自己那个问题，而不是先读一段话再去下面找数字。
//   - 硬编码的容器清单是文档冒充数据：它不来自任何接口，改了 compose 也不会变。
//     收进默认收起的折叠块，七句 desc 删掉（概念解释交给教程外链），只留「谁是谁、从哪进」。
//   - 七个快捷入口全删：侧边栏「路由 / 工作区」两组本来就有这些页，上面的指标卡也已经链过去，
//     同一屏第三次重复导航只是占版面。
//   - 每个面板的解释压到一句，超出的收进 HelpPopover。
//   - 颜色不再写十六进制：语义色一律走 --ok / --warn / --err / --info（含 -bg），
//     否则浅色主题下这些为深色底调过的绿黄红会直接刺眼。
import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, Server, GitCompare, Cpu, Layers, Database, Tags, Shuffle, KeyRound, ShieldCheck } from 'lucide-react';
import { bindActiveAppCallerPools, bulkClaimConfigAuthority, getPools, getPlatforms, getModels, getShadowComparisons, getGatewayAppCallers, getExchanges, getKeyHealth, getConfigAuthorityReport, getRuntimeGates, getProtocolCoverage } from '@/lib/api';
import type { ModelPool, PlatformItem, ModelItem, ShadowSummary, ExchangeItem, KeyHealthSummary, ConfigAuthoritySummary, RuntimeGatesData, ProtocolCoverageData } from '@/lib/types';
import { Button, Card, Chip, InlineAlert, ReadOnlyNotice, SectionLoader } from '@/components/ui';
import { DetailsBlock, HelpPopover, PageBody, PageHeader, PageShell, TutorialLink } from '@/components/PageShell';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';
import { CARD_BODY, GAP, INSET_BLOCK } from '@/lib/surface';
import { BODY_TEXT, METRIC_CAPTION, METRIC_VALUE, MONO_META, SECTION_TITLE } from '@/lib/typography';

// 网关容器拓扑（SSOT：cds-compose.yml 的 services + .claude/rules/cds-dual-exit-topology.md）。
// 这是静态清单而非运行时数据，所以只在折叠块里作为参考资料出现，不占常驻版面。
type TopoRole = {
  name: string;
  role: string;
  exposure: string;
  group: 'gateway' | 'map' | 'infra';
};
const TOPOLOGY: TopoRole[] = [
  { name: 'llmgw-serve', role: 'serving 引擎', exposure: 'HTTPS 出口', group: 'gateway' },
  { name: 'llmgw', role: '控制台后端', exposure: 'HTTPS 出口', group: 'gateway' },
  { name: 'llmgw-web', role: '控制台前端', exposure: '经 llmgw 反代', group: 'gateway' },
  { name: 'api', role: 'MAP 后端', exposure: 'HTTPS 出口', group: 'map' },
  { name: 'admin', role: 'MAP 前端', exposure: 'HTTPS 出口', group: 'map' },
  { name: 'mongodb', role: '共享数据库', exposure: '内网', group: 'infra' },
  { name: 'redis', role: '共享缓存', exposure: '内网', group: 'infra' },
];

// 三个分组是**分类色**不是状态色，但仍从语义 token 取值：自己拍十六进制的话，
// 浅色主题没有对应覆盖，绿/黄会直接刺眼（cds-theme-tokens.md 同一条教训）。
const GROUP_META: Record<TopoRole['group'], { label: string; color: string; bg: string; icon: JSX.Element }> = {
  gateway: { label: '网关', color: 'var(--accent)', bg: 'var(--accent-soft)', icon: <Cpu size={13} /> },
  map: { label: 'MAP 主应用', color: 'var(--info)', bg: 'var(--info-bg)', icon: <Layers size={13} /> },
  infra: { label: '共享基础设施', color: 'var(--ok)', bg: 'var(--ok-bg)', icon: <Database size={13} /> },
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
  const keyHealthTone = keyHealth!.status === 'ok' ? 'var(--ok)' : keyHealth!.status === 'unreadable' ? 'var(--err)' : 'var(--warn)';
  const authorityTone = configAuthority!.status === 'ready' ? 'var(--ok)' : configAuthority!.status === 'blocked' ? 'var(--err)' : 'var(--warn)';
  const mapOnlyTotal = configAuthority!.mapOnlyPools + configAuthority!.mapOnlyPlatforms + configAuthority!.mapOnlyModels + configAuthority!.mapOnlyExchanges;
  const unusableActivePools = configAuthority!.activeBoundPoolWithoutUsableMember ?? 0;
  const activeFallbackStatus = configAuthority!.activeAppCallerMapFallbackReady
    ? 'active fallback 可关闭'
    : `${configAuthority!.activeMissingGatewayPool} 未绑池 · ${unusableActivePools} 不可用池`;

  return (
    <PageShell>
      {/* 页头这排小字直接由 runtimeGates 派生：这一页存在的理由就是回答「现在卡在哪」，
          答案不该藏在下面某张卡里，更不该先写一段话再让人去找数字。 */}
      <PageHeader
        title="系统运维"
        subtitle="判断网关能否按预期承接流量。"
        summary={(
          <>
            <Chip label={runtimeGateLabel(runtimeGates!)} color={runtimeGateColor(runtimeGates!.status)} bg={runtimeGateBg(runtimeGates!.status)} />
            <span>通过 <strong>{runtimeGates!.passed}</strong></span>
            <span>阻塞 <strong>{runtimeGates!.blocked}</strong></span>
            <span>等待 <strong>{runtimeGates!.waiting}</strong></span>
            {runtimeGates!.releaseCommit ? <code style={MONO_META}>{runtimeGates!.releaseCommit}</code> : null}
          </>
        )}
      />

      <PageBody>
        {/* 部分接口失败：明示故障，避免「计数为 0」被误读为网关健康 */}
        {error ? <InlineAlert tone="error">部分接口加载失败，计数可能不完整：{error}</InlineAlert> : null}
        {actionMessage ? <InlineAlert tone="info">{actionMessage}</InlineAlert> : null}

        <RuntimeGatePanel gates={runtimeGates!} />
        <ProtocolCoveragePanel coverage={protocolCoverage!} />

        {/* 配置概览计数 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: GAP.section }}>
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

        <Card style={{ ...CARD_BODY, display: 'flex', alignItems: 'center', gap: GAP.section, flexWrap: 'wrap' }}>
          <span style={SECTION_TITLE}>配置权威迁移</span>
          <span style={BODY_TEXT}>
            把 MAP-only 配置复制到网关，并给 active 调用方绑定默认池。
            <HelpPopover label="配置权威迁移">
              认领会把 MAP 侧的模型池、平台、模型和 Exchange 复制到 llm_gateway 作为权威副本，已存在的对象直接跳过、不会覆盖。
              绑定则把 active 调用方指到同类型的 GW 默认池；缺默认池或池内没有可用成员的调用方会被跳过，需要先去模型池补齐。
            </HelpPopover>
          </span>
          <Link to="/app-callers?status=active" style={{ textDecoration: 'none' }}>
            <Chip label={`未绑池 ${configAuthority!.activeMissingGatewayPool}`} color={configAuthority!.activeMissingGatewayPool > 0 ? 'var(--warn)' : 'var(--ok)'} bg={configAuthority!.activeMissingGatewayPool > 0 ? 'var(--warn-bg)' : 'var(--ok-bg)'} />
          </Link>
          <Link to="/pools" style={{ textDecoration: 'none' }}>
            <Chip label={`不可用池 ${unusableActivePools}`} color={unusableActivePools > 0 ? 'var(--err)' : 'var(--ok)'} bg={unusableActivePools > 0 ? 'var(--err-bg)' : 'var(--ok-bg)'} />
          </Link>
          {canWrite ? <Button size="sm" variant="secondary" disabled={busyAction !== null || mapOnlyTotal === 0} onClick={() => void claimMapOnlyConfig()} style={{ marginLeft: 'auto' }}>
            {busyAction === 'bulk-claim-authority' ? '处理中…' : '认领 MAP-only 配置'}
          </Button> : null}
          {canWrite ? <Button size="sm" variant="secondary" disabled={busyAction !== null || configAuthority!.activeMissingGatewayPool === 0} onClick={() => void bindActiveCallers()}>
            {busyAction === 'bind-active-callers' ? '处理中…' : '绑定 active 调用方'}
          </Button> : null}
        </Card>
        {!canWrite ? <ReadOnlyNotice>当前角色可以查看运行状态、配置权威和容器拓扑，但不能执行配置认领或绑定。</ReadOnlyNotice> : null}

        {/* 容器拓扑：静态参考资料，默认收起。概念解释走教程，不在控制台里复述。 */}
        <DetailsBlock title={`容器拓扑（${TOPOLOGY.length} 个容器）`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: GAP.normal }}>
            {TOPOLOGY.map((t) => {
              const g = GROUP_META[t.group];
              const https = t.exposure.includes('HTTPS');
              return (
                <div
                  key={t.name}
                  style={{ ...INSET_BLOCK, display: 'flex', alignItems: 'center', gap: GAP.section, flexWrap: 'wrap' }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: g.color }}>{g.icon}<Chip label={g.label} color={g.color} bg={g.bg} /></span>
                  <span style={{ ...MONO_META, color: 'var(--text-primary)', fontWeight: 600, minWidth: 120 }}>{t.name}</span>
                  <span style={{ ...BODY_TEXT, minWidth: 96 }}>{t.role}</span>
                  <Chip label={t.exposure} color={https ? 'var(--ok)' : 'var(--text-muted)'} bg={https ? 'var(--ok-bg)' : 'var(--bg-elevated)'} />
                </div>
              );
            })}
          </div>
          <TutorialLink chapter="chapter-31">查看教程：容器拓扑与双出口</TutorialLink>
        </DetailsBlock>
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

function RuntimeGatePanel({ gates }: { gates: RuntimeGatesData }) {
  return (
    <Card style={CARD_BODY}>
      <div style={cardHeadStyle}>
        <h2 style={{ ...SECTION_TITLE, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ShieldCheck size={16} /> 发布 Gate
          <HelpPopover label="发布 Gate">
            这些 gate 只聚合本控制台已有的证据，不替代发布脚本和生产台账。
            readyForHttpFull 为真才代表可以进入 full-http 发布流程；为假时，下面每张卡的「下一步」就是当前阻塞点。
          </HelpPopover>
        </h2>
        <Chip label={runtimeGateLabel(gates)} color={runtimeGateColor(gates.status)} bg={runtimeGateBg(gates.status)} />
        {/* 右侧这句由 readyForHttpFull 派生，不是常驻说明：状态变了它跟着变。 */}
        <span style={{ ...BODY_TEXT, marginLeft: 'auto' }}>
          {gates.readyForHttpFull ? '可以进入 full-http 发布流程' : '还不能宣称 full-http 完成'}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: GAP.normal }}>
        {gates.items.map((item) => {
          const actions = item.links && item.links.length > 0 ? item.links : runtimeGateActionLinks(item, gates);
          return (
            <div key={item.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: 12, background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: GAP.tight }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, justifyContent: 'space-between' }}>
                <span style={{ fontSize: 'var(--fs-secondary)', fontWeight: 650, color: 'var(--text-primary)' }}>{item.label}</span>
                <Chip label={runtimeGateStatusLabel(item.status)} color={runtimeGateColor(item.status)} bg={runtimeGateBg(item.status)} />
              </div>
              {/* 成句解释一律正文档：这两处原来是 12/11px 配 1.45 行高，正是「整页糊一档」的来源。 */}
              <div style={BODY_TEXT}>{item.detail}</div>
              {item.facts && Object.keys(item.facts).length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.tight }}>
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
                        fontSize: 'var(--fs-micro)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '3px 6px',
                        background: 'var(--bg-surface)',
                      }}
                    >
                      <span style={{ color: 'var(--text-muted)' }}>{key}</span>: {value || 'empty'}
                    </span>
                  ))}
                </div>
              ) : null}
              <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', wordBreak: 'break-word' }}>{item.evidence}</div>
              {actions.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.tight }}>
                  {actions.map((action) => (
                    <Link
                      key={`${item.id}:${action.to}:${action.label}`}
                      to={action.to}
                      style={miniLinkStyle}
                    >
                      {action.label}
                    </Link>
                  ))}
                </div>
              ) : null}
              <div style={{ ...BODY_TEXT, color: item.blocking ? 'var(--warn)' : 'var(--text-muted)' }}>{item.nextAction}</div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ProtocolCoveragePanel({ coverage }: { coverage: ProtocolCoverageData }) {
  return (
    <Card style={CARD_BODY}>
      <div style={cardHeadStyle}>
        <h2 style={{ ...SECTION_TITLE, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Shuffle size={16} /> 协议入口覆盖
          <HelpPopover label="协议入口覆盖">
            覆盖判定只看两样东西：这个协议在选定窗口内有没有真实请求日志，以及 active 调用方是否都被日志覆盖到。
            「代码里支持该协议」不算数；缺样本的调用方会直接列在对应卡片上，点「日志」即可按协议回查。
          </HelpPopover>
        </h2>
        <Chip
          label={`${coverage.coveredProtocols}/${coverage.items.length} 有运行日志`}
          color={coverage.missingRuntimeProtocols === 0 ? 'var(--ok)' : 'var(--warn)'}
          bg={coverage.missingRuntimeProtocols === 0 ? 'var(--ok-bg)' : 'var(--warn-bg)'}
        />
        <span style={{ ...BODY_TEXT, marginLeft: 'auto' }}>
          {coverage.releaseCommit ? `commit=${coverage.releaseCommit}` : `最近 ${coverage.sinceHours} 小时`}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: GAP.normal }}>
        {coverage.items.map((item) => (
          <div key={item.ingressProtocol} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', padding: 12, background: 'var(--bg-elevated)', display: 'flex', flexDirection: 'column', gap: 7 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: GAP.normal }}>
              <span style={{ fontSize: 'var(--fs-secondary)', fontWeight: 650, color: 'var(--text-primary)' }}>{item.label}</span>
              <Chip label={protocolCoverageLabel(item.status)} color={protocolCoverageColor(item.status)} bg={protocolCoverageBg(item.status)} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: GAP.tight }}>
              <MiniMetric label="请求" value={`${item.logRequests}`} />
              <MiniMetric label="HTTP" value={`${item.httpRequests}`} />
              <MiniMetric label="active 覆盖" value={`${item.coveredActiveAppCallers}/${item.activeAppCallers}`} />
              <MiniMetric label="失败/丢参" value={`${item.failedRequests}/${item.droppedParameterRequests}`} />
            </div>
            <div style={{ minHeight: 18, fontSize: 'var(--fs-micro)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.requestTypes.length > 0 ? item.requestTypes.join(', ') : '暂无 requestType 样本'}
            </div>
            {item.missingActiveAppCallerCodes.length > 0 ? (
              <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--warn)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.missingActiveAppCallerCodes.join(', ')}>
                缺样本：{item.missingActiveAppCallerCodes.join(', ')}
              </div>
            ) : null}
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
  if (status === 'covered') return 'var(--ok)';
  if (status === 'runtime-seen') return 'var(--warn)';
  if (status === 'registry-only') return 'var(--accent)';
  return 'var(--text-muted)';
}

function protocolCoverageBg(status: string) {
  if (status === 'covered') return 'var(--ok-bg)';
  if (status === 'runtime-seen') return 'var(--warn-bg)';
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
  if (status === 'ready' || status === 'pass') return 'var(--ok)';
  if (status === 'blocked') return 'var(--err)';
  if (status === 'retained') return 'var(--text-muted)';
  return 'var(--warn)';
}

function runtimeGateBg(status: string) {
  if (status === 'ready' || status === 'pass') return 'var(--ok-bg)';
  if (status === 'blocked') return 'var(--err-bg)';
  if (status === 'retained') return 'var(--bg-surface)';
  return 'var(--warn-bg)';
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 'var(--fs-secondary)' }}>
      {text}
    </div>
  );
}
