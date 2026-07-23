import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpRight, Check, CircleDollarSign, Clock3, Gauge, KeyRound, Route, Server, ShieldCheck } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { AppEntityIcon, ModelEntityIcon, ProviderEntityIcon } from '@/components/LogEntityIcon';
import { Chip, SectionLoader } from '@/components/ui';
import { getGatewayAppCallers, getLogicalModels, getLogs, getModels, getPlatforms, getPools } from '@/lib/api';
import type {
  GatewayAppCaller,
  LlmLogListItem,
  LogicalModelItem,
  ModelItem,
  ModelPool,
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
  sections: Array<{ id: string; title: string; description?: string; content: ReactNode }>;
  backHref: string;
  backLabel: string;
  primaryHref: string;
  primaryLabel: string;
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
}: ShellProps) {
  return (
    <div className="lg-entity-detail-page">
      <div className="lg-entity-detail-content">
        <Link className="lg-entity-detail-back" to={backHref}><ArrowLeft size={15} />{backLabel}</Link>
        <header className="lg-entity-detail-hero">
          <div className={`lg-entity-detail-brand lg-entity-detail-brand-${kind}`}>{icon}</div>
          <div className="lg-entity-detail-heading">
            <span>{subtitle}</span>
            <h1>{title}</h1>
            <code>{identifier}</code>
          </div>
          <div className="lg-entity-detail-actions">
            <Link to={primaryHref}>{primaryLabel}<ArrowUpRight size={15} /></Link>
          </div>
        </header>

        <p className="lg-entity-detail-description">{description}</p>
        <div className="lg-entity-detail-status">
          {status.map((item) => <StatusPill key={item.label} label={item.label} tone={item.tone} />)}
        </div>

        <div className="lg-entity-detail-metrics">
          {metrics.map((metric) => (
            <article key={metric.label}>
              <span>{metric.icon}</span>
              <div><small>{metric.label}</small><strong>{metric.value}</strong>{metric.hint ? <p>{metric.hint}</p> : null}</div>
            </article>
          ))}
        </div>

        <div className="lg-entity-detail-layout">
          <aside aria-label="详情章节">
            <nav>
              {sections.map((section) => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}
            </nav>
          </aside>
          <main>
            {sections.map((section) => (
              <section key={section.id} id={section.id} className="lg-entity-detail-section">
                <h2>{section.title}</h2>
                {section.description ? <p>{section.description}</p> : null}
                {section.content}
              </section>
            ))}
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
            <div><span>{fmtDate(item.startedAt)}</span><span>{fmtMs(item.durationMs)}</span><Chip label={badge.label} color={badge.color} bg={badge.bg} /></div>
          </Link>
        );
      })}
    </div>
  );
}

function DetailError({ message, backHref }: { message: string; backHref: string }) {
  return (
    <div className="lg-entity-detail-page">
      <div className="lg-entity-detail-empty lg-entity-detail-empty-page">
        <strong>无法打开实体详情</strong>
        <p>{message}</p>
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
      requestedModel ? getLogs({ ...range, model: requestedModel, page: 1, pageSize: 8 }) : Promise.resolve(null),
    ]).then(([logicalResult, modelResult, platformResult, logResult]) => {
      if (!alive) return;
      if (!logicalResult.success || !modelResult.success || !platformResult.success) {
        setError(logicalResult.error?.message || modelResult.error?.message || platformResult.error?.message || '模型详情加载失败');
        setLoading(false);
        return;
      }
      const matchedLogical = logicalResult.data.items.find((item) => (
        item.id === logicalModelId
        || item.publicId === requestedModel
        || item.name === requestedModel
      )) ?? null;
      setLogical(matchedLogical);
      setModels(modelResult.data.items);
      setPlatforms(platformResult.data.items);
      if (logResult?.success) setRecent(logResult.data.items);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [logicalModelId, requestedModel]);

  const physicalModels = useMemo(() => {
    if (logical) {
      const targetIds = new Set(logical.offerings.filter((item) => item.targetKind === 'model').map((item) => item.targetId));
      const matched = models.filter((item) => targetIds.has(item.id));
      if (matched.length) return matched;
    }
    return models.filter((item) => (
      item.id === requestedModel
      || item.modelName === requestedModel
      || item.name === requestedModel
    ));
  }, [logical, models, requestedModel]);
  const primaryModel = physicalModels[0] ?? null;
  const relatedPlatforms = useMemo(() => {
    const ids = new Set([
      requestedPlatformId,
      ...physicalModels.map((item) => item.platformId || ''),
    ].filter(Boolean));
    return platforms.filter((item) => ids.has(item.id));
  }, [physicalModels, platforms, requestedPlatformId]);
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
        { label: `${relatedPlatforms.length || logical?.offerings.length || 0} 个可见上游`, tone: 'neutral' },
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
      primaryLabel="查看该模型日志"
      sections={[
        {
          id: 'providers',
          title: 'Providers',
          description: '同一逻辑模型可以绑定多个上游。Gateway 按优先级、权重、健康和限流选择实际调用目标。',
          content: relatedPlatforms.length || logical?.offerings.length ? (
            <div className="lg-entity-detail-card-list">
              {(logical?.offerings.length ? logical.offerings : physicalModels).map((item) => {
                const targetId = 'targetId' in item ? item.targetId : item.id;
                const platform = 'targetId' in item
                  ? relatedPlatforms.find((candidate) => candidate.name === item.providerName)
                  : relatedPlatforms.find((candidate) => candidate.id === item.platformId);
                const providerName = 'targetId' in item ? item.providerName || item.targetName : platform?.name || item.platformId || '未标注 Provider';
                return (
                  <Link key={targetId} to={`/platforms/view?id=${encodeURIComponent(platform?.id || '')}&name=${encodeURIComponent(providerName)}`}>
                    <ProviderEntityIcon provider={providerName} />
                    <div><strong>{providerName}</strong><span>{'protocol' in item ? item.protocol || '继承协议' : item.protocol || platform?.platformType || '继承协议'}</span></div>
                    <ArrowUpRight size={15} />
                  </Link>
                );
              })}
            </div>
          ) : <div className="lg-entity-detail-empty">尚未解析到该模型的 Provider 配置。</div>,
        },
        {
          id: 'capabilities',
          title: 'Capabilities',
          description: '能力来自模型或逻辑模型权威配置，不根据名称猜测。',
          content: capabilities.length ? <div className="lg-entity-detail-capabilities">{capabilities.map((item) => <span key={item}>{item}</span>)}</div> : <div className="lg-entity-detail-empty">当前模型尚未声明能力。</div>,
        },
        {
          id: 'routing',
          title: 'Routing',
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
          title: 'Activity',
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
  const [recent, setRecent] = useState<LlmLogListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const range = last30Days();
    Promise.all([
      getPlatforms(),
      getModels(requestedId ? { platformId: requestedId } : undefined),
      requestedName ? getLogs({ ...range, provider: requestedName, page: 1, pageSize: 8 }) : Promise.resolve(null),
    ]).then(([platformResult, modelResult, logResult]) => {
      if (!alive) return;
      if (!platformResult.success || !modelResult.success) {
        setError(platformResult.error?.message || modelResult.error?.message || 'Provider 详情加载失败');
        setLoading(false);
        return;
      }
      const matched = platformResult.data.items.find((item) => item.id === requestedId || item.name === requestedName) ?? null;
      setProvider(matched);
      setModels(requestedId ? modelResult.data.items : modelResult.data.items.filter((item) => item.platformId === matched?.id));
      if (logResult?.success) setRecent(logResult.data.items);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [requestedId, requestedName]);

  const totalCalls = models.reduce((sum, item) => sum + item.callCount, 0);
  if (loading) return <SectionLoader text="正在加载 Provider 详情" />;
  if (error) return <DetailError message={error} backHref="/logs" />;
  if (!provider) return <DetailError message="当前租户中没有找到该 Provider，可能已删除或不在你的权限范围内。" backHref="/logs" />;

  return (
    <EntityDetailsShell
      kind="provider"
      title={provider.name}
      identifier={provider.providerId || provider.id}
      subtitle={`Gateway Provider · ${provider.platformType || '未标注协议'}`}
      description={provider.remark || '该 Provider 负责把 Gateway 请求发送到上游服务。页面只展示当前租户有权读取的连接摘要，不显示密钥明文，也不会建立新的上游连接。'}
      icon={<ProviderEntityIcon provider={provider.name} size="lg" />}
      status={[
        { label: provider.enabled ? '已启用' : '已停用', tone: provider.enabled ? 'good' : 'warning' },
        { label: provider.hasKey ? '通讯密钥已配置' : '通讯密钥缺失', tone: provider.hasKey ? 'good' : 'warning' },
        { label: provider.authority === 'llm_gateway' ? 'Gateway 权威配置' : 'MAP 兼容配置', tone: 'neutral' },
      ]}
      metrics={[
        { label: '托管模型', value: models.length, hint: '当前租户可见', icon: <Server size={17} /> },
        { label: '最大并发', value: provider.maxConcurrency || '未配置', hint: 'Provider 级上限', icon: <Gauge size={17} /> },
        { label: '累计调用', value: fmtCompact(totalCalls || recent.length), hint: '可见模型累计', icon: <Route size={17} /> },
        { label: '密钥状态', value: provider.hasKey ? '就绪' : '未就绪', hint: '不会显示密钥明文', icon: <KeyRound size={17} /> },
      ]}
      backHref="/logs"
      backLabel="返回请求记录"
      primaryHref={`/logs?provider=${encodeURIComponent(provider.name)}`}
      primaryLabel="查看该 Provider 日志"
      sections={[
        {
          id: 'connection',
          title: 'Connection',
          description: '这组字段决定 Gateway 如何连接该 Provider。',
          content: <Facts items={[
            { label: '接口类型', value: provider.platformType || '未配置' },
            { label: 'API 地址', value: <code>{provider.apiUrl || '未配置'}</code>, hint: '这是上游地址，不是业务应用调用 Gateway 的地址。' },
            { label: '供应方标识', value: provider.providerId || '未单独设置' },
            { label: '最大并发', value: provider.maxConcurrency || '未配置' },
            { label: '配置来源', value: provider.sourceCollection || '未标注' },
            { label: '最近更新', value: provider.updatedAt ? fmtDate(provider.updatedAt) : '未记录' },
          ]} />,
        },
        {
          id: 'models',
          title: 'Models',
          description: '该 Provider 下当前可见的模型。点击模型可继续进入模型详情。',
          content: models.length ? (
            <div className="lg-entity-detail-card-list">
              {models.map((model) => (
                <Link key={model.id} to={`/models/view?model=${encodeURIComponent(model.modelName || model.name)}&platformId=${encodeURIComponent(provider.id)}`}>
                  <ModelEntityIcon model={model.modelName || model.name} />
                  <div><strong>{model.name || model.modelName}</strong><span>{model.modelName} · {model.protocol || '继承协议'}</span></div>
                  <ArrowUpRight size={15} />
                </Link>
              ))}
            </div>
          ) : <div className="lg-entity-detail-empty">该 Provider 尚未关联模型。</div>,
        },
        {
          id: 'activity',
          title: 'Activity',
          description: '最近 30 天由该 Provider 处理的请求。',
          content: <RecentRequests items={recent} emptyText="最近 30 天没有匹配请求。" />,
        },
      ]}
    />
  );
}

export function AppCallerDetailsPage() {
  const [params] = useSearchParams();
  const requestedCode = (params.get('code') || '').replace(/^G-/, '');
  const requestedId = params.get('id') || '';
  const [app, setApp] = useState<GatewayAppCaller | null>(null);
  const [pool, setPool] = useState<ModelPool | null>(null);
  const [recent, setRecent] = useState<LlmLogListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const range = last30Days();
    Promise.all([
      getGatewayAppCallers({ page: 1, pageSize: 50, search: requestedCode || requestedId }),
      getPools(),
      requestedCode ? getLogs({ ...range, appCallerCode: requestedCode, page: 1, pageSize: 8 }) : Promise.resolve(null),
    ]).then(([appResult, poolResult, logResult]) => {
      if (!alive) return;
      if (!appResult.success || !poolResult.success) {
        setError(appResult.error?.message || poolResult.error?.message || 'App 详情加载失败');
        setLoading(false);
        return;
      }
      const matched = appResult.data.items.find((item) => (
        item.id === requestedId
        || item.appCallerCode.replace(/^G-/, '') === requestedCode
      )) ?? appResult.data.items[0] ?? null;
      setApp(matched);
      setPool(poolResult.data.items.find((item) => item.id === matched?.modelPoolId) ?? null);
      if (logResult?.success) setRecent(logResult.data.items);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [requestedCode, requestedId]);

  if (loading) return <SectionLoader text="正在加载 App 详情" />;
  if (error) return <DetailError message={error} backHref="/logs" />;
  if (!app) return <DetailError message="当前租户中没有找到该 App，可能尚未注册或不在你的团队范围内。" backHref="/logs" />;

  const displayCode = app.appCallerCode.startsWith('G-') ? app.appCallerCode : `G-${app.appCallerCode}`;
  return (
    <EntityDetailsShell
      kind="app"
      title={app.title || displayCode}
      identifier={displayCode}
      subtitle={`${app.sourceSystem || '未知来源'} · ${app.requestType || '未标注类型'}`}
      description={app.notes || 'App 表示发起 Gateway 请求的业务身份。页面汇总它的调用来源、模型路由、预算与速率治理以及最近请求，便于从一条日志继续定位完整业务上下文。'}
      icon={<AppEntityIcon size="lg" />}
      status={[
        { label: app.status === 'active' ? '已启用' : app.status || '状态未知', tone: app.status === 'active' ? 'good' : 'warning' },
        { label: app.modelPolicy || 'auto', tone: 'neutral' },
        { label: app.owner ? `负责人 ${app.owner}` : '未指定负责人', tone: app.owner ? 'good' : 'warning' },
      ]}
      metrics={[
        { label: '累计请求', value: fmtCompact(app.totalSeen), hint: '注册表累计观察', icon: <Route size={17} /> },
        { label: '月预算', value: app.monthlyBudgetUsd == null ? '未限制' : `USD ${app.monthlyBudgetUsd}`, hint: '租户治理边界内', icon: <CircleDollarSign size={17} /> },
        { label: '每分钟请求', value: app.rateLimitPerMinute == null ? '未限制' : app.rateLimitPerMinute, hint: 'App 级速率限制', icon: <Gauge size={17} /> },
        { label: '最近调用', value: app.lastSeenAt ? fmtDate(app.lastSeenAt) : '暂无', hint: '最后一次观察时间', icon: <Clock3 size={17} /> },
      ]}
      backHref="/logs"
      backLabel="返回请求记录"
      primaryHref={`/app-callers?search=${encodeURIComponent(app.appCallerCode)}&focus=${encodeURIComponent(app.appCallerCode)}`}
      primaryLabel="打开治理配置"
      sections={[
        {
          id: 'identity',
          title: 'Identity',
          description: '这些字段回答“谁在调用、从哪里调用、以什么方式调用”。',
          content: <Facts items={[
            { label: 'appCallerCode', value: <code>{app.appCallerCode}</code> },
            { label: '来源系统', value: app.sourceSystem || '未标注' },
            { label: '调用客户端', value: app.clientCode || '未标注' },
            { label: '环境', value: app.environment || '未标注' },
            { label: '入口协议', value: app.ingressProtocol || '未标注' },
            { label: '用途', value: app.purpose || '未标注' },
          ]} />,
        },
        {
          id: 'routing',
          title: 'Routing',
          description: 'App 自己不维护上游连接，只声明模型策略；具体 Provider 选择由 Gateway 完成。',
          content: <Facts items={[
            { label: '模型策略', value: app.modelPolicy || 'auto' },
            { label: '模型池', value: pool ? <Link to={`/pools?focus=${encodeURIComponent(pool.id)}`}>{pool.name || pool.code || pool.id}</Link> : app.modelPoolId || '未绑定' },
            { label: '参数策略', value: app.parameterPolicy || 'default-drop' },
            { label: '模型池健康', value: pool?.health || '未解析' },
            { label: '健康成员', value: pool ? `${pool.healthyMembers} / ${pool.models.length}` : '未解析' },
            { label: '最近实际模型池', value: app.lastObservedModelPoolId || '未观察到' },
          ]} />,
        },
        {
          id: 'governance',
          title: 'Governance',
          content: <Facts items={[
            { label: '月预算', value: app.monthlyBudgetUsd == null ? '未限制' : `USD ${app.monthlyBudgetUsd}` },
            { label: '单次预占', value: app.budgetReservationUsd == null ? '未设置' : `USD ${app.budgetReservationUsd}` },
            { label: '每分钟请求', value: app.rateLimitPerMinute == null ? '未限制' : app.rateLimitPerMinute },
            { label: '负责人', value: app.owner || '未指定' },
            { label: '首次观察', value: app.firstSeenAt ? fmtDate(app.firstSeenAt) : '未记录' },
            { label: '最近更新', value: app.updatedAt ? fmtDate(app.updatedAt) : '未记录' },
          ]} />,
        },
        {
          id: 'activity',
          title: 'Activity',
          description: '最近 30 天该 App 发起的请求。',
          content: <RecentRequests items={recent} emptyText="最近 30 天没有匹配请求。" />,
        },
      ]}
    />
  );
}
