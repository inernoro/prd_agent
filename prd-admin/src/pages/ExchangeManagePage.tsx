import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { Dialog } from '@/components/ui/Dialog';
import {
  getExchanges,
  createExchange,
  updateExchange,
  deleteExchange,
  getTransformerTypes,
  getExchangeTemplates,
  importExchangeFromTemplate,
} from '@/services/real/exchanges';
import type { ModelExchange, CreateExchangeRequest, UpdateExchangeRequest, TransformerTypeOption, ExchangeTemplate, ExchangeModelInput, ExchangeModel } from '@/types/exchange';
import { AUTH_SCHEME_OPTIONS, MODEL_TYPE_OPTIONS } from '@/types/exchange';
import { ExchangeTestPanel } from '@/components/exchange/ExchangeTestPanel';
import { tryExchangeModel } from '@/services/real/exchanges';
import {
  ArrowLeftRight,
  Box,
  Download,
  Edit,
  FlaskConical,
  Play,
  Plus,
  Trash2,
  X,
  Zap,
  ZapOff,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import { ModelGroupsService } from '@/services/real/modelGroups';
import type { CreateModelGroupRequest } from '@/types/modelGroup';
import { PoolStrategyType } from '@/types/modelGroup';

const modelGroupsService = new ModelGroupsService();

/** 推断 Exchange 转换器类型对应的模型类型 */
function inferModelType(transformerType: string): string {
  if (transformerType.startsWith('doubao-asr') || transformerType.includes('asr')) return 'asr';
  if (transformerType.startsWith('fal-image')) return 'generation';
  if (transformerType === 'tts' || transformerType.includes('tts')) return 'tts';
  return 'chat';
}

type ExchangeForm = {
  /** 虚拟平台名称（用户自定义） */
  name: string;
  /** 挂在此中继下的模型列表 */
  models: ExchangeModelInput[];
  targetUrl: string;
  targetApiKey: string;
  targetAuthScheme: string;
  transformerType: string;
  imageTransferMode: string;
  enabled: boolean;
  description: string;
};

function isFalImageType(type: string) {
  return ['fal-image', 'fal-image-edit'].includes(type);
}

const IMAGE_TRANSFER_MODE_OPTIONS = [
  { value: 'auto', label: '自动 (推荐)', desc: '上传 → Base64，URL → 保持原样' },
  { value: 'base64', label: '仅 Base64', desc: '全部转为 Base64 data URI，确保对方可接收' },
  { value: 'url', label: '仅 URL', desc: '只允许 URL 输入，日志更干净' },
];

const defaultForm: ExchangeForm = {
  name: '',
  models: [],
  targetUrl: '',
  targetApiKey: '',
  targetAuthScheme: 'Bearer',
  transformerType: 'passthrough',
  imageTransferMode: 'auto',
  enabled: true,
  description: '',
};

const emptyModel = (): ExchangeModelInput => ({
  modelId: '',
  displayName: '',
  modelType: 'chat',
  enabled: true,
});

export function ExchangeManagePage() {
  const [exchanges, setExchanges] = useState<ModelExchange[]>([]);
  const [transformerTypes, setTransformerTypes] = useState<TransformerTypeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ExchangeForm>(defaultForm);
  const [saving, setSaving] = useState(false);
  const [testingExchange, setTestingExchange] = useState<ModelExchange | null>(null);

  // 导入模板状态
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [templates, setTemplates] = useState<ExchangeTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<ExchangeTemplate | null>(null);
  const [templateApiKey, setTemplateApiKey] = useState('');
  const [importing, setImporting] = useState(false);

  // 一键创建模型池状态
  const [showPoolDialog, setShowPoolDialog] = useState(false);
  const [poolExchange, setPoolExchange] = useState<ModelExchange | null>(null);
  const [poolForm, setPoolForm] = useState({
    name: '',
    code: '',
    modelType: 'asr',
    isDefaultForType: false,
  });
  const [creatingPool, setCreatingPool] = useState(false);

  const handleOpenPoolDialog = (exchange: ModelExchange) => {
    // 取 Exchange 下第一个启用的模型作为默认，兜底用旧 modelAlias
    const firstModel = (exchange.models ?? []).find(m => m.enabled);
    const fallbackModelId = firstModel?.modelId ?? exchange.modelAlias ?? '';
    const modelType = firstModel?.modelType ?? inferModelType(exchange.transformerType);
    setPoolExchange(exchange);
    setPoolForm({
      name: `${exchange.name} 模型池`,
      code: `pool-${fallbackModelId || exchange.id.slice(0, 8)}`,
      modelType,
      isDefaultForType: false,
    });
    setShowPoolDialog(true);
  };

  const handleCreatePool = async () => {
    if (!poolExchange) return;
    if (!poolForm.name.trim()) { toast.error('请填写模型池名称'); return; }
    if (!poolForm.code.trim()) { toast.error('请填写模型池代码'); return; }

    const firstModel = (poolExchange.models ?? []).find(m => m.enabled);
    const modelId = firstModel?.modelId ?? poolExchange.modelAlias ?? '';
    if (!modelId) { toast.error('该中继未配置任何模型'); return; }

    setCreatingPool(true);
    try {
      const req: CreateModelGroupRequest = {
        name: poolForm.name.trim(),
        code: poolForm.code.trim(),
        priority: 50,
        modelType: poolForm.modelType,
        isDefaultForType: poolForm.isDefaultForType,
        strategyType: PoolStrategyType.FailFast,
        models: [{
          modelId,
          platformId: poolExchange.platformId, // 真实 Exchange.Id，不再是 __exchange__
          priority: 0,
          healthStatus: 'Healthy' as any,
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
        }],
      };
      await modelGroupsService.createModelGroup(req);
      toast.success(`模型池「${poolForm.name}」已创建，包含模型 ${modelId}`);
      setShowPoolDialog(false);
    } catch (err: any) {
      toast.error(err.message ?? '创建模型池失败');
    } finally {
      setCreatingPool(false);
    }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const [exchRes, ttRes] = await Promise.all([getExchanges(), getTransformerTypes()]);
      if (exchRes.success) setExchanges(exchRes.data);
      if (ttRes.success) setTransformerTypes(ttRes.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreate = () => {
    setEditingId(null);
    setForm(defaultForm);
    setShowDialog(true);
  };

  const handleEdit = (exchange: ModelExchange) => {
    setEditingId(exchange.id);
    setForm({
      name: exchange.name,
      models: (exchange.models ?? []).map(m => ({
        modelId: m.modelId,
        displayName: m.displayName ?? '',
        modelType: m.modelType || 'chat',
        description: m.description ?? '',
        enabled: m.enabled,
      })),
      targetUrl: exchange.targetUrl,
      targetApiKey: '', // 不回填密钥
      targetAuthScheme: exchange.targetAuthScheme,
      transformerType: exchange.transformerType,
      imageTransferMode: (exchange.transformerConfig?.imageTransferMode as string) ?? 'auto',
      enabled: exchange.enabled,
      description: exchange.description ?? '',
    });
    setShowDialog(true);
  };

  const handleDelete = async (exchange: ModelExchange) => {
    const confirmed = await systemDialog.confirm({
      title: '确认删除',
      message: `确定删除模型中继「${exchange.name}」吗？删除后，引用该 Exchange 的模型池将无法调用此模型。`,
      tone: 'danger',
    });
    if (!confirmed) return;

    const res = await deleteExchange(exchange.id);
    if (res.success) {
      toast.success('已删除');
      loadData();
    } else {
      toast.error(res.error?.message ?? '删除失败');
    }
  };

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error('请填写虚拟平台名称'); return; }
    if (!form.targetUrl.trim()) { toast.error('请填写目标 URL'); return; }

    // 规范化 Models：过滤空行 + 去重
    const seen = new Set<string>();
    const normalizedModels: ExchangeModelInput[] = form.models
      .map(m => ({
        modelId: m.modelId.trim(),
        displayName: m.displayName?.trim() || undefined,
        modelType: m.modelType || 'chat',
        description: m.description?.trim() || undefined,
        enabled: m.enabled ?? true,
      }))
      .filter(m => m.modelId && !seen.has(m.modelId) && (seen.add(m.modelId) || true));

    if (normalizedModels.length === 0) {
      toast.error('至少添加一个模型');
      return;
    }

    setSaving(true);
    try {
      if (editingId) {
        const transformerConfig: Record<string, unknown> = {};
        if (isFalImageType(form.transformerType)) {
          transformerConfig.imageTransferMode = form.imageTransferMode;
        }
        const req: UpdateExchangeRequest = {
          name: form.name.trim(),
          models: normalizedModels,
          // 写入一个 modelAlias 兜底兼容（取第一个模型），不影响实际使用
          modelAlias: normalizedModels[0].modelId,
          targetUrl: form.targetUrl.trim(),
          targetAuthScheme: form.targetAuthScheme,
          transformerType: form.transformerType,
          transformerConfig,
          enabled: form.enabled,
          description: form.description.trim() || undefined,
        };
        if (form.targetApiKey.trim()) {
          req.targetApiKey = form.targetApiKey.trim();
        }
        const res = await updateExchange(editingId, req);
        if (res.success) {
          toast.success('已更新');
          setShowDialog(false);
          loadData();
        } else {
          toast.error(res.error?.message ?? '更新失败');
        }
      } else {
        const createConfig: Record<string, unknown> = {};
        if (isFalImageType(form.transformerType)) {
          createConfig.imageTransferMode = form.imageTransferMode;
        }
        const req: CreateExchangeRequest = {
          name: form.name.trim(),
          models: normalizedModels,
          modelAlias: normalizedModels[0].modelId,
          targetUrl: form.targetUrl.trim(),
          targetApiKey: form.targetApiKey.trim() || undefined,
          targetAuthScheme: form.targetAuthScheme,
          transformerType: form.transformerType,
          transformerConfig: createConfig,
          enabled: form.enabled,
          description: form.description.trim() || undefined,
        };
        const res = await createExchange(req);
        if (res.success) {
          toast.success('已创建');
          setShowDialog(false);
          loadData();
        } else {
          toast.error(res.error?.message ?? '创建失败');
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCopyAlias = (alias: string) => {
    navigator.clipboard.writeText(alias);
    toast.success(`已复制: ${alias}`);
  };

  const handleOpenTemplates = async () => {
    setShowTemplateDialog(true);
    setSelectedTemplate(null);
    setTemplateApiKey('');
    setTemplatesLoading(true);
    try {
      const res = await getExchangeTemplates();
      if (res.success) setTemplates(res.data);
    } finally {
      setTemplatesLoading(false);
    }
  };

  const handleImportTemplate = async () => {
    if (!selectedTemplate) { toast.error('请选择模板'); return; }
    if (!templateApiKey.trim()) { toast.error('请填写 API Key'); return; }
    setImporting(true);
    try {
      const res = await importExchangeFromTemplate(selectedTemplate.id, templateApiKey.trim());
      if (res.success) {
        toast.success(`已导入虚拟平台: ${res.data.name}${res.data.modelCount ? ` (${res.data.modelCount} 个模型)` : ''}`);
        setShowTemplateDialog(false);
        loadData();
      } else {
        toast.error(res.error?.message ?? '导入失败');
      }
    } finally {
      setImporting(false);
    }
  };

  // 一键体验：调用后端 try-it 端点，将结果塞进 ExchangeTestPanel 的初始数据
  const [tryingKey, setTryingKey] = useState<string | null>(null);
  const handleTryModel = async (exchange: ModelExchange, model: ExchangeModel) => {
    const key = `${exchange.id}:${model.modelId}`;
    setTryingKey(key);
    try {
      const res = await tryExchangeModel(exchange.id, model.modelId);
      if (res.success) {
        // 简洁反馈：成功 → toast + 打开测试面板展示详情
        toast.success(`✓ ${model.modelId} 跑通 (${res.data.durationMs ?? '?'}ms)`);
        setTestingExchange(exchange);
      } else {
        toast.error(res.error?.message ?? '一键体验失败');
      }
    } finally {
      setTryingKey(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* 顶部工具栏 */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          模型中继将非标准 API 伪装为标准接口，使模型池可以像使用普通模型一样调用非标准模型。
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={handleOpenTemplates}>
            <Download size={14} className="mr-1" /> 从模板导入
          </Button>
          <Button size="sm" onClick={handleCreate}>
            <Plus size={14} className="mr-1" /> 新建中继
          </Button>
        </div>
      </div>

      {/* 列表 */}
      {loading ? (
        <MapSectionLoader />
      ) : exchanges.length === 0 ? (
        <GlassCard animated className="text-center py-12">
          <ArrowLeftRight size={36} className="mx-auto mb-3 text-muted-foreground/50" />
          <div className="text-muted-foreground">暂无模型中继配置</div>
          <div className="text-xs text-muted-foreground/60 mt-1">点击「新建中继」添加第一个 Exchange</div>
        </GlassCard>
      ) : (
        <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
          {exchanges.map(exchange => (
            <GlassCard animated key={exchange.id} className="relative p-4 space-y-3">
              {/* 头部：名称 + 状态 */}
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <ArrowLeftRight size={16} className="text-primary/70 shrink-0" />
                    <span className="font-medium truncate">{exchange.name}</span>
                    {exchange.enabled ? (
                      <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full"
                        style={{ background: 'rgba(34,197,94,0.12)', color: 'rgba(34,197,94,0.95)', border: '1px solid rgba(34,197,94,0.28)' }}>
                        <Zap size={10} /> 启用
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full"
                        style={{ background: 'rgba(239,68,68,0.12)', color: 'rgba(239,68,68,0.95)', border: '1px solid rgba(239,68,68,0.28)' }}>
                        <ZapOff size={10} /> 停用
                      </span>
                    )}
                  </div>
                  {exchange.description && (
                    <div className="text-xs text-muted-foreground mt-1 truncate">{exchange.description}</div>
                  )}
                </div>
                <div className="flex items-center gap-1 ml-2 shrink-0">
                  <button className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
                    onClick={() => handleOpenPoolDialog(exchange)} title="一键添加到模型池">
                    <Box size={14} />
                  </button>
                  <button className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
                    onClick={() => setTestingExchange(exchange)} title="测试">
                    <FlaskConical size={14} />
                  </button>
                  <button className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
                    onClick={() => handleEdit(exchange)} title="编辑">
                    <Edit size={14} />
                  </button>
                  <button className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-destructive"
                    onClick={() => handleDelete(exchange)} title="删除">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {/* Provider 元信息 */}
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-16 shrink-0">虚拟平台</span>
                  <span className="flex-1 truncate text-foreground/80">{exchange.platformName || exchange.name}</span>
                  <span className="text-[10px] px-1 py-0.5 rounded bg-primary/10 text-primary/80 border border-primary/20">Exchange</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-16 shrink-0">目标 URL</span>
                  <span className="flex-1 truncate text-foreground/80">{exchange.targetUrl}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-16 shrink-0">认证方案</span>
                  <span className="text-foreground/80">{exchange.targetAuthScheme}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-16 shrink-0">转换器</span>
                  <code className="px-1.5 py-0.5 rounded bg-muted/40 font-mono text-[11px]">{exchange.transformerType}</code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-16 shrink-0">API Key</span>
                  <span className="text-foreground/60 font-mono text-[11px]">{exchange.apiKeyMasked}</span>
                </div>
              </div>

              {/* 模型列表 */}
              <div className="pt-2 border-t border-border/30">
                <div className="text-[11px] text-muted-foreground mb-1.5">
                  已挂载模型 ({(exchange.models ?? []).length})
                </div>
                {(exchange.models ?? []).length === 0 ? (
                  <div className="text-[11px] text-muted-foreground/60 italic">（未配置模型，点击编辑添加）</div>
                ) : (
                  <div className="space-y-1">
                    {(exchange.models ?? []).map(m => {
                      const tryKey = `${exchange.id}:${m.modelId}`;
                      const isTrying = tryingKey === tryKey;
                      return (
                        <div key={m.modelId} className="flex items-center gap-2 text-xs">
                          <code
                            className="flex-1 truncate px-1.5 py-0.5 rounded bg-muted/40 font-mono text-[11px] cursor-pointer hover:bg-muted/60"
                            onClick={() => handleCopyAlias(m.modelId)}
                            title="点击复制 ModelId"
                          >
                            {m.displayName ? `${m.displayName} · ${m.modelId}` : m.modelId}
                          </code>
                          <span className="text-[10px] text-muted-foreground/70">{m.modelType}</span>
                          {!m.enabled && <span className="text-[10px] text-muted-foreground/50">(禁用)</span>}
                          <button
                            className="p-0.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary disabled:opacity-50"
                            onClick={() => handleTryModel(exchange, m)}
                            disabled={!m.enabled || isTrying}
                            title="一键体验"
                          >
                            <Play size={12} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 底部使用提示 */}
              <div className="pt-2 border-t border-border/30 text-[11px] text-muted-foreground/60">
                在模型池管理页选择平台「{exchange.platformName || exchange.name}」下的任意模型即可使用
              </div>
            </GlassCard>
          ))}
        </div>
      )}

      {/* 测试面板对话框 */}
      <Dialog
        open={testingExchange !== null}
        onOpenChange={open => { if (!open) setTestingExchange(null); }}
        title="Exchange 转换管线测试"
        maxWidth={1100}
        content={
          testingExchange ? (
            <ExchangeTestPanel
              exchange={testingExchange}
              onClose={() => setTestingExchange(null)}
            />
          ) : <div />
        }
      />

      {/* 模板导入对话框 */}
      <Dialog
        open={showTemplateDialog}
        onOpenChange={setShowTemplateDialog}
        title="从模板导入中继"
        maxWidth={560}
        content={
          <div className="space-y-4 pt-2">
            {templatesLoading ? (
              <div className="text-center py-8 text-muted-foreground text-sm">加载模板中...</div>
            ) : templates.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">暂无可用模板</div>
            ) : (
              <>
                <div className="text-sm text-muted-foreground">
                  选择预设模板，只需填写 API Key 即可一键创建中继配置。
                </div>
                <div className="space-y-2">
                  {templates.map(tpl => (
                    <button
                      key={tpl.id}
                      className={`w-full text-left p-3 rounded-lg border transition-colors ${
                        selectedTemplate?.id === tpl.id
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-primary/50 hover:bg-muted/30'
                      }`}
                      onClick={() => { setSelectedTemplate(tpl); setTemplateApiKey(''); }}
                    >
                      <div className="font-medium text-sm">{tpl.name}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{tpl.description}</div>
                      <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground/70">
                        <span>转换器: <code className="px-1 py-0.5 rounded bg-muted/40">{tpl.preset.transformerType}</code></span>
                        <span>认证: {tpl.preset.targetAuthScheme}</span>
                      </div>
                    </button>
                  ))}
                </div>

                {selectedTemplate && (
                  <div className="space-y-3 pt-2 border-t border-border/30">
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        API Key
                      </label>
                      <input
                        type="password"
                        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                        placeholder={selectedTemplate.apiKeyPlaceholder}
                        value={templateApiKey}
                        onChange={e => setTemplateApiKey(e.target.value)}
                      />
                      <div className="text-[11px] text-muted-foreground mt-1">
                        {selectedTemplate.apiKeyHint}
                      </div>
                    </div>

                    <div className="text-xs text-muted-foreground space-y-1 p-2 rounded bg-muted/20">
                      <div>将创建虚拟平台: <strong>{selectedTemplate.preset.name}</strong></div>
                      {(selectedTemplate.preset.models && selectedTemplate.preset.models.length > 0) ? (
                        <div>包含模型: <strong>{selectedTemplate.preset.models.length}</strong> 个
                          <div className="mt-1 flex flex-wrap gap-1">
                            {selectedTemplate.preset.models.map(m => (
                              <code key={m.modelId} className="px-1 py-0.5 rounded bg-muted/40 text-[10px]">{m.modelId}</code>
                            ))}
                          </div>
                        </div>
                      ) : selectedTemplate.preset.modelAlias ? (
                        <div>模型: <code className="px-1 py-0.5 rounded bg-muted/40">{selectedTemplate.preset.modelAlias}</code></div>
                      ) : null}
                      <div className="truncate">目标 URL: {selectedTemplate.preset.targetUrl}</div>
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="secondary" size="sm" onClick={() => setShowTemplateDialog(false)}>
                    取消
                  </Button>
                  <Button size="sm" onClick={handleImportTemplate} disabled={importing || !selectedTemplate || !templateApiKey.trim()}>
                    {importing ? '导入中...' : '导入'}
                  </Button>
                </div>
              </>
            )}
          </div>
        }
      />

      {/* 一键创建模型池对话框 */}
      <Dialog
        open={showPoolDialog}
        onOpenChange={setShowPoolDialog}
        title="一键创建模型池"
        maxWidth={480}
        content={
          poolExchange ? (
            <div className="space-y-4 pt-2">
              <div className="text-sm text-muted-foreground">
                为中继「{poolExchange.name}」创建专属模型池，自动关联模型 <code className="px-1 py-0.5 rounded bg-muted/40 text-[11px]">{poolExchange.modelAlias}</code>。
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">模型池名称</label>
                <input
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                  value={poolForm.name}
                  onChange={e => setPoolForm(f => ({ ...f, name: e.target.value }))}
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">模型池代码</label>
                <input
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm font-mono"
                  value={poolForm.code}
                  onChange={e => setPoolForm(f => ({ ...f, code: e.target.value }))}
                />
                <div className="text-[11px] text-muted-foreground mt-1">
                  用于 Gateway 调度匹配，建议使用 kebab-case
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">模型类型</label>
                <select
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                  value={poolForm.modelType}
                  onChange={e => setPoolForm(f => ({ ...f, modelType: e.target.value }))}
                >
                  <option value="chat">对话 (chat)</option>
                  <option value="vision">视觉 (vision)</option>
                  <option value="generation">图片生成 (generation)</option>
                  <option value="asr">语音识别 (asr)</option>
                  <option value="tts">语音合成 (tts)</option>
                  <option value="video-gen">视频生成 (video-gen)</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="pool-default"
                  checked={poolForm.isDefaultForType}
                  onChange={e => setPoolForm(f => ({ ...f, isDefaultForType: e.target.checked }))}
                  className="rounded"
                />
                <label htmlFor="pool-default" className="text-sm">设为该类型的默认模型池</label>
              </div>

              <div className="p-2 rounded bg-muted/20 text-[11px] text-muted-foreground space-y-1">
                <div>平台: <strong>{poolExchange.platformName}</strong></div>
                <div>模型: <code className="px-1 py-0.5 rounded bg-muted/40">{poolExchange.modelAlias}</code></div>
                <div>策略: FailFast（快速失败，单模型推荐）</div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" size="sm" onClick={() => setShowPoolDialog(false)}>
                  取消
                </Button>
                <Button size="sm" onClick={handleCreatePool} disabled={creatingPool}>
                  {creatingPool ? '创建中...' : '创建模型池'}
                </Button>
              </div>
            </div>
          ) : <div />
        }
      />

      {/* 新建/编辑对话框 */}
      <Dialog
        open={showDialog}
        onOpenChange={setShowDialog}
        title={editingId ? '编辑模型中继' : '新建模型中继'}
        maxWidth={540}
        content={
          <div className="space-y-4 pt-2">
            {/* 名称 */}
            <div>
              <label className="block text-sm font-medium mb-1">名称</label>
              <input
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                placeholder="例如: Nano Banana Pro Edit"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>

            {/* 模型列表（一中继 = 虚拟平台 + N 个模型） */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium">模型列表</label>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setForm(f => ({ ...f, models: [...f.models, emptyModel()] }))}
                >
                  <Plus size={12} className="mr-1" /> 添加模型
                </Button>
              </div>
              <div className="text-[11px] text-muted-foreground mb-2">
                此虚拟平台下的可用模型。ModelId 会拼进 URL 模版的 <code className="px-1 py-0.5 rounded bg-muted/40">{'{model}'}</code> 占位符。
              </div>

              {form.models.length === 0 ? (
                <div className="p-4 text-center text-xs text-muted-foreground border border-dashed border-border rounded-lg">
                  暂无模型，点击上方「添加模型」开始配置
                </div>
              ) : (
                <div className="space-y-2">
                  {form.models.map((m, idx) => (
                    <div key={idx} className="p-2 rounded-lg border border-border/60 bg-muted/20 space-y-1.5">
                      <div className="grid grid-cols-[1fr_1fr_110px_32px] gap-1.5 items-center">
                        <input
                          className="px-2 py-1.5 rounded border border-border bg-background text-xs font-mono"
                          placeholder="ModelId (如 gemini-2.5-flash)"
                          value={m.modelId}
                          onChange={e => setForm(f => ({
                            ...f,
                            models: f.models.map((x, i) => i === idx ? { ...x, modelId: e.target.value } : x)
                          }))}
                        />
                        <input
                          className="px-2 py-1.5 rounded border border-border bg-background text-xs"
                          placeholder="显示名 (可选)"
                          value={m.displayName ?? ''}
                          onChange={e => setForm(f => ({
                            ...f,
                            models: f.models.map((x, i) => i === idx ? { ...x, displayName: e.target.value } : x)
                          }))}
                        />
                        <select
                          className="px-2 py-1.5 rounded border border-border bg-background text-xs"
                          value={m.modelType || 'chat'}
                          onChange={e => setForm(f => ({
                            ...f,
                            models: f.models.map((x, i) => i === idx ? { ...x, modelType: e.target.value } : x)
                          }))}
                        >
                          {MODEL_TYPE_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                        <button
                          className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                          onClick={() => setForm(f => ({
                            ...f,
                            models: f.models.filter((_, i) => i !== idx)
                          }))}
                          title="删除"
                        >
                          <X size={12} />
                        </button>
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <input
                            type="checkbox"
                            className="rounded"
                            checked={m.enabled ?? true}
                            onChange={e => setForm(f => ({
                              ...f,
                              models: f.models.map((x, i) => i === idx ? { ...x, enabled: e.target.checked } : x)
                            }))}
                          />
                          启用
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 目标 URL */}
            <div>
              <label className="block text-sm font-medium mb-1">目标 API URL</label>
              <input
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                placeholder="例如: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
                value={form.targetUrl}
                onChange={e => setForm(f => ({ ...f, targetUrl: e.target.value }))}
              />
              <div className="text-[11px] text-muted-foreground mt-1">
                支持 <code className="px-1 py-0.5 rounded bg-muted/40">{'{model}'}</code> 占位符，运行时自动替换为模型池调度出的实际模型 ID。留空占位符则一条中继固定调用一个模型。
              </div>
            </div>

            {/* API Key */}
            <div>
              <label className="block text-sm font-medium mb-1">
                目标 API Key
                {editingId && <span className="text-muted-foreground font-normal ml-2">(留空则不更新)</span>}
              </label>
              <input
                type="password"
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                placeholder={editingId ? '留空不更新' : '输入 API Key'}
                value={form.targetApiKey}
                onChange={e => setForm(f => ({ ...f, targetApiKey: e.target.value }))}
              />
            </div>

            {/* 认证方案 + 转换器 */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">认证方案</label>
                <select
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                  value={form.targetAuthScheme}
                  onChange={e => setForm(f => ({ ...f, targetAuthScheme: e.target.value }))}
                >
                  {AUTH_SCHEME_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">转换器类型</label>
                <select
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                  value={form.transformerType}
                  onChange={e => setForm(f => ({ ...f, transformerType: e.target.value }))}
                >
                  {transformerTypes.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* 图片传输模式（仅图片类型转换器显示） */}
            {isFalImageType(form.transformerType) && (
              <div>
                <label className="block text-sm font-medium mb-1">图片传输模式</label>
                <select
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                  value={form.imageTransferMode}
                  onChange={e => setForm(f => ({ ...f, imageTransferMode: e.target.value }))}
                >
                  {IMAGE_TRANSFER_MODE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label} — {opt.desc}</option>
                  ))}
                </select>
              </div>
            )}

            {/* 启用 */}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="exchange-enabled"
                checked={form.enabled}
                onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
                className="rounded"
              />
              <label htmlFor="exchange-enabled" className="text-sm">启用</label>
            </div>

            {/* 描述 */}
            <div>
              <label className="block text-sm font-medium mb-1">备注</label>
              <textarea
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm resize-none"
                rows={2}
                placeholder="可选备注信息"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              />
            </div>

            {/* 操作按钮 */}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={() => setShowDialog(false)}>
                取消
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? '保存中...' : editingId ? '保存' : '创建'}
              </Button>
            </div>
          </div>
        }
      />
    </div>
  );
}
