// Exchange：把非 OpenAI/Claude 标准上游映射为 Gateway 可调度的虚拟平台。
// tenantId 永远由服务端会话解析；密钥仅写入，不从 API 读回。
import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, KeyRound, Pencil, Plus, Route, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  bulkRotateApiKeys,
  claimExchangeToGateway,
  createExchange,
  deleteExchangeApiKey,
  getExchangeMeta,
  getExchanges,
  rotateExchangeApiKey,
  updateExchange,
} from '@/lib/api';
import type {
  CreateExchangeRequest,
  ExchangeItem,
  ExchangeMetaData,
  ExchangeModelWriteRequest,
  UpdateExchangeRequest,
} from '@/lib/types';
import { Button, Chip, ReadOnlyNotice, SectionLoader } from '@/components/ui';
import { EntityPreviewDrawer } from '@/components/EntityPreviewDrawer';
import { boolChip } from '@/components/poolsHelpers';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';

type ExchangeFormState = {
  name: string;
  targetUrl: string;
  apiKey: string;
  targetAuthScheme: string;
  transformerType: string;
  enabled: boolean;
  description: string;
  models: ExchangeModelWriteRequest[];
  version: number;
};

const emptyModel = (): ExchangeModelWriteRequest => ({
  modelId: '',
  displayName: '',
  modelType: 'chat',
  description: '',
  enabled: true,
});

const emptyForm = (): ExchangeFormState => ({
  name: '',
  targetUrl: '',
  apiKey: '',
  targetAuthScheme: 'Bearer',
  transformerType: 'passthrough',
  enabled: true,
  description: '',
  models: [emptyModel()],
  version: 0,
});

export function ExchangesPage() {
  const { tenant } = useAuth();
  const canWrite = canUseCapability(tenant?.role, 'configWrite');
  const [items, setItems] = useState<ExchangeItem[] | null>(null);
  const [meta, setMeta] = useState<ExchangeMetaData | null>(null);
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [keyEditId, setKeyEditId] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [bulkKeyValue, setBulkKeyValue] = useState('');
  const [bulkOnlyMissing, setBulkOnlyMissing] = useState(true);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ExchangeFormState>(emptyForm);
  const [savedItem, setSavedItem] = useState<ExchangeItem | null>(null);

  useEffect(() => {
    let alive = true;
    setItems(null);
    setError(null);
    getExchanges({ enabled: enabledOnly ? true : undefined }).then((res) => {
      if (!alive) return;
      if (res.success) setItems(res.data.items);
      else setError(res.error?.message || 'Exchange 加载失败');
    });
    return () => { alive = false; };
  }, [enabledOnly]);

  useEffect(() => {
    let alive = true;
    getExchangeMeta().then((res) => {
      if (!alive) return;
      if (res.success) setMeta(res.data);
      else setError(res.error?.message || 'Exchange 配置选项加载失败');
    });
    return () => { alive = false; };
  }, []);

  function openCreate() {
    setForm(emptyForm());
    setEditingId(null);
    setFormMode('create');
    setSavedItem(null);
    setNotice(null);
  }

  function openEdit(item: ExchangeItem) {
    setForm({
      name: item.name,
      targetUrl: item.targetUrl,
      apiKey: '',
      targetAuthScheme: item.targetAuthScheme || 'Bearer',
      transformerType: item.transformerType || 'passthrough',
      enabled: item.enabled,
      description: item.description || '',
      models: item.models.length ? item.models.map((model) => ({ ...model })) : [emptyModel()],
      version: item.version,
    });
    setEditingId(item.id);
    setFormMode('edit');
    setSavedItem(null);
    setNotice(null);
  }

  function closeForm() {
    setFormMode(null);
    setEditingId(null);
    setForm(emptyForm());
  }

  function updateForm(nextForm: ExchangeFormState) {
    setForm(nextForm);
    setNotice(null);
  }

  function updateModel(index: number, patch: Partial<ExchangeModelWriteRequest>) {
    setForm((current) => ({
      ...current,
      models: current.models.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model),
    }));
    setNotice(null);
  }

  async function saveExchange() {
    if (!form.name.trim() || !form.targetUrl.trim()) {
      setNotice('请填写 Exchange 名称和目标地址');
      return;
    }
    if (form.models.some((model) => !model.modelId.trim())) {
      setNotice('每条模型映射都必须填写上游模型标识');
      return;
    }
    const modelRows = new Map<string, number>();
    for (const [index, model] of form.models.entries()) {
      const normalizedModelId = model.modelId.trim().toLowerCase();
      const firstRow = modelRows.get(normalizedModelId);
      if (firstRow !== undefined) {
        setNotice(`第 ${index + 1} 行与第 ${firstRow + 1} 行的上游模型标识重复，请删除或改名`);
        return;
      }
      modelRows.set(normalizedModelId, index);
    }
    if (formMode === 'create' && !form.apiKey.trim()) {
      setNotice('第一次创建必须填写 Exchange 通讯密钥');
      return;
    }

    setBusyId(formMode === 'create' ? 'create-exchange' : editingId);
    setNotice(null);
    const common = {
      name: form.name.trim(),
      models: form.models.map((model) => ({
        ...model,
        modelId: model.modelId.trim(),
        displayName: model.displayName?.trim() || null,
        description: model.description?.trim() || null,
      })),
      targetUrl: form.targetUrl.trim(),
      targetAuthScheme: form.targetAuthScheme,
      transformerType: form.transformerType,
      enabled: form.enabled,
      description: form.description.trim() || null,
    };
    const res = formMode === 'create'
      ? await createExchange({ ...common, apiKey: form.apiKey.trim() } satisfies CreateExchangeRequest)
      : await updateExchange(editingId!, { ...common, version: form.version } satisfies UpdateExchangeRequest);
    setBusyId(null);
    if (!res.success) {
      setNotice(res.error.code === 'EXCHANGE_CONCURRENTLY_MODIFIED'
        ? '这条 Exchange 已被其他人修改。你当前填写的内容仍保留在表单中；请先保留需要的内容，再关闭表单并重新打开最新版本后合并修改。'
        : res.error.message || 'Exchange 保存失败');
      return;
    }

    setItems((current) => {
      if (!current) return [res.data];
      const exists = current.some((item) => item.id === res.data.id);
      return exists ? current.map((item) => item.id === res.data.id ? res.data : item) : [res.data, ...current];
    });
    setSavedItem(res.data);
    setNotice(formMode === 'create' ? '第一条 Exchange 映射已创建并读回' : 'Exchange 映射已更新并读回');
    closeForm();
  }

  async function claimExchange(item: ExchangeItem) {
    setBusyId(item.id);
    setNotice(null);
    const res = await claimExchangeToGateway(item.id);
    setBusyId(null);
    if (res.success) {
      setItems((current) => current?.map((candidate) => candidate.id === res.data.id ? res.data : candidate) ?? current);
      setNotice(`已将「${res.data.name}」导入平台 Exchange`);
    } else {
      setNotice(res.error?.message || '旧配置导入失败');
    }
  }

  async function saveApiKey(item: ExchangeItem) {
    const apiKey = keyValue.trim();
    if (!apiKey) {
      setNotice('通讯密钥不能为空');
      return;
    }
    setBusyId(item.id);
    setNotice(null);
    const res = await rotateExchangeApiKey(item.id, apiKey);
    setBusyId(null);
    if (res.success) {
      setItems((current) => current?.map((candidate) => candidate.id === res.data.id ? res.data : candidate) ?? current);
      setKeyEditId(null);
      setKeyValue('');
      setNotice(`已更新「${res.data.name}」的通讯密钥`);
    } else {
      setNotice(res.error?.message || '密钥更新失败');
    }
  }

  async function clearApiKey(item: ExchangeItem) {
    if (!window.confirm(`清除「${item.name}」的 Exchange 通讯密钥？清除后该映射不能调用上游。`)) return;
    setBusyId(item.id);
    setNotice(null);
    const res = await deleteExchangeApiKey(item.id);
    setBusyId(null);
    if (res.success) {
      setItems((current) => current?.map((candidate) => candidate.id === res.data.id ? res.data : candidate) ?? current);
      setNotice(`已清除「${res.data.name}」的通讯密钥`);
    } else {
      setNotice(res.error?.message || '密钥清除失败');
    }
  }

  async function applyBulkApiKey() {
    const apiKey = bulkKeyValue.trim();
    if (!apiKey) {
      setNotice('通讯密钥不能为空');
      return;
    }
    if (!bulkConfirm) {
      setNotice('请先确认批量修改范围');
      return;
    }
    const enabledText = enabledOnly ? '启用的 ' : '';
    const scope = bulkOnlyMissing ? `缺失密钥的${enabledText}Exchange` : `全部${enabledText}Exchange`;
    if (!window.confirm(`批量更新${scope}的通讯密钥？`)) return;
    setBusyId('bulk-exchange-api-key');
    setNotice(null);
    const res = await bulkRotateApiKeys({
      objectType: 'exchange',
      apiKey,
      enabledOnly,
      onlyMissing: bulkOnlyMissing,
      allGwOwned: true,
    });
    setBusyId(null);
    if (res.success) {
      setItems((current) => current?.map((item) => (
        item.authority === 'llm_gateway' && (!bulkOnlyMissing || !item.hasKey) ? { ...item, hasKey: true } : item
      )) ?? current);
      setBulkKeyValue('');
      setBulkConfirm(false);
      setNotice(`批量轮换完成：匹配 ${res.data.matchedCount}，更新 ${res.data.modifiedCount}，跳过 ${res.data.skippedCount}`);
    } else {
      setNotice(res.error?.message || '批量密钥更新失败');
    }
  }

  return (
    <div className="lg-exchange-page">
      <header className="lg-exchange-hero">
        <div>
          <div className="lg-eyebrow">路由</div>
          <h1>Exchange 映射</h1>
          <p>当上游不是 OpenAI 或 Claude 标准协议时，用一条 Exchange 把目标地址、转换方式和模型标识连起来。</p>
        </div>
        {canWrite ? <Button variant="primary" onClick={openCreate}><Plus size={15} /> 新建 Exchange</Button> : null}
      </header>

      <section className="lg-exchange-steps" aria-label="Exchange 三步工作流">
        <div><span>1</span><strong>创建映射</strong><p>填写上游地址、模型标识和通讯密钥。</p></div>
        <div><span>2</span><strong>加入模型池</strong><p>把已启用模型加入对应用途的模型池。</p></div>
        <div><span>3</span><strong>用 requestId 验证</strong><p>从 Quickstart 安全测试，再到审计定位变更。</p></div>
      </section>

      {notice ? <div className="lg-inline-alert" role="status">{notice}</div> : null}
      {error ? <div className="lg-inline-alert">{error}</div> : null}
      {!canWrite ? <ReadOnlyNotice /> : null}

      {savedItem ? (
        <section className="lg-exchange-success" aria-label="Exchange 保存结果">
          <CheckCircle2 size={19} />
          <div><strong>{savedItem.name} 已保存</strong><p>{savedItem.models.length} 条模型映射已从服务端读回。下一步可加入模型池，或打开审计核对本次变化。</p></div>
          <div className="lg-exchange-success-actions">
            <Link to={`/audits?targetType=llmgw_model_exchange&search=${encodeURIComponent(savedItem.id)}`}>打开本次审计 <ArrowRight size={13} /></Link>
            <Link to="/pools">去模型池 <ArrowRight size={13} /></Link>
          </div>
        </section>
      ) : null}

      {formMode && meta ? (
        <ExchangeForm
          mode={formMode}
          form={form}
          meta={meta}
          busy={formMode === 'create'
            ? busyId === 'create-exchange'
            : editingId !== null && busyId === editingId}
          onChange={updateForm}
          onUpdateModel={updateModel}
          onSave={() => void saveExchange()}
          onCancel={closeForm}
        />
      ) : null}

      <div className="lg-exchange-toolbar">
        <label><input type="checkbox" checked={enabledOnly} onChange={(event) => setEnabledOnly(event.target.checked)} /> 仅显示启用项</label>
        <span>{items ? `${items.length} 个 Exchange` : '正在读取'}</span>
      </div>

      {canWrite ? (
        <details className="lg-exchange-bulk">
          <summary>批量维护通讯密钥</summary>
          <div>
            <input type="password" autoComplete="new-password" value={bulkKeyValue} onChange={(event) => setBulkKeyValue(event.target.value)} placeholder="新的通讯密钥" />
            <label><input type="checkbox" checked={bulkOnlyMissing} onChange={(event) => setBulkOnlyMissing(event.target.checked)} /> 只补缺失</label>
            <label><input type="checkbox" checked={bulkConfirm} onChange={(event) => setBulkConfirm(event.target.checked)} /> 确认当前筛选范围</label>
            <Button size="sm" variant="ghost" disabled={busyId === 'bulk-exchange-api-key'} onClick={() => void applyBulkApiKey()}>{busyId === 'bulk-exchange-api-key' ? '处理中' : '批量轮换'}</Button>
          </div>
        </details>
      ) : null}

      {!items || !meta ? (error ? (
        <section className="lg-exchange-empty">
          <Route size={24} />
          <div><strong>Exchange 暂时无法读取</strong><p>上方保留了服务端返回的原因。重新加载不会创建配置，也不会调用上游。</p></div>
          <Button variant="ghost" onClick={() => window.location.reload()}>重新加载</Button>
        </section>
      ) : <SectionLoader text="正在加载 Exchange…" />) : items.length === 0 ? (
        <section className="lg-exchange-empty">
          <Route size={24} />
          <div><strong>还没有 Exchange 映射</strong><p>先创建第一条映射。保存只建立配置和审计，不会自动测试上游，也不会产生模型调用费用。</p></div>
          {canWrite ? <Button variant="primary" onClick={openCreate}>创建第一条映射</Button> : null}
        </section>
      ) : (
        <div className="lg-exchange-list">
          {items.map((item) => {
            const enabled = boolChip(item.enabled, '已启用', '已停用');
            const key = boolChip(item.hasKey, '密钥已配置', '密钥缺失');
            return (
              <article className="lg-exchange-card" key={item.id}>
                <div className="lg-exchange-card-head">
                  <div><strong>{item.name || item.id}</strong><code>{item.id}</code></div>
                  <span><Chip label={enabled.label} color={enabled.color} bg={enabled.bg} /><Chip label={key.label} color={key.color} bg={key.bg} /></span>
                </div>
                <div className="lg-exchange-route">
                  <span>{item.transformerType || 'passthrough'}</span>
                  <ArrowRight size={14} />
                  <code title={item.targetUrl}>{item.targetUrl || '未配置目标地址'}</code>
                  <EntityPreviewDrawer
                    buttonLabel="查看路由"
                    kicker="Exchange 路由预览"
                    title={item.name || item.id}
                    summary="从当前卡片直接查看 adapter 如何把 Gateway 请求转换并发往上游。这里只展示配置与请求边界，不会试连目标地址，也不会读取通讯密钥。"
                    status={[
                      { label: item.enabled ? '已启用' : '已停用', tone: item.enabled ? 'good' : 'warning' },
                      { label: item.hasKey ? '通讯密钥已配置' : '通讯密钥缺失', tone: item.hasKey ? 'good' : 'warning' },
                      { label: `版本 ${item.version}` },
                    ]}
                    sections={[
                      {
                        title: 'adapter 与目标接口',
                        description: meta.transformerTypes.find((option) => option.value === item.transformerType)?.description || '当前 adapter 没有额外说明。',
                        fields: [
                          { label: '上游接口类型', value: meta.transformerTypes.find((option) => option.value === item.transformerType)?.label || item.transformerType || 'passthrough' },
                          { label: '目标地址', value: <code>{item.targetUrl || '未配置'}</code>, hint: item.targetUrl?.includes('{model}') ? '运行时会把 {model} 替换为当前模型标识。' : '请求按此完整地址发送。' },
                          { label: '认证方式', value: meta.authSchemes.find((option) => option.value === item.targetAuthScheme)?.label || item.targetAuthScheme || 'Bearer' },
                          { label: '配置来源', value: item.authority === 'llm_gateway' ? '当前租户 Gateway 配置' : '旧 MAP 配置，需先导入' },
                        ],
                      },
                      {
                        title: '模型映射',
                        description: '上游模型标识先映射为明确用途，再决定能加入哪一类模型池。',
                        fields: item.models.map((model) => ({
                          label: model.displayName || model.modelId,
                          value: <><code>{model.modelId}</code> · {meta.modelTypes.find((option) => option.value === model.modelType)?.label || model.modelType} · {model.enabled ? '已启用' : '已停用'}</>,
                        })),
                      },
                      {
                        title: '验证方式',
                        fields: [
                          { label: '保存配置', value: '只写配置和审计，不访问上游' },
                          { label: '安全验证', value: '使用 Quickstart dry-run 取得 requestId' },
                          { label: '真实验证', value: '在明确批准后按协议单次调用，避免批量付费测试' },
                        ],
                      },
                    ]}
                  />
                </div>
                <div className="lg-exchange-models">
                  {item.models.length ? item.models.map((model) => (
                    <div key={`${item.id}:${model.modelId}`}>
                      <strong>{model.displayName || model.modelId}</strong>
                      <span>{model.modelId}</span>
                      <Chip label={meta.modelTypes.find((option) => option.value === model.modelType)?.label || model.modelType} color="var(--text-secondary)" bg="var(--bg-elevated)" />
                    </div>
                  )) : <p>这条旧配置没有结构化模型映射，请编辑后保存。</p>}
                </div>
                <div className="lg-exchange-card-footer">
                  <span>{item.authority === 'llm_gateway' ? '当前租户平台配置' : '旧 MAP 配置待导入'} · 认证 {item.targetAuthScheme || 'Bearer'} · 版本 {item.version}</span>
                  {canWrite ? (
                    <div>
                      {item.authority === 'llm_gateway' ? <Button size="sm" variant="ghost" onClick={() => openEdit(item)}><Pencil size={13} /> 编辑映射</Button> : <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => void claimExchange(item)}>导入旧配置</Button>}
                      {item.authority === 'llm_gateway' && keyEditId !== item.id ? <Button size="sm" variant="ghost" onClick={() => { setKeyEditId(item.id); setKeyValue(''); }}><KeyRound size={13} /> 更新密钥</Button> : null}
                      {item.authority === 'llm_gateway' && item.hasKey ? <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => void clearApiKey(item)}>清除密钥</Button> : null}
                    </div>
                  ) : <span>只读</span>}
                </div>
                {keyEditId === item.id ? (
                  <div className="lg-exchange-key-editor">
                    <input type="password" autoComplete="new-password" value={keyValue} onChange={(event) => setKeyValue(event.target.value)} placeholder="输入新的通讯密钥" />
                    <span>保存后只返回“已配置”，页面不会读回密钥内容。</span>
                    <Button size="sm" variant="primary" disabled={busyId === item.id} onClick={() => void saveApiKey(item)}>保存密钥</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setKeyEditId(null); setKeyValue(''); }}>取消</Button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ExchangeForm({ mode, form, meta, busy, onChange, onUpdateModel, onSave, onCancel }: {
  mode: 'create' | 'edit';
  form: ExchangeFormState;
  meta: ExchangeMetaData;
  busy: boolean;
  onChange: (value: ExchangeFormState) => void;
  onUpdateModel: (index: number, patch: Partial<ExchangeModelWriteRequest>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const targetPlaceholder = ({
    'gemini-native': 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    'fal-image': 'https://fal.run/fal-ai/nano-banana-pro',
    'fal-image-edit': 'https://fal.run/fal-ai/nano-banana-pro/edit',
    'doubao-asr': 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit',
    'doubao-asr-stream': 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
    'volcengine-video': 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
  } as Record<string, string>)[form.transformerType] || 'https://provider.example.com/v1/invoke';
  const transformerOptions = meta.transformerTypes;
  const changeTransformer = (transformerType: string) => {
    const targetAuthScheme = transformerType === 'gemini-native'
      ? 'x-goog-api-key'
      : transformerType === 'fal-image' || transformerType === 'fal-image-edit'
        ? 'Key'
        : transformerType === 'doubao-asr' || transformerType === 'doubao-asr-stream'
          ? 'XApiKey'
          : 'Bearer';
    onChange({ ...form, transformerType, targetAuthScheme });
  };

  return (
    <section className="lg-exchange-form" aria-labelledby="exchange-form-title">
      <div className="lg-exchange-form-head">
        <div><div className="lg-card-kicker">{mode === 'create' ? '第一步' : '修改现有配置'}</div><h2 id="exchange-form-title">{mode === 'create' ? '创建 Exchange 映射' : '编辑 Exchange 映射'}</h2><p>基本信息保存后立即从服务端读回；页面不接收 tenantId，也不会在保存时调用上游。</p></div>
        <Button size="sm" variant="ghost" onClick={onCancel}>关闭</Button>
      </div>
      <div className="lg-exchange-form-grid">
        <label>Exchange 名称<input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder="例如：我的 Gemini 原生接口" /></label>
        <label>上游接口类型<select value={form.transformerType} onChange={(event) => changeTransformer(event.target.value)}>{transformerOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>{meta.transformerTypes.find((option) => option.value === form.transformerType)?.description}。选择类型后会自动推荐认证方式。只有豆包流式语音识别可使用公网 WSS；其他类型必须使用 HTTP/HTTPS。运行时会固定已验证公网 IP 并校验证书主机名。</small></label>
        <label>认证方式<select value={form.targetAuthScheme} onChange={(event) => onChange({ ...form, targetAuthScheme: event.target.value })}>{meta.authSchemes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>{meta.authSchemes.find((option) => option.value === form.targetAuthScheme)?.description}</small></label>
        <label className="is-wide">目标地址<input value={form.targetUrl} onChange={(event) => onChange({ ...form, targetUrl: event.target.value })} placeholder={targetPlaceholder} /><small>请填写上游真实接口地址；需要动态模型名时使用 {'{model}'}。通讯密钥必须放在密钥字段，不要放进 URL。</small></label>
        {mode === 'create' ? <label className="is-wide">通讯密钥<input type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => onChange({ ...form, apiKey: event.target.value })} placeholder="创建时必填" /><small>密钥加密保存，不进入响应和操作审计。</small></label> : null}
      </div>

      <div className="lg-exchange-model-editor">
        <div><strong>模型映射</strong><p>至少一条。模型用途决定它可以加入哪一种默认池。</p></div>
        {form.models.map((model, index) => (
          <div className="lg-exchange-model-row" key={`model-row-${index}`}>
            <label>上游模型标识<input value={model.modelId} onChange={(event) => onUpdateModel(index, { modelId: event.target.value })} placeholder="例如 gemini-2.5-flash" /></label>
            <label>显示名称<input value={model.displayName || ''} onChange={(event) => onUpdateModel(index, { displayName: event.target.value })} placeholder="可选" /></label>
            <label>模型用途<select value={model.modelType} onChange={(event) => onUpdateModel(index, { modelType: event.target.value })}>{meta.modelTypes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <label className="lg-exchange-enabled"><input type="checkbox" checked={model.enabled} onChange={(event) => onUpdateModel(index, { enabled: event.target.checked })} /> 启用这条映射</label>
            {form.models.length > 1 ? <Button size="sm" variant="ghost" onClick={() => onChange({ ...form, models: form.models.filter((_, modelIndex) => modelIndex !== index) })}><Trash2 size={13} /> 移除</Button> : null}
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => onChange({ ...form, models: [...form.models, emptyModel()] })}><Plus size={13} /> 添加模型映射</Button>
      </div>

      <details className="lg-exchange-advanced">
        <summary>高级设置</summary>
        <div>
          <label className="is-wide">说明<textarea value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="说明这条 Exchange 在系统里承担什么作用" /></label>
          <label className="lg-exchange-enabled"><input type="checkbox" checked={form.enabled} onChange={(event) => onChange({ ...form, enabled: event.target.checked })} /> 创建后立即启用</label>
        </div>
      </details>

      <div className="lg-exchange-form-actions">
        <span>{mode === 'edit' ? `正在编辑版本 ${form.version}，旧版本提交会被服务端拒绝。` : '保存只创建配置，不会自动产生上游请求。'}</span>
        <Button variant="ghost" onClick={onCancel}>取消</Button>
        <Button variant="primary" disabled={busy} onClick={onSave}>{busy ? '保存中' : mode === 'create' ? '创建并读回' : '保存并读回'}</Button>
      </div>
    </section>
  );
}
