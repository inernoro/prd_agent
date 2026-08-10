// Exchange：把非 OpenAI/Claude 标准上游映射为 Gateway 可调度的虚拟平台。
// tenantId 永远由服务端会话解析；密钥仅写入，不从 API 读回。
//
// 按「控制台风格调性 v1.2」原则 6 / 7 迁移（doc/rule.platform.llm-gateway.console-design-tonality.md）：
//   - 走 PageShell / PageHeader / PageBody 骨架；此前是自造页头 .lg-exchange-hero
//     与自造根容器 .lg-exchange-page，同一层级的东西和别的页长得不一样。
//   - 文字预算：迁移前 4 段 / 417 汉字（有豁免条目）。四段常驻说明里，
//     「保存不会调用上游」「保存后从服务端读回」这类边界承诺是产品语义不能删，
//     只把它们压到一句以内；成套的解释（Exchange 是什么、adapter 怎么选、
//     公网出口与证书校验）收进 HelpPopover 与 DetailsBlock，并深链教程第 19 章。
//   - 空状态的三步引导保留：零数据的人正需要它，而有配置的人根本看不到它。
//   - 卡片内边距统一到 surface.ts 的 CARD_BODY(14) / INSET_BLOCK(10)；
//     原来 .lg-exchange-* 一套 CSS 里混了 9 / 12 / 14 / 24 四种内边距。
//   - 本路由被 e2e/llmgw-layout-drift.mjs 监测：表单一律内联、DOM 保持扁平，
//     不许把创建/编辑改成抽屉或对话框（EntityPreviewDrawer 是只读预览，另论）。
import { useEffect, useState } from 'react';
import { ArrowRight, AudioLines, CheckCircle2, Image, KeyRound, Layers3, Pencil, Plus, Route, Trash2, Video } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  bulkRotateApiKeys,
  claimExchangeToGateway,
  createExchange,
  deleteExchange,
  deleteExchangeApiKey,
  getExchangeMeta,
  getExchanges,
  getImageLayeringCapability,
  installImageLayeringCapability,
  rotateExchangeApiKey,
  updateExchange,
} from '@/lib/api';
import type {
  CreateExchangeRequest,
  ExchangeItem,
  ExchangeMetaData,
  ExchangeModelWriteRequest,
  ImageLayeringCapabilityStatus,
  UpdateExchangeRequest,
} from '@/lib/types';
import { Button, Card, Chip, InlineAlert, ReadOnlyNotice, SectionLoader } from '@/components/ui';
import { DetailsBlock, FormGrid, HelpPopover, PageBody, PageHeader, PageShell, Prose, TutorialLink } from '@/components/PageShell';
import { EntityPreviewDrawer } from '@/components/EntityPreviewDrawer';
import { boolChip } from '@/components/poolsHelpers';
import { useAuth } from '@/lib/auth';
import { canUseCapability } from '@/lib/access';
import { CARD_ACTIONS, CARD_BODY, GAP, INSET_BLOCK, INSET_PADDING } from '@/lib/surface';
import { BODY_TEXT, FIELD_INPUT, FIELD_LABEL, HINT_TEXT, MONO_META, SECTION_TITLE } from '@/lib/typography';

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

/**
 * 出口一：上游接口类型旁的 ?。
 *
 * 这三句是《模型网关权威教程》第 19 章的锚点，教程巡检按字面量比对，
 * **逐字保留**：公网 WSS 只对豆包流式语音识别开放、其他类型必须 HTTP/HTTPS、
 * 运行时固定已验证公网 IP。删任何一句都会让教程对不上界面。
 */
function TargetTypeHelp() {
  return (
    <HelpPopover label="上游接口类型">
      选择类型后会自动推荐认证方式。只有豆包流式语音识别可使用公网 WSS；其他类型必须使用 HTTP/HTTPS。运行时会固定已验证公网 IP 并校验证书主机名。
    </HelpPopover>
  );
}

/**
 * adapter 前缀 → 图标。给每张卡片一个视觉锚点：一列卡片如果只有文字，
 * 扫的时候分不出哪条是生图、哪条是语音，只能逐字读。
 * 按前缀匹配而不是穷举全部 transformerType——新增同族 adapter 不必回来改这里。
 */
const ADAPTER_ICONS: Array<[string, LucideIcon]> = [
  ['fal-image', Image],
  ['gemini-image', Image],
  ['doubao-asr', AudioLines],
  ['volcengine-video', Video],
];

function adapterIcon(transformerType: string | null | undefined): LucideIcon {
  const type = String(transformerType ?? '');
  return ADAPTER_ICONS.find(([prefix]) => type.startsWith(prefix))?.[1] ?? Route;
}

/**
 * 卡片左边的状态色条。状态本来只由两枚小 chip 表达，和周围的字一样轻，
 * 一列扫下来看不出哪条有问题；色条让「停用 / 缺密钥 / 正常」在余光里就能分辨。
 */
function statusAccent(item: { enabled: boolean; hasKey: boolean }): string {
  if (!item.enabled) return 'var(--text-muted)';
  if (!item.hasKey) return 'var(--warn)';
  return 'var(--accent)';
}

/** 能力卡四种状态的完整含义。收进 ? 里：常驻只留一句「下一步」，细节点开才看。 */
function StatusHelp() {
  return (
    <HelpPopover label="能力状态">
      未安装：还没提交过 Key。配置不完整：Exchange、逻辑能力、上游供给、凭据这四样缺了一样，或者其中一样被停用了，重新提交一次 Key 会补齐。已安装，等待验证：四样都在，但还没有人成功调用过；任意调用方通过 image-layering 成功分层一次，状态会自动转为已验证，不需要在本页做别的操作。已验证：网关请求日志里存在一条该能力的成功调用记录。
    </HelpPopover>
  );
}

export function ExchangesPage() {
  const { tenant } = useAuth();
  const [searchParams] = useSearchParams();
  const focusedExchangeId = searchParams.get('exchangeId')?.trim() || null;
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
  const [layeringCapability, setLayeringCapability] = useState<ImageLayeringCapabilityStatus | null>(null);
  const [layeringApiKey, setLayeringApiKey] = useState('');

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

  useEffect(() => {
    let alive = true;
    getImageLayeringCapability().then((res) => {
      if (!alive) return;
      if (res.success) setLayeringCapability(res.data);
      else setError(res.error?.message || '图片分层能力状态加载失败');
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!focusedExchangeId || items === null || items.some((item) => item.id === focusedExchangeId)) return;
    setNotice('当前租户中没有找到该 Exchange');
  }, [focusedExchangeId, items]);

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

  // 交换所可能正被模型池成员当上游用（直指 id，或走 __exchange__ 别名匹配）。
  // 后端两种引用都查，这里只负责把它报回来的阻挡原文原样端给运维。
  async function removeExchange(item: ExchangeItem) {
    const typed = window.prompt(
      `删除 Exchange「${item.name}」（${item.targetUrl || '无地址'}）。\n它的地址、通讯密钥与全部模型映射一并消失，无法撤销。\n确认请输入 Exchange 名称：`,
    );
    if (typed === null) return;
    if (typed.trim() !== item.name) { setNotice('输入的名称不一致，已取消删除'); return; }
    setBusyId(item.id);
    setNotice(null);
    const res = await deleteExchange(item.id);
    setBusyId(null);
    if (!res.success) { setNotice(res.error?.message || '删除失败'); return; }
    setItems((current) => current?.filter((candidate) => candidate.id !== item.id) ?? current);
    setNotice(`已删除 Exchange「${item.name}」`);
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

  async function installLayeringCapability() {
    const apiKey = layeringApiKey.trim();
    if (!apiKey) {
      setNotice('请填写 fal.ai API Key');
      return;
    }
    setBusyId('install-image-layering');
    setNotice(null);
    const res = await installImageLayeringCapability(apiKey);
    setBusyId(null);
    if (!res.success) {
      setNotice(res.error?.message || '图片分层能力安装失败');
      return;
    }
    setLayeringCapability(res.data);
    setLayeringApiKey('');
    setNotice(res.data.verified
      ? '图片分层能力已更新，并保留真实调用验证状态'
      : '图片分层能力已安装。调用方通过 image-layering 发起首次真实请求后，这里会显示已验证。');
    const exchanges = await getExchanges({ enabled: enabledOnly ? true : undefined });
    if (exchanges.success) setItems(exchanges.data.items);
  }

  return (
    <PageShell>
      <PageHeader
        title="Exchange 映射"
        subtitle="上游不是 OpenAI 或 Claude 标准协议时，用一条 Exchange 把它接进网关。"
        summary={items ? (
          <>
            <span>映射 <strong>{items.length}</strong></span>
            <span>已启用 <strong>{items.filter((item) => item.enabled).length}</strong></span>
            <span>缺密钥 <strong>{items.filter((item) => !item.hasKey).length}</strong></span>
          </>
        ) : undefined}
        actions={canWrite ? <Button variant="primary" size="sm" onClick={openCreate}>新建 Exchange</Button> : undefined}
      />

      <PageBody>
        {notice ? <InlineAlert tone="info">{notice}</InlineAlert> : null}
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        {!canWrite ? <ReadOnlyNotice /> : null}

        <section id="image-layering" aria-labelledby="image-layering-title" style={capabilitySectionStyle}>
          <div style={sectionHeaderStyle}>
            <span style={sectionIconStyle}><Layers3 size={16} /></span>
            <strong id="image-layering-title" style={SECTION_TITLE}>fal.ai 图片分层</strong>
            <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
              <Chip
                label={layeringCapability?.verified
                  ? '调用已验证'
                  : layeringCapability?.installed
                    ? '已安装，等待验证'
                    : layeringCapability?.state === 'incomplete'
                      ? '配置不完整'
                      : '未安装'}
                color={layeringCapability?.verified ? 'var(--ok)' : layeringCapability?.installed ? 'var(--warn)' : 'var(--text-secondary)'}
                bg={layeringCapability?.verified ? 'var(--ok-bg)' : layeringCapability?.installed ? 'var(--warn-bg)' : 'var(--bg-elevated)'}
              />
            </span>
          </div>

          <Card style={CARD_BODY}>
            <div style={capabilityMetaStyle}>
              <span style={metaPairStyle}><span style={HINT_TEXT}>能力</span><code style={MONO_META}>{layeringCapability?.publicId || 'image-layering'}</code></span>
              <span style={metaPairStyle}><span style={HINT_TEXT}>模型</span><code style={MONO_META}>{layeringCapability?.modelId || 'fal-qwen-image-layered'}</code></span>
              {layeringCapability?.lastVerifiedAt ? <span style={{ ...HINT_TEXT, marginLeft: 'auto' }}>最近验证 {new Date(layeringCapability.lastVerifiedAt).toLocaleString()}</span> : null}
            </div>

            {/* 状态角标只有四个词，用户看到「等待验证」并不知道在等什么。
                这里补一句「下一步是什么」——保持短句，四种状态的完整含义收进右侧 ?。 */}
            <p style={{ ...HINT_TEXT, marginTop: GAP.section }}>
              {layeringCapability?.verified
                ? '已有成功调用记录。'
                : layeringCapability?.installed
                  ? '配置已就位，成功调用一次后自动转为已验证。'
                  : layeringCapability?.state === 'incomplete'
                    ? '配置缺了一部分，重新提交 Key 可补齐。'
                    : '提交 Key 后自动完成安装。'}
              <StatusHelp />
            </p>
            {canWrite ? (
              <div style={capabilityFormStyle}>
                {/* 卡片不限宽后输入框会一路拉到一千多像素——一个 Key 不需要那么长的槽，
                    也会把「更新凭据」推到视线之外。限一个上限，按钮就紧跟在它后面。 */}
                <label htmlFor="fal-image-layering-key" style={{ ...FIELD_LABEL, flex: '1 1 360px', maxWidth: 520 }}>
                  <span style={rowStyle}>
                    fal.ai API Key
                    <HelpPopover label="安装说明">
                      LLMGW 会创建原生 Exchange、公开逻辑能力和上游供给。它不绑定任何业务系统；保存不调用模型，首次真实请求才产生费用。
                    </HelpPopover>
                  </span>
                  <input
                    id="fal-image-layering-key"
                    type="password"
                    autoComplete="new-password"
                    value={layeringApiKey}
                    onChange={(event) => setLayeringApiKey(event.target.value)}
                    placeholder={layeringCapability?.hasKey ? '输入新 Key 可更新凭据并修复能力配置' : '输入后加密保存，不会回显'}
                    style={FIELD_INPUT}
                  />
                </label>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busyId === 'install-image-layering'}
                  onClick={() => void installLayeringCapability()}
                >
                  {busyId === 'install-image-layering'
                    ? '安装中'
                    : layeringCapability?.installed
                      ? '更新凭据'
                      : '安装能力'}
                </Button>
              </div>
            ) : null}
          </Card>
        </section>

        {savedItem ? (
          <Card style={{ ...CARD_BODY, borderColor: 'color-mix(in srgb, var(--ok) 45%, var(--border-subtle))', background: 'var(--ok-bg)' }}>
            <div style={rowStyle}>
              <CheckCircle2 size={18} style={{ color: 'var(--ok)', flexShrink: 0 }} />
              <strong style={SECTION_TITLE}>{savedItem.name} 已保存</strong>
              <span style={HINT_TEXT}>{savedItem.models.length} 条模型映射已读回</span>
              <div style={{ ...CARD_ACTIONS, marginLeft: 'auto' }}>
                <Link className="lg-text-link" to={`/audits?targetType=llmgw_model_exchange&search=${encodeURIComponent(savedItem.id)}`}>打开本次审计 <ArrowRight size={13} /></Link>
                <Link className="lg-text-link" to="/pools">去模型池 <ArrowRight size={13} /></Link>
              </div>
            </div>
          </Card>
        ) : null}

        {/* 创建与编辑一律内联展开：本路由被漂移检测监测，禁止抽屉与对话框。 */}
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

        {/* 标题、筛选、批量操作原本各占一行，三行加起来只承载一个标题和两个控件。
            合并成一行：左边是「这一段是什么 + 怎么筛」，右边是批量操作。 */}
        <div style={toolbarStyle}>
          <span style={sectionIconStyle}><Route size={16} /></span>
          <strong style={SECTION_TITLE}>Exchange</strong>
          <label style={{ ...checkStyle, marginLeft: GAP.section }}>
            <input type="checkbox" checked={enabledOnly} onChange={(event) => setEnabledOnly(event.target.checked)} /> 仅显示启用项
          </label>
          {canWrite ? (
            <details style={{ ...INSET_BLOCK, marginLeft: 'auto' }}>
              <summary style={summaryStyle}>批量维护通讯密钥</summary>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: GAP.normal, marginTop: GAP.normal }}>
                <input type="password" autoComplete="new-password" value={bulkKeyValue} onChange={(event) => setBulkKeyValue(event.target.value)} placeholder="新的通讯密钥" style={{ ...FIELD_INPUT, maxWidth: 220 }} />
                <label style={checkStyle}><input type="checkbox" checked={bulkOnlyMissing} onChange={(event) => setBulkOnlyMissing(event.target.checked)} /> 只补缺失</label>
                <label style={checkStyle}><input type="checkbox" checked={bulkConfirm} onChange={(event) => setBulkConfirm(event.target.checked)} /> 确认当前筛选范围</label>
                <Button size="sm" variant="ghost" disabled={busyId === 'bulk-exchange-api-key'} onClick={() => void applyBulkApiKey()}>{busyId === 'bulk-exchange-api-key' ? '处理中' : '批量轮换'}</Button>
              </div>
            </details>
          ) : null}
        </div>

        {!items || !meta ? (error ? (
          <Card style={CARD_BODY}>
            <div style={emptyStyle}>
              <Route size={24} />
              <strong style={SECTION_TITLE}>Exchange 暂时无法读取</strong>
              <Prose>重新加载不会创建配置，也不会调用上游。</Prose>
              <Button variant="ghost" onClick={() => window.location.reload()}>重新加载</Button>
            </div>
          </Card>
        ) : <SectionLoader text="正在加载 Exchange…" />) : items.length === 0 ? (
          <Card style={CARD_BODY}>
            {/* 出口二：空状态。三步引导只在零数据时出现——有配置的人不需要每次进页面都被教一遍。 */}
            <div style={emptyStyle}>
              <Route size={24} />
              <strong style={SECTION_TITLE}>还没有 Exchange 映射</strong>
              <Prose>保存只建立配置和审计，不会调用上游，也不产生费用。</Prose>
              <ol className="lg-exchange-steps" aria-label="Exchange 三步工作流">
                <li><strong>创建映射</strong><p style={BODY_TEXT}>填写上游地址、模型标识和通讯密钥。</p></li>
                <li><strong>加入模型池</strong><p style={BODY_TEXT}>把已启用模型加入对应用途的模型池。</p></li>
                <li><strong>用 requestId 验证</strong><p style={BODY_TEXT}>从 Quickstart 安全测试，再到审计定位变更。</p></li>
              </ol>
              {canWrite ? <Button variant="primary" size="sm" onClick={openCreate}>创建第一条映射</Button> : null}
            </div>
          </Card>
        ) : (
          <div data-testid="exchange-list" style={listStyle}>
            {items.map((item) => {
              const enabled = boolChip(item.enabled, '已启用', '已停用');
              const key = boolChip(item.hasKey, '密钥已配置', '密钥缺失');
              const AdapterIcon = adapterIcon(item.transformerType);
              return (
                /* 左边一条状态色条：一列卡片全是文字时，扫不出哪条停用了、哪条缺密钥。 */
                <Card key={item.id} style={{ ...CARD_BODY, borderLeft: `3px solid ${statusAccent(item)}` }}>
                  {/* 标题行：图标锚点 + 名字 + 状态。
                      内部 id 是排障用的，挪到卡片底部——它此前占着标题下最显眼的一行，
                      让每张卡片一上来就是一串没人读的哈希。 */}
                  <div style={rowStyle}>
                    <span style={sectionIconStyle}><AdapterIcon size={16} /></span>
                    <strong style={{ ...SECTION_TITLE, minWidth: 0 }}>{item.name || item.id}</strong>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.tight, marginLeft: 'auto' }}>
                      <Chip label={enabled.label} color={enabled.color} bg={enabled.bg} />
                      <Chip label={key.label} color={key.color} bg={key.bg} />
                    </span>
                  </div>

                  {/* 路由行：adapter 与目标地址此前都是同一种灰字，读起来像一句话而不是两个字段。
                      adapter 本来就是枚举值，改用 Chip；目标地址前加标签，方向感由箭头承担。 */}
                  <div style={{ ...INSET_BLOCK, ...rowStyle, marginTop: GAP.section }}>
                    <Chip label={item.transformerType || 'passthrough'} color="var(--text-secondary)" bg="var(--bg-base)" />
                    <ArrowRight size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    <code style={{ ...MONO_META, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.targetUrl}>{item.targetUrl || '未配置目标地址'}</code>
                    <span style={{ marginLeft: 'auto' }}>
                      <EntityPreviewDrawer
                        buttonLabel="查看路由"
                        kicker="Exchange 路由预览"
                        title={item.name || item.id}
                        icon={<Route size={20} />}
                        initiallyOpen={item.id === focusedExchangeId}
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
                    </span>
                  </div>

                  {/* 模型行此前每条都套一个灰底块，两三条并排下来整张卡片就碎成一堆小方块。
                      改成无底色的行 + 细分隔线：灰底只留给上面那条「打到哪」的路由行，
                      让一张卡片里只有一个视觉重块。 */}
                  <div style={{ display: 'grid', marginTop: GAP.tight }}>
                    {item.models.length ? item.models.map((model) => (
                      <div key={`${item.id}:${model.modelId}`} style={modelLineStyle}>
                        <strong style={BODY_TEXT}>{model.displayName || model.modelId}</strong>
                        <code style={{ ...MONO_META, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.modelId}</code>
                        <span style={{ display: 'flex', flexWrap: 'wrap', gap: GAP.tight, marginLeft: 'auto' }}>
                          {model.enabled ? null : <Chip label="已停用" color="var(--warn)" bg="var(--warn-bg)" />}
                          <Chip label={meta.modelTypes.find((option) => option.value === model.modelType)?.label || model.modelType} color="var(--text-secondary)" bg="var(--bg-elevated)" />
                        </span>
                      </div>
                    )) : <span style={{ ...HINT_TEXT, color: 'var(--warn)', paddingTop: GAP.normal }}>这条旧配置没有结构化模型映射，请编辑后保存。</span>}
                  </div>

                  {/* 底部此前是「一串 · 连起来的灰字 + 右侧一排同样灰的文字按钮」，
                      信息和操作分不开。改成元信息各自成对（标签在上、值在下）、操作独占一行。 */}
                  {/* 元信息与操作同一行：加了色条和图标之后层次已经够，
                      再各占一行只是把卡片撑高、让一屏看到的条数变少。窄屏由 flexWrap 自己折。 */}
                  <div style={{ ...rowStyle, marginTop: GAP.tight, paddingTop: INSET_PADDING, borderTop: '1px solid var(--border-subtle)' }}>
                    <span style={HINT_TEXT}>{item.authority === 'llm_gateway' ? '当前租户平台配置' : '旧 MAP 配置待导入'} · 认证 {item.targetAuthScheme || 'Bearer'} · 版本 {item.version} ·</span>
                    <code style={{ ...MONO_META, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.id}>{item.id}</code>
                    {canWrite ? (
                      <div style={{ ...CARD_ACTIONS, marginLeft: 'auto' }}>
                        {item.authority === 'llm_gateway' ? <Button size="sm" variant="ghost" onClick={() => openEdit(item)}><Pencil size={13} /> 编辑映射</Button> : <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => void claimExchange(item)}>导入旧配置</Button>}
                        {item.authority === 'llm_gateway' && keyEditId !== item.id ? <Button size="sm" variant="ghost" onClick={() => { setKeyEditId(item.id); setKeyValue(''); }}><KeyRound size={13} /> 更新密钥</Button> : null}
                        {item.authority === 'llm_gateway' && item.hasKey ? <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => void clearApiKey(item)}>清除密钥</Button> : null}
                        {item.authority === 'llm_gateway' ? <Button size="sm" variant="ghost" disabled={busyId === item.id} onClick={() => void removeExchange(item)}><Trash2 size={13} /> 删除</Button> : null}
                      </div>
                    ) : <span style={{ ...HINT_TEXT, marginLeft: 'auto' }}>只读</span>}
                  </div>

                  {keyEditId === item.id ? (
                    <div style={{ ...INSET_BLOCK, ...rowStyle, marginTop: GAP.normal, border: '1px solid var(--accent)', background: 'var(--accent-soft)' }}>
                      <input type="password" autoComplete="new-password" value={keyValue} onChange={(event) => setKeyValue(event.target.value)} placeholder="输入新的通讯密钥" style={{ ...FIELD_INPUT, maxWidth: 220 }} />
                      <span style={HINT_TEXT}>保存后只返回“已配置”，页面不会读回密钥内容。</span>
                      <div style={{ ...CARD_ACTIONS, marginLeft: 'auto' }}>
                        <Button size="sm" variant="primary" disabled={busyId === item.id} onClick={() => void saveApiKey(item)}>保存密钥</Button>
                        <Button size="sm" variant="ghost" onClick={() => { setKeyEditId(null); setKeyValue(''); }}>取消</Button>
                      </div>
                    </div>
                  ) : null}
                </Card>
              );
            })}
          </div>
        )}

        <DetailsBlock title="工作原理：Exchange 把非标准上游接成可调度的模型">
          <Prose>
            一条 Exchange 记录目标地址、adapter 与认证方式，再把上游模型标识映射成明确用途，
            之后就能像平台模型一样加入模型池。租户由服务端会话解析，通讯密钥只写不读，
            保存只写配置与审计，不会替你调用上游产生费用。
          </Prose>
          <TutorialLink chapter="chapter-19">查看教程：第 19 章 Exchange 映射</TutorialLink>
        </DetailsBlock>
      </PageBody>
    </PageShell>
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
    <Card style={{ ...CARD_BODY, borderColor: 'var(--accent)' }}>
      <div style={rowStyle}>
        <h2 id="exchange-form-title" style={SECTION_TITLE}>{mode === 'create' ? '创建 Exchange 映射' : '编辑 Exchange 映射'}</h2>
        <span style={HINT_TEXT}>保存后立即从服务端读回，保存本身不调用上游。</span>
        <div style={{ marginLeft: 'auto' }}><Button size="sm" variant="ghost" onClick={onCancel}>关闭</Button></div>
      </div>

      {/* 表单栅格走 PageShell 的 FormGrid（列宽 260~320 固定），
          只覆盖 align-items：字段带 <small> 提示，底对齐会把标签抬歪。 */}
      <FormGrid style={{ alignItems: 'start', marginTop: GAP.section }}>
        <label style={FIELD_LABEL}>
          <span>Exchange 名称</span>
          <input value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} placeholder="例如：我的 Gemini 原生接口" style={FIELD_INPUT} />
        </label>
        <label style={FIELD_LABEL}>
          <span>上游接口类型<TargetTypeHelp /></span>
          <select value={form.transformerType} onChange={(event) => changeTransformer(event.target.value)} style={FIELD_INPUT}>
            {transformerOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <small style={HINT_TEXT}>{meta.transformerTypes.find((option) => option.value === form.transformerType)?.description}</small>
        </label>
        <label style={FIELD_LABEL}>
          <span>认证方式</span>
          <select value={form.targetAuthScheme} onChange={(event) => onChange({ ...form, targetAuthScheme: event.target.value })} style={FIELD_INPUT}>
            {meta.authSchemes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <small style={HINT_TEXT}>{meta.authSchemes.find((option) => option.value === form.targetAuthScheme)?.description}</small>
        </label>
        <label style={{ ...FIELD_LABEL, gridColumn: '1 / -1', maxWidth: 660 }}>
          <span>
            目标地址
            <HelpPopover label="目标地址">
              请填写上游真实接口地址；需要动态模型名时使用 <code>{'{model}'}</code>。通讯密钥必须放在密钥字段，不要放进 URL。
            </HelpPopover>
          </span>
          <input value={form.targetUrl} onChange={(event) => onChange({ ...form, targetUrl: event.target.value })} placeholder={targetPlaceholder} style={FIELD_INPUT} />
        </label>
        {mode === 'create' ? (
          <label style={{ ...FIELD_LABEL, gridColumn: '1 / -1', maxWidth: 660 }}>
            <span>
              通讯密钥
              <HelpPopover label="通讯密钥">密钥加密保存，不进入响应和操作审计；保存后只返回“已配置”，不会再读回明文。</HelpPopover>
            </span>
            <input type="password" autoComplete="new-password" value={form.apiKey} onChange={(event) => onChange({ ...form, apiKey: event.target.value })} placeholder="创建时必填" style={FIELD_INPUT} />
          </label>
        ) : null}
      </FormGrid>

      <div style={{ ...INSET_BLOCK, display: 'flex', flexDirection: 'column', gap: GAP.normal, marginTop: GAP.section }}>
        <div style={rowStyle}>
          <strong style={SECTION_TITLE}>模型映射</strong>
          <HelpPopover label="模型映射">至少一条。模型用途决定它可以加入哪一种默认池，也决定 Gateway 调度时把它当成什么模型使用。</HelpPopover>
        </div>
        {form.models.map((model, index) => (
          <div style={modelRowStyle} key={`model-row-${index}`}>
            <label style={modelFieldStyle(180)}>
              <span>上游模型标识</span>
              <input value={model.modelId} onChange={(event) => onUpdateModel(index, { modelId: event.target.value })} placeholder="例如 gemini-2.5-flash" style={FIELD_INPUT} />
            </label>
            <label style={modelFieldStyle(150)}>
              <span>显示名称</span>
              <input value={model.displayName || ''} onChange={(event) => onUpdateModel(index, { displayName: event.target.value })} placeholder="可选" style={FIELD_INPUT} />
            </label>
            <label style={modelFieldStyle(130)}>
              <span>模型用途</span>
              <select value={model.modelType} onChange={(event) => onUpdateModel(index, { modelType: event.target.value })} style={FIELD_INPUT}>
                {meta.modelTypes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label style={checkStyle}>
              <input type="checkbox" checked={model.enabled} onChange={(event) => onUpdateModel(index, { enabled: event.target.checked })} /> 启用这条映射
            </label>
            {form.models.length > 1 ? <Button size="sm" variant="ghost" onClick={() => onChange({ ...form, models: form.models.filter((_, modelIndex) => modelIndex !== index) })}><Trash2 size={13} /> 移除</Button> : null}
          </div>
        ))}
        <div style={CARD_ACTIONS}>
          <Button size="sm" variant="ghost" onClick={() => onChange({ ...form, models: [...form.models, emptyModel()] })}><Plus size={13} /> 添加模型映射</Button>
        </div>
      </div>

      <details style={{ ...INSET_BLOCK, marginTop: GAP.section }}>
        <summary style={summaryStyle}>高级设置</summary>
        <div style={{ display: 'grid', gap: GAP.normal, marginTop: GAP.normal, maxWidth: 660 }}>
          <label style={FIELD_LABEL}>
            <span>说明</span>
            <textarea value={form.description} onChange={(event) => onChange({ ...form, description: event.target.value })} placeholder="说明这条 Exchange 在系统里承担什么作用" style={{ ...FIELD_INPUT, height: 76, padding: 10, resize: 'vertical' }} />
          </label>
          <label style={checkStyle}>
            <input type="checkbox" checked={form.enabled} onChange={(event) => onChange({ ...form, enabled: event.target.checked })} /> 创建后立即启用
          </label>
        </div>
      </details>

      <div style={{ ...rowStyle, marginTop: GAP.section, paddingTop: GAP.section, borderTop: '1px solid var(--border-subtle)' }}>
        <span style={HINT_TEXT}>{mode === 'edit' ? `正在编辑版本 ${form.version}，旧版本提交会被服务端拒绝。` : '保存只创建配置，不会自动产生上游请求。'}</span>
        <div style={{ ...CARD_ACTIONS, marginLeft: 'auto' }}>
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={onSave}>{busy ? '保存中' : mode === 'create' ? '创建并读回' : '保存并读回'}</Button>
        </div>
      </div>
    </Card>
  );
}

/** 卡片内的一行：图标 / 标题 / 元信息 / 右侧操作，全站同一种排法。 */
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: GAP.normal,
  flexWrap: 'wrap',
  minWidth: 0,
};

/** 模型一行：无底色，靠细线与上一行分开。灰底留给卡片里唯一的重块（路由行）。 */
const modelLineStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: GAP.normal,
  flexWrap: 'wrap',
  minWidth: 0,
  paddingTop: GAP.normal,
  paddingBottom: GAP.tight,
  borderBottom: '1px solid var(--border-subtle)',
};

const listStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: GAP.section,
};

// 不限宽：此前固定 840，而下方 Exchange 列表是撑满的，
// 两个区块右边缘对不齐，一眼就是「这页没排过版」。
const capabilitySectionStyle: React.CSSProperties = {
  display: 'grid',
  gap: GAP.normal,
  width: '100%',
};

const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: GAP.normal,
  minWidth: 0,
};

const sectionIconStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  borderRadius: 'var(--radius-sm)',
  color: 'var(--accent)',
  background: 'var(--accent-soft)',
};

const capabilityMetaStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: GAP.section,
  paddingBottom: GAP.section,
  borderBottom: '1px solid var(--border-subtle)',
};

const metaPairStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: GAP.tight,
  minWidth: 0,
};

const capabilityFormStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  flexWrap: 'wrap',
  gap: GAP.normal,
  marginTop: GAP.section,
};

const toolbarStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: GAP.normal,
  flexWrap: 'wrap',
  minWidth: 0,
};

// 空状态：外层 Card 已经带 CARD_BODY(14)，这里不再叠第二层内边距
// ——「卡片内边距只许 14 或 10」，多拍一个数就会给漂移检测多一种规格。
const emptyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: GAP.section,
  maxWidth: 'var(--measure)',
  color: 'var(--text-muted)',
};

const checkStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: GAP.tight,
  color: 'var(--text-secondary)',
  fontSize: 'var(--fs-body)',
};

const summaryStyle: React.CSSProperties = {
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  fontSize: 'var(--fs-secondary)',
  fontWeight: 600,
};

// 模型映射一行：原来是五列 grid，靠 theme.css 的 @media(max-width:760px) 塌成一列。
// 迁到内联样式后**内联优先级高于媒体查询**，那条兜底就失效了——
// 所以这里改成 flex 换行，窄屏靠 flex-basis 自己折行，不再依赖任何断点。
const modelRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  gap: GAP.normal,
  paddingTop: GAP.normal,
  borderTop: '1px solid var(--border-subtle)',
};

/** 模型行里的字段：窄屏折行，宽屏按权重分配。 */
const modelFieldStyle = (basis: number): React.CSSProperties => ({ ...FIELD_LABEL, flex: `1 1 ${basis}px` });
