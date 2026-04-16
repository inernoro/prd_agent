import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { GlassSwitch } from '@/components/design/GlassSwitch';
import { MapSpinner } from '@/components/ui/VideoLoader';
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
  resetModelHealth,
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
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import { getModelTypeDisplayName, getModelTypeIcon, MODEL_TYPE_DEFINITIONS } from '@/lib/appCallerUtils';
import { ModelTypePicker } from '@/components/model/ModelTypePicker';

/* ── 4 种可预测的调度策略（icon 选择器） ── */
const STRATEGY_OPTIONS = [
  { value: PoolStrategyType.FailFast, label: '快速', desc: '选最优，失败即止', icon: Zap, color: 'rgba(251,146,60,0.95)' },
  { value: PoolStrategyType.Race, label: '竞速', desc: '并行发送，取最快', icon: GitBranch, color: 'rgba(168,85,247,0.95)' },
  { value: PoolStrategyType.Sequential, label: '顺序容灾', desc: '逐个尝试，失败切换', icon: ArrowRight, color: 'rgba(56,189,248,0.95)' },
  { value: PoolStrategyType.RoundRobin, label: '轮询', desc: '均匀分配', icon: RotateCw, color: 'rgba(34,197,94,0.95)' },
];

/* 卡片列表中显示策略标签时也需要文案映射 */
const STRATEGY_LABEL_MAP: Record<number, string> = {
  [PoolStrategyType.FailFast]: '快速',
  [PoolStrategyType.Race]: '竞速',
  [PoolStrategyType.Sequential]: '顺序容灾',
  [PoolStrategyType.RoundRobin]: '轮询',
  [PoolStrategyType.WeightedRandom]: '加权随机',
  [PoolStrategyType.LeastLatency]: '最低延迟',
};

// MODEL_TYPES 已迁移到 appCallerUtils.ts 的 MODEL_TYPE_DEFINITIONS

const HEALTH_STATUS_MAP = {
  Healthy: { label: '健康', color: 'rgba(34,197,94,0.95)', bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.28)' },
  Degraded: { label: '降权', color: 'rgba(251,191,36,0.95)', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.28)' },
  Unavailable: { label: '不可用', color: 'rgba(239,68,68,0.95)', bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.28)' },
};

function keyOfModel(m: Pick<ModelGroupItem, 'platformId' | 'modelId'>) {
  return `${m.platformId}:${m.modelId}`.toLowerCase();
}

export function ModelPoolManagePage() {
  const { isMobile } = useBreakpoint();
  const [pools, setPools] = useState<ModelGroup[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  // 左侧选中的模型池
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);

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
        // 后端 getPlatforms 已经把每条 Exchange 作为独立虚拟平台混合返回（kind="exchange"）
        // 不再在前端硬编码合成 "__exchange__" 虚拟平台
        getPlatforms(),
      ]);
      setPools(poolsData);
      setPlatforms(platformsData.success ? platformsData.data : []);
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

  const handleSetDefault = useCallback(async (pool: ModelGroup) => {
    try {
      await updateModelGroup(pool.id, {
        name: pool.name,
        code: pool.code || '',
        priority: pool.priority ?? 50,
        modelType: pool.modelType || 'chat',
        strategyType: pool.strategyType ?? PoolStrategyType.FailFast,
        isDefaultForType: true,
        description: pool.description || '',
        models: pool.models || [],
      });
      toast.success('已设为备用');
      await loadData();
    } catch (error) {
      toast.error('设置失败', String(error));
    }
  }, [loadData]);

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

  const filteredPools = useMemo(() => {
    let result = pools;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(term) ||
          (p.code || '').toLowerCase().includes(term) ||
          (p.modelType || '').toLowerCase().includes(term)
      );
    }
    // 备用池置顶，其余按名称
    return [...result].sort((a, b) => {
      if (a.isDefaultForType && !b.isDefaultForType) return -1;
      if (!a.isDefaultForType && b.isDefaultForType) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [pools, searchTerm]);

  // 按 modelType 分组（用于左侧列表分组标题）
  const groupedByType = useMemo(() => {
    const typeOrder = MODEL_TYPE_DEFINITIONS.map(t => t.value);
    const groups = new Map<string, ModelGroup[]>();
    for (const pool of filteredPools) {
      const type = pool.modelType || 'chat';
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type)!.push(pool);
    }
    const ordered = typeOrder
      .filter(type => groups.has(type))
      .map(type => ({
        type,
        label: getModelTypeDisplayName(type),
        Icon: getModelTypeIcon(type),
        pools: groups.get(type)!,
      }));
    for (const [type, typePools] of groups) {
      if (!typeOrder.includes(type)) {
        ordered.push({
          type,
          label: getModelTypeDisplayName(type),
          Icon: getModelTypeIcon(type),
          pools: typePools,
        });
      }
    }
    return ordered;
  }, [filteredPools]);

  // 选中的模型池
  const selectedPool = useMemo(() => {
    if (!selectedPoolId) return null;
    return pools.find(p => p.id === selectedPoolId) ?? null;
  }, [pools, selectedPoolId]);

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">

      {/* 主体：左侧列表 + 右侧详情 */}
      <div className="grid gap-4 flex-1 min-h-0 lg:grid-cols-[280px_1fr]">

        {/* ══ 左侧：模型池列表 ══ */}
        <GlassCard animated glow className="flex flex-col min-h-0 p-0 overflow-hidden">
          <div className="p-3 border-b border-white/10">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  placeholder="搜索..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full h-8 pl-8 pr-3 rounded-lg outline-none text-[12px]"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>
              <Button variant="primary" size="sm" onClick={handleAddPool} title="新建模型池">
                <Plus size={14} />
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
                <Database size={32} className="mx-auto mb-2 opacity-40" />
                <div className="text-sm">加载中...</div>
              </div>
            ) : filteredPools.length === 0 ? (
              <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
                <Database size={32} className="mx-auto mb-2 opacity-40" />
                <div className="text-sm">暂无模型池</div>
              </div>
            ) : (
              <div>
                {groupedByType.map((group) => {
                  const GroupIcon = group.Icon;
                  return (
                    <div key={group.type}>
                      {/* 类型分组标题 */}
                      <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5 sticky top-0 z-[1]" style={{ color: 'var(--text-muted)', background: 'var(--bg-input)' }}>
                        <GroupIcon size={11} />
                        {group.label}
                        <span className="opacity-60">{group.pools.length}</span>
                      </div>
                      {/* 池列表 */}
                      {group.pools.map((pool) => {
                        const isSelected = pool.id === selectedPoolId;
                        const modelCount = pool.models?.length || 0;
                        const healthyCnt = pool.models?.filter(m => m.healthStatus === 'Healthy').length ?? 0;
                        const strategyOpt = STRATEGY_OPTIONS.find(s => s.value === pool.strategyType) || STRATEGY_OPTIONS[0];
                        const StrategyIcon = strategyOpt.icon;

                        return (
                          <div
                            key={pool.id}
                            onClick={() => setSelectedPoolId(pool.id)}
                            className="surface-row px-3 py-2 cursor-pointer"
                            style={isSelected ? { background: 'var(--bg-input-hover)' } : undefined}
                          >
                            <div className="flex items-center gap-2.5">
                              <div
                                className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center"
                                style={{
                                  background: isSelected ? `${strategyOpt.color}15` : 'transparent',
                                  border: isSelected ? `1px solid ${strategyOpt.color}30` : '1px solid var(--border-subtle)',
                                }}
                              >
                                <StrategyIcon size={13} style={{ color: isSelected ? strategyOpt.color : 'var(--text-muted)' }} />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[12px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                                    {pool.name}
                                  </span>
                                  {pool.isDefaultForType && (
                                    <span className="shrink-0 px-1 py-px rounded text-[9px]" style={{ background: 'rgba(34,197,94,0.12)', color: 'rgba(34,197,94,0.95)' }}>
                                      备用
                                    </span>
                                  )}
                                </div>
                                <div className="text-[10px] mt-px flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                                  {modelCount > 0 ? (
                                    <>
                                      <span className="w-1 h-1 rounded-full inline-block" style={{ background: healthyCnt === modelCount ? 'rgba(34,197,94,0.95)' : 'rgba(251,191,36,0.95)' }} />
                                      {modelCount} 模型
                                    </>
                                  ) : '空'}
                                </div>
                              </div>
                              {/* 设为备用按钮 */}
                              {!pool.isDefaultForType && (
                                <Tooltip content="设为备用">
                                  <button
                                    className="shrink-0 w-5 h-5 rounded border flex items-center justify-center hover:border-green-500/50 hover:bg-green-500/10 transition-colors"
                                    style={{ borderColor: 'var(--border-subtle)' }}
                                    onClick={(e) => { e.stopPropagation(); handleSetDefault(pool); }}
                                  >
                                    <Check size={10} className="opacity-0 hover:opacity-100" style={{ color: 'rgba(34,197,94,0.95)' }} />
                                  </button>
                                </Tooltip>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </GlassCard>

        {/* ══ 右侧：单面板详情 ══ */}
        {!selectedPool ? (
          <GlassCard animated glow className="flex items-center justify-center overflow-hidden">
            <div className="text-center" style={{ color: 'var(--text-muted)' }}>
              <Database size={40} className="mx-auto mb-3 opacity-30" />
              <div className="text-[13px]">选择一个模型池</div>
            </div>
          </GlassCard>
        ) : (() => {
          const modelCount = selectedPool.models?.length || 0;
          const healthyCnt = selectedPool.models?.filter(m => m.healthStatus === 'Healthy').length ?? 0;
          const degradedCnt = selectedPool.models?.filter(m => m.healthStatus === 'Degraded').length ?? 0;
          const unavailableCnt = selectedPool.models?.filter(m => m.healthStatus === 'Unavailable').length ?? 0;
          const strategyOpt = STRATEGY_OPTIONS.find(s => s.value === selectedPool.strategyType) || STRATEGY_OPTIONS[0];
          const StrategyIcon = strategyOpt.icon;
          const TypeIcon = getModelTypeIcon(selectedPool.modelType || 'chat');

          return (
            <GlassCard animated glow className="min-h-0 overflow-auto p-0">
              {/* ── 头部：名称 + 操作 ── */}
              <div className="sticky top-0 z-[1] px-5 py-3 flex items-center justify-between gap-3 border-b" style={{ borderColor: 'var(--nested-block-border)', background: 'var(--bg-card)' }}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <h3 className="text-[15px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {selectedPool.name}
                  </h3>
                  {selectedPool.isDefaultForType && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium" style={{ background: 'rgba(34,197,94,0.12)', color: 'rgba(34,197,94,0.95)' }}>
                      备用
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Tooltip content="预测调度">
                    <button className="p-1.5 rounded-lg hover:bg-white/10 transition-colors" onClick={() => handlePredict(selectedPool)}>
                      <Radar size={15} style={{ color: 'rgba(56,189,248,0.85)' }} />
                    </button>
                  </Tooltip>
                  <Tooltip content="复制">
                    <button className="p-1.5 rounded-lg hover:bg-white/10 transition-colors" onClick={() => handleCopyPool(selectedPool)}>
                      <Copy size={15} style={{ color: 'var(--text-muted)' }} />
                    </button>
                  </Tooltip>
                  <Tooltip content="编辑">
                    <button className="p-1.5 rounded-lg hover:bg-white/10 transition-colors" onClick={() => handleEditPool(selectedPool)}>
                      <Edit size={15} style={{ color: 'var(--text-muted)' }} />
                    </button>
                  </Tooltip>
                  <Tooltip content="删除">
                    <button className="p-1.5 rounded-lg hover:bg-white/10 transition-colors" onClick={() => handleDeletePool(selectedPool)}>
                      <Trash2 size={15} style={{ color: 'var(--text-muted)' }} />
                    </button>
                  </Tooltip>
                </div>
              </div>

              {/* ── 属性标签行 ── */}
              <div className="px-5 py-2.5 flex items-center gap-3 flex-wrap text-[11px] border-b" style={{ borderColor: 'var(--nested-block-border)' }}>
                <span className="inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                  <TypeIcon size={12} />
                  {getModelTypeDisplayName(selectedPool.modelType || 'chat')}
                </span>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: `${strategyOpt.color}12`, color: strategyOpt.color }}>
                  <StrategyIcon size={10} />
                  {STRATEGY_LABEL_MAP[selectedPool.strategyType ?? 0] || '快速'}
                </span>
                {selectedPool.code && (
                  <span className="font-mono" style={{ color: 'var(--text-muted)' }}>{selectedPool.code}</span>
                )}
                <span style={{ color: 'var(--text-muted)' }}>优先级 {selectedPool.priority ?? 50}</span>
                {selectedPool.description && (
                  <>
                    <span style={{ color: 'var(--border-default)' }}>|</span>
                    <span style={{ color: 'var(--text-muted)' }}>{selectedPool.description}</span>
                  </>
                )}
              </div>

              {/* ── 统计瓦片 ── */}
              <div className="px-5 py-3 grid grid-cols-4 gap-3">
                <div className="rounded-lg px-3 py-2 text-center" style={{ background: 'var(--bg-input)' }}>
                  <div className="text-[18px] font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>{modelCount}</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>模型</div>
                </div>
                <div className="rounded-lg px-3 py-2 text-center" style={{ background: 'rgba(34,197,94,0.06)' }}>
                  <div className="text-[18px] font-semibold tabular-nums" style={{ color: 'rgba(34,197,94,0.95)' }}>{healthyCnt}</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>健康</div>
                </div>
                <div className="rounded-lg px-3 py-2 text-center" style={{ background: degradedCnt > 0 ? 'rgba(251,191,36,0.06)' : 'var(--bg-input)' }}>
                  <div className="text-[18px] font-semibold tabular-nums" style={{ color: degradedCnt > 0 ? 'rgba(251,191,36,0.95)' : 'var(--text-muted)' }}>{degradedCnt}</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>降权</div>
                </div>
                <div className="rounded-lg px-3 py-2 text-center" style={{ background: unavailableCnt > 0 ? 'rgba(239,68,68,0.06)' : 'var(--bg-input)' }}>
                  <div className="text-[18px] font-semibold tabular-nums" style={{ color: unavailableCnt > 0 ? 'rgba(239,68,68,0.95)' : 'var(--text-muted)' }}>{unavailableCnt}</div>
                  <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>不可用</div>
                </div>
              </div>

              {(!selectedPool.models || selectedPool.models.length === 0) ? (
                <div className="flex items-center justify-center py-12">
                  <div className="text-center" style={{ color: 'var(--text-muted)' }}>
                    <div className="text-sm">暂无模型</div>
                    <div className="mt-2">
                      <Button variant="secondary" size="sm" onClick={() => handleEditPool(selectedPool)}>
                        <Plus size={14} />
                        添加模型
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {/* ── 模型列表 ── */}
                  <div className="px-5 pb-3">
                    <div className="text-[11px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
                      模型列表
                    </div>
                    <div className="space-y-1">
                      {selectedPool.models.map((model, idx) => {
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
                            total={selectedPool.models!.length}
                            size="sm"
                            suffix={
                              model.healthStatus !== 'Healthy' ? (
                                <button
                                  className="text-[10px] px-1.5 py-0.5 rounded cursor-pointer hover:opacity-80 transition-opacity"
                                  style={{ background: status.bg, color: status.color }}
                                  title="点击重置为健康状态"
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    try {
                                      await resetModelHealth(selectedPool.id, model.modelId);
                                      toast.success('已重置为健康状态');
                                      loadData();
                                    } catch (err: any) {
                                      toast.error(err.message || '重置失败');
                                    }
                                  }}
                                >
                                  {status.label} ↻
                                </button>
                              ) : (
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded"
                                  style={{ background: status.bg, color: status.color }}
                                >
                                  {status.label}
                                </span>
                              )
                            }
                          />
                        );
                      })}
                    </div>
                  </div>

                  {/* ── 调度策略可视化 ── */}
                  <div className="px-5 pb-4">
                    <div className="text-[11px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
                      调度预览
                    </div>
                    <div className="rounded-xl surface-inset">
                      <InlineDispatchPreview
                        models={selectedPool.models}
                        strategyType={selectedPool.strategyType ?? PoolStrategyType.FailFast}
                        platformNameById={platformNameById}
                      />
                    </div>
                  </div>
                </>
              )}
            </GlassCard>
          );
        })()}
      </div>

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
          maxWidth={isMobile ? undefined : 760}
          content={
            <div className="space-y-4">
              {/* ── 第一行：名称 / 代码 ── */}
              <div className={`grid gap-3 ${isMobile ? 'grid-cols-1' : 'grid-cols-2'}`}>
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
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
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
                    className="w-full h-9 px-3 rounded-[10px] outline-none text-[13px]"
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                  />
                </div>
              </div>

              {/* ── 模型类型面板 ── */}
              <div>
                <label className="block text-[12px] font-semibold mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                  模型类型
                </label>
                <ModelTypePicker
                  value={poolForm.modelType}
                  onChange={(v) => setPoolForm({ ...poolForm, modelType: v })}
                />
              </div>

              {/* ── 第二行：优先级 / 调度策略 icons / 设为默认 ── */}
              <div className={`flex gap-3 ${isMobile ? 'flex-col' : 'items-end'}`}>
                <div className={isMobile ? 'w-full' : 'w-[80px] shrink-0'}>
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
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
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
                    设为备用
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
                  style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
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
                  className="rounded-[12px] overflow-hidden surface-inset"
                >
                  {poolForm.models.length === 0 ? (
                    <div className="py-10 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      暂无模型，点击"添加模型"按钮选择
                    </div>
                  ) : (
                    <InlineDispatchPreview
                      models={poolForm.models}
                      strategyType={poolForm.strategyType ?? PoolStrategyType.FailFast}
                      platformNameById={platformNameById}
                      editable
                      onUpdatePriority={(platformId, modelId, priority) => {
                        setPoolForm((prev) => ({
                          ...prev,
                          models: prev.models.map((x) =>
                            x.platformId === platformId && x.modelId === modelId ? { ...x, priority } : x
                          ),
                        }));
                      }}
                      onRemoveModel={(platformId, modelId) => toggleModel(platformId, modelId)}
                    />
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
  editable,
  onUpdatePriority,
  onRemoveModel,
}: {
  models: ModelGroupItem[];
  strategyType: PoolStrategyType;
  platformNameById: Map<string, string>;
  editable?: boolean;
  onUpdatePriority?: (platformId: string, modelId: string, priority: number) => void;
  onRemoveModel?: (platformId: string, modelId: string) => void;
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
                    <div className="w-px flex-1 transition-all duration-400" style={{ background: isActive ? `${color}40` : 'var(--nested-block-border)' }} />
                    <div
                      className="w-2 h-2 rounded-full border-[1.5px] shrink-0 transition-all duration-400"
                      style={{
                        borderColor: isActive ? color : 'var(--border-default)',
                        background: isTarget && isActive ? color : 'transparent',
                        boxShadow: isTarget && isActive ? `0 0 8px ${color}50` : 'none',
                      }}
                    />
                    <div className="w-px flex-1" style={{ background: i < sorted.length - 1 ? 'var(--nested-block-border)' : 'transparent' }} />
                  </div>
                  <div
                    className="flex-1 flex items-center gap-2 px-2 py-1.5 rounded-lg transition-all duration-400"
                    style={{
                      opacity: isActive ? 1 : 0.15,
                      transform: isActive ? 'translateX(0)' : 'translateX(-6px)',
                      background: isTarget ? `${color}10` : 'var(--nested-block-bg)',
                      border: `1px solid ${isTarget ? `${color}25` : 'var(--nested-block-border)'}`,
                    }}
                  >
                    {platformNameById.get(m.platformId) && (
                      <span className="text-[9px] px-1 py-0.5 rounded shrink-0" style={{ background: 'var(--bg-input-hover)', color: 'var(--text-muted)' }}>
                        {platformNameById.get(m.platformId)}
                      </span>
                    )}
                    <span className="text-[11px] font-mono truncate flex-1" style={{ color: 'var(--text-primary)' }}>{m.modelId}</span>
                    {editable ? (
                      <div className="flex items-center gap-1 shrink-0">
                        <input
                          type="number"
                          value={Number(m.priority ?? 0)}
                          onChange={(e) => onUpdatePriority?.(m.platformId, m.modelId, parseInt(e.target.value) || 0)}
                          className="h-6 w-12 px-1 rounded-md outline-none text-[10px] text-center"
                          style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                          title="优先级（越小越优先）"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <button
                          className="p-0.5 rounded-md hover:bg-white/10 transition-colors"
                          onClick={(e) => { e.stopPropagation(); onRemoveModel?.(m.platformId, m.modelId); }}
                          title="移除"
                        >
                          <Trash2 size={11} style={{ color: 'var(--text-muted)' }} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span
                          className="text-[10px] px-1.5 py-0.5 rounded-md shrink-0"
                          style={{
                            background: isTarget ? `${color}18` : 'var(--bg-card-hover)',
                            color: isTarget ? color : 'var(--text-muted)',
                          }}
                        >
                          {isTarget ? '发送请求' : `第${i + 1}备选`}
                        </span>
                        {isTarget && isActive && <Check size={12} style={{ color }} className="shrink-0" />}
                      </>
                    )}
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
                    background: isWinner ? `${color}12` : 'var(--nested-block-bg)',
                    border: `1px solid ${isWinner ? `${color}35` : 'var(--nested-block-border)'}`,
                  }}
                >
                  {platformNameById.get(m.platformId) && (
                    <span className="text-[9px] px-1 py-0.5 rounded" style={{ background: 'var(--bg-input-hover)', color: 'var(--text-muted)' }}>
                      {platformNameById.get(m.platformId)}
                    </span>
                  )}
                  <span className="font-mono text-[10px] truncate max-w-full text-center" style={{ color: 'var(--text-primary)' }}>
                    {m.modelId}
                  </span>
                  {editable ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={Number(m.priority ?? 0)}
                        onChange={(e) => onUpdatePriority?.(m.platformId, m.modelId, parseInt(e.target.value) || 0)}
                        className="h-6 w-12 px-1 rounded-md outline-none text-[10px] text-center"
                        style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                        title="优先级（越小越优先）"
                        onClick={(e) => e.stopPropagation()}
                      />
                      <button
                        className="p-0.5 rounded-md hover:bg-white/10 transition-colors"
                        onClick={(e) => { e.stopPropagation(); onRemoveModel?.(m.platformId, m.modelId); }}
                        title="移除"
                      >
                        <Trash2 size={11} style={{ color: 'var(--text-muted)' }} />
                      </button>
                    </div>
                  ) : isWinner ? (
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
              {phase >= sorted.length ? <MapSpinner size={10} /> : <RotateCw size={10} />}
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
                    background: isCurrent ? `${color}10` : 'var(--nested-block-bg)',
                    border: `1px solid ${isCurrent ? `${color}30` : 'var(--nested-block-border)'}`,
                  }}
                >
                  <div
                    className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 transition-all duration-300"
                    style={{
                      background: isCurrent ? `${color}20` : 'var(--bg-input)',
                      border: `1px solid ${isCurrent ? `${color}40` : 'var(--border-subtle)'}`,
                    }}
                  >
                    {isCurrent ? (
                      <ArrowRight size={9} style={{ color }} />
                    ) : (
                      <span className="text-[9px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{i + 1}</span>
                    )}
                  </div>
                  {platformNameById.get(m.platformId) && (
                    <span className="text-[9px] px-1 py-0.5 rounded shrink-0" style={{ background: 'var(--bg-input-hover)', color: 'var(--text-muted)' }}>
                      {platformNameById.get(m.platformId)}
                    </span>
                  )}
                  <span className="font-mono text-[11px] truncate flex-1" style={{ color: 'var(--text-primary)' }}>{m.modelId}</span>
                  {editable ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <input
                        type="number"
                        value={Number(m.priority ?? 0)}
                        onChange={(e) => onUpdatePriority?.(m.platformId, m.modelId, parseInt(e.target.value) || 0)}
                        className="h-6 w-12 px-1 rounded-md outline-none text-[10px] text-center"
                        style={{ background: 'var(--bg-input)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                        title="优先级（越小越优先）"
                        onClick={(e) => e.stopPropagation()}
                      />
                      <button
                        className="p-0.5 rounded-md hover:bg-white/10 transition-colors"
                        onClick={(e) => { e.stopPropagation(); onRemoveModel?.(m.platformId, m.modelId); }}
                        title="移除"
                      >
                        <Trash2 size={11} style={{ color: 'var(--text-muted)' }} />
                      </button>
                    </div>
                  ) : isCurrent ? (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-md shrink-0" style={{ background: `${color}18`, color }}>
                      当前
                    </span>
                  ) : null}
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
