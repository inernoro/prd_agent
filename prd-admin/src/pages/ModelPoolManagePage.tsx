import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { GlassSwitch } from '@/components/design/GlassSwitch';
import { TabBar } from '@/components/design/TabBar';
import { Select } from '@/components/design/Select';
import { Dialog } from '@/components/ui/Dialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { ModelPoolPickerDialog, type SelectedModelItem } from '@/components/model/ModelPoolPickerDialog';
import { ModelListItem } from '@/components/model/ModelListItem';
import { PoolPredictionDialog } from '@/components/model/PoolPredictionDialog';
import {
  getModelGroups,
  getPlatforms,
  createModelGroup,
  updateModelGroup,
  deleteModelGroup,
  predictNextDispatch,
} from '@/services';
import type { ModelGroup, ModelGroupItem, Platform, PoolPrediction } from '@/types';
import { ModelHealthStatus, PoolStrategyType } from '@/types/modelGroup';
import {
  Copy,
  Database,
  Edit,
  Plus,
  Search,
  Trash2,
  Radar,
  Zap,
  GitBranch,
  ArrowRight,
  RotateCw,
  CircleDot,
  Check,
  ChevronRight,
} from 'lucide-react';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import { getModelTypeDisplayName, getModelTypeIcon } from '@/lib/appCallerUtils';

/* ── 4 种可预测的调度策略（icon 选择器） ── */
const STRATEGY_OPTIONS = [
  { value: PoolStrategyType.FailFast, label: '快速失败', desc: '选最优，失败即止', icon: Zap, color: 'rgba(251,146,60,0.95)' },
  { value: PoolStrategyType.Race, label: '竞速', desc: '并行发送，取最快', icon: GitBranch, color: 'rgba(168,85,247,0.95)' },
  { value: PoolStrategyType.Sequential, label: '顺序容灾', desc: '逐个尝试，失败切换', icon: ArrowRight, color: 'rgba(56,189,248,0.95)' },
  { value: PoolStrategyType.RoundRobin, label: '轮询', desc: '均匀分配', icon: RotateCw, color: 'rgba(34,197,94,0.95)' },
];

/* 卡片列表中显示策略标签时也需要文案映射 */
const STRATEGY_LABEL_MAP: Record<number, string> = {
  [PoolStrategyType.FailFast]: '快速失败',
  [PoolStrategyType.Race]: '竞速',
  [PoolStrategyType.Sequential]: '顺序容灾',
  [PoolStrategyType.RoundRobin]: '轮询',
  [PoolStrategyType.WeightedRandom]: '加权随机',
  [PoolStrategyType.LeastLatency]: '最低延迟',
};

const MODEL_TYPES = [
  { value: 'chat', label: '对话模型' },
  { value: 'intent', label: '意图识别' },
  { value: 'vision', label: '视觉理解' },
  { value: 'generation', label: '图像生成' },
  { value: 'code', label: '代码生成' },
  { value: 'long-context', label: '长上下文' },
  { value: 'embedding', label: '向量嵌入' },
  { value: 'rerank', label: '重排序' },
];

const HEALTH_STATUS_MAP = {
  Healthy: { label: '健康', color: 'rgba(34,197,94,0.95)', bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.28)' },
  Degraded: { label: '降权', color: 'rgba(251,191,36,0.95)', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.28)' },
  Unavailable: { label: '不可用', color: 'rgba(239,68,68,0.95)', bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.28)' },
};

function keyOfModel(m: Pick<ModelGroupItem, 'platformId' | 'modelId'>) {
  return `${m.platformId}:${m.modelId}`.toLowerCase();
}

export function ModelPoolManagePage() {
  const [pools, setPools] = useState<ModelGroup[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  // 弹窗状态
  const [showPoolDialog, setShowPoolDialog] = useState(false);
  const [editingPool, setEditingPool] = useState<ModelGroup | null>(null);

  // 模型池表单
  const [poolForm, setPoolForm] = useState({
    name: '',
    code: '',
    priority: 50,
    modelType: 'chat',
    strategyType: PoolStrategyType.FailFast as PoolStrategyType,
    isDefaultForType: false,
    description: '',
    models: [] as ModelGroupItem[],
  });

  // 模型选择弹窗（使用公共组件）
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  // 预测弹窗
  const [predictionOpen, setPredictionOpen] = useState(false);
  const [predictionData, setPredictionData] = useState<PoolPrediction | null>(null);
  const [predictionLoading, setPredictionLoading] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [poolsData, platformsData] = await Promise.all([
        getModelGroups(),
        getPlatforms(),
      ]);
      setPools(poolsData);
      if (platformsData.success) {
        setPlatforms(platformsData.data);
      }
    } catch (error) {
      toast.error('加载失败', String(error));
    } finally {
      setLoading(false);
    }
  };

  const handleAddPool = () => {
    setEditingPool(null);
    setPoolForm({
      name: '',
      code: '',
      priority: 50,
      modelType: 'chat',
      strategyType: PoolStrategyType.FailFast,
      isDefaultForType: false,
      description: '',
      models: [],
    });
    setShowPoolDialog(true);
  };

  const handleEditPool = (pool: ModelGroup) => {
    setEditingPool(pool);
    setPoolForm({
      name: pool.name,
      code: pool.code || '',
      priority: pool.priority ?? 50,
      modelType: pool.modelType || 'chat',
      strategyType: pool.strategyType ?? PoolStrategyType.FailFast,
      isDefaultForType: pool.isDefaultForType || false,
      description: pool.description || '',
      models: pool.models || [],
    });
    setShowPoolDialog(true);
  };

  const handleCopyPool = (pool: ModelGroup) => {
    setEditingPool(null);
    setPoolForm({
      name: '',
      code: '',
      priority: 50,
      modelType: pool.modelType || 'chat',
      strategyType: pool.strategyType ?? PoolStrategyType.FailFast,
      isDefaultForType: false,
      description: '',
      models: (pool.models || []).map((m, idx) => ({
        ...m,
        priority: idx + 1,
        healthStatus: ModelHealthStatus.Healthy,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
      })),
    });
    setShowPoolDialog(true);
  };

  const handleDeletePool = async (pool: ModelGroup) => {
    const confirmed = await systemDialog.confirm({
      title: '确认删除',
      message: `删除模型池"${pool.name}"后无法恢复，确定继续？`,
    });
    if (!confirmed) return;

    try {
      await deleteModelGroup(pool.id);
      toast.success('删除成功');
      await loadData();
    } catch (error) {
      toast.error('删除失败', String(error));
    }
  };

  const handlePredict = useCallback(async (pool: ModelGroup) => {
    if (pool.models?.length === 0) {
      toast.warning('无法预测', '模型池为空');
      return;
    }
    setPredictionLoading(true);
    setPredictionOpen(true);
    setPredictionData(null);
    try {
      const data = await predictNextDispatch(pool.id);
      setPredictionData(data);
    } catch (error) {
      toast.error('预测失败', String(error));
      setPredictionOpen(false);
    } finally {
      setPredictionLoading(false);
    }
  }, []);

  const handleSavePool = async () => {
    if (!poolForm.name.trim()) {
      toast.warning('验证失败', '模型池名称不能为空');
      return;
    }
    if (!editingPool && !poolForm.code.trim()) {
      toast.warning('验证失败', '模型池代码不能为空');
      return;
    }
    if (!poolForm.modelType.trim()) {
      toast.warning('验证失败', '模型类型不能为空');
      return;
    }

    try {
      if (editingPool) {
        await updateModelGroup(editingPool.id, {
          name: poolForm.name,
          code: poolForm.code,
          priority: poolForm.priority,
          modelType: poolForm.modelType,
          strategyType: poolForm.strategyType,
          isDefaultForType: poolForm.isDefaultForType,
          description: poolForm.description,
          models: poolForm.models,
        });
      } else {
        await createModelGroup({
          name: poolForm.name,
          code: poolForm.code,
          priority: poolForm.priority,
          modelType: poolForm.modelType,
          strategyType: poolForm.strategyType,
          isDefaultForType: poolForm.isDefaultForType,
          description: poolForm.description,
          models: poolForm.models,
        });
      }
      toast.success('保存成功');
      await loadData();
      setShowPoolDialog(false);
    } catch (error) {
      toast.error('保存失败', String(error));
    }
  };

  const toggleModel = (platformId: string, modelId: string) => {
    const key = `${platformId}:${modelId}`.toLowerCase();
    const exists = poolForm.models.some((m) => keyOfModel(m) === key);
    if (exists) {
      setPoolForm((prev) => ({
        ...prev,
        models: prev.models.filter((m) => keyOfModel(m) !== key),
      }));
    } else {
      const newModel: ModelGroupItem = {
        platformId,
        modelId,
        priority: poolForm.models.length + 1,
        healthStatus: ModelHealthStatus.Healthy,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
      };
      setPoolForm((prev) => ({
        ...prev,
        models: [...prev.models, newModel],
      }));
    }
  };

  // 平台名称查找表
  const platformNameById = useMemo(() => {
    const map = new Map<string, string>();
    (platforms ?? []).forEach((p) => {
      if (p?.id) map.set(p.id, p.name || p.id);
    });
    return map;
  }, [platforms]);

  const filteredPools = searchTerm
    ? pools.filter(
        (p) =>
          p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          (p.code || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
          (p.modelType || '').toLowerCase().includes(searchTerm.toLowerCase())
      )
    : pools;

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <TabBar
        title="模型池管理"
        icon={<Database size={16} />}
        actions={
          <>
            <div className="relative max-w-md">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input
                type="text"
                placeholder="搜索模型池..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full h-9 pl-9 pr-3 rounded-[11px] outline-none text-[13px]"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>
            <Button variant="primary" size="sm" onClick={handleAddPool}>
              <Plus size={14} />
              新建模型池
            </Button>
          </>
        }
      />

      {/* 模型池列表 */}
      <GlassCard variant="subtle" className="flex-1 min-h-0">
        <div className="h-full min-h-0 overflow-auto">
          {loading ? (
            <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
              加载中...
            </div>
          ) : filteredPools.length === 0 ? (
            <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
              <Database size={48} className="mx-auto mb-4 opacity-40" />
              <div className="text-sm">暂无模型池</div>
              <div className="mt-2 text-xs">点击"新建模型池"创建你的第一个模型池</div>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filteredPools.map((pool) => {
                const ModelTypeIcon = getModelTypeIcon(pool.modelType || 'chat');
                const modelTypeLabel = getModelTypeDisplayName(pool.modelType || 'chat');

                return (
                  <GlassCard glow key={pool.id} className="p-0 overflow-hidden">
                    <div className="p-4 border-b border-white/10">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <span className="shrink-0" style={{ color: 'var(--text-secondary)' }} title={modelTypeLabel}>
                            <ModelTypeIcon size={20} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                              {pool.name}
                            </div>
                            <div className="mt-0.5 text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                              {pool.code || pool.id} | {modelTypeLabel} | 优先级: {pool.priority ?? 50}
                              {pool.isDefaultForType && (
                                <span className="ml-2 px-1.5 py-0.5 rounded text-[10px]" style={{ background: 'rgba(34,197,94,0.12)', color: 'rgba(34,197,94,0.95)' }}>
                                  默认
                                </span>
                              )}
                              {pool.strategyType != null && pool.strategyType !== PoolStrategyType.FailFast && (
                                <span className="ml-2 px-1.5 py-0.5 rounded text-[10px]" style={{ background: 'rgba(56,189,248,0.12)', color: 'rgba(56,189,248,0.95)' }}>
                                  {STRATEGY_LABEL_MAP[pool.strategyType!] || '快速失败'}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Tooltip content="预测下次调度路径">
                            <button
                              className="p-1.5 rounded-lg hover:bg-white/10 transition-colors group"
                              onClick={() => handlePredict(pool)}
                            >
                              <Radar size={14} style={{ color: 'rgba(56,189,248,0.85)' }} className="group-hover:animate-pulse" />
                            </button>
                          </Tooltip>
                          <Tooltip content="复制为新模型池">
                            <button
                              className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                              onClick={() => handleCopyPool(pool)}
                            >
                              <Copy size={14} style={{ color: 'var(--text-muted)' }} />
                            </button>
                          </Tooltip>
                          <Tooltip content="编辑模型池">
                            <button
                              className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                              onClick={() => handleEditPool(pool)}
                            >
                              <Edit size={14} style={{ color: 'var(--text-muted)' }} />
                            </button>
                          </Tooltip>
                          <Tooltip content="删除模型池">
                            <button
                              className="p-1.5 rounded-lg hover:bg-white/10 transition-colors"
                              onClick={() => handleDeletePool(pool)}
                            >
                              <Trash2 size={14} style={{ color: 'var(--text-muted)' }} />
                            </button>
                          </Tooltip>
                        </div>
                      </div>
                    </div>

                    <div className="p-4">
                      <div className="text-[11px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
                        模型列表 ({pool.models?.length || 0})
                      </div>
                      {!pool.models || pool.models.length === 0 ? (
                        <div className="text-[12px] py-3 text-center" style={{ color: 'var(--text-muted)' }}>
                          暂无模型，点击编辑添加
                        </div>
                      ) : (
                        <div className="space-y-1.5 max-h-[140px] overflow-auto">
                          {pool.models.map((model, idx) => {
                            const status = HEALTH_STATUS_MAP[model.healthStatus as keyof typeof HEALTH_STATUS_MAP] || HEALTH_STATUS_MAP.Healthy;
                            return (
                              <ModelListItem
                                key={keyOfModel(model)}
                                model={{
                                  platformId: model.platformId,
                                  platformName: platformNameById.get(model.platformId),
                                  modelId: model.modelId,
                                }}
                                index={idx + 1}
                                total={pool.models.length}
                                size="sm"
                                suffix={
                                  <span
                                    className="text-[10px] px-1.5 py-0.5 rounded"
                                    style={{ background: status.bg, color: status.color }}
                                  >
                                    {status.label}
                                  </span>
                                }
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </GlassCard>
                );
              })}
            </div>
          )}
        </div>
      </GlassCard>

      {/* 调度预测弹窗 */}
      <PoolPredictionDialog
        open={predictionOpen}
        onOpenChange={setPredictionOpen}
        prediction={predictionData}
        loading={predictionLoading}
        platformNameById={platformNameById}
      />

      {/* 新建/编辑模型池弹窗 */}
      {showPoolDialog && (
        <Dialog
          open={showPoolDialog}
          onOpenChange={setShowPoolDialog}
          title={editingPool ? '编辑模型池' : '新建模型池'}
          maxWidth={760}
          content={
            <div className="space-y-4">
              {/* ── 第一行：名称 / 代码 / 模型类型 ── */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-[12px] font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    模型池名称
                  </label>
                  <input
                    type="text"
                    value={poolForm.name}
                    onChange={(e) => setPoolForm({ ...poolForm, name: e.target.value })}
                    placeholder="例如：主对话模型池"
                    className="w-full h-9 px-3 rounded-[10px] outline-none text-[13px]"
                    style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    模型池代码
                  </label>
                  <input
                    type="text"
                    value={poolForm.code}
                    onChange={(e) => setPoolForm({ ...poolForm, code: e.target.value })}
                    placeholder="例如：main-chat-pool"
                    disabled={!!editingPool}
                    className="w-full h-9 px-3 rounded-[10px] outline-none text-[13px]"
                    style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)', opacity: editingPool ? 0.6 : 1 }}
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    模型类型
                  </label>
                  <Select
                    value={poolForm.modelType}
                    onChange={(e) => setPoolForm({ ...poolForm, modelType: e.target.value })}
                  >
                    {MODEL_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </Select>
                </div>
              </div>

              {/* ── 第二行：优先级 / 调度策略 icons / 设为默认 ── */}
              <div className="flex items-end gap-3">
                <div className="w-[80px] shrink-0">
                  <label className="block text-[12px] font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    优先级
                  </label>
                  <input
                    type="number"
                    value={poolForm.priority}
                    onChange={(e) => setPoolForm({ ...poolForm, priority: parseInt(e.target.value) || 50 })}
                    placeholder="50"
                    min={1}
                    max={100}
                    className="w-full h-9 px-3 rounded-[10px] outline-none text-[13px] text-center"
                    style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                    title="数字越小优先级越高"
                  />
                </div>

                {/* 策略 icon 选择器 (GlassSwitch) */}
                <div className="flex-1 min-w-0">
                  <label className="block text-[12px] font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    调度策略
                  </label>
                  <GlassSwitch
                    size="md"
                    value={String(poolForm.strategyType ?? 0)}
                    onChange={(key) => setPoolForm({ ...poolForm, strategyType: parseInt(key) as PoolStrategyType })}
                    options={STRATEGY_OPTIONS.map((opt) => ({
                      key: String(opt.value),
                      label: opt.label,
                      icon: <opt.icon size={13} />,
                    }))}
                  />
                </div>

                <div className="shrink-0 flex items-center gap-2 h-9 pb-px">
                  <input
                    type="checkbox"
                    id="isDefaultForType"
                    checked={poolForm.isDefaultForType}
                    onChange={(e) => setPoolForm({ ...poolForm, isDefaultForType: e.target.checked })}
                    className="h-4 w-4 rounded"
                  />
                  <label htmlFor="isDefaultForType" className="text-[12px] whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                    设为默认
                  </label>
                </div>
              </div>

              {/* ── 第三行：描述 ── */}
              <div>
                <label className="block text-[12px] font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  描述
                </label>
                <textarea
                  value={poolForm.description}
                  onChange={(e) => setPoolForm({ ...poolForm, description: e.target.value })}
                  placeholder="模型池用途说明..."
                  rows={2}
                  className="w-full px-3 py-2 rounded-[10px] outline-none text-[13px] resize-none"
                  style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                />
              </div>

              {/* ── 第四行：统一的「调度与模型」区域 ── */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    调度与模型 ({poolForm.models.length})
                  </label>
                  <Button variant="secondary" size="xs" onClick={() => setModelPickerOpen(true)}>
                    <Plus size={12} />
                    添加模型
                  </Button>
                </div>

                <div
                  className="rounded-[12px] overflow-hidden"
                  style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)' }}
                >
                  {poolForm.models.length === 0 ? (
                    <div className="py-10 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      暂无模型，点击"添加模型"按钮选择
                    </div>
                  ) : (
                    <>
                      {/* 模型列表（可编辑） */}
                      <div className="p-2 space-y-1 max-h-[180px] overflow-auto">
                        {poolForm.models.map((m, idx) => (
                          <ModelListItem
                            key={keyOfModel(m)}
                            model={{
                              platformId: m.platformId,
                              platformName: platformNameById.get(m.platformId),
                              modelId: m.modelId,
                            }}
                            index={idx + 1}
                            total={poolForm.models.length}
                            size="sm"
                            suffix={
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number"
                                  value={Number(m.priority ?? 0)}
                                  onChange={(e) => {
                                    const v = parseInt(e.target.value) || 0;
                                    setPoolForm((prev) => ({
                                      ...prev,
                                      models: prev.models.map((x) =>
                                        keyOfModel(x) === keyOfModel(m) ? { ...x, priority: v } : x
                                      ),
                                    }));
                                  }}
                                  className="h-7 w-14 px-1 rounded-md outline-none text-[11px] text-center"
                                  style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.10)', color: 'var(--text-primary)' }}
                                  title="优先级（越小越优先）"
                                />
                                <button
                                  className="p-1 rounded-md hover:bg-white/10 transition-colors"
                                  onClick={() => toggleModel(m.platformId, m.modelId)}
                                  title="移除"
                                >
                                  <Trash2 size={13} style={{ color: 'var(--text-muted)' }} />
                                </button>
                              </div>
                            }
                          />
                        ))}
                      </div>

                      {/* 虚线分隔 */}
                      <div className="mx-3" style={{ borderTop: '1px dashed rgba(255,255,255,0.10)' }} />

                      {/* 调度预测可视化（本地计算） */}
                      <InlineDispatchPreview
                        models={poolForm.models}
                        strategyType={poolForm.strategyType ?? PoolStrategyType.FailFast}
                        platformNameById={platformNameById}
                      />
                    </>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" size="sm" onClick={() => setShowPoolDialog(false)}>
                  取消
                </Button>
                <Button variant="primary" size="sm" onClick={handleSavePool}>
                  保存
                </Button>
              </div>

              {/* 模型选择弹窗（公共组件） */}
              <ModelPoolPickerDialog
                open={modelPickerOpen}
                onOpenChange={setModelPickerOpen}
                platforms={platforms}
                selectedModels={poolForm.models.map((m) => ({
                  platformId: m.platformId,
                  modelId: m.modelId,
                  modelName: m.modelId,
                  name: m.modelId,
                }))}
                confirmText="加入模型池"
                title="添加模型"
                description="通过平台把模型加入下方选择池，确认后一次性加入模型池"
                onConfirm={(models: SelectedModelItem[]) => {
                  const newModels: ModelGroupItem[] = models.map((m, idx) => ({
                    platformId: m.platformId,
                    modelId: m.modelId,
                    priority: poolForm.models.length + idx + 1,
                    healthStatus: ModelHealthStatus.Healthy,
                    consecutiveFailures: 0,
                    consecutiveSuccesses: 0,
                  }));
                  const existingKeys = new Set(poolForm.models.map((x) => keyOfModel(x)));
                  const toAdd = newModels.filter((x) => !existingKeys.has(keyOfModel(x)));
                  setPoolForm((prev) => ({ ...prev, models: [...prev.models, ...toAdd] }));
                }}
              />
            </div>
          }
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   InlineDispatchPreview — 编辑弹窗内的本地调度预测可视化
   基于 poolForm.models 和 strategyType 实时计算，不调用 API
   ═══════════════════════════════════════════════════════════════════ */

function InlineDispatchPreview({
  models,
  strategyType,
  platformNameById,
}: {
  models: ModelGroupItem[];
  strategyType: PoolStrategyType;
  platformNameById: Map<string, string>;
}) {
  const sorted = useMemo(
    () => [...models].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)),
    [models],
  );

  const meta = STRATEGY_OPTIONS.find((s) => s.value === strategyType) || STRATEGY_OPTIONS[0];
  const Icon = meta.icon;
  const color = meta.color;

  // animation phase — restart when strategy or model count changes
  const [phase, setPhase] = useState(0);
  const animKey = `${strategyType}-${models.length}`;
  useEffect(() => {
    setPhase(0);
    const timers = sorted.map((_, i) =>
      setTimeout(() => setPhase(i + 1), 200 + i * 220),
    );
    return () => timers.forEach(clearTimeout);
  }, [animKey, sorted.length]);

  // RoundRobin rotation
  const [rrIdx, setRrIdx] = useState(0);
  useEffect(() => {
    if (strategyType !== PoolStrategyType.RoundRobin || phase < sorted.length) return;
    const iv = setInterval(() => setRrIdx((p) => (p + 1) % sorted.length), 1200);
    return () => clearInterval(iv);
  }, [strategyType, phase, sorted.length]);

  return (
    <div className="px-3 py-3 transition-all duration-300" key={animKey}>
      {/* 策略标题 */}
      <div className="flex items-center gap-2 mb-2.5">
        <div
          className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
          style={{ background: `${color}15` }}
        >
          <Icon size={13} style={{ color }} />
        </div>
        <span className="text-[12px] font-semibold" style={{ color }}>{meta.label}</span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{meta.desc}</span>
      </div>

      {/* ── FailFast / Sequential: 线性流 ── */}
      {(strategyType === PoolStrategyType.FailFast || strategyType === PoolStrategyType.Sequential) && (
        <div>
          {/* 请求入口 */}
          <div className="flex items-center gap-2 mb-2">
            <div
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-semibold"
              style={{ background: `${color}12`, border: `1px solid ${color}25`, color }}
            >
              <CircleDot size={10} />
              请求入口
            </div>
            <div className="flex-1 relative h-px">
              <div className="absolute inset-0" style={{ background: `linear-gradient(to right, ${color}30, transparent)` }} />
              <div
                className="absolute top-[-2px] w-1.5 h-1.5 rounded-full"
                style={{ background: color, boxShadow: `0 0 6px ${color}`, animation: 'flowDot 2s ease-in-out infinite' }}
              />
            </div>
          </div>
          {/* 端点列表 */}
          <div className="space-y-1 ml-1">
            {sorted.map((m, i) => {
              const isTarget = i === 0;
              const isActive = phase > i;
              return (
                <div key={keyOfModel(m)} className="flex items-center gap-2">
                  <div className="flex flex-col items-center w-4 shrink-0 self-stretch">
                    <div className="w-px flex-1 transition-all duration-400" style={{ background: isActive ? `${color}40` : 'rgba(255,255,255,0.06)' }} />
                    <div
                      className="w-2 h-2 rounded-full border-[1.5px] shrink-0 transition-all duration-400"
                      style={{
                        borderColor: isActive ? color : 'rgba(255,255,255,0.15)',
                        background: isTarget && isActive ? color : 'transparent',
                        boxShadow: isTarget && isActive ? `0 0 8px ${color}50` : 'none',
                      }}
                    />
                    <div className="w-px flex-1" style={{ background: i < sorted.length - 1 ? 'rgba(255,255,255,0.06)' : 'transparent' }} />
                  </div>
                  <div
                    className="flex-1 flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all duration-400"
                    style={{
                      opacity: isActive ? 1 : 0.15,
                      transform: isActive ? 'translateX(0)' : 'translateX(-6px)',
                      background: isTarget ? `${color}10` : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${isTarget ? `${color}25` : 'rgba(255,255,255,0.05)'}`,
                    }}
                  >
                    {platformNameById.get(m.platformId) && (
                      <span className="text-[9px] px-1 py-0.5 rounded shrink-0" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}>
                        {platformNameById.get(m.platformId)}
                      </span>
                    )}
                    <span className="text-[11px] font-mono truncate flex-1" style={{ color: 'var(--text-primary)' }}>{m.modelId}</span>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-md shrink-0"
                      style={{
                        background: isTarget ? `${color}18` : 'rgba(255,255,255,0.05)',
                        color: isTarget ? color : 'var(--text-muted)',
                      }}
                    >
                      {isTarget ? '发送请求' : `第${i + 1}备选`}
                    </span>
                    {isTarget && isActive && <Check size={12} style={{ color }} className="shrink-0" />}
                  </div>
                </div>
              );
            })}
          </div>
          {strategyType === PoolStrategyType.Sequential && sorted.length > 1 && (
            <div className="mt-2 ml-5 text-[10px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
              <ChevronRight size={9} />
              失败自动顺延到下一个端点
            </div>
          )}
        </div>
      )}

      {/* ── Race: 并行竞速 ── */}
      {strategyType === PoolStrategyType.Race && (
        <div>
          <div className="flex justify-center mb-2">
            <div
              className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[10px] font-semibold"
              style={{ background: `${color}12`, border: `1px solid ${color}25`, color }}
            >
              <CircleDot size={10} />
              同时发送到 {sorted.length} 个端点
            </div>
          </div>
          {/* SVG 扇出线 */}
          <div className="flex justify-center mb-1">
            <svg width="100%" height="20" viewBox="0 0 400 20" preserveAspectRatio="xMidYMid meet" className="max-w-[400px]">
              <defs>
                <linearGradient id="raceLineInline" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity="0.5" />
                  <stop offset="100%" stopColor={color} stopOpacity="0.15" />
                </linearGradient>
              </defs>
              {sorted.map((_, i) => {
                const x = sorted.length === 1 ? 200 : 40 + (320 / (sorted.length - 1)) * i;
                return (
                  <line
                    key={i} x1="200" y1="0" x2={x} y2="20"
                    stroke="url(#raceLineInline)" strokeWidth={phase > i ? 2 : 1}
                    strokeOpacity={phase > i ? 1 : 0.15}
                    strokeDasharray={phase > i ? 'none' : '4 3'}
                    className="transition-all duration-400"
                  />
                );
              })}
            </svg>
          </div>
          <div className="flex gap-2 flex-wrap justify-center">
            {sorted.map((m, i) => {
              const isActive = phase > i;
              const isWinner = phase >= sorted.length && i === 0;
              return (
                <div
                  key={keyOfModel(m)}
                  className="flex flex-col items-center gap-1 px-3 py-2 rounded-lg transition-all duration-400 min-w-[90px] max-w-[140px]"
                  style={{
                    opacity: isActive ? 1 : 0.15,
                    transform: isActive ? 'translateY(0) scale(1)' : 'translateY(-4px) scale(0.96)',
                    background: isWinner ? `${color}12` : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${isWinner ? `${color}35` : 'rgba(255,255,255,0.06)'}`,
                  }}
                >
                  {platformNameById.get(m.platformId) && (
                    <span className="text-[9px] px-1 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}>
                      {platformNameById.get(m.platformId)}
                    </span>
                  )}
                  <span className="font-mono text-[10px] truncate max-w-full text-center" style={{ color: 'var(--text-primary)' }}>
                    {m.modelId}
                  </span>
                  {isWinner ? (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-md flex items-center gap-0.5" style={{ background: `${color}18`, color }}>
                      <Check size={9} /> 最快返回
                    </span>
                  ) : isActive ? (
                    <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>竞争中...</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── RoundRobin: 轮询 ── */}
      {strategyType === PoolStrategyType.RoundRobin && (
        <div>
          <div className="flex justify-center mb-2">
            <div
              className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[10px] font-semibold"
              style={{ background: `${color}12`, border: `1px solid ${color}25`, color }}
            >
              <RotateCw size={10} className={phase >= sorted.length ? 'animate-spin' : ''} style={{ animationDuration: '3s' }} />
              轮询调度
            </div>
          </div>
          <div className="space-y-1">
            {sorted.map((m, i) => {
              const isCurrent = phase >= sorted.length && rrIdx === i;
              const isActive = phase > i;
              return (
                <div
                  key={keyOfModel(m)}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all duration-300"
                  style={{
                    opacity: isActive ? 1 : 0.15,
                    background: isCurrent ? `${color}10` : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${isCurrent ? `${color}30` : 'rgba(255,255,255,0.05)'}`,
                  }}
                >
                  <div
                    className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 transition-all duration-300"
                    style={{
                      background: isCurrent ? `${color}20` : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${isCurrent ? `${color}40` : 'rgba(255,255,255,0.08)'}`,
                    }}
                  >
                    {isCurrent ? (
                      <ArrowRight size={9} style={{ color }} />
                    ) : (
                      <span className="text-[9px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{i + 1}</span>
                    )}
                  </div>
                  {platformNameById.get(m.platformId) && (
                    <span className="text-[9px] px-1 py-0.5 rounded shrink-0" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}>
                      {platformNameById.get(m.platformId)}
                    </span>
                  )}
                  <span className="font-mono text-[11px] truncate flex-1" style={{ color: 'var(--text-primary)' }}>{m.modelId}</span>
                  {isCurrent && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-md shrink-0" style={{ background: `${color}18`, color }}>
                      当前
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-2 text-center text-[10px]" style={{ color: 'var(--text-muted)' }}>
            请求按顺序均匀分配到 {sorted.length} 个端点
          </div>
        </div>
      )}

      <style>{`
        @keyframes flowDot {
          0% { left: 0; opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { left: 100%; opacity: 0; }
        }
      `}</style>
    </div>
  );
}
