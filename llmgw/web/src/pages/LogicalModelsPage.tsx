// 逻辑模型目录：应用只认一个稳定的模型标识，具体接哪个上游由它下面的 Offering 决定。
//
// 「控制台风格调性 v1.2」迁移要点（详见
// doc/rule.platform.llm-gateway.console-design-tonality.md 原则 6 / 7）：
//   - 走 PageShell / PageHeader / PageBody 骨架；页头里那句 maxWidth:760 一并删掉，
//     副标题宽度已由 .lg-page-heading p 的 --measure 统一约束，页面不再自己拍数。
//   - 创建卡此前是 padding:16，是全站第三种卡片内边距（另两种是 CARD_PADDING 14 与
//     INSET_PADDING 10）。漂移检测按「卡片内边距种类不超过基准页」判定，故归一到 CARD_BODY。
//     两处表单栅格从 repeat(auto-fit, minmax(N, 1fr)) 换成 FormGrid，宽屏下输入框不再被拉长。
//   - 提示条此前手写 var(--danger) / var(--success)：这两个 token 在 theme.css 里**从未定义**，
//     整条 color 声明因此作废，报错文字根本没变红。语义色只有 --ok / --warn / --err / --info，
//     页面级提示统一改走 ui.tsx 的 InlineAlert，chip 的启用色改 --ok。
//   - 文字预算：Provider/Endpoint/协议/密钥归属、模型池兜底、两种路由策略的算法收进
//     默认收起的 DetailsBlock 并深链教程第 18 章；字段口径收进字段旁的 HelpPopover。
//   - 元信息（publicId）走 MONO_META，不再用 --fs-micro 排成句解释。
//
// 本路由被 e2e/llmgw-layout-drift.mjs 监测：新增上游与新建模型都必须留在页面内联表单里，
// 不要改成抽屉或对话框——被测的扁平 DOM 一旦变成浮层，量到的就不是这一页的版式了。
import { useEffect, useMemo, useState } from 'react';
import {
  createLogicalModel,
  createModelOffering,
  deleteLogicalModel,
  getExchanges,
  getLogicalModels,
  getLogicalModelUsage,
  getModels,
  setLogicalModelEnabled,
  setModelOfferingEnabled,
  updateLogicalModel,
  updateModelOffering,
} from '@/lib/api';
import type {
  CreateLogicalModelRequest,
  CreateModelOfferingRequest,
  ExchangeItem,
  LogicalModelItem,
  LogicalModelUsageItem,
  ModelItem,
  ModelOfferingItem,
} from '@/lib/types';
import { Button, Card, Chip, InlineAlert, ReadOnlyNotice, SectionLoader } from '@/components/ui';
import { DetailsBlock, FormGrid, HelpPopover, PageBody, PageHeader, PageShell, Prose, TutorialLink } from '@/components/PageShell';
import { useDialogs } from '@/components/ConfirmDialog';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT, METRIC_CAPTION, MONO_META } from '@/lib/typography';
import { CARD_BODY, CARD_PADDING, GAP, INSET_BLOCK } from '@/lib/surface';
import { RouteDot, UpstreamMark, UsageSparkline, type RouteHealth } from '@/components/ModelRouteVisuals';

const inputStyle: React.CSSProperties = {
  ...FIELD_INPUT,
};
const labelStyle: React.CSSProperties = FIELD_LABEL;
const DEFAULT_IMAGE_GENERATION_CAPABILITIES = ['image_generation', 'text2img', 'img2img', 'vision_generation'];

function defaultImageGenerationCapabilities() {
  return [...DEFAULT_IMAGE_GENERATION_CAPABILITIES];
}

export function LogicalModelsPage() {
  const { tenant } = useAuth();
  const canWrite = canUseCapability(tenant?.role, 'configWrite');
  const { promptText } = useDialogs();
  const [items, setItems] = useState<LogicalModelItem[] | null>(null);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [exchanges, setExchanges] = useState<ExchangeItem[]>([]);
  // 近 30 天用量：列表那条趋势线与花费列的唯一数据源。拉不到就整列不渲染，
  // 不画一条假的平滑曲线——「没数据」和「用量平稳」是两件事，画成一样会误导。
  const [usage, setUsage] = useState<Map<string, LogicalModelUsageItem> | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 带 tone 的提示：此前是裸字符串 + 固定 tone="ok"，10 个写入点里有 6 个是失败路径，
  // 于是「更新路由策略失败」会渲染成一条绿色成功条 —— 运维会以为改动生效了（Codex P2）。
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const okNotice = (text: string) => setNotice({ tone: 'ok', text });
  const failNotice = (text: string) => setNotice({ tone: 'error', text });
  const [createOpen, setCreateOpen] = useState(false);
  const [offeringFor, setOfferingFor] = useState<string | null>(null);
  const [editingOfferingId, setEditingOfferingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<CreateLogicalModelRequest>({
    publicId: '', name: '', modelType: 'generation', capabilities: defaultImageGenerationCapabilities(),
    allowedAppCallerCodes: [], routingStrategy: 'priority', displayOrder: 100,
  });
  const [offeringDraft, setOfferingDraft] = useState<CreateModelOfferingRequest>({
    targetKind: 'model', targetId: '', priority: 100, weight: 100,
  });

  async function reload() {
    setError(null);
    const [logicalRes, modelsRes, exchangesRes, usageRes] = await Promise.all([
      getLogicalModels(), getModels({ enabled: true }), getExchanges({ enabled: true }), getLogicalModelUsage(30),
    ]);
    if (!logicalRes.success) {
      setError(logicalRes.error?.message || '加载逻辑模型失败');
      setItems([]);
      return;
    }
    setItems(logicalRes.data.items);
    if (modelsRes.success) setModels(modelsRes.data.items.filter((x) => x.authority === 'llm_gateway'));
    if (exchangesRes.success) setExchanges(exchangesRes.data.items.filter((x) => x.authority === 'llm_gateway'));
    // 用量只是锦上添花，取不到不该让整页报错——列表照常渲染，那一列留空。
    setUsage(usageRes.success ? new Map(usageRes.data.items.map((x) => [x.publicId, x])) : null);
  }

  useEffect(() => { void reload(); }, []);

  const targets = useMemo(() => offeringDraft.targetKind === 'model'
    ? models.map((x) => ({ id: x.id, label: `${x.name || x.modelName} · ${x.modelName}` }))
    : exchanges.map((x) => ({ id: x.id, label: x.name })), [models, exchanges, offeringDraft.targetKind]);

  async function submitLogical(event: React.FormEvent) {
    event.preventDefault();
    setBusy('create-logical');
    setNotice(null);
    const request = {
      ...draft,
      publicId: draft.publicId.trim(), name: draft.name.trim(),
      capabilities: draft.capabilities.map((x) => x.trim()).filter(Boolean),
      allowedAppCallerCodes: draft.allowedAppCallerCodes.map((x) => x.trim()).filter(Boolean),
      description: draft.description?.trim() || undefined,
    };
    const res = await createLogicalModel(request);
    setBusy(null);
    if (!res.success) { failNotice(res.error?.message || '创建失败'); return; }
    setItems((prev) => [...(prev || []), res.data]);
    setDraft({ publicId: '', name: '', modelType: 'generation', capabilities: defaultImageGenerationCapabilities(), allowedAppCallerCodes: [], routingStrategy: 'priority', displayOrder: 100 });
    setCreateOpen(false);
    okNotice(`逻辑模型「${res.data.name}」已创建，请继续添加至少一个上游 Offering`);
  }

  async function submitOffering(event: React.FormEvent, logical: LogicalModelItem) {
    event.preventDefault();
    if (!offeringDraft.targetId) { failNotice('请选择上游目标'); return; }
    setBusy(`offering:${logical.id}`);
    const res = editingOfferingId
      ? await updateModelOffering(logical.id, editingOfferingId, {
          ...offeringDraft,
          maxConcurrency: offeringDraft.maxConcurrency ?? 0,
          rateLimitPerMinute: offeringDraft.rateLimitPerMinute ?? 0,
        })
      : await createModelOffering(logical.id, offeringDraft);
    setBusy(null);
    if (!res.success) { failNotice(res.error?.message || '添加 Offering 失败'); return; }
    setItems((prev) => prev?.map((x) => x.id === logical.id
      ? { ...x, offerings: editingOfferingId ? x.offerings.map((o) => o.id === editingOfferingId ? res.data : o) : [...x.offerings, res.data] }
      : x) || null);
    setOfferingFor(null);
    setEditingOfferingId(null);
    setOfferingDraft({ targetKind: 'model', targetId: '', priority: 100, weight: 100 });
    okNotice(editingOfferingId ? `已更新「${logical.name}」的上游 ${res.data.targetName}` : `已为「${logical.name}」添加上游 ${res.data.targetName}`);
  }

  async function changeStrategy(item: LogicalModelItem, routingStrategy: 'priority' | 'weighted') {
    setBusy(`strategy:${item.id}`);
    const res = await updateLogicalModel(item.id, { routingStrategy });
    setBusy(null);
    if (!res.success) { failNotice(res.error?.message || '更新路由策略失败'); return; }
    setItems((prev) => prev?.map((x) => x.id === item.id ? res.data : x) || null);
    okNotice(`「${item.name}」已切换为${routingStrategy === 'weighted' ? '权重负载均衡' : '优先级与故障切换'}`);
  }

  function openNewOffering(logicalId: string) {
    setOfferingFor((current) => current === logicalId && editingOfferingId === null ? null : logicalId);
    setEditingOfferingId(null);
    setOfferingDraft({ targetKind: 'model', targetId: '', priority: 100, weight: 100 });
  }

  function openOfferingEditor(logicalId: string, offering: LogicalModelItem['offerings'][number]) {
    setOfferingFor(logicalId);
    setEditingOfferingId(offering.id);
    setOfferingDraft({
      targetKind: offering.targetKind,
      targetId: offering.targetId,
      upstreamModelId: offering.upstreamModelId || undefined,
      protocol: offering.protocol || undefined,
      endpointPath: offering.endpointPath || undefined,
      priority: offering.priority,
      weight: offering.weight,
      maxConcurrency: offering.maxConcurrency || undefined,
      rateLimitPerMinute: offering.rateLimitPerMinute || undefined,
      notes: offering.notes || undefined,
    });
  }

  async function toggleLogical(item: LogicalModelItem) {
    setBusy(item.id);
    const res = await setLogicalModelEnabled(item.id, !item.enabled);
    setBusy(null);
    if (!res.success) { failNotice(res.error?.message || '操作失败'); return; }
    setItems((prev) => prev?.map((x) => x.id === item.id ? { ...x, enabled: res.data.enabled } : x) || null);
  }

  // Offering 是逻辑模型自己的下挂路由，没有别处引用，所以删除是连带删而不是阻挡。
  // 但连带删对运维是「一次点击删掉 N 条」，必须先把 N 报出来再让他确认。
  async function removeLogical(item: LogicalModelItem) {
    const typed = await promptText({
      title: `删除逻辑模型「${item.name}」`,
      description: `${item.publicId}\n它名下 ${item.offerings.length} 条 Offering 会一并删除，无法撤销。`,
      inputLabel: '确认请输入 publicId',
      requireExact: item.publicId,
      tone: 'danger',
      confirmLabel: '删除',
    });
    if (typed === null) return;
    if (typed.trim() !== item.publicId) { failNotice('输入的 publicId 不一致，已取消删除'); return; }
    setBusy(item.id);
    setNotice(null);
    const res = await deleteLogicalModel(item.id);
    setBusy(null);
    if (!res.success) { failNotice(res.error?.message || '删除失败'); return; }
    setItems((prev) => prev?.filter((x) => x.id !== item.id) || null);
    okNotice(`已删除「${item.name}」，连带 ${res.data.offeringsDeleted} 条 Offering`);
  }

  async function toggleOffering(logical: LogicalModelItem, offeringId: string, enabled: boolean) {
    setBusy(offeringId);
    const res = await setModelOfferingEnabled(logical.id, offeringId, !enabled);
    setBusy(null);
    if (!res.success) { failNotice(res.error?.message || '操作失败'); return; }
    setItems((prev) => prev?.map((x) => x.id === logical.id
      ? { ...x, offerings: x.offerings.map((o) => o.id === offeringId ? res.data : o) }
      : x) || null);
  }

  const offeringCount = items?.reduce((sum, x) => sum + x.offerings.length, 0) ?? 0;
  // 抬头先给结论再给数字：一排孤零零的计数读完不知道该干嘛，出问题的那几个才是要先看的。
  const attention = useMemo(() => (items ?? [])
    .filter((x) => x.enabled)
    .map((x) => ({ item: x, health: summarizeHealth(x, describeRoutes(x, models)) }))
    .filter((x) => x.health.tone === 'warn'), [items, models]);
  const monthlyCostUsd = useMemo(
    () => [...(usage?.values() ?? [])].reduce((sum, x) => sum + (x.totalCostUsd || 0), 0),
    [usage]);
  const unpricedCalls = useMemo(
    () => [...(usage?.values() ?? [])].reduce((sum, x) => sum + (x.unpricedCalls || 0), 0),
    [usage]);

  return (
    <PageShell>
      <PageHeader
        title="模型白名单"
        subtitle={attention.length === 0
          ? '名单外的调用一律拒绝。应用只选择稳定的模型标识，接哪个上游由它下面的线路决定。'
          : `${attention.map((x) => x.item.name).join('、')} 需要看一眼，其余线路正常。`}
        summary={items ? (
          <>
            <span>名单内 <strong>{items.length}</strong> 个模型 · <strong>{offeringCount}</strong> 条线路</span>
            <span>已启用 <strong>{items.filter((x) => x.enabled).length}</strong></span>
            {usage ? <span>近 30 天 <strong>{formatUsd(monthlyCostUsd)}</strong></span> : null}
            {unpricedCalls > 0 ? <span>缺价调用 <strong>{formatCount(unpricedCalls)}</strong> 次未计入</span> : null}
          </>
        ) : undefined}
        actions={canWrite ? (
          <Button variant="primary" size="sm" onClick={() => setCreateOpen((x) => !x)}>{createOpen ? '收起' : '添加逻辑模型'}</Button>
        ) : null}
      />

      <PageBody>
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        {notice ? <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert> : null}
        {!canWrite ? <ReadOnlyNotice /> : null}

        {createOpen && canWrite ? (
          <Card style={CARD_BODY}>
            <form onSubmit={submitLogical}>
              <FormGrid>
                <label style={labelStyle}>
                  <span>公开模型标识</span>
                  <input required value={draft.publicId} onChange={(e) => setDraft((x) => ({ ...x, publicId: e.target.value }))} placeholder="例如 image2" style={inputStyle} />
                </label>
                <label style={labelStyle}>
                  <span>显示名称</span>
                  <input required value={draft.name} onChange={(e) => setDraft((x) => ({ ...x, name: e.target.value }))} placeholder="例如 GPT Image 2" style={inputStyle} />
                </label>
                <label style={labelStyle}>
                  <span>模型类型</span>
                  <select value={draft.modelType} onChange={(e) => setDraft((x) => ({ ...x, modelType: e.target.value }))} style={inputStyle}>
                    <option value="generation">generation</option>
                    <option value="vision">vision</option>
                    <option value="chat">chat</option>
                    <option value="video-gen">video-gen</option>
                  </select>
                </label>
                <label style={labelStyle}>
                  <span>
                    路由策略
                    <HelpPopover label="路由策略">
                      优先级与故障切换按 priority 从小到大依次尝试，上一个上游不可用才轮到下一个；
                      权重负载均衡按 weight 在健康的上游之间分配流量。建好之后随时可以在卡片右上角改。
                    </HelpPopover>
                  </span>
                  <select value={draft.routingStrategy} onChange={(e) => setDraft((x) => ({ ...x, routingStrategy: e.target.value as 'priority' | 'weighted' }))} style={inputStyle}>
                    <option value="priority">优先级与故障切换</option>
                    <option value="weighted">按权重负载均衡</option>
                  </select>
                </label>
                <label style={labelStyle}>
                  <span>
                    能力，逗号分隔
                    <HelpPopover label="图片生成场景能力">
                      图片生成默认覆盖文生图、图生图和视觉参考生成；删除某个细分能力即可限制对应场景。
                    </HelpPopover>
                  </span>
                  <input value={draft.capabilities.join(', ')} onChange={(e) => setDraft((x) => ({ ...x, capabilities: e.target.value.split(',') }))} style={inputStyle} />
                </label>
                <label style={labelStyle}>
                  <span>
                    允许的 appCaller
                    <HelpPopover label="允许的 appCaller" align="end">
                      多个用逗号分隔。留空表示当前租户里的全部 appCaller 都能用这个模型标识；
                      填了就只有列出来的调用方能用，其余请求会被拒绝。
                    </HelpPopover>
                  </span>
                  <input value={draft.allowedAppCallerCodes.join(', ')} onChange={(e) => setDraft((x) => ({ ...x, allowedAppCallerCodes: e.target.value.split(',').filter(Boolean) }))} style={inputStyle} />
                </label>
                <Button type="submit" variant="primary" size="sm" disabled={busy === 'create-logical'}>{busy === 'create-logical' ? '保存中' : '保存逻辑模型'}</Button>
              </FormGrid>
            </form>
          </Card>
        ) : null}

        {items === null ? <SectionLoader text="正在加载逻辑模型目录" /> : null}

        {items !== null && items.length === 0 ? (
          <Card style={{ ...CARD_BODY, flex: 1, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
            <Prose>尚无逻辑模型。先创建模型，再把一个或多个上游模型或 Exchange 绑定为 Offering。</Prose>
          </Card>
        ) : null}

        {items !== null && items.length > 0 ? (
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ ...ROW_GRID, ...ROW_HEAD }}>
              <span style={COL_CAP}>模型</span>
              <span style={COL_CAP}>上游线路与单价</span>
              <span style={COL_CAP}>近 30 天</span>
              <span style={COL_CAP}>状态</span>
              <span />
            </div>

            {(items ?? []).map((item) => {
              const routes = describeRoutes(item, models);
              const stat = usage?.get(item.publicId) ?? null;
              const open = expanded === item.id;
              const health = summarizeHealth(item, routes);
              return (
                <div key={item.id} style={{ borderTop: '1px solid var(--border-subtle)', background: health.tone === 'warn' ? 'var(--warn-bg)' : undefined, boxShadow: health.tone === 'warn' ? 'inset 3px 0 0 var(--warn)' : undefined }}>
                  <div style={ROW_GRID}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, minWidth: 0 }}>
                      <UpstreamMark hints={[routes[0]?.providerName, routes[0]?.upstreamModelId, item.publicId]} />
                      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <strong style={{ fontSize: 'var(--fs-body)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.name}</strong>
                        <span style={{ ...MONO_META, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {item.publicId} · {describeScope(item.allowedAppCallerCodes)}
                        </span>
                      </span>
                    </span>

                    <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                      {routes.length === 0
                        ? <span style={{ ...HINT_TEXT, color: 'var(--warn)' }}>没有上游线路，这个模型不承接请求</span>
                        : routes.map((route) => (
                          <span key={route.id} style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, opacity: route.health === 'live' ? 1 : 0.66, minWidth: 0 }}>
                            <RouteDot health={route.health} />
                            <span style={{ fontSize: 'var(--fs-caption)', whiteSpace: 'nowrap' }}>{route.label}</span>
                            <span style={route.priced ? { ...MONO_META, whiteSpace: 'nowrap' } : { ...HINT_TEXT, whiteSpace: 'nowrap' }}>{route.price}</span>
                            <span style={{ ...HINT_TEXT, whiteSpace: 'nowrap' }}>{route.roleLabel}</span>
                          </span>
                        ))}
                    </span>

                    <span style={{ display: 'flex', alignItems: 'center', gap: GAP.normal }}>
                      {stat ? (
                        <>
                          <UsageSparkline values={stat.dailyCalls} title={`近 30 天 ${stat.totalCalls} 次调用`} />
                          <span style={{ display: 'flex', flexDirection: 'column' }}>
                            <span style={{ ...MONO_META, color: 'var(--text-primary)' }}>{formatUsd(stat.totalCostUsd)}</span>
                            <span style={HINT_TEXT}>{formatCount(stat.totalCalls)} 次</span>
                          </span>
                        </>
                      ) : <span style={HINT_TEXT}>暂无</span>}
                    </span>

                    <span style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, minWidth: 0 }}>
                      <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, flexShrink: 0, background: health.dot }} />
                      <span style={{ fontSize: 'var(--fs-secondary)', color: health.tone === 'warn' ? 'var(--warn)' : 'var(--text-secondary)' }}>{health.text}</span>
                    </span>

                    <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setExpanded((x) => (x === item.id ? null : item.id))}>
                      {open ? '收起' : '展开'}
                    </Button>
                  </div>

                  {open ? (
                    <div style={{ padding: `0 ${CARD_PADDING}px ${CARD_PADDING}px 46px`, display: 'flex', flexDirection: 'column', gap: GAP.section }}>
                      {health.tone === 'warn' && health.advice ? <InlineAlert tone="info">{health.advice}</InlineAlert> : null}

                      <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, flexWrap: 'wrap' }}>
                        <Chip label={item.modelType} color="var(--text-secondary)" bg="var(--bg-elevated)" />
                        <Chip label={item.enabled ? '已启用' : '已停用'} color={item.enabled ? 'var(--ok)' : 'var(--text-muted)'} bg={item.enabled ? 'var(--ok-bg)' : 'var(--bg-elevated)'} />
                        <span style={HINT_TEXT}>{item.capabilities.join(' · ') || '未声明能力'}</span>
                        {canWrite ? (
                          <>
                            <span style={{ flex: 1 }} />
                            <select aria-label={`${item.name} 路由策略`} value={item.routingStrategy} disabled={busy === `strategy:${item.id}`} onChange={(e) => void changeStrategy(item, e.target.value as 'priority' | 'weighted')} style={{ ...inputStyle, width: 150 }}>
                              <option value="priority">优先级与故障切换</option>
                              <option value="weighted">权重负载均衡</option>
                            </select>
                            <Button size="sm" onClick={() => openNewOffering(item.id)}>添加上游</Button>
                            <Button size="sm" variant="ghost" disabled={busy === item.id} onClick={() => void toggleLogical(item)}>{item.enabled ? '停用' : '启用'}</Button>
                            <Button size="sm" variant="ghost" disabled={busy === item.id} onClick={() => void removeLogical(item)}>删除</Button>
                          </>
                        ) : null}
                      </div>

                      {offeringFor === item.id && canWrite ? (
                        <form onSubmit={(e) => submitOffering(e, item)} style={INSET_BLOCK}>
                          <FormGrid>
                            <label style={labelStyle}>
                              <span>目标类型</span>
                              <select disabled={editingOfferingId !== null} value={offeringDraft.targetKind} onChange={(e) => setOfferingDraft((x) => ({ ...x, targetKind: e.target.value as 'model' | 'exchange', targetId: '' }))} style={inputStyle}>
                                <option value="model">Provider 模型</option>
                                <option value="exchange">Exchange</option>
                              </select>
                            </label>
                            <label style={labelStyle}>
                              <span>上游目标</span>
                              <select disabled={editingOfferingId !== null} required value={offeringDraft.targetId} onChange={(e) => setOfferingDraft((x) => ({ ...x, targetId: e.target.value }))} style={inputStyle}>
                                <option value="">请选择</option>
                                {targets.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                              </select>
                            </label>
                            <label style={labelStyle}>
                              <span>
                                上游模型标识
                                <HelpPopover label="上游模型标识">
                                  留空就沿用上面所选目标自己登记的模型名；只有同一个上游要用另一个模型名时才在这里覆盖。
                                  协议与 Endpoint path 两栏同理，填了才覆盖。
                                </HelpPopover>
                              </span>
                              <input value={offeringDraft.upstreamModelId || ''} onChange={(e) => setOfferingDraft((x) => ({ ...x, upstreamModelId: e.target.value }))} style={inputStyle} />
                            </label>
                            <label style={labelStyle}>
                              <span>协议</span>
                              <input value={offeringDraft.protocol || ''} onChange={(e) => setOfferingDraft((x) => ({ ...x, protocol: e.target.value }))} placeholder="openai / google / exchange" style={inputStyle} />
                            </label>
                            <label style={labelStyle}>
                              <span>Endpoint path</span>
                              <input value={offeringDraft.endpointPath || ''} onChange={(e) => setOfferingDraft((x) => ({ ...x, endpointPath: e.target.value }))} placeholder="例如 v1beta/models/{model}:generateContent" style={inputStyle} />
                            </label>
                            <label style={labelStyle}>
                              <span>优先级</span>
                              <input type="number" min={0} value={offeringDraft.priority ?? 100} onChange={(e) => setOfferingDraft((x) => ({ ...x, priority: Number(e.target.value) }))} style={inputStyle} />
                            </label>
                            <label style={labelStyle}>
                              <span>权重</span>
                              <input type="number" min={1} value={offeringDraft.weight ?? 100} onChange={(e) => setOfferingDraft((x) => ({ ...x, weight: Number(e.target.value) }))} style={inputStyle} />
                            </label>
                            <label style={labelStyle}>
                              <span>
                                最大并发
                                <HelpPopover label="最大并发">
                                  留空表示继承上游自己的并发上限；每分钟速率留空表示这一层不额外限流。
                                  两栏都填时，本条上游与上游本身的限制同时生效，任一层触顶都会让请求切到下一个上游。
                                </HelpPopover>
                              </span>
                              <input type="number" min={1} max={10000} value={offeringDraft.maxConcurrency ?? ''} onChange={(e) => setOfferingDraft((x) => ({ ...x, maxConcurrency: e.target.value ? Number(e.target.value) : undefined }))} style={inputStyle} />
                            </label>
                            <label style={labelStyle}>
                              <span>每分钟速率</span>
                              <input type="number" min={1} max={1000000} value={offeringDraft.rateLimitPerMinute ?? ''} onChange={(e) => setOfferingDraft((x) => ({ ...x, rateLimitPerMinute: e.target.value ? Number(e.target.value) : undefined }))} style={inputStyle} />
                            </label>
                            <label style={labelStyle}>
                              <span>运维备注</span>
                              <input value={offeringDraft.notes || ''} onChange={(e) => setOfferingDraft((x) => ({ ...x, notes: e.target.value }))} style={inputStyle} />
                            </label>
                            <Button type="submit" variant="primary" size="sm" disabled={busy === `offering:${item.id}`}>{busy === `offering:${item.id}` ? '保存中' : editingOfferingId ? '保存修改' : '保存 Offering'}</Button>
                            {editingOfferingId ? <Button type="button" size="sm" variant="ghost" onClick={() => openNewOffering(item.id)}>取消编辑</Button> : null}
                          </FormGrid>
                        </form>
                      ) : null}

                      {routes.map((route) => (
                        <div key={`detail-${route.id}`} style={{ ...INSET_BLOCK, display: 'flex', alignItems: 'center', gap: GAP.section }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: GAP.normal, width: 200, flexShrink: 0 }}>
                            <RouteDot health={route.health} />
                            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                              <strong style={{ fontSize: 'var(--fs-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{route.label}</strong>
                              <span style={HINT_TEXT}>{route.roleLabel} · 协议 {route.protocol}</span>
                            </span>
                          </span>
                          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                            <span style={HINT_TEXT}>{route.priceOrigin}</span>
                            <span style={HINT_TEXT}>优先级 {route.priority} · 权重 {route.weight} · {route.governance}</span>
                          </span>
                          {canWrite ? (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => openOfferingEditor(item.id, route.offering)}>编辑</Button>
                              <Button size="sm" variant="ghost" disabled={busy === route.id} onClick={() => void toggleOffering(item, route.id, route.offering.enabled)}>{route.offering.enabled ? '停用' : '启用'}</Button>
                            </>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </Card>
        ) : null}

        <DetailsBlock title="工作原理：逻辑模型、Offering 与模型池的分工">
          <Prose>
            应用侧只写一个稳定的模型标识，Provider、Endpoint、协议、密钥、限流和故障切换全部由它下面的
            Offering 维护；换供应商、换 Endpoint、加一路备用上游都不需要业务改代码。
          </Prose>
          <Prose>
            模型池是另一件事：它只负责请求没有指定模型时的默认选择与兜底，指定了模型标识的请求一律走这里的
            Offering 列表。一个逻辑模型没有可用 Offering 时不会承接请求，也不会被模型池顶上。
          </Prose>
          <TutorialLink chapter="practical-image-01">查看教程：如何给视觉创作增加图片模型</TutorialLink>
        </DetailsBlock>
      </PageBody>
    </PageShell>
  );
}

// ── 列表行的版式常量 ──────────────────────────────────────────────
// 五列定宽而不是 auto：十来行模型的列头必须对齐，auto 会让每行各算各的宽度。
const ROW_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 320px 168px 156px 64px',
  alignItems: 'center',
  gap: GAP.page,
  padding: `${GAP.section}px ${CARD_PADDING}px`,
};
const ROW_HEAD: React.CSSProperties = { background: 'var(--bg-base)', paddingTop: GAP.normal, paddingBottom: GAP.normal };
const COL_CAP: React.CSSProperties = { ...METRIC_CAPTION, whiteSpace: 'nowrap' };

/**
 * 团队授权只给数量，不平铺名字。
 *
 * 平铺的写法在样例数据下看着挺好（「研发、产品」），一旦部门多起来或者名字长起来
 * 就会把整行撑爆，而列宽是定死的。数量不会变长，名字留在展开态里看。
 */
function describeScope(allowedAppCallerCodes: string[]): string {
  return allowedAppCallerCodes.length === 0 ? '全部 appCaller' : `限 ${allowedAppCallerCodes.length} 个 appCaller`;
}

type RouteView = {
  id: string;
  offering: ModelOfferingItem;
  label: string;
  providerName?: string | null;
  upstreamModelId?: string | null;
  price: string;
  /** 价格是不是真有值。没值时那一格是说明文字，不该用等宽排版——中文在等宽下发虚。 */
  priced: boolean;
  priceOrigin: string;
  protocol: string;
  priority: number;
  weight: number;
  governance: string;
  health: RouteHealth;
  roleLabel: string;
};

/**
 * 把一个逻辑模型的 Offering 列表翻译成「线路」——列表上一条线路一行。
 *
 * 单价取的是这条线路指向的那个物理模型自己的价格：同一个模型走官网和走中转单价不同，
 * 不折算成一个统一价（用户口径：几条线路就报几个价，统计诚实即可）。
 * Exchange 线路当前没有价格字段，如实写「未登记」，不拿别处的价顶上。
 */
function describeRoutes(item: LogicalModelItem, models: ModelItem[]): RouteView[] {
  const ordered = [...item.offerings].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  // 「谁在扛流量」= 第一条既启用又健康的线路。全挂了就没有 live，不硬指一条。
  const liveId = ordered.find((x) => x.enabled && x.healthStatus === 0)?.id ?? null;

  return ordered.map((offering) => {
    const model = offering.targetKind === 'model' ? models.find((x) => x.id === offering.targetId) : undefined;
    const health: RouteHealth = !offering.enabled ? 'disabled'
      : offering.healthStatus === 2 ? 'down'
      : offering.id === liveId ? 'live'
      : 'standby';
    return {
      id: offering.id,
      offering,
      label: offering.providerName || offering.targetName || offering.targetId,
      providerName: offering.providerName,
      upstreamModelId: offering.upstreamModelId,
      price: formatRoutePrice(model),
      priced: hasPrice(model),
      priceOrigin: describePriceOrigin(model),
      protocol: offering.protocol || '继承目标',
      priority: offering.priority,
      weight: offering.weight,
      governance: offering.maxConcurrency ? `并发 ${offering.maxConcurrency}` : '并发继承上游',
      health,
      roleLabel: !offering.enabled ? '已停用'
        : offering.healthStatus === 2 ? '熔断'
        : offering.id === liveId ? '主' : '备',
    };
  });
}

function hasPrice(model: ModelItem | undefined): boolean {
  if (!model) return false;
  return model.pricePerCall != null || model.inputPricePerMillion != null || model.outputPricePerMillion != null;
}

/** 单价文案。没登记就说没登记——缺价不挡调用，但也不能假装有价。 */
function formatRoutePrice(model: ModelItem | undefined): string {
  if (!model) return '单价未登记';
  if (model.pricePerCall != null) return `${formatUsd(model.pricePerCall)} / 次`;
  const input = model.inputPricePerMillion;
  const output = model.outputPricePerMillion;
  if (input == null && output == null) return '单价未登记';
  return `${input == null ? '—' : formatUsd(input)} / ${output == null ? '—' : formatUsd(output)}`;
}

function describePriceOrigin(model: ModelItem | undefined): string {
  if (!model) return '单价未登记';
  if (model.priceCurrency && model.priceCurrency !== 'USD') return `价格按 ${model.priceCurrency} 记，未换算成美金`;
  if (!hasPrice(model)) return '单价未登记，这条线路的调用算不出钱';
  const source = model.priceSource === 'upstream' ? '上游返回'
    : model.priceSource === 'admin' ? '人工录入'
    : model.priceSource === 'migrated' ? '历史价换算' : '来源不详';
  const age = model.priceAgeDays == null ? '' : `，${model.priceAgeDays} 天前取的`;
  return `价格${source}${age}${model.priceStale ? '（已过复核期）' : ''}`;
}

type HealthSummary = { text: string; dot: string; tone: 'ok' | 'warn'; advice?: string };

/** 一行只给一句结论：要不要管。细节留给展开态。 */
function summarizeHealth(item: LogicalModelItem, routes: RouteView[]): HealthSummary {
  if (!item.enabled) return { text: '已停用', dot: 'var(--text-muted)', tone: 'ok' };
  if (routes.length === 0) {
    return { text: '没有上游', dot: 'var(--warn)', tone: 'warn', advice: '这个模型下面还没有上游线路，它不会承接任何请求。先添加一条上游。' };
  }
  const down = routes.filter((x) => x.health === 'down');
  const live = routes.find((x) => x.health === 'live');
  if (down.length > 0 && live) {
    return {
      text: '已自动切走',
      dot: 'var(--warn)',
      tone: 'warn',
      advice: `${down.map((x) => x.label).join('、')} 连续失败已被摘掉，流量正走 ${live.label}。冷却期满后系统会拿一条真实请求去试探，成功就自己回来，不用等人处理。`,
    };
  }
  if (!live) {
    return { text: '无可用线路', dot: 'var(--err)', tone: 'warn', advice: '所有上游线路都不可用，这个模型当前会解析失败。检查上游密钥与配额，或在展开里手动恢复一条。' };
  }
  if (routes.length === 1) return { text: '正常 · 单线路', dot: 'var(--ok)', tone: 'ok' };
  return { text: '正常', dot: 'var(--ok)', tone: 'ok' };
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '$0.00';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function formatCount(value: number): string {
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 万`;
  return value.toLocaleString('en-US');
}

