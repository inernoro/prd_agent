import { providerForDetail, logicalForDetail, physicalForDetail, offeringParticipationStatus } from '@/lib/modelDetailIdentity';
import { appCallerDetailCandidates, callerManagementState } from '@/lib/appCallerIdentity';
import { callerWorkspaceReturnHref } from '@/lib/appCallerDefaultModel';
import { AppCallerDefaultModel, AppCallerDefaultsProvider } from '@/components/AppCallerDefaultModel';
import { formatPlatformTime } from '@/lib/platformTime';
import { HINT_TEXT } from '@/lib/typography';
import { CollectionView } from '@/components/CollectionView';
import { collectProviderModels } from '@/components/ProviderModelsPanel';
import { groupModelProviders } from '@/lib/modelProviderGroups';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, Check, CircleDollarSign, Clock3, Gauge, KeyRound, Route, Server, ShieldCheck } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { AppEntityIcon, ModelEntityIcon, ProviderEntityIcon } from '@/components/LogEntityIcon';
import { Button, Chip, SectionLoader } from '@/components/ui';
import { getGatewayAppCallers, getLogicalModels, getLogs, getModels, getPlatforms } from '@/lib/api';
import type {
  GatewayAppCaller,
  LlmLogListItem,
  LogicalModelItem,
  ModelItem,
  ModelOfferingItem,
  PlatformItem,
} from '@/lib/types';
import { fmtCompact, fmtDate, fmtMs, statusBadgeStyle } from '@/lib/logsHelpers';

type EntityKind = 'model' | 'provider' | 'app';

type ShellProps = {
  kind: EntityKind;
  title: string;
  identifier: string;
  subtitle: string;
  description: string;
  icon: ReactNode;
  status: Array<{ label: string; tone: 'good' | 'warning' | 'neutral' }>;
  metrics: Array<{ label: string; value: ReactNode; hint?: string; icon: ReactNode }>;
  sections: Array<{ id: string; title: string; description?: string; hideHeading?: boolean; content: ReactNode }>;
  backHref: string;
  backLabel: string;
  primaryHref: string;
  primaryLabel: string;
  management?: { href: string; label: string };
  connectionSummary?: ReactNode;
};

function EntityDetailsShell({
  kind,
  title,
  identifier,
  subtitle,
  description,
  icon,
  status,
  metrics,
  sections,
  backHref,
  backLabel,
  primaryHref,
  primaryLabel,
  management,
  connectionSummary,
}: ShellProps) {
  const descriptionContent = <p className="lg-entity-detail-description">{description}</p>;
  const statusContent = <div className="lg-entity-detail-status">
          {status.map((item) => <StatusPill key={item.label} label={item.label} tone={item.tone} />)}
        </div>;
  const metricsContent = <div className="lg-entity-detail-metrics">
          {metrics.map((metric) => (
            <article key={metric.label}>
              <span>{metric.icon}</span>
              <div><small>{metric.label}</small><strong>{metric.value}</strong>{metric.hint ? <p>{metric.hint}</p> : null}</div>
            </article>
          ))}
        </div>;
  const bounded = kind === 'model' || kind === 'provider';
  const appTask = kind === 'app';
  return (
    <div className={`lg-entity-detail-page${bounded ? ' lg-entity-detail-bounded' : ''}${appTask ? ' lg-entity-detail-app-task' : ''}`}>
      <div className="lg-entity-detail-content">
        <Link className="lg-entity-detail-back" to={backHref}><ArrowLeft size={15} />{backLabel}</Link>
        <header className="lg-entity-detail-hero">
          {!bounded && !appTask ? <div className={`lg-entity-detail-brand lg-entity-detail-brand-${kind}`}>{icon}</div> : null}
          <div className="lg-entity-detail-heading">
            {bounded || appTask ? <><h1>{title}</h1>{kind === 'model' || appTask ? <code title={identifier}>{identifier}</code> : null}{kind === 'provider' || appTask ? <span>{subtitle}</span> : null}</> : <><span>{subtitle}</span><h1>{title}</h1><code title={identifier}>{identifier}</code></>}
          </div>
          <div className="lg-entity-detail-actions">
            <Link to={primaryHref}>{primaryLabel}<ArrowUpRight size={15} /></Link>
            {management ? <Link className="lg-entity-detail-manage" to={management.href}>{management.label}<ArrowUpRight size={15} /></Link> : null}
          </div>
        </header>

        {bounded ? <div className={`lg-collection-entity-meta lg-collection-entity-meta-${kind}`}>{connectionSummary}{statusContent}<details className="lg-entity-detail-properties"><summary>{kind === 'provider' ? '完整连接参数' : '模型属性'}</summary><div><p>{subtitle}</p>{descriptionContent}<code>{identifier}</code>{metricsContent}{kind === 'provider' ? sections.filter((section) => section.id === 'connection').map((section) => <div key={section.id}>{section.description ? <p>{section.description}</p> : null}{section.content}</div>) : null}<nav aria-label="详情章节">{sections.filter((section) => !(kind === 'provider' && section.id === 'connection')).map((section) => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}</nav></div></details></div> : appTask ? <><div className="lg-entity-detail-app-observation">{statusContent}{metricsContent}</div>{descriptionContent}</> : <>{descriptionContent}{statusContent}{metricsContent}</>}

        <div className="lg-entity-detail-layout">
          {!bounded && !appTask ? <aside aria-label="详情章节">
            <nav>
              {sections.map((section) => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}
            </nav>
          </aside> : null}
          <main>
            {sections.filter((section) => !bounded || section.id === 'providers' || section.id === 'models').map((section) => {
              const collection = bounded;
              return <section key={section.id} id={section.id} title={section.hideHeading ? section.description : undefined} className={`lg-entity-detail-section${collection ? ' lg-entity-detail-collection' : ''}`}>
                {!section.hideHeading ? bounded ? <div className="lg-collection-section-heading"><h2>{section.title}</h2>{kind === 'provider' ? <Link to="/models">去模型页看全部</Link> : null}</div> : <><h2>{section.title}</h2>{section.description ? <p>{section.description}</p> : null}</> : null}{section.content}
              </section>;
            })}
            {bounded ? <div className={`lg-collection-entity-extras lg-collection-entity-extras-${kind}`}>
              {kind === 'model' ? <section className="lg-collection-summary-card"><h3>能力与路由</h3><div id="capabilities">{sections.find((section) => section.id === 'capabilities')?.content}</div><details id="routing"><summary>完整路由配置</summary><div>{sections.find((section) => section.id === 'routing')?.content}</div></details></section> : null}
              {sections.filter((section) => section.id === 'activity').map((section) => <section key={section.id} id={section.id} className="lg-collection-summary-card"><div className="lg-collection-section-heading"><h3>{section.title}</h3><Link to={primaryHref}>查看全部请求</Link></div><div className="lg-collection-summary-scroll">{section.content}</div></section>)}
            </div> : null}
          </main>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: 'good' | 'warning' | 'neutral' }) {
  return <span className={`lg-entity-detail-pill lg-entity-detail-pill-${tone}`}>{tone === 'good' ? <Check size={12} /> : null}{label}</span>;
}

function Facts({ items }: { items: Array<{ label: string; value: ReactNode; hint?: string }> }) {
  return (
    <dl className="lg-entity-detail-facts">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
          {item.hint ? <small>{item.hint}</small> : null}
        </div>
      ))}
    </dl>
  );
}

function RecentRequests({ items, emptyText }: { items: LlmLogListItem[]; emptyText: string }) {
  if (!items.length) return <div className="lg-entity-detail-empty">{emptyText}</div>;
  return (
    <div className="lg-entity-detail-request-list">
      {items.map((item) => {
        const badge = statusBadgeStyle(item.status, item.statusCode);
        return (
          <Link key={item.id} to={`/logs/${encodeURIComponent(item.id)}`}>
            <div><strong>{item.logicalModelPublicId || item.model || '未标注模型'}</strong><span>{item.platformName || item.provider || '未标注 Provider'}</span></div>
            <div><span>{formatPlatformTime(item.startedAt)}</span><span>{fmtMs(item.durationMs)}</span><Chip label={badge.label} color={badge.color} bg={badge.bg} /></div>
          </Link>
        );
      })}
    </div>
  );
}

function DetailError({ message, backHref, retry }: { message: string; backHref: string; retry?: () => void }) {
  return (
    <div className="lg-entity-detail-page">
      <div className="lg-entity-detail-empty lg-entity-detail-empty-page">
        <strong>无法打开实体详情</strong>
        <p>{message}</p>
        {retry ? <Button size="sm" onClick={retry}>重新读取</Button> : null}
        <Link to={backHref}>返回请求记录</Link>
      </div>
    </div>
  );
}

function last30Days() {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function formatPrice(model?: ModelItem | null) {
  if (!model) return '未配置';
  const currency = model.priceCurrency || 'USD';
  if (model.pricePerCall != null) return `${currency} ${model.pricePerCall}/次`;
  if (model.inputPricePerMillion == null && model.outputPricePerMillion == null) return '未配置';
  return `${currency} ${model.inputPricePerMillion ?? '—'} / ${model.outputPricePerMillion ?? '—'}`;
}

function formatContext(tokens?: number | null) {
  if (!tokens) return '未配置';
  return `${fmtCompact(tokens)} tokens`;
}

function modelSuccessRate(model?: ModelItem | null) {
  if (!model || model.callCount <= 0) return '暂无数据';
  return `${Math.round((model.successCount / model.callCount) * 1000) / 10}%`;
}

export function ModelDetailsPage() {
  const [params] = useSearchParams();
  const physicalModelId = params.get('modelId') || '';
  const logicalModelId = params.get('logicalModelId') || '';
  const requestedModel = params.get('model') || '';
  const requestedPlatformId = params.get('platformId') || '';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logical, setLogical] = useState<LogicalModelItem | null>(null);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [platforms, setPlatforms] = useState<PlatformItem[]>([]);
  const [recent, setRecent] = useState<LlmLogListItem[]>([]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const range = last30Days();
    Promise.all([
      getLogicalModels(),
      getModels(),
      getPlatforms(),
      requestedModel ? getLogs({ ...range, model: requestedModel, view: 'logical', page: 1, pageSize: 8 }) : Promise.resolve(null),
    ]).then(([logicalResult, modelResult, platformResult, logResult]) => {
      if (!alive) return;
      if (!logicalResult.success || !modelResult.success || !platformResult.success) {
        setError(logicalResult.error?.message || modelResult.error?.message || platformResult.error?.message || '模型详情加载失败');
        setLoading(false);
        return;
      }
      const matchedLogical = logicalForDetail(logicalResult.data.items, logicalModelId, physicalModelId, requestedModel);
      setLogical(matchedLogical);
      setModels(modelResult.data.items);
      setPlatforms(platformResult.data.items);
      if (logResult?.success) setRecent(logResult.data.items);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [logicalModelId, physicalModelId, requestedModel]);

  const physicalModels = useMemo(() => {
    if (physicalModelId) return physicalForDetail(models, physicalModelId, requestedPlatformId, requestedModel);
    if (logical) {
      const targetIds = new Set(logical.offerings.filter((item) => item.targetKind === 'model').map((item) => item.targetId));
      const matched = models.filter((item) => targetIds.has(item.id));
      if (matched.length) return matched;
    }
    return physicalForDetail(models, '', requestedPlatformId, requestedModel);
  }, [logical, models, physicalModelId, requestedModel, requestedPlatformId]);
  const primaryModel = physicalModels[0] ?? null;
  const relatedPlatforms = useMemo(() => {
    const ids = new Set([
      requestedPlatformId,
      ...physicalModels.map((item) => item.platformId || ''),
    ].filter(Boolean));
    return platforms.filter((item) => ids.has(item.id));
  }, [physicalModels, platforms, requestedPlatformId]);
  const providerGroups = useMemo(() => groupModelProviders(logical?.offerings || [], models, platforms), [logical, models, platforms]);
  const providerGroupByRoute = new Map(providerGroups.flatMap((group) => group.offerings.map((route) => [route.id, group] as const)));
  const title = logical?.name || primaryModel?.name || primaryModel?.modelName || requestedModel;
  const identifier = logical?.publicId || primaryModel?.modelName || requestedModel;
  const capabilities = logical?.capabilities.length
    ? logical.capabilities
    : primaryModel?.capabilities.filter((item) => item.value).map((item) => item.type) ?? [];

  if (loading) return <SectionLoader text="正在加载模型详情" />;
  if (error) return <DetailError message={error} backHref="/logs" />;
  if (!logical && !primaryModel && !requestedModel) return <DetailError message="日志没有提供可解析的模型标识。" backHref="/logs" />;

  return (
    <EntityDetailsShell
      kind="model"
      title={title || '未命名模型'}
      identifier={identifier || '未标注模型'}
      subtitle={logical ? '逻辑模型目录' : '上游模型'}
      description={logical?.description || primaryModel?.remark || `该模型由 LLM Gateway 统一解析并路由。页面展示当前租户可见的真实配置、Provider、能力、价格和最近请求，不发起新的上游调用。`}
      icon={<ModelEntityIcon model={identifier} size="lg" />}
      status={[
        { label: (logical?.enabled ?? primaryModel?.enabled ?? true) ? '已启用' : '已停用', tone: (logical?.enabled ?? primaryModel?.enabled ?? true) ? 'good' : 'warning' },
        { label: logical ? `${providerGroups.length} 个供应方 · ${logical.offerings.length} 条上游线路` : `${relatedPlatforms.length} 个可见上游`, tone: 'neutral' },
        { label: capabilities.length ? `${capabilities.length} 项能力` : '能力未标注', tone: capabilities.length ? 'good' : 'warning' },
      ]}
      metrics={[
        { label: '上下文', value: formatContext(primaryModel?.maxTokens), hint: '来自模型权威配置', icon: <Gauge size={17} /> },
        { label: '输入 / 输出价格', value: formatPrice(primaryModel), hint: '每百万 Token 或每次', icon: <CircleDollarSign size={17} /> },
        { label: '历史调用', value: fmtCompact(primaryModel?.callCount ?? recent.length), hint: '当前租户可见范围', icon: <Route size={17} /> },
        { label: '成功率', value: modelSuccessRate(primaryModel), hint: '模型累计统计', icon: <ShieldCheck size={17} /> },
      ]}
      backHref="/logs"
      backLabel="返回请求记录"
      primaryHref={`/logs?model=${encodeURIComponent(identifier || requestedModel)}`}
      primaryLabel="查看模型日志"
      management={{ href: logical ? "/logical-models" : "/models", label: "管理模型" }}
      sections={[
        {
          id: 'providers',
          title: '供应方与上游线路',
          hideHeading: Boolean(logical?.offerings.length),
          description: '同一逻辑模型可以绑定多个上游。Gateway 按优先级、权重、健康和限流选择实际调用目标。',
          content: logical?.offerings.length ? <>
            <div className="lg-collection-supplier-section"><h3 className="lg-collection-section-title">供应方 · {providerGroups.length}</h3><div className="lg-collection-provider-groups">
              {providerGroups.slice(0, 2).map((group) => <Link key={group.id} to={group.targetKind === 'exchange' ? `/platforms?view=exchange&exchangeId=${encodeURIComponent(group.offerings[0].targetId)}` : group.platformId ? `/platforms/view?id=${encodeURIComponent(group.platformId)}&name=${encodeURIComponent(group.name)}` : '/models'}><Server size={20}/><div><strong>{group.name}</strong><span>{group.offerings.length} 条线路</span></div><small>供应方详情</small></Link>)}
              {providerGroups.length > 2 ? <span style={HINT_TEXT}>全部供应方见下方线路清单</span> : null}
            </div></div>
            <h3 className="lg-collection-section-title">上游线路 · {logical.offerings.length}</h3><CollectionView items={logical.offerings} filterLabel="供应方筛选" allFilterLabel="全部供应方" filters={providerGroups.map((group) => ({ value: group.id, label: group.name, matches: (route: ModelOfferingItem) => providerGroupByRoute.get(route.id)?.id === group.id }))} placeholder="搜索上游模型、供应方或协议" searchText={(item) => [providerGroupByRoute.get(item.id)?.name, item.providerName, item.targetName, item.upstreamModelId, item.protocol, item.notes].filter(Boolean).join(' ')}>
              {(routes) => <table className="lg-collection-entity-table lg-collection-route-table"><colgroup><col style={{width: '38%'}}/><col style={{width: '15%'}}/><col style={{width: '15%'}}/><col style={{width: '15%'}}/><col style={{width: '17%'}}/></colgroup><thead><tr><th>上游模型</th><th>供应方</th><th>协议</th><th>顺位 / 权重</th><th>状态</th></tr></thead><tbody>{routes.map((route) => {
                const group = providerGroupByRoute.get(route.id)!;
                const participation = offeringParticipationStatus(route);
                return <tr key={route.id}><td><strong title={route.upstreamModelId || route.targetName}>{route.upstreamModelId || route.targetName}</strong>{route.skipReason ? <small title={route.skipReason}>{route.skipReason}</small> : null}</td><td><Link to={route.targetKind === 'exchange' ? `/platforms?view=exchange&exchangeId=${encodeURIComponent(route.targetId)}` : group.platformId ? `/platforms/view?id=${encodeURIComponent(group.platformId)}&name=${encodeURIComponent(group.name)}` : '/models'}>{group.name}</Link></td><td>{route.protocol || '继承协议'}</td><td>{route.priority} / {route.weight}</td><td><span title={participation.detail}><StatusPill label={participation.label} tone={participation.tone} /></span></td></tr>;
              })}</tbody></table>}

            </CollectionView>
          </> : <CollectionView items={physicalModels} placeholder="搜索上游模型或协议" searchText={(item) => `${item.name} ${item.modelName} ${item.protocol || ''}`}>
            {(pageModels) => <>{pageModels.map((model) => {
              const platform = platforms.find((item) => item.id === model.platformId);
              return <div key={model.id} className="lg-collection-detail-card"><div><strong>{model.name || model.modelName}</strong><span>{model.protocol || '继承协议'}</span></div><Link to={`/platforms/view?id=${encodeURIComponent(model.platformId || '')}&name=${encodeURIComponent(platform?.name || '')}`}>{platform?.name || model.platformId || '未标注 Provider'}</Link></div>;
            })}</>}
          </CollectionView>,
        },
        {
          id: 'capabilities',
          title: '模型能力',
          description: '能力来自模型或逻辑模型权威配置，不根据名称猜测。',
          content: capabilities.length ? <div className="lg-entity-detail-capabilities">{capabilities.map((item) => <span key={item}>{item}</span>)}</div> : <div className="lg-entity-detail-empty">当前模型尚未声明能力。</div>,
        },
        {
          id: 'routing',
          title: '能力与路由',
          content: <Facts items={[
            { label: '路由策略', value: logical?.routingStrategy || '由模型池决定' },
            { label: '上游协议', value: primaryModel?.protocol || '继承 Provider' },
            { label: '优先级', value: primaryModel?.priority ?? logical?.displayOrder ?? '未配置' },
            { label: '最大并发', value: primaryModel?.maxConcurrency || '未配置' },
            { label: '超时', value: primaryModel?.timeout ? `${primaryModel.timeout} ms` : '未配置' },
            { label: '重试次数', value: primaryModel?.maxRetries ?? '未配置' },
          ]} />,
        },
        {
          id: 'activity',
          title: '最近请求活动',
          description: '最近 30 天该模型的请求记录，点击可进入完整请求详情。',
          content: <RecentRequests items={recent} emptyText="最近 30 天没有匹配请求。" />,
        },
      ]}
    />
  );
}

export function ProviderDetailsPage() {
  const [params] = useSearchParams();
  const requestedId = params.get('id') || '';
  const requestedName = params.get('name') || '';
  const [provider, setProvider] = useState<PlatformItem | null>(null);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [logicalModels, setLogicalModels] = useState<LogicalModelItem[] | null>(null);
  const [recent, setRecent] = useState<LlmLogListItem[]>([]);
  const [registered, setRegistered] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const range = last30Days();
    Promise.all([
      getLogicalModels().catch(() => null),
      getPlatforms(),
      getModels(requestedId ? { platformId: requestedId } : undefined),
      requestedName ? getLogs({ ...range, provider: requestedName, view: 'logical', page: 1, pageSize: 8 }) : Promise.resolve(null),
    ]).then(([logicalResult, platformResult, modelResult, logResult]) => {
      if (!alive) return;
      if (!platformResult.success || !modelResult.success) {
        setError(platformResult.error?.message || modelResult.error?.message || 'Provider 详情加载失败');
        setLoading(false);
        return;
      }
      const matched = providerForDetail(platformResult.data.items, requestedId, requestedName) ?? null;
      const recentItems = logResult?.success ? logResult.data.items : [];
      const observed = recentItems.find((item) => (item.platformName || item.provider) === requestedName) ?? recentItems[0] ?? null;
      setLogicalModels(logicalResult?.success ? logicalResult.data.items : null);
      setRegistered(Boolean(matched));
      setProvider(matched ?? (observed ? observedProvider(observed, requestedName) : null));
      setModels(matched
        ? requestedId
          ? modelResult.data.items
          : modelResult.data.items.filter((item) => item.platformId === matched.id)
        : []);
      setRecent(recentItems);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [requestedId, requestedName]);

  const providerRows = useMemo(() => provider ? collectProviderModels(provider.id, models, logicalModels || []) : [], [provider, models, logicalModels]);
  const totalCalls = models.reduce((sum, item) => sum + item.callCount, 0);
  const observedModels = Array.from(new Set(
    recent
      .map((item) => item.logicalModelPublicId || item.model)
      .filter((model): model is string => Boolean(model)),
  ));
  const observedProtocol = recent.find((item) => item.protocol)?.protocol || provider?.platformType || '未标注';
  const observedTransport = recent.find((item) => item.transport)?.transport || '未标注';
  if (loading) return <SectionLoader text="正在加载 Provider 详情" />;
  if (error) return <DetailError message={error} backHref="/logs" />;
  if (!provider) return <DetailError message="当前租户中没有找到该 Provider，可能已删除或不在你的权限范围内。" backHref="/logs" />;

  return (
    <EntityDetailsShell
      kind="provider"
      title={provider.name}
      identifier={provider.providerId || provider.id}
      subtitle={registered ? `Provider · ${models.length} 个托管模型` : `运行时 Provider · ${provider.platformType || '未标注协议'}`}
      description={provider.remark || '该 Provider 负责把 Gateway 请求发送到上游服务。页面只展示当前租户有权读取的连接摘要，不显示密钥明文，也不会建立新的上游连接。'}
      icon={<ProviderEntityIcon provider={provider.name} size="lg" />}
      status={registered ? [
        { label: provider.enabled ? '已启用' : '已停用', tone: provider.enabled ? 'good' : 'warning' },
        { label: provider.hasKey ? '通讯密钥已配置' : '通讯密钥缺失', tone: provider.hasKey ? 'good' : 'warning' },
        { label: provider.authority === 'llm_gateway' ? 'Gateway 权威配置' : 'MAP 兼容配置', tone: 'neutral' },
      ] : [
        { label: '仅日志观测', tone: 'neutral' },
        { label: '非配置实体', tone: 'neutral' },
        { label: '不补造密钥状态', tone: 'neutral' },
      ]}
      metrics={registered ? [
        { label: '托管模型', value: models.length, hint: '当前租户可见', icon: <Server size={17} /> },
        { label: '最大并发', value: provider.maxConcurrency || '未配置', hint: 'Provider 级上限', icon: <Gauge size={17} /> },
        { label: '累计调用', value: fmtCompact(totalCalls || recent.length), hint: '可见模型累计', icon: <Route size={17} /> },
        { label: '密钥状态', value: provider.hasKey ? '就绪' : '未就绪', hint: '不会显示密钥明文', icon: <KeyRound size={17} /> },
      ] : [
        { label: '最近请求', value: fmtCompact(recent.length), hint: '当前筛选窗口', icon: <Route size={17} /> },
        { label: '观察模型', value: observedModels.length, hint: '来自日志，不代表配置', icon: <Server size={17} /> },
        { label: '上游协议', value: observedProtocol, hint: '最近记录', icon: <Gauge size={17} /> },
        { label: '传输方式', value: observedTransport, hint: '最近记录', icon: <KeyRound size={17} /> },
      ]}
      backHref="/logs"
      backLabel="返回请求记录"
      primaryHref={`/logs?provider=${encodeURIComponent(provider.name)}`}
      primaryLabel="查看 Provider 日志"
      management={registered ? { href: "/platforms?view=provider", label: "管理供应方" } : undefined}
      connectionSummary={registered ? <div className="lg-collection-connection-summary"><Server size={20}/><div><strong>{provider.platformType === "openai" ? "OpenAI compatible" : provider.platformType || "未配置协议"}</strong><code title={provider.apiUrl || "未配置"}>{provider.apiUrl || "未配置"}</code></div><span>{models.length} 个托管模型</span></div> : undefined}
      sections={[
        {
          id: 'connection',
          title: '完整连接参数',
          description: registered ? '这组字段决定 Gateway 如何连接该 Provider。' : '该 Provider 只存在于运行日志中；以下字段是最近一次可见记录，不会伪装成可编辑配置。',
          content: <Facts items={[
            { label: '接口类型', value: provider.platformType || '未配置' },
            { label: 'API 地址', value: <code>{provider.apiUrl || (registered ? '未配置' : '日志未记录')}</code>, hint: registered ? '这是上游地址，不是业务应用调用 Gateway 的地址。' : '运行日志不保存可复用的上游连接地址。' },
            { label: '供应方标识', value: provider.providerId || '未单独设置' },
            { label: '最大并发', value: registered ? provider.maxConcurrency || '未配置' : '不适用' },
            { label: '配置来源', value: provider.sourceCollection || '未标注' },
            { label: '最近更新', value: provider.updatedAt ? fmtDate(provider.updatedAt) : '未记录' },
          ]} />,
        },
        {
          id: 'models',
          title: '托管模型',
          description: registered ? '该 Provider 下当前可见的模型。点击模型可继续进入模型详情。' : '从最近请求中观察到的模型；只证明实际请求经过这里，不补造托管关系。',
          content: registered ? <CollectionView items={providerRows} placeholder="搜索模型名称、标识或协议" searchText={({ model, publicIds }) => `${model.name} ${model.modelName} ${model.protocol || ''} ${publicIds.join(' ')}`} filters={logicalModels ? [{ value: 'registered', label: '已登记', matches: (row) => row.publicIds.length > 0 }, { value: 'unregistered', label: '未登记', matches: (row) => row.publicIds.length === 0 }] : []}>
            {(pageRows) => <table className="lg-collection-entity-table lg-collection-hosted-table"><colgroup><col style={{width: '47%'}}/><col style={{width: '19%'}}/><col style={{width: '19%'}}/><col style={{width: '15%'}}/></colgroup><thead><tr><th>模型</th><th>协议</th><th>登记状态</th><th>操作</th></tr></thead><tbody>{pageRows.map(({ model, publicIds }) => <tr key={model.id}><td><strong className="lg-collection-model-id" title={`${model.modelName} · ${model.name}`}>{model.modelName || model.name}</strong></td><td>{model.protocol || '继承协议'}</td><td><StatusPill label={logicalModels ? publicIds.length ? `已登记 · ${publicIds.length}` : '未登记' : '登记状态未读取'} tone={logicalModels ? publicIds.length ? 'good' : 'warning' : 'neutral'} /></td><td><Link to={`/models/view?modelId=${encodeURIComponent(model.id)}&model=${encodeURIComponent(model.modelName || model.name)}&platformId=${encodeURIComponent(provider.id)}`}>模型详情<ArrowUpRight size={13} /></Link></td></tr>)}</tbody></table>}
          </CollectionView> : <CollectionView items={observedModels} placeholder="搜索日志观察到的模型" searchText={(model) => model}>
            {(pageModels) => <>{pageModels.map((model) => <Link className="lg-collection-detail-card" key={model} to={`/models/view?model=${encodeURIComponent(model)}`}><ModelEntityIcon model={model} /><div><strong>{model}</strong><span>日志观测 · 非配置关系</span></div><ArrowUpRight size={15} /></Link>)}</>}
          </CollectionView>,
        },
        {
          id: 'activity',
          title: '最近请求活动',
          description: '最近 30 天由该 Provider 处理的请求。',
          content: <RecentRequests items={recent} emptyText="最近 30 天没有匹配请求。" />,
        },
      ]}
    />
  );
}

function observedProvider(item: LlmLogListItem, requestedName: string): PlatformItem {
  const name = item.platformName || item.provider || requestedName;
  return {
    id: item.platformId || `observed:${name}`,
    name,
    platformType: item.protocol || 'runtime',
    providerId: item.provider || name,
    apiUrl: null,
    enabled: true,
    maxConcurrency: 0,
    remark: '该 Provider 仅在运行日志中被观察到，不是当前租户的可编辑 Provider 配置。页面展示可验证的运行事实，不补造连接、密钥或并发配置。',
    hasKey: false,
    // 这条 Provider 是从运行日志里观察到的，不是可编辑配置，本来就没有密钥可谈
    keyStatus: 'missing',
    sourceCollection: 'llmrequestlogs',
    authority: 'runtime_observed',
    createdAt: null,
    updatedAt: item.endedAt || item.startedAt,
  };
}

type AppCallerDetail = Omit<GatewayAppCaller, 'purpose'> & { purpose: GatewayAppCaller['purpose'] | null };
function observedAppCaller(item: LlmLogListItem, requestedCode: string): AppCallerDetail {
  const requestType = item.requestType!.trim();
  return {
    id: `observed:${requestedCode}:${requestType}`,
    teamId: item.teamId || null,
    appCallerCode: item.appCallerCode || requestedCode,
    requestType,
    sourceSystem: item.sourceSystem || '未标注',
    clientCode: item.clientCode || '未标注',
    environment: item.environment || '未标注',
    purpose: null,
    ingressProtocol: item.ingressProtocol || '未标注',
    observedIngressProtocols: item.ingressProtocol ? [item.ingressProtocol] : [],
    title: item.appCallerCodeDisplayName || item.appCallerTitle || null,
    status: 'observed',
    modelPoolId: item.modelPoolId || null,
    modelPolicy: item.modelPolicy || null,
    parameterPolicy: null,
    lastObservedModelPoolId: item.modelPoolId || null,
    lastObservedModelPolicy: item.modelPolicy || null,
    lastObservedParameterPolicy: null,
    lastObservedRequestId: item.requestId || item.id,
    lastObservedSessionId: item.sessionId || null,
    lastObservedRunId: item.runId || null,
    owner: null,
    monthlyBudgetUsd: null,
    budgetReservationUsd: null,
    rateLimitPerMinute: null,
    notes: null,
    totalSeen: 1,
    firstSeenAt: item.startedAt,
    lastSeenAt: item.startedAt,
    createdAt: null,
    rotatesKeyId: null,
    rotatedByKeyId: null,
    rotationState: 'observed',
    updatedAt: item.startedAt,
  };
}

export function AppCallerDetailsPage() {
  const [params] = useSearchParams();
  const requestedCode = (params.get('code') || '').trim();
  const requestedType = (params.get('requestType') || '').trim().toLowerCase();
  const requestedId = (params.get('id') || '').trim();
  const [app, setApp] = useState<AppCallerDetail | null>(null);
  const [candidates, setCandidates] = useState<GatewayAppCaller[]>([]);
  const [recent, setRecent] = useState<LlmLogListItem[]>([]);
  const [recentError, setRecentError] = useState<string | null>(null);
  const [registered, setRegistered] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null); setApp(null); setCandidates([]); setRecent([]); setRecentError(null);
    const load = async () => {
      try {
        if (!requestedCode && !requestedId) { if (alive) setError('链接缺少调用方身份，请从请求记录或调用方清单重新打开。'); return; }
        // Exact id is ANDed with the existing tenant/team scope on the server. Code search
        // is anchored, then checked again as a code+requestType identity on the client.
        const escapedCode = requestedCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const result = await getGatewayAppCallers(requestedId
          ? { id: requestedId, page: 1, pageSize: 1 }
          : { search: `^${escapedCode}$`, requestType: requestedType || undefined, page: 1, pageSize: 200 });
        if (!alive) return;
        if (!result.success) { setError(result.error?.message || '调用方登记读取失败，请重试。'); return; }
        const matches = appCallerDetailCandidates(result.data.items, requestedId, requestedCode, requestedType);
        if (matches.length > 1 || (!requestedType && !requestedId && result.data.total > result.data.items.length)) {
          setCandidates(matches);
          if (!matches.length) setError('此身份查询结果过多，无法确认目标。请从调用方清单按业务名与请求类型打开。');
          return;
        }
        const matched = matches[0] || null;
        if (!matched && requestedId) { setError('当前租户与团队范围内没有这个精确调用方 ID；未改用同名对象。'); return; }
        if (!matched && !requestedType) { setError('没有找到登记身份，且链接未指定请求类型，无法将日志记录归为某个调用方。'); return; }
        if (!matched && result.data.total > result.data.items.length) { setError('查询结果未完整返回，无法确认该调用方是否登记。请从调用方清单重新打开。'); return; }
        if (matched) { setApp(matched); setRegistered(true); }
        const identityCode = matched?.appCallerCode || requestedCode;
        const identityType = matched?.requestType || requestedType;
        try {
          const logs = await getLogs({ ...last30Days(), appCallerCode: identityCode, requestType: identityType, view: 'logical', page: 1, pageSize: 8 });
          if (!alive) return;
          if (!logs.success) { if (!matched) setError(logs.error?.message || '日志身份读取失败，无法确认该调用方。'); else setRecentError(logs.error?.message || '最近请求读取失败'); return; }
          const items = logs.data.items.filter(item => item.appCallerCode?.toLowerCase() === identityCode.toLowerCase() && item.requestType?.toLowerCase() === identityType.toLowerCase());
          setRecent(items);
          if (!matched && items.length) { setApp(observedAppCaller(items[0], identityCode)); setRegistered(false); }
        } catch { if (alive) { if (!matched) setError('日志读取中断，未确认该调用方身份。请重新读取。'); else setRecentError('最近请求读取中断，请重新读取。'); } }
      } catch { if (alive) setError('调用方登记读取中断，请重新读取；未将失败结果当作未登记。'); }
      finally { if (alive) setLoading(false); }
    };
    void load();
    return () => { alive = false; };
  }, [requestedCode, requestedType, requestedId, revision]);

  if (loading) return <SectionLoader text="正在加载 App 详情" />;
  if (error) return <DetailError message={error} backHref="/logs" retry={() => setRevision(value => value + 1)} />;
  if (candidates.length) return <div className="lg-entity-detail-page"><h1>选择要查看的调用方用途</h1><div className="lg-entity-detail-request-list">{candidates.map(item => <Link key={item.id} to={`/app-callers/view?${new URLSearchParams({ id: item.id, code: item.appCallerCode, requestType: item.requestType })}`}><div><strong>{item.title || item.appCallerCode}</strong><code>{item.appCallerCode}</code></div><span>{item.requestType}</span></Link>)}</div><Link to="/logs">返回请求记录</Link></div>;
  if (!app) return <DetailError message="当前租户中没有找到该 App，可能尚未注册或不在你的团队范围内。" backHref="/logs" />;

  const displayCode = app.appCallerCode;
  return (
    <EntityDetailsShell
      kind="app"
      title={app.title || displayCode}
      identifier={displayCode}
      subtitle={`${app.sourceSystem || '未知来源'} · ${app.requestType || '未标注类型'}`}
      description={app.notes || (registered
        ? '查看此业务用途的调用记录、未点名默认模型与治理设置。允许调用是管理设置，不代表线路健康或保证请求成功。'
        : '该 App 已出现在请求日志中，但当前租户注册表尚无对应治理记录。这里先保留真实调用来源、路由与最近请求，不补造预算或速率配置。')}
      icon={<AppEntityIcon size="lg" />}
      status={[
        registered ? callerManagementState(app.status) : { label: '仅日志观测', tone: 'warning' },
      ]}
      metrics={[
        { label: registered ? '累计请求' : '已载入记录', value: fmtCompact(registered ? app.totalSeen : recent.length), hint: registered ? '注册表累计观察' : '最近30天 · 最多8条', icon: <Route size={17} /> },
        { label: '最近调用', value: app.lastSeenAt ? formatPlatformTime(app.lastSeenAt) : '暂无', hint: '最后一次观察时间', icon: <Clock3 size={17} /> },
      ]}
      backHref="/logs"
      backLabel="返回请求记录"
      primaryHref={callerWorkspaceReturnHref(app.appCallerCode, app.requestType, '')}
      primaryLabel={registered ? '查看调用方治理' : '查看调用方登记'}
      sections={[
        {
          id: 'activity',
          title: '最近请求',
          description: `最近30天 · ${app.requestType} · 最多8条`,
          content: recentError ? <div role="alert">{recentError}<Button size="sm" onClick={() => setRevision(value => value + 1)}>重新读取</Button></div> : <RecentRequests items={recent} emptyText="最近30天没有这个调用方与请求类型的记录。" />,
        },
        {
          id: 'routing',
          title: '未点名默认模型',
          description: '仅影响未显式指定模型的这个请求类型；允许范围、用途能力和线路状态仍会决定请求结果。',
          content: registered ? <AppCallerDefaultsProvider returnSearch=""><AppCallerDefaultModel item={app} /></AppCallerDefaultsProvider> : <span>仅有历史日志，未推断当前默认配置。</span>,
        },
        {
          id: 'governance',
          title: '治理设置',
          content: <Facts items={[
            { label: '月预算', value: !registered ? '未登记' : app.monthlyBudgetUsd == null ? '未限制' : `USD ${app.monthlyBudgetUsd}` },
            { label: '单次预占', value: !registered ? '未登记' : app.budgetReservationUsd == null ? '未设置' : `USD ${app.budgetReservationUsd}` },
            { label: '每分钟请求', value: !registered ? '未登记' : app.rateLimitPerMinute == null ? '未限制' : app.rateLimitPerMinute },
            { label: '负责人', value: app.owner || '未指定' },
            { label: '首次观察', value: app.firstSeenAt ? formatPlatformTime(app.firstSeenAt) : '未记录' },
            { label: '最近更新', value: app.updatedAt ? formatPlatformTime(app.updatedAt) : '未记录' },
          ]} />,
        },
        {
          id: 'identity',
          title: '调用身份',
          content: <Facts items={[
            { label: '来源系统', value: app.sourceSystem || '未标注' },
            { label: '调用客户端', value: app.clientCode || '未标注' },
            { label: '环境', value: app.environment || '未标注' },
            { label: '入口协议', value: app.ingressProtocol || '未标注' },
            { label: '用途', value: app.purpose || '未标注' },
          ]} />,
        },
      ]}
    />
  );
}
