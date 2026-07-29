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
  getExchanges,
  getLogicalModels,
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
  ModelItem,
} from '@/lib/types';
import { Button, Card, Chip, InlineAlert, ReadOnlyNotice, SectionLoader } from '@/components/ui';
import { DetailsBlock, FormGrid, HelpPopover, PageBody, PageHeader, PageShell, Prose, TutorialLink } from '@/components/PageShell';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';
import { FIELD_INPUT, FIELD_LABEL, HINT_TEXT, MONO_META, TABLE_CELL_MUTED, TABLE_HEAD_CELL } from '@/lib/typography';
import { CARD_BODY, GAP, INSET_BLOCK } from '@/lib/surface';

const inputStyle: React.CSSProperties = {
  ...FIELD_INPUT,
};
const labelStyle: React.CSSProperties = FIELD_LABEL;

export function LogicalModelsPage() {
  const { tenant } = useAuth();
  const canWrite = canUseCapability(tenant?.role, 'configWrite');
  const [items, setItems] = useState<LogicalModelItem[] | null>(null);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [exchanges, setExchanges] = useState<ExchangeItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [offeringFor, setOfferingFor] = useState<string | null>(null);
  const [editingOfferingId, setEditingOfferingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<CreateLogicalModelRequest>({
    publicId: '', name: '', modelType: 'generation', capabilities: ['image_generation'],
    allowedAppCallerCodes: [], routingStrategy: 'priority', displayOrder: 100,
  });
  const [offeringDraft, setOfferingDraft] = useState<CreateModelOfferingRequest>({
    targetKind: 'model', targetId: '', priority: 100, weight: 100,
  });

  async function reload() {
    setError(null);
    const [logicalRes, modelsRes, exchangesRes] = await Promise.all([
      getLogicalModels(), getModels({ enabled: true }), getExchanges({ enabled: true }),
    ]);
    if (!logicalRes.success) {
      setError(logicalRes.error?.message || '加载逻辑模型失败');
      setItems([]);
      return;
    }
    setItems(logicalRes.data.items);
    if (modelsRes.success) setModels(modelsRes.data.items.filter((x) => x.authority === 'llm_gateway'));
    if (exchangesRes.success) setExchanges(exchangesRes.data.items.filter((x) => x.authority === 'llm_gateway'));
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
    if (!res.success) { setNotice(res.error?.message || '创建失败'); return; }
    setItems((prev) => [...(prev || []), res.data]);
    setDraft({ publicId: '', name: '', modelType: 'generation', capabilities: ['image_generation'], allowedAppCallerCodes: [], routingStrategy: 'priority', displayOrder: 100 });
    setCreateOpen(false);
    setNotice(`逻辑模型「${res.data.name}」已创建，请继续添加至少一个上游 Offering`);
  }

  async function submitOffering(event: React.FormEvent, logical: LogicalModelItem) {
    event.preventDefault();
    if (!offeringDraft.targetId) { setNotice('请选择上游目标'); return; }
    setBusy(`offering:${logical.id}`);
    const res = editingOfferingId
      ? await updateModelOffering(logical.id, editingOfferingId, {
          ...offeringDraft,
          maxConcurrency: offeringDraft.maxConcurrency ?? 0,
          rateLimitPerMinute: offeringDraft.rateLimitPerMinute ?? 0,
        })
      : await createModelOffering(logical.id, offeringDraft);
    setBusy(null);
    if (!res.success) { setNotice(res.error?.message || '添加 Offering 失败'); return; }
    setItems((prev) => prev?.map((x) => x.id === logical.id
      ? { ...x, offerings: editingOfferingId ? x.offerings.map((o) => o.id === editingOfferingId ? res.data : o) : [...x.offerings, res.data] }
      : x) || null);
    setOfferingFor(null);
    setEditingOfferingId(null);
    setOfferingDraft({ targetKind: 'model', targetId: '', priority: 100, weight: 100 });
    setNotice(editingOfferingId ? `已更新「${logical.name}」的上游 ${res.data.targetName}` : `已为「${logical.name}」添加上游 ${res.data.targetName}`);
  }

  async function changeStrategy(item: LogicalModelItem, routingStrategy: 'priority' | 'weighted') {
    setBusy(`strategy:${item.id}`);
    const res = await updateLogicalModel(item.id, { routingStrategy });
    setBusy(null);
    if (!res.success) { setNotice(res.error?.message || '更新路由策略失败'); return; }
    setItems((prev) => prev?.map((x) => x.id === item.id ? res.data : x) || null);
    setNotice(`「${item.name}」已切换为${routingStrategy === 'weighted' ? '权重负载均衡' : '优先级与故障切换'}`);
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
    if (!res.success) { setNotice(res.error?.message || '操作失败'); return; }
    setItems((prev) => prev?.map((x) => x.id === item.id ? { ...x, enabled: res.data.enabled } : x) || null);
  }

  async function toggleOffering(logical: LogicalModelItem, offeringId: string, enabled: boolean) {
    setBusy(offeringId);
    const res = await setModelOfferingEnabled(logical.id, offeringId, !enabled);
    setBusy(null);
    if (!res.success) { setNotice(res.error?.message || '操作失败'); return; }
    setItems((prev) => prev?.map((x) => x.id === logical.id
      ? { ...x, offerings: x.offerings.map((o) => o.id === offeringId ? res.data : o) }
      : x) || null);
  }

  const offeringCount = items?.reduce((sum, x) => sum + x.offerings.length, 0) ?? 0;

  return (
    <PageShell>
      <PageHeader
        title="逻辑模型目录"
        subtitle="应用只选择稳定的模型标识，接哪个上游由它下面的 Offering 决定。"
        summary={items ? (
          <>
            <span>模型 <strong>{items.length}</strong></span>
            <span>已启用 <strong>{items.filter((x) => x.enabled).length}</strong></span>
            <span>Offering <strong>{offeringCount}</strong></span>
          </>
        ) : undefined}
        actions={canWrite ? (
          <Button variant="primary" size="sm" onClick={() => setCreateOpen((x) => !x)}>{createOpen ? '收起' : '添加逻辑模型'}</Button>
        ) : null}
      />

      <PageBody>
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        {notice ? <InlineAlert tone="ok">{notice}</InlineAlert> : null}
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
                  <span>能力，逗号分隔</span>
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

        {(items ?? []).map((item) => (
          <Card key={item.id} style={CARD_BODY}>
            <div style={{ display: 'flex', gap: GAP.section, justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div>
                <div style={{ display: 'flex', gap: GAP.tight, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 'var(--fs-body)' }}>{item.name}</strong>
                  <code style={MONO_META}>{item.publicId}</code>
                  <Chip label={item.modelType} color="var(--text-secondary)" bg="var(--bg-elevated)" />
                  <Chip label={item.routingStrategy === 'weighted' ? '权重路由' : '优先级路由'} color="var(--text-secondary)" bg="var(--bg-elevated)" />
                  <Chip label={item.enabled ? '已启用' : '已停用'} color={item.enabled ? 'var(--ok)' : 'var(--text-muted)'} bg={item.enabled ? 'var(--ok-bg)' : 'var(--bg-elevated)'} />
                </div>
                <div style={{ ...HINT_TEXT, marginTop: GAP.tight }}>{item.capabilities.join(' · ') || '未声明能力'} · {item.offerings.length} 个 Offering</div>
                <div style={{ ...HINT_TEXT, marginTop: GAP.tight }}>可用 appCaller：{item.allowedAppCallerCodes.length > 0 ? item.allowedAppCallerCodes.join('、') : '当前租户全部 appCaller'}</div>
              </div>
              {canWrite ? <div style={{ display: 'flex', gap: GAP.tight, alignItems: 'center', flexWrap: 'wrap' }}>
                <select aria-label={`${item.name} 路由策略`} value={item.routingStrategy} disabled={busy === `strategy:${item.id}`} onChange={(e) => void changeStrategy(item, e.target.value as 'priority' | 'weighted')} style={{ ...inputStyle, width: 150 }}><option value="priority">优先级与故障切换</option><option value="weighted">权重负载均衡</option></select>
                <Button size="sm" onClick={() => openNewOffering(item.id)}>添加上游</Button><Button size="sm" variant="ghost" disabled={busy === item.id} onClick={() => void toggleLogical(item)}>{item.enabled ? '停用' : '启用'}</Button>
              </div> : null}
            </div>

            {offeringFor === item.id && canWrite ? (
              <form onSubmit={(e) => submitOffering(e, item)} style={{ ...INSET_BLOCK, marginTop: GAP.section }}>
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

            <div style={{ marginTop: GAP.section, overflowX: 'auto' }}>
              <table className="lg-data-table" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
                <thead><tr>{['上游', '目标类型', '协议', '优先级 / 权重', '健康', '治理', '操作'].map((x) => <th key={x} style={TABLE_HEAD_CELL}>{x}</th>)}</tr></thead>
                <tbody>{item.offerings.length === 0 ? <tr><td colSpan={7} style={td}>还没有可用上游，当前逻辑模型不会承接请求。</td></tr> : item.offerings.map((o) => (
                  <tr key={o.id}>
                    <td style={td}><strong>{o.targetName}</strong><div style={HINT_TEXT}>{o.providerName || o.upstreamModelId || o.targetId}</div></td>
                    <td style={td}>{o.targetKind}</td><td style={td}>{o.protocol || '继承目标'}</td><td style={td}>{o.priority} / {o.weight}</td>
                    <td style={td}>{o.healthStatus === 0 ? '健康' : o.healthStatus === 1 ? '降权' : '不可用'}{o.consecutiveFailures > 0 ? ` · 连续失败 ${o.consecutiveFailures}` : ''}</td>
                    <td style={td}>{o.maxConcurrency ? `并发 ${o.maxConcurrency}` : '继承上游'}{o.rateLimitPerMinute ? ` · ${o.rateLimitPerMinute}/分钟` : ''}</td>
                    <td style={td}>{canWrite ? <div style={{ display: 'flex', gap: GAP.tight }}><Button size="sm" variant="ghost" onClick={() => openOfferingEditor(item.id, o)}>编辑</Button><Button size="sm" variant="ghost" disabled={busy === o.id} onClick={() => void toggleOffering(item, o.id, o.enabled)}>{o.enabled ? '停用' : '启用'}</Button></div> : (o.enabled ? '已启用' : '已停用')}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </Card>
        ))}

        <DetailsBlock title="工作原理：逻辑模型、Offering 与模型池的分工">
          <Prose>
            应用侧只写一个稳定的模型标识，Provider、Endpoint、协议、密钥、限流和故障切换全部由它下面的
            Offering 维护；换供应商、换 Endpoint、加一路备用上游都不需要业务改代码。
          </Prose>
          <Prose>
            模型池是另一件事：它只负责请求没有指定模型时的默认选择与兜底，指定了模型标识的请求一律走这里的
            Offering 列表。一个逻辑模型没有可用 Offering 时不会承接请求，也不会被模型池顶上。
          </Prose>
          <TutorialLink chapter="chapter-18">查看教程：第 18 章 逻辑模型与 Offering</TutorialLink>
        </DetailsBlock>
      </PageBody>
    </PageShell>
  );
}

const td: React.CSSProperties = TABLE_CELL_MUTED;
