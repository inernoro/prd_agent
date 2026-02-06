import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
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
} from 'lucide-react';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
// Note: systemDialog 仅用于 confirm 确认框，toast 用于轻量级提示
import { getModelTypeDisplayName, getModelTypeIcon } from '@/lib/appCallerUtils';

const STRATEGY_TYPES = [
  { value: PoolStrategyType.FailFast, label: '快速失败', description: '选最优端点，失败直接返回' },
  { value: PoolStrategyType.Race, label: '竞速模式', description: '并行请求所有端点，取最快' },
  { value: PoolStrategyType.Sequential, label: '顺序容灾', description: '按顺序尝试，失败自动切换' },
  { value: PoolStrategyType.RoundRobin, label: '轮询均衡', description: '均匀分配到所有端点' },
  { value: PoolStrategyType.WeightedRandom, label: '加权随机', description: '按优先级权重随机选择' },
  { value: PoolStrategyType.LeastLatency, label: '最低延迟', description: '优先选择响应最快的端点' },
];

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
                                  {STRATEGY_TYPES.find(s => s.value === pool.strategyType)?.label || '快速失败'}
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
          maxWidth={720}
          content={
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                    模型池名称
                  </label>
                  <input
                    type="text"
                    value={poolForm.name}
                    onChange={(e) => setPoolForm({ ...poolForm, name: e.target.value })}
                    placeholder="例如：主对话模型池"
                    className="w-full h-10 px-3 rounded-[12px] outline-none text-[13px]"
                    style={{
                      background: 'var(--bg-input)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>

                <div>
                  <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                    模型池代码
                  </label>
                  <input
                    type="text"
                    value={poolForm.code}
                    onChange={(e) => setPoolForm({ ...poolForm, code: e.target.value })}
                    placeholder="例如：main-chat-pool"
                    disabled={!!editingPool}
                    className="w-full h-10 px-3 rounded-[12px] outline-none text-[13px]"
                    style={{
                      background: 'var(--bg-input)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: 'var(--text-primary)',
                      opacity: editingPool ? 0.6 : 1,
                    }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                    模型类型
                  </label>
                  <Select
                    value={poolForm.modelType}
                    onChange={(e) => setPoolForm({ ...poolForm, modelType: e.target.value })}
                  >
                    {MODEL_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </Select>
                </div>

                <div>
                  <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                    调度策略
                  </label>
                  <Select
                    value={String(poolForm.strategyType ?? 0)}
                    onChange={(e) => setPoolForm({ ...poolForm, strategyType: parseInt(e.target.value) })}
                  >
                    {STRATEGY_TYPES.map((s) => (
                      <option key={s.value} value={String(s.value)}>
                        {s.label} — {s.description}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                    优先级
                  </label>
                  <input
                    type="number"
                    value={poolForm.priority}
                    onChange={(e) => setPoolForm({ ...poolForm, priority: parseInt(e.target.value) || 50 })}
                    placeholder="50"
                    min={1}
                    max={100}
                    className="w-full h-10 px-3 rounded-[12px] outline-none text-[13px]"
                    style={{
                      background: 'var(--bg-input)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      color: 'var(--text-primary)',
                    }}
                    title="数字越小优先级越高"
                  />
                </div>

                <div className="flex items-end">
                  <div className="flex items-center gap-2 h-10">
                    <input
                      type="checkbox"
                      id="isDefaultForType"
                      checked={poolForm.isDefaultForType}
                      onChange={(e) => setPoolForm({ ...poolForm, isDefaultForType: e.target.checked })}
                      className="h-4 w-4 rounded"
                    />
                    <label htmlFor="isDefaultForType" className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                      设为默认
                    </label>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                  描述
                </label>
                <textarea
                  value={poolForm.description}
                  onChange={(e) => setPoolForm({ ...poolForm, description: e.target.value })}
                  placeholder="模型池用途说明..."
                  rows={2}
                  className="w-full px-3 py-2 rounded-[12px] outline-none text-[13px] resize-none"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              {/* 模型列表 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                    模型列表 ({poolForm.models.length})
                  </label>
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => setModelPickerOpen(true)}
                  >
                    <Plus size={12} />
                    添加模型
                  </Button>
                </div>

                <div
                  className="rounded-[12px] p-3 min-h-[100px] max-h-[200px] overflow-auto"
                  style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)' }}
                >
                  {poolForm.models.length === 0 ? (
                    <div className="py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      暂无模型，点击"添加模型"按钮选择平台添加
                    </div>
                  ) : (
                    <div className="space-y-2">
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
                          size="md"
                          suffix={
                            <div className="flex items-center gap-2">
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
                                className="h-8 w-16 px-2 rounded-lg outline-none text-[12px] text-center"
                                style={{
                                  background: 'var(--bg-input)',
                                  border: '1px solid rgba(255,255,255,0.12)',
                                  color: 'var(--text-primary)',
                                }}
                                title="优先级"
                              />
                              <Button variant="ghost" size="sm" onClick={() => toggleModel(m.platformId, m.modelId)} title="移除">
                                <Trash2 size={14} />
                              </Button>
                            </div>
                          }
                        />
                      ))}
                    </div>
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
                  // 将选中的模型合并到 poolForm.models
                  const newModels: ModelGroupItem[] = models.map((m, idx) => ({
                    platformId: m.platformId,
                    modelId: m.modelId,
                    priority: poolForm.models.length + idx + 1,
                    healthStatus: ModelHealthStatus.Healthy,
                    consecutiveFailures: 0,
                    consecutiveSuccesses: 0,
                  }));
                  // 去重合并
                  const existingKeys = new Set(poolForm.models.map((x) => keyOfModel(x)));
                  const toAdd = newModels.filter((x) => !existingKeys.has(keyOfModel(x)));
                  setPoolForm((prev) => ({
                    ...prev,
                    models: [...prev.models, ...toAdd],
                  }));
                }}
              />
            </div>
          }
        />
      )}
    </div>
  );
}
