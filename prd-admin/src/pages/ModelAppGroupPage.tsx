import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { Dialog } from '@/components/ui/Dialog';
import { ModelPoolPickerDialog, type SelectedModelItem } from '@/components/model/ModelPoolPickerDialog';
import {
  getAppCallers,
  updateAppCaller,
  // deleteAppCaller, // 暂时未使用
  getModelGroups,
  getPlatforms,
  createModelGroup,
  updateModelGroup,
  deleteModelGroup,
  getGroupMonitoring,
  resetModelHealth,
  // simulateDowngrade, // 暂时未使用
  // simulateRecover, // 暂时未使用
  getSchedulerConfig,
  updateSchedulerConfig,
  getBatchModelStats,
  resolveModels,
} from '@/services';
import type { LlmModelStatsItem } from '@/services/contracts/llmLogs';
import type { ResolvedModelInfo } from '@/services/contracts/appCallers';
import { api } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type {
  LLMAppCaller,
  AppModelRequirement,
  ModelGroup,
  ModelGroupItem,
  ModelGroupMonitoringData,
  ModelSchedulerConfig,
} from '@/types';
import { ModelHealthStatus, PoolStrategyType } from '@/types/modelGroup';
import type { Platform } from '@/types/admin';
import {
  Activity,
  AlertTriangle,
  Box,
  ChevronDown,
  ChevronRight,
  Eye,
  Layers,
  Link2,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Trash2,
  Zap,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import {
  groupAppCallers,
  getModelTypeDisplayName,
  getModelTypeIcon,
  normalizeModelType,
  AppCallerCodeIcon,
} from '@/lib/appCallerUtils';
import type { AppGroup } from '@/lib/appCallerUtils';
import { ModelTypePicker, ModelTypeFilterBar } from '@/components/model/ModelTypePicker';

// MODEL_TYPES 和 MODEL_TYPE_FILTERS 已迁移到 appCallerUtils.ts 的 MODEL_TYPE_DEFINITIONS
// 所有消费方统一从 MODEL_TYPE_DEFINITIONS 读取，禁止各处硬编码

const HEALTH_STATUS_MAP = {
  Healthy: { label: '健康', color: 'rgba(34,197,94,0.95)', bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.28)' },
  Degraded: { label: '降权', color: 'rgba(251,191,36,0.95)', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.28)' },
  Unavailable: { label: '不可用', color: 'rgba(239,68,68,0.95)', bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.28)' },
};

export function ModelAppGroupPage({ onActionsReady }: { onActionsReady?: (actions: React.ReactNode) => void }) {
  const { isMobile } = useBreakpoint();
  const token = useAuthStore((s) => s.token);
  const navigate = useNavigate();
  const [appCallers, setAppCallers] = useState<LLMAppCaller[]>([]);
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [modelTypeFilter, setModelTypeFilter] = useState('all');
  // 模型池统计数据 (key: appCallerCode:platformId:modelId) - 按应用+模型组合统计
  const [poolModelStats, setPoolModelStats] = useState<Record<string, LlmModelStatsItem | null>>({});
  
  // 后端解析的默认模型信息（key: appCallerCode::modelType）
  const [resolvedModels, setResolvedModels] = useState<Record<string, ResolvedModelInfo | null>>({});
  
  // 加载状态
  const [isLoading, setIsLoading] = useState(true);
  
  // 树形结构状态
  const [, setAppGroups] = useState<AppGroup[]>([]);
  const [expandedApps, setExpandedApps] = useState<Set<string>>(new Set());

  // 功能模型列表折叠状态（默认全部展开）
  const [collapsedFeatures, setCollapsedFeatures] = useState<Set<string>>(new Set());

  // 弹窗状态
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  // 模型池编辑弹窗（暂未使用 - 新建分组已跳转到独立页签）
  const [showGroupDialog, _setShowGroupDialog] = useState(false);
  const [showRequirementDialog, setShowRequirementDialog] = useState(false);
  const [editingGroup, _setEditingGroup] = useState<ModelGroup | null>(null);
  const [editingRequirement, setEditingRequirement] = useState<AppModelRequirement | null>(null);

  // 监控数据
  const [monitoringData, setMonitoringData] = useState<Record<string, ModelGroupMonitoringData>>({});
  const [schedulerConfig, setSchedulerConfig] = useState<ModelSchedulerConfig | null>(null);

  // 配置模型统一弹窗（合并了「一键配置」「升级为模型池」「选择已有池」「管理模型池」「编辑现有池模型」五个入口）。
  // - editPool 不为空：picker 进入「编辑现有池」模式（无 Tab 切换，确认 = 替换该池模型列表）
  // - 否则：picker 显示双 Tab，新建/升级 + 选择已有池
  const [quickConfigOpen, setQuickConfigOpen] = useState(false);
  const [quickConfigContext, setQuickConfigContext] = useState<{
    app?: LLMAppCaller;
    modelType?: string;
    /** 升级 LegacySingle 时预选的当前直连模型 */
    preselected?: SelectedModelItem[];
    /** 默认打开哪个 tab（仅非 editPool 模式生效） */
    defaultTab?: 'create' | 'binding';
    /** 当前已绑定的池 id（Tab 2 初始勾选） */
    currentBoundPoolIds?: string[];
    /** 编辑现有池模型列表（独立模式，无 Tab） */
    editPool?: ModelGroup;
  } | null>(null);

  // 初始化结果弹窗
  const [initResult, setInitResult] = useState<{
    created: string[];
    updated: string[];
    unchanged: string[];
    orphanDeleted: string[];
    preservedBindingsCount: number;
    message: string;
  } | null>(null);


  // 表单状态
  const [groupForm, setGroupForm] = useState({
    name: '',
    code: '',
    modelType: 'chat' as string,
    isDefaultForType: false,
    description: '',
    models: [] as ModelGroupItem[],
  });

  const [requirementForm, setRequirementForm] = useState({
    modelType: 'chat',
    purpose: '',
    modelGroupIds: [] as string[],
    isRequired: true,
  });

  const [configForm, setConfigForm] = useState({
    consecutiveFailuresToDegrade: 1,
    consecutiveFailuresToUnavailable: 3,
    healthCheckIntervalMinutes: 5,
    healthCheckTimeoutSeconds: 10,
    healthCheckPrompt: 'ping',
    autoRecoveryEnabled: true,
    recoverySuccessThreshold: 2,
    statsWindowMinutes: 60,
  });

  const selectedApp = appCallers.find((a) => a.id === selectedAppId);

  useEffect(() => {
    loadData();
  }, []);

  // 初次加载标记，用于区分初次加载和后续切换应用
  const isInitialLoadRef = useRef(true);

  useEffect(() => {
    // 非初次加载时，切换应用才加载监控数据
    if (selectedAppId && !isInitialLoadRef.current) {
      loadMonitoringForApp(selectedAppId);
    }
  }, [selectedAppId]);

  // 使用 ref 稳定 loadData，避免每次渲染都创建新引用
  const loadDataRef = useRef<() => Promise<void>>();
  loadDataRef.current = async () => {
    try {
      const [apps, groups, config] = await Promise.all([
        getAppCallers(),
        getModelGroups(),
        getSchedulerConfig(),
      ]);
      setAppCallers(apps);
      setModelGroups(groups);
      setSchedulerConfig(config);

      // 平台列表（用于"添加模型"选择可用模型）
      try {
        const ps = await getPlatforms();
        if (ps.success) {
          setPlatforms(ps.data || []);
        } else {
          setPlatforms([]);
        }
      } catch {
        setPlatforms([]);
      }
      
      // 模型池应用
      const grouped = groupAppCallers(apps);
      setAppGroups(grouped);
      
      // 默认展开第一个应用
      if (grouped.length > 0 && expandedApps.size === 0) {
        setExpandedApps(new Set([grouped[0].app]));
      }
      setConfigForm({
        consecutiveFailuresToDegrade: config.consecutiveFailuresToDegrade,
        consecutiveFailuresToUnavailable: config.consecutiveFailuresToUnavailable,
        healthCheckIntervalMinutes: config.healthCheckIntervalMinutes,
        healthCheckTimeoutSeconds: config.healthCheckTimeoutSeconds,
        healthCheckPrompt: config.healthCheckPrompt,
        autoRecoveryEnabled: config.autoRecoveryEnabled,
        recoverySuccessThreshold: config.recoverySuccessThreshold,
        statsWindowMinutes: config.statsWindowMinutes,
      });
      
      // 设置默认选中的应用，并加载其监控数据
      if (apps.length > 0 && !selectedAppId) {
        const firstAppId = apps[0].id;
        setSelectedAppId(firstAppId);
        
        // 初次加载时，等待监控数据加载完成后再结束 loading 状态
        const firstApp = apps[0];
        if (firstApp) {
          const groupIds = firstApp.modelRequirements
            .flatMap((r: AppModelRequirement) => r.modelGroupIds || [])
            .filter((id): id is string => !!id);

          const data: Record<string, ModelGroupMonitoringData> = {};
          await Promise.all(
            groupIds.map(async (groupId: string) => {
              try {
                const monitoring = await getGroupMonitoring(groupId);
                data[groupId] = monitoring;
              } catch (error) {
                console.error(`Failed to load monitoring for group ${groupId}:`, error);
              }
            })
          );
          setMonitoringData(data);
        }
        
        // 加载后端解析的默认模型信息
        const resolveItems: { appCallerCode: string; modelType: string }[] = [];
        for (const caller of apps) {
          for (const req of caller.modelRequirements) {
            if (!req.modelGroupIds || req.modelGroupIds.length === 0) {
              resolveItems.push({
                appCallerCode: caller.appCode || '',
                modelType: req.modelType,
              });
            }
          }
        }
        if (resolveItems.length > 0) {
          try {
            const res = await resolveModels(resolveItems);
            if (res.success && res.data) {
              setResolvedModels(res.data);
            }
          } catch (e) {
            console.error('Failed to resolve models:', e);
          }
        }
      }
    } catch (error) {
      toast.error('加载失败', String(error));
    } finally {
      isInitialLoadRef.current = false;
      setIsLoading(false);
    }
  };

  const loadData = useCallback(() => loadDataRef.current?.(), []);

  const loadMonitoringForApp = async (appId: string) => {
    const app = appCallers.find((a) => a.id === appId);
    if (!app) return;

    const groupIds = app.modelRequirements
      .flatMap((r: AppModelRequirement) => r.modelGroupIds || [])
      .filter((id): id is string => !!id);

    const data: Record<string, ModelGroupMonitoringData> = {};
    await Promise.all(
      groupIds.map(async (groupId: string) => {
        try {
          const monitoring = await getGroupMonitoring(groupId);
          data[groupId] = monitoring;
        } catch (error) {
          console.error(`Failed to load monitoring for group ${groupId}:`, error);
        }
      })
    );
    setMonitoringData(data);
    
    // 加载默认模型解析结果（针对未绑定专属模型池的功能）
    loadResolvedModels();
    
    // 加载模型池中模型的统计数据（按 appCallerCode + model 组合）
    loadPoolModelStats(app, data);
  };
  
  // 加载模型池中模型的统计数据（按 appCallerCode + model 组合）
  const loadPoolModelStats = async (app: LLMAppCaller, monitoringData: Record<string, ModelGroupMonitoringData>) => {
    // 收集所有需要统计的 (appCallerCode, platformId, modelId) 组合
    const items: { appCallerCode: string; platformId: string; modelId: string }[] = [];
    
    for (const req of app.modelRequirements) {
      if (req.modelGroupIds && req.modelGroupIds.length > 0) {
        for (const groupId of req.modelGroupIds) {
          const monitoring = monitoringData[groupId];
          const group = modelGroups.find(g => g.id === groupId);
          const models = monitoring?.models && monitoring.models.length > 0 
            ? monitoring.models 
            : (group?.models || []);
          
          for (const model of models) {
            items.push({
              appCallerCode: app.appCode || '',
              platformId: model.platformId,
              modelId: model.modelId,
            });
          }
        }
      }
    }
    
    if (items.length === 0) {
      setPoolModelStats({});
      return;
    }
    
    try {
      const res = await getBatchModelStats({ days: 7, items });
      if (res.success && res.data?.items) {
        setPoolModelStats(res.data.items);
      }
    } catch (e) {
      console.error('Failed to load pool model stats:', e);
    }
  };
  
  // 加载后端解析的默认模型信息
  const loadResolvedModels = async () => {
    // 收集所有未绑定专属模型池的 appCallerCode::modelType 组合
    const items: { appCallerCode: string; modelType: string }[] = [];
    
    for (const caller of appCallers) {
      for (const req of caller.modelRequirements) {
        // 只有未绑定专属模型池的才需要解析
        if (!req.modelGroupIds || req.modelGroupIds.length === 0) {
          items.push({
            appCallerCode: caller.appCode || '',
            modelType: req.modelType,
          });
        }
      }
    }
    
    if (items.length === 0) {
      setResolvedModels({});
      return;
    }
    
    try {
      const res = await resolveModels(items);
      if (res.success && res.data) {
        setResolvedModels(res.data);
      }
    } catch (e) {
      console.error('Failed to resolve models:', e);
    }
  };

  // 打开"编辑现有池模型"——走统一 picker，不再用旧的表单 dialog
  const openGroupModelsEditor = (group: ModelGroup) => {
    setQuickConfigContext({ editPool: group });
    setQuickConfigOpen(true);
  };

  /* ── 一键配置模型（前端编排：picker → createModelGroup → updateAppCaller，失败回滚孤儿池） ── */

  // 流程 A：未配置功能行点 [配置模型] → 打开 picker，默认 Tab 1（新建/升级）；用户可在内部切到 Tab 2（选择已有池）
  const handleStartQuickConfig = (app: LLMAppCaller, modelType: string, currentBoundPoolIds: string[] = []) => {
    setQuickConfigContext({ app, modelType, defaultTab: 'create', currentBoundPoolIds });
    setQuickConfigOpen(true);
  };

  // 流程 B：LegacySingle 行点 [升级为模型池] → 打开 picker Tab 1，预选当前直连模型
  const handleUpgradeLegacyToPool = (app: LLMAppCaller, modelType: string, resolved: ResolvedModelInfo) => {
    setQuickConfigContext({
      app,
      modelType,
      preselected: [{
        platformId: resolved.platformId,
        modelId: resolved.modelId,
        modelName: resolved.modelId,
        name: resolved.modelId,
      }],
      defaultTab: 'create',
      currentBoundPoolIds: [],
    });
    setQuickConfigOpen(true);
  };

  // 流程 C：已绑定/未绑定都可点 [管理/选择已有池] → 打开 picker Tab 2（选择已有池），勾选当前已绑定的池
  const handleManagePools = (app: LLMAppCaller, modelType: string, currentBoundPoolIds: string[]) => {
    setQuickConfigContext({ app, modelType, defaultTab: 'binding', currentBoundPoolIds });
    setQuickConfigOpen(true);
  };

  // 卡片绑定 confirm → 复用现有 saveBindings 的逻辑（直接 PATCH /api/open-platform/app-callers/:id/requirements/:modelType/bindings）
  const handleConfirmBinding = async (selectedPoolIds: string[]) => {
    if (!quickConfigContext) return;
    const { app, modelType } = quickConfigContext;
    if (!app || !modelType) return;
    try {
      const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
      const url = `${API_BASE}/open-platform/app-callers/${app.id}/requirements/${modelType}/bindings`;
      const r = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ modelGroupIds: selectedPoolIds }),
      });
      if (!r.ok) {
        const errText = await r.text();
        throw new Error(errText || `HTTP ${r.status}`);
      }
      toast.success(selectedPoolIds.length > 0 ? `已绑定 ${selectedPoolIds.length} 个模型池` : '已清空绑定');
      await loadData();
      if (selectedAppId) await loadMonitoringForApp(selectedAppId);
    } catch (e) {
      toast.error('绑定失败', e instanceof Error ? e.message : String(e));
    }
  };

  // 编辑现有池模型列表：confirm = 把 picker 里最终选中的模型集合**替换**到该池
  // （增 = 新选中的；减 = 在 picker 里取消勾选的；其余字段如名字/策略/优先级保留不动）
  const handleEditPoolConfirm = async (pool: ModelGroup, selected: SelectedModelItem[]) => {
    try {
      // 保留原模型行的 priority/healthStatus 等元信息；新增的模型补默认值
      const existingByKey = new Map<string, ModelGroupItem>();
      for (const m of pool.models || []) {
        existingByKey.set(`${m.platformId}:${m.modelId}`.toLowerCase(), m);
      }
      const finalModels: ModelGroupItem[] = selected.map((s, idx) => {
        const k = `${s.platformId}:${s.modelId}`.toLowerCase();
        const existing = existingByKey.get(k);
        return existing
          ? { ...existing, priority: idx + 1 }
          : {
              platformId: s.platformId,
              modelId: s.modelId,
              priority: idx + 1,
              healthStatus: ModelHealthStatus.Healthy,
              consecutiveFailures: 0,
              consecutiveSuccesses: 0,
            };
      });
      const r = await updateModelGroup(pool.id, { models: finalModels });
      if (!r.success) throw new Error(r.error?.message || '保存失败');
      toast.success('已保存');
      await loadData();
      try {
        const monitoring = await getGroupMonitoring(pool.id);
        setMonitoringData((prev) => ({ ...prev, [pool.id]: monitoring }));
      } catch {
        /* 监控刷新失败静默 */
      }
    } catch (e) {
      toast.error('保存失败', e instanceof Error ? e.message : String(e));
    }
  };

  const handleQuickConfigConfirm = async (selected: SelectedModelItem[]) => {
    if (!quickConfigContext) return;
    // editPool 模式走单独路径
    if (quickConfigContext.editPool) {
      await handleEditPoolConfirm(quickConfigContext.editPool, selected);
      return;
    }
    const { app, modelType } = quickConfigContext;
    if (!app || !modelType) return;
    if (selected.length === 0) {
      toast.warning('请至少选择 1 个模型');
      return;
    }

    // Step 1: 自动建池（自动推断 name/code/strategy/priority/isDefault/description）
    const friendly = app.displayName || app.appCode;
    const autoCode = `auto-${app.appCode}-${modelType}-${Date.now().toString(36)}`;
    const autoName = `${friendly} · ${modelType} · 自动池`;
    let newPoolId: string | null = null;
    try {
      const created = await createModelGroup({
        name: autoName,
        code: autoCode,
        modelType,
        strategyType: PoolStrategyType.FailFast,
        priority: 50,
        isDefaultForType: false,
        description: `为 ${friendly} 自动创建（用户可在「模型池管理」编辑名称/策略）`,
        models: selected.map((m, idx) => ({
          platformId: m.platformId,
          modelId: m.modelId,
          priority: idx + 1,
          healthStatus: ModelHealthStatus.Healthy,
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
        })),
      });
      // createModelGroup 返回 ApiResponse<ModelGroup>
      if (!created?.success || !created.data?.id) {
        throw new Error(created?.error?.message || '建池后未拿到 id');
      }
      newPoolId = created.data.id;
    } catch (e) {
      toast.error('建池失败', String(e));
      setQuickConfigContext(null);
      return;
    }

    // Step 2: 把新池追加到 AppCaller.modelRequirements[modelType].modelGroupIds
    try {
      const reqs = [...(app.modelRequirements || [])];
      const idx = reqs.findIndex((r) => r.modelType === modelType);
      if (idx >= 0) {
        const existing = reqs[idx].modelGroupIds || [];
        reqs[idx] = { ...reqs[idx], modelGroupIds: [...existing, newPoolId] };
      } else {
        reqs.push({
          modelType,
          purpose: '',
          modelGroupIds: [newPoolId],
          isRequired: true,
        });
      }
      await updateAppCaller(app.id, { modelRequirements: reqs });
      toast.success(`已为 ${friendly} 配置 ${selected.length} 个模型`);
      await loadData();
    } catch (e) {
      // 回滚：删掉孤儿池
      try { await deleteModelGroup(newPoolId); } catch { /* 静默：池仍可在管理页手动清 */ }
      toast.error('绑定失败，已自动回滚孤儿池', String(e));
    } finally {
      setQuickConfigContext(null);
    }
  };

  // 从模型池中删除单个模型
  const handleRemoveModelFromPool = async (poolGroup: ModelGroup, platformId: string, modelId: string) => {
    const confirmed = await systemDialog.confirm({
      title: '确认移除',
      message: `确定从「${poolGroup.name}」中移除模型「${modelId}」吗？`,
    });
    if (!confirmed) return;

    try {
      const updatedModels = (poolGroup.models || []).filter(
        m => !(m.platformId === platformId && m.modelId === modelId)
      );

      const r = await updateModelGroup(poolGroup.id, { models: updatedModels });
      if (!r.success) throw new Error(r.error?.message || '移除失败');

      toast.success('模型已移除');
      // 刷新模型池列表
      const groups = await getModelGroups();
      setModelGroups(groups);
      // 刷新监控数据
      try {
        const monitoring = await getGroupMonitoring(poolGroup.id);
        setMonitoringData((prev) => ({ ...prev, [poolGroup.id]: monitoring }));
      } catch (e) {
        console.error('[RemoveModel] 刷新监控失败:', e);
      }
    } catch (error) {
      toast.error('移除失败', error instanceof Error ? error.message : String(error));
    }
  };

  const handleInitDefaultApps = useCallback(async () => {
    const confirmed = await systemDialog.confirm({
      title: '同步应用注册表',
      message: `此操作将：
1. 新增代码中新定义的应用
2. 更新已有应用的名称和描述
3. 清理已废弃的孤儿应用
4. 保留所有专属模型池绑定和调用统计

确定继续？`,
    });
    if (!confirmed) return;

    try {
      if (!token) {
        throw new Error('未登录，请重新登录');
      }

      const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim().replace(/\/+$/, '') || '';
      const url = `${API_BASE}${api.settings.init.defaultApps()}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMsg = `HTTP ${response.status}`;
        try {
          const errorData = JSON.parse(errorText);
          errorMsg = errorData?.error?.message || errorData?.message || errorMsg;
        } catch {
          errorMsg = errorText || errorMsg;
        }
        throw new Error(errorMsg);
      }

      const result = await response.json();
      
      if (result.success && result.data) {
        setInitResult(result.data);
        await loadData();
      } else {
        throw new Error(result.error?.message || '初始化失败');
      }
    } catch (error) {
      console.error('[InitDefaultApps] 异常:', error);
      toast.error('初始化失败', error instanceof Error ? error.message : String(error));
    }
  }, [token, loadData]);

  // const handleDeleteApp = async (appId: string) => {
  //   const confirmed = await systemDialog.confirm({ title: '确认删除', message: '删除应用后无法恢复，确定继续？' });
  //   if (!confirmed) return;

  //   try {
  //     await deleteAppCaller(appId);
  //     systemDialog.success('删除成功');
  //     await loadData();
  //     if (selectedAppId === appId) {
  //       setSelectedAppId(appCallers[0]?.id ?? null);
  //     }
  //   } catch (error) {
  //     systemDialog.error('删除失败', String(error));
  //   }
  // };

  // const handleAddRequirement = () => {
  //   setEditingRequirement(null);
  //   setRequirementForm({
  //     modelType: 'chat',
  //     purpose: '',
  //     modelGroupId: '',
  //     isRequired: true,
  //   });
  //   setShowRequirementDialog(true);
  // };

  // const handleEditRequirement = (req: AppModelRequirement) => {
  //   setEditingRequirement(req);
  //   setRequirementForm({
  //     modelType: req.modelType,
  //     purpose: req.purpose,
  //     modelGroupId: req.modelGroupId ?? '',
  //     isRequired: req.isRequired,
  //   });
  //   setShowRequirementDialog(true);
  // };

  const handleSaveRequirement = async () => {
    if (!selectedApp) return;

    const newReq: AppModelRequirement = {
      modelType: requirementForm.modelType,
      purpose: requirementForm.purpose,
      modelGroupIds: requirementForm.modelGroupIds,
      isRequired: requirementForm.isRequired,
    };

    let updatedReqs: AppModelRequirement[];
    if (editingRequirement) {
      updatedReqs = selectedApp.modelRequirements.map((r) =>
        r.modelType === editingRequirement.modelType && r.purpose === editingRequirement.purpose ? newReq : r
      );
    } else {
      updatedReqs = [...selectedApp.modelRequirements, newReq];
    }

    try {
      await updateAppCaller(selectedApp.id, {
        displayName: selectedApp.displayName,
        description: selectedApp.description,
        modelRequirements: updatedReqs,
      });
      toast.success('保存成功');
      await loadData();
      setShowRequirementDialog(false);
      setEditingRequirement(null);
    } catch (error) {
      toast.error('保存失败', String(error));
    }
  };

  // const handleDeleteRequirement = async (req: AppModelRequirement) => {
  //   if (!selectedApp) return;

  //   const confirmed = await systemDialog.confirm({ title: '确认删除', message: '删除需求后将使用默认模型，确定继续？' });
  //   if (!confirmed) return;

  //   const updatedReqs = selectedApp.modelRequirements.filter(
  //     (r: AppModelRequirement) => !(r.modelType === req.modelType && r.purpose === req.purpose)
  //   );

  //   try {
  //     await updateAppCaller(selectedApp.id, {
  //       displayName: selectedApp.displayName,
  //       description: selectedApp.description,
  //       modelRequirements: updatedReqs,
  //     });
  //     systemDialog.success('删除成功');
  //     await loadData();
  //   } catch (error) {
  //     systemDialog.error('删除失败', String(error));
  //   }
  // };

  /* 暂时未使用，保留用于未来功能
  const handleEditGroup = (group: ModelGroup) => {
    _setEditingGroup(group);
    setGroupForm({
      name: group.name,
      code: group.code,
      description: group.description ?? '',
      models: group.models,
    });
    _setShowGroupDialog(true);
  };
  */

  const handleSaveGroup = async () => {
    if (!groupForm.name.trim()) {
      toast.warning('验证失败', '模型池名称不能为空');
      return;
    }
    if (!editingGroup && !groupForm.code.trim()) {
      toast.warning('验证失败', '模型池代码不能为空');
      return;
    }
    if (!groupForm.modelType.trim()) {
      toast.warning('验证失败', '模型类型不能为空');
      return;
    }

    try {
      if (editingGroup) {
        await updateModelGroup(editingGroup.id, {
          name: groupForm.name,
          description: groupForm.description,
          models: groupForm.models,
        });
      } else {
        await createModelGroup({
          name: groupForm.name,
          code: groupForm.code,
          modelType: groupForm.modelType,
          isDefaultForType: groupForm.isDefaultForType,
          description: groupForm.description,
          models: groupForm.models,
        });
      }
      toast.success('保存成功');
      await loadData();
      _setShowGroupDialog(false);
    } catch (error) {
      toast.error('保存失败', String(error));
    }
  };

  /* 暂时未使用，保留用于未来功能
  const handleDeleteGroup = async (groupId: string) => {
    const confirmed = await systemDialog.confirm({ title: '确认删除', message: '删除模型池后无法恢复，确定继续？' });
    if (!confirmed) return;

    try {
      await deleteModelGroup(groupId);
      systemDialog.success('删除成功');
      await loadData();
    } catch (error) {
      systemDialog.error('删除失败', String(error));
    }
  };
  */

  const handleSaveConfig = async () => {
    try {
      await updateSchedulerConfig(configForm);
      toast.success('保存成功');
      await loadData();
      setShowConfigDialog(false);
    } catch (error) {
      toast.error('保存失败', String(error));
    }
  };

  // const handleSimulateDowngrade = async (groupId: string, modelId: string, platformId: string) => {
  //   try {
  //     await simulateDowngrade(groupId, modelId, platformId, 5);
  //     systemDialog.success('模拟降权成功');
  //     await loadMonitoringForApp(selectedAppId!);
  //   } catch (error) {
  //     systemDialog.error('模拟失败', String(error));
  //   }
  // };

  // const handleSimulateRecover = async (groupId: string, modelId: string, platformId: string) => {
  //   try {
  //     await simulateRecover(groupId, modelId, platformId, 3);
  //     systemDialog.success('模拟恢复成功');
  //     await loadMonitoringForApp(selectedAppId!);
  //   } catch (error) {
  //     systemDialog.error('模拟失败', String(error));
  //   }
  // };

  // 按应用聚合
  const groupedApps = groupAppCallers(appCallers);
  
  // ????????
  const filteredAppGroups = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    const byType = groupedApps
      .map((group) => {
        if (modelTypeFilter === 'all') return group;
        const features = group.features
          .map((feature) => ({
            ...feature,
            items: feature.items.filter(
              (item) => normalizeModelType(item.parsed.modelType) === modelTypeFilter
            ),
          }))
          .filter((feature) => feature.items.length > 0);
        if (features.length === 0) return null;
        return { ...group, features };
      })
      .filter(Boolean) as AppGroup[];

    if (!normalizedSearch) return byType;
    // 搜索匹配范围：appName（中文/英文显示名）、app code、以及任意子项的 appCallerCode
    // （让用户能直接搜 "visual-agent.image.text2img" 这类完整 code 定位到对应分组）
    return byType.filter(
      (group) =>
        group.appName.toLowerCase().includes(normalizedSearch) ||
        group.app.toLowerCase().includes(normalizedSearch) ||
        group.features.some((feature) =>
          feature.items.some((item) =>
            (item.appCallerCode || '').toLowerCase().includes(normalizedSearch) ||
            (item.displayName || '').toLowerCase().includes(normalizedSearch)
          )
        )
    );
  }, [groupedApps, modelTypeFilter, searchTerm]);

  useEffect(() => {
    if (filteredAppGroups.length === 0) return;
    const stillVisible = filteredAppGroups.some((group) =>
      group.features.some((feature) => feature.items.some((item) => item.id === selectedAppId))
    );
    if (!stillVisible) {
      const firstItem = filteredAppGroups[0].features[0]?.items[0];
      setSelectedAppId(firstItem?.id ?? null);
    }
  }, [filteredAppGroups, selectedAppId]);

  const selectedAppGroup = selectedAppId 
    ? groupedApps.find(g => g.features.some(f => f.items.some(i => i.id === selectedAppId)))
    : null;
  
  // 获取选中应用的所有功能项（扁平化）
  const selectedAppFeatures = selectedAppGroup 
    ? selectedAppGroup.features.flatMap(f => f.items)
    : [];

  // 将actions传递给父组件 - 只在首次挂载时设置
  const actionsSetRef = useRef(false);
  const actions = useMemo(() => (
        <>
          <Button variant="secondary" size="sm" onClick={handleInitDefaultApps} title="同步应用">
            <RefreshCw size={14} />
            {!isMobile && '同步应用'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setShowConfigDialog(true)} title="系统配置">
            <Settings size={14} />
            {!isMobile && '系统配置'}
          </Button>
          <Button variant="primary" size="sm" onClick={() => window.location.href = '/mds?tab=pools'} title="新建模型池">
            <Plus size={14} />
            {!isMobile && '新建模型池'}
          </Button>
        </>
  ), [handleInitDefaultApps, isMobile]);

  useEffect(() => {
    if (!actionsSetRef.current && onActionsReady) {
      actionsSetRef.current = true;
      onActionsReady(actions);
    }
  }, [onActionsReady, actions]);

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">

      {/* 固定三栏布局：左侧320px，右侧分上下两栏（上栏60px固定，下栏占满） */}
      <div className="grid gap-4 flex-1 min-h-0 lg:grid-cols-[320px_1fr]">
        {/* 左侧：应用列表 */}
        <GlassCard animated glow className="flex flex-col min-h-0 p-0 overflow-hidden">
          <div className="p-3 border-b border-white/10 space-y-2">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input
                type="text"
                placeholder="搜索应用..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full h-9 pl-9 pr-3 rounded-[11px] outline-none text-[13px]"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>
            <ModelTypeFilterBar
              value={modelTypeFilter}
              onChange={setModelTypeFilter}
            />
          </div>

          <div className="flex-1 overflow-auto">
            {isLoading ? (
              <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
                <MapSectionLoader text="加载中..." />
              </div>
            ) : filteredAppGroups.length === 0 ? (
              <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
                <Activity size={32} className="mx-auto mb-2 opacity-40" />
                <div className="text-sm">暂无应用</div>
              </div>
            ) : (
              <div className="divide-y divide-white/10">
                {filteredAppGroups.map((appGroup) => {
                  // 检查这个应用组中是否有被选中的项
                  const isSelected = appGroup.features.some(f => f.items.some(i => i.id === selectedAppId));
                  const totalItems = appGroup.features.reduce((sum, f) => sum + f.items.length, 0);

                  return (
                    <div
                      key={appGroup.app}
                      onClick={() => {
                        // 选中这个应用组的第一个功能项
                        const firstItem = appGroup.features[0]?.items[0];
                        if (firstItem) {
                          setSelectedAppId(firstItem.id);
                        }
                      }}
                      className="surface-row px-3 py-3 cursor-pointer"
                      style={isSelected ? { background: 'var(--bg-input-hover)' } : undefined}
                    >
                      <div className="flex items-center gap-3">
                        {/* 应用图标 */}
                        <div
                          className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center"
                          style={{
                            background: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-input-hover)',
                            border: isSelected ? '1px solid rgba(59, 130, 246, 0.3)' : '1px solid var(--border-subtle)',
                          }}
                        >
                          <Layers size={18} style={{ color: isSelected ? 'rgba(59, 130, 246, 0.9)' : 'var(--text-muted)' }} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                              {appGroup.appName}
                            </div>
                            <Badge variant="subtle" size="sm">
                              {totalItems}
                            </Badge>
                          </div>
                          <div className="mt-0.5 text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                            {appGroup.app}
                          </div>
                        </div>
                        {isSelected && <ChevronRight size={16} style={{ color: 'var(--text-muted)' }} />}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </GlassCard>

        {/* 右侧：固定上下两栏布局（上栏60px，下栏占满剩余空间） */}
        <div className="grid grid-rows-[60px_1fr] gap-4 min-h-0">
          {/* 上栏：应用信息卡片（固定60px高度） */}
          <GlassCard animated glow className="p-4 overflow-hidden">
            {isLoading ? (
              <div className="h-full flex items-center justify-center">
                <MapSectionLoader text="加载中..." />
              </div>
            ) : !selectedAppGroup ? (
              <div className="h-full flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
                请选择一个应用
              </div>
            ) : (
              <div className="h-full flex items-center justify-between gap-4">
                {/* 左侧：应用名称和标识 */}
                <div className="flex items-center gap-3 min-w-0">
                  <h3 className="text-base font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                    {selectedAppGroup.appName}
                  </h3>
                  <Badge variant="subtle" size="sm" className="shrink-0">
                    {selectedAppFeatures.length} 个功能
                  </Badge>
                  <span className="text-[13px] truncate hidden sm:block" style={{ color: 'var(--text-muted)' }}>
                    {selectedAppGroup.app}
                  </span>
                </div>
                {/* 右侧：统计数据 */}
                <div className="flex items-center gap-4 text-[12px] shrink-0">
                  <span style={{ color: 'var(--text-muted)' }}>
                    总调用: <span style={{ color: 'var(--text-secondary)' }}>
                      {selectedAppFeatures.reduce((sum, f) => sum + f.stats.totalCalls, 0).toLocaleString()}
                    </span>
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    成功: <span style={{ color: 'rgba(34,197,94,0.95)' }}>
                      {selectedAppFeatures.reduce((sum, f) => sum + f.stats.successCalls, 0).toLocaleString()}
                    </span>
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    失败: <span style={{ color: 'rgba(239,68,68,0.95)' }}>
                      {selectedAppFeatures.reduce((sum, f) => sum + f.stats.failedCalls, 0).toLocaleString()}
                    </span>
                  </span>
                </div>
              </div>
            )}
          </GlassCard>

          {/* 下栏：功能列表（占满剩余空间） */}
          {isLoading ? (
            <GlassCard animated glow className="flex items-center justify-center overflow-hidden">
              <div className="text-center" style={{ color: 'var(--text-muted)' }}>
                <MapSectionLoader text="加载中..." />
              </div>
            </GlassCard>
          ) : !selectedAppGroup ? (
            <GlassCard animated glow className="flex items-center justify-center overflow-hidden">
              <div className="text-center" style={{ color: 'var(--text-muted)' }}>
                <Activity size={48} className="mx-auto mb-4 opacity-40" />
                <div className="text-sm">请选择一个应用</div>
              </div>
            </GlassCard>
          ) : (
            <GlassCard animated glow className="min-h-0 overflow-auto p-0">
                {selectedAppFeatures.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center py-12">
                    <div className="text-center" style={{ color: 'var(--text-muted)' }}>
                      <Zap size={48} className="mx-auto mb-4 opacity-40" />
                      <div className="text-sm">暂无功能配置</div>
                    </div>
                  </div>
                ) : (
                  <div className="divide-y divide-white/[0.06]">
                    {selectedAppFeatures.map((featureItem, idx: number) => {
                      const app = appCallers.find(a => a.id === featureItem.id);
                      if (!app) return null;

                      const req = app.modelRequirements[0]; // 每个功能项只有一个需求
                      const boundGroupIds = req?.modelGroupIds || [];
                      // 获取所有绑定的模型池
                      const boundGroups = boundGroupIds
                        .map(id => modelGroups.find(g => g.id === id))
                        .filter((g): g is ModelGroup => !!g);
                      // 优先使用数据库的 modelType，回退到 AppCode 解析
                      const actualModelType = req?.modelType || featureItem.parsed.modelType;
                      const ModelTypeIcon = getModelTypeIcon(actualModelType);
                      const modelTypeLabel = getModelTypeDisplayName(actualModelType);
                      // 使用数据库的 displayName（单一数据源原则：后端 AppCallerRegistry 是唯一数据源）
                      const featureDescription = featureItem.displayName || featureItem.appCallerCode;

                      // 判断是否使用默认模型池（未绑定专属模型池）
                      const isDefaultGroup = boundGroups.length === 0;
                      
                      // 从后端解析结果获取默认模型信息
                      const resolveKey = app.appCode || '';
                      const resolvedModel = isDefaultGroup ? resolvedModels[resolveKey] : null;
                      const isLegacySingle = isDefaultGroup && resolvedModel?.source === 'legacy';
                      const isDefaultPool = isDefaultGroup && !isLegacySingle;

                      // 判断模型列表是否折叠
                      const featureKey = `${app.id}-${idx}`;
                      const isCollapsed = collapsedFeatures.has(featureKey);

                      // 切换折叠状态
                      const toggleCollapse = () => {
                        setCollapsedFeatures(prev => {
                          const next = new Set(prev);
                          if (next.has(featureKey)) {
                            next.delete(featureKey);
                          } else {
                            next.add(featureKey);
                          }
                          return next;
                        });
                      };

                      // 计算所有模型池的总模型数
                      const totalModelsCount = boundGroups.reduce((sum, g) => {
                        const mon = monitoringData[g.id];
                        const models = mon?.models && mon.models.length > 0 ? mon.models : (g.models || []);
                        return sum + models.length;
                      }, 0);

                      // 获取平台名称
                      const getPlatformName = (platformId: string) => {
                        const platform = platforms.find(p => p.id === platformId);
                        return platform?.name || platformId;
                      };

                      const modeBadge = boundGroups.length > 0
                        ? {
                          label: '专属模型池',
                          icon: Layers,
                          bg: 'rgba(59, 130, 246, 0.18)',
                          color: 'rgba(59, 130, 246, 0.95)',
                          border: 'rgba(59, 130, 246, 0.4)',
                        }
                        : isLegacySingle
                          ? {
                            label: '直连单模型',
                            icon: Zap,
                            bg: 'rgba(148, 163, 184, 0.18)',
                            color: 'rgba(148, 163, 184, 0.95)',
                            border: 'rgba(148, 163, 184, 0.35)',
                          }
                          : {
                            label: resolvedModel ? '默认模型池' : '默认未配置',
                            icon: Layers,
                            bg: resolvedModel ? 'rgba(148, 163, 184, 0.16)' : 'rgba(251, 191, 36, 0.18)',
                            color: resolvedModel ? 'rgba(148, 163, 184, 0.95)' : 'rgba(251, 191, 36, 0.95)',
                            border: resolvedModel ? 'rgba(148, 163, 184, 0.3)' : 'rgba(251, 191, 36, 0.35)',
                          };
                      const ModeBadgeIcon = modeBadge.icon;
                      const FeatureIcon = isLegacySingle ? Zap : ModelTypeIcon;
                      const featureAccent = isLegacySingle
                        ? 'rgba(148, 163, 184, 0.95)'
                        : isDefaultPool
                          ? (resolvedModel ? 'rgba(148, 163, 184, 0.95)' : 'rgba(251, 191, 36, 0.95)')
                          : 'rgba(59, 130, 246, 0.9)';

                      return (
                        <div key={idx} className="p-4">
                          {/* 功能头部 - 左侧竖线指示器 */}
                          <div className="flex items-start gap-3">
                            {/* 功能类型图标 - 未绑定专属模型池用灰色，已绑定用蓝色 */}
                            <div
                              className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center"
                              style={{
                                background: isLegacySingle
                                  ? 'rgba(148, 163, 184, 0.12)'
                                  : isDefaultPool
                                    ? (resolvedModel ? 'rgba(148, 163, 184, 0.12)' : 'rgba(251, 191, 36, 0.12)')
                                    : 'rgba(59, 130, 246, 0.1)',
                                border: isLegacySingle
                                  ? '1px solid rgba(148, 163, 184, 0.25)'
                                  : isDefaultPool
                                    ? (resolvedModel ? '1px solid rgba(148, 163, 184, 0.25)' : '1px solid rgba(251, 191, 36, 0.28)')
                                    : '1px solid rgba(59, 130, 246, 0.2)',
                              }}
                            >
                              <FeatureIcon size={20} style={{ color: featureAccent }} />
                            </div>

                            {/* 功能信息 */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                                      {featureDescription}
                                    </span>
                                    <span
                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold"
                                      style={{
                                        background: modeBadge.bg,
                                        color: modeBadge.color,
                                        border: `1px solid ${modeBadge.border}`,
                                      }}
                                    >
                                      <ModeBadgeIcon size={10} />
                                      {modeBadge.label}
                                    </span>
                                    <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                      <AppCallerCodeIcon size={11} className="opacity-60" />
                                      {featureItem.appCallerCode}
                                    </span>
                                  </div>
                                  <div className="mt-1">
                                    {isDefaultGroup ? (
                                      resolvedModel ? (
                                        (() => {
                                          // 使用后端返回的统计数据（基于 appCallerCode + model 组合）
                                          const defaultStats = resolvedModel.stats;
                                          const defaultStatus = HEALTH_STATUS_MAP[resolvedModel.healthStatus as keyof typeof HEALTH_STATUS_MAP] || HEALTH_STATUS_MAP.Healthy;
                                          const isFallback = resolvedModel.isFallback;
                                          const configuredPool = resolvedModel.configuredPool;
                                          return (
                                            <div className="space-y-1">
                                              {/* 降级警告条 - 显示原始配置 */}
                                              {isFallback && configuredPool && (
                                                <div
                                                  className="flex items-start gap-2 py-1.5 px-2 rounded-lg text-[11px]"
                                                  style={{
                                                    background: 'rgba(251, 191, 36, 0.08)',
                                                    border: '1px dashed rgba(251, 191, 36, 0.3)',
                                                  }}
                                                >
                                                  <AlertTriangle size={12} className="shrink-0 mt-0.5" style={{ color: 'rgba(251, 191, 36, 0.9)' }} />
                                                  <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                      <span style={{ color: 'rgba(251, 191, 36, 0.9)' }}>
                                                        模型池降级
                                                      </span>
                                                      <span style={{ color: 'var(--text-muted)' }}>
                                                        配置: {configuredPool.poolName || '(未知)'}
                                                      </span>
                                                      {configuredPool.models?.map((m, i) => (
                                                        <span
                                                          key={i}
                                                          className="inline-flex items-center gap-1 px-1 py-0.5 rounded"
                                                          style={{
                                                            background: m.isAvailable ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                                                            color: m.isAvailable ? 'rgba(34, 197, 94, 0.8)' : 'rgba(239, 68, 68, 0.8)',
                                                            textDecoration: m.isAvailable ? 'none' : 'line-through',
                                                          }}
                                                        >
                                                          {m.modelId}
                                                          <span className="text-[9px]">({m.healthStatus})</span>
                                                        </span>
                                                      ))}
                                                    </div>
                                                  </div>
                                                </div>
                                              )}
                                              {/* 实际使用的模型 */}
                                              <div
                                                className="group flex items-center gap-2 py-1.5 px-2 rounded-lg transition-colors"
                                                style={{ background: isFallback ? 'rgba(34, 197, 94, 0.05)' : 'var(--bg-card, rgba(255, 255, 255, 0.03))' }}
                                                onMouseEnter={(e) => {
                                                  e.currentTarget.style.background = isFallback ? 'rgba(34, 197, 94, 0.1)' : 'var(--bg-input-hover)';
                                                }}
                                                onMouseLeave={(e) => {
                                                  e.currentTarget.style.background = isFallback ? 'rgba(34, 197, 94, 0.05)' : 'var(--bg-card, rgba(255, 255, 255, 0.03))';
                                                }}
                                                title={isFallback ? `降级回退：${resolvedModel.fallbackReason || ''}` : resolvedModel.source === 'legacy' ? '使用传统配置的单模型' : resolvedModel.modelGroupName ? `使用默认模型池：${resolvedModel.modelGroupName}` : '使用默认模型池'}
                                              >
                                              {/* 序号 */}
                                              <span className="text-[10px] font-medium w-5 text-center shrink-0" style={{ color: 'var(--text-muted)' }}>
                                                1
                                              </span>
                                              {/* 平台 */}
                                              <span
                                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] shrink-0"
                                                style={{ background: 'var(--bg-card-hover)', color: 'var(--text-muted)' }}
                                              >
                                                <Server size={10} />
                                                {resolvedModel.platformName}
                                              </span>
                                              {/* 模型名 */}
                                              <div className="flex items-center gap-1 min-w-0 flex-1">
                                                <Box size={12} style={{ color: 'var(--text-muted)' }} className="shrink-0" />
                                                <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                                                  {resolvedModel.modelId}
                                                </span>
                                              </div>
                                              {/* 调用统计（基于 appCallerCode + model 组合） */}
                                              {defaultStats ? (
                                                <div className="flex items-center gap-2 text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                                                  <span title="近7天请求次数（该功能+此模型）">
                                                    {defaultStats.requestCount.toLocaleString()}次
                                                  </span>
                                                  {defaultStats.avgDurationMs != null && (
                                                    <span title="平均耗时">
                                                      {defaultStats.avgDurationMs}ms
                                                    </span>
                                                  )}
                                                  {defaultStats.avgTtfbMs != null && (
                                                    <span title="首字延迟(TTFB)">
                                                      TTFB:{defaultStats.avgTtfbMs}ms
                                                    </span>
                                                  )}
                                                  {(defaultStats.totalInputTokens != null || defaultStats.totalOutputTokens != null) && (
                                                    <span title="输入/输出Token">
                                                      {((defaultStats.totalInputTokens || 0) / 1000).toFixed(1)}k/{((defaultStats.totalOutputTokens || 0) / 1000).toFixed(1)}k
                                                    </span>
                                                  )}
                                                </div>
                                              ) : (
                                                <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                                                  暂无统计
                                                </span>
                                              )}
                                              {/* 状态（非 Healthy 时可点击重置） */}
                                              {resolvedModel.healthStatus !== 'Healthy' && resolvedModel.modelGroupId ? (
                                                <button
                                                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
                                                  style={{ background: defaultStatus.bg, color: defaultStatus.color }}
                                                  title="点击重置为健康状态"
                                                  onClick={async (e) => {
                                                    e.stopPropagation();
                                                    try {
                                                      await resetModelHealth(resolvedModel.modelGroupId!, resolvedModel.modelId);
                                                      toast.success('已重置为健康状态');
                                                      loadData();
                                                    } catch (err: any) {
                                                      toast.error(err.message || '重置失败');
                                                    }
                                                  }}
                                                >
                                                  {defaultStatus.label} ↻
                                                </button>
                                              ) : (
                                                <span
                                                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold shrink-0"
                                                  style={{ background: defaultStatus.bg, color: defaultStatus.color }}
                                                >
                                                  {defaultStatus.label}
                                                </span>
                                              )}
                                              {/* 查看日志按钮 - hover 显示 */}
                                              <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button
                                                  className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-blue-500/20"
                                                  onClick={() => {
                                                    const params = new URLSearchParams();
                                                    params.set('tab', 'llm');
                                                    if (resolvedModel.platformName) params.set('provider', resolvedModel.platformName);
                                                    if (resolvedModel.modelId) params.set('model', resolvedModel.modelId);
                                                    navigate(`/logs?${params.toString()}`);
                                                  }}
                                                  title="查看该模型的调用日志"
                                                >
                                                  <Eye size={11} style={{ color: 'rgba(59, 130, 246, 0.8)' }} />
                                                </button>
                                              </div>
                                            </div>
                                            </div>
                                          );
                                        })()
                                      ) : (
                                        <div
                                          className="flex items-center gap-2 py-1.5 px-2 rounded-lg"
                                          style={{ background: 'rgba(251, 191, 36, 0.08)' }}
                                          title="未配置默认模型"
                                        >
                                          <span className="text-[12px]" style={{ color: 'rgba(251, 191, 36, 0.95)' }}>
                                            (未配置默认{modelTypeLabel})
                                          </span>
                                        </div>
                                      )
                                    ) : (
                                      <>
                                        {/* 模型池名字已下沉到下方卡片网格，这里只保留汇总 + 折叠按钮 */}
                                        {totalModelsCount > 0 && (
                                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                            {boundGroups.length} 个模型池 · {totalModelsCount} 个模型
                                          </span>
                                        )}
                                        {/* 折叠/展开按钮 */}
                                        {totalModelsCount > 0 && (
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              toggleCollapse();
                                            }}
                                            className="inline-flex items-center justify-center w-5 h-5 rounded hover:bg-white/10 transition-colors"
                                            title={isCollapsed ? '展开模型列表' : '折叠模型列表'}
                                          >
                                            {isCollapsed ? (
                                              <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
                                            ) : (
                                              <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} />
                                            )}
                                          </button>
                                        )}
                                      </>
                                    )}
                                  </div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  {/* 主操作：未配置 → [+ 配置模型]，LegacySingle → [升级为模型池]，已绑定 → [添加模型] */}
                                  {boundGroups.length === 0 && !isLegacySingle && (
                                    <Button
                                      variant="primary"
                                      size="xs"
                                      onClick={() => handleStartQuickConfig(
                                        app,
                                        req?.modelType || featureItem.parsed.modelType,
                                        req?.modelGroupIds || []
                                      )}
                                      title="新建池或选择已有池（弹窗内 Tab 切换）"
                                    >
                                      <Plus size={12} />
                                      配置模型
                                    </Button>
                                  )}
                                  {isLegacySingle && resolvedModel && (
                                    <Button
                                      variant="primary"
                                      size="xs"
                                      onClick={() => handleUpgradeLegacyToPool(
                                        app,
                                        req?.modelType || featureItem.parsed.modelType,
                                        resolvedModel
                                      )}
                                      title="升级当前直连为模型池；弹窗内可切到「选择已有池」Tab"
                                    >
                                      <Plus size={12} />
                                      升级为模型池
                                    </Button>
                                  )}
                                  {/* 已绑定时：[+ 添加模型] 编辑当前池 + [管理模型池] 切换/多绑 */}
                                  {boundGroups.length === 1 && (
                                    <Button
                                      variant="secondary"
                                      size="xs"
                                      onClick={() => openGroupModelsEditor(boundGroups[0])}
                                      title="添加模型到当前池"
                                    >
                                      <Plus size={12} />
                                      添加模型
                                    </Button>
                                  )}
                                  {boundGroups.length > 0 && (
                                    <Button
                                      variant="ghost"
                                      size="xs"
                                      onClick={() => handleManagePools(
                                        app,
                                        req?.modelType || featureItem.parsed.modelType,
                                        req?.modelGroupIds || []
                                      )}
                                      title="管理当前功能绑定的模型池（卡片式选择，可多选）"
                                    >
                                      <Link2 size={12} />
                                      管理模型池
                                    </Button>
                                  )}
                                </div>
                              </div>

                              {/* 模型池卡片网格 - 每个池一张卡片，模型直接平铺，永不空 */}
                              {boundGroups.length > 0 && !isCollapsed && (
                                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                  {boundGroups.map((poolGroup) => {
                                    const poolMonitoring = monitoringData[poolGroup.id];
                                    const poolModels = poolMonitoring?.models && poolMonitoring.models.length > 0
                                      ? poolMonitoring.models
                                      : (poolGroup.models || []).map(m => ({ ...m, healthScore: 100 }));

                                    // 池级降级判定：复用 LegacySingle "模型池降级" 警示条的视觉语言
                                    // 任一不可用 → 黄色虚线；全部不可用 → 红色虚线
                                    const hasUnavailable = poolModels.some((m) => (m as { healthStatus?: string }).healthStatus === 'Unavailable');
                                    const allUnavailable = poolModels.length > 0 && poolModels.every((m) => (m as { healthStatus?: string }).healthStatus === 'Unavailable');
                                    const hasDegraded = poolModels.some((m) => (m as { healthStatus?: string }).healthStatus === 'Degraded');
                                    const isPoolDegraded = hasUnavailable || hasDegraded;

                                    const cardStyle = allUnavailable
                                      ? { background: 'rgba(239, 68, 68, 0.05)', border: '1px dashed rgba(239, 68, 68, 0.45)' }
                                      : isPoolDegraded
                                        ? { background: 'rgba(251, 191, 36, 0.05)', border: '1px dashed rgba(251, 191, 36, 0.4)' }
                                        : { background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(59, 130, 246, 0.18)' };
                                    const headerAccent = allUnavailable
                                      ? 'rgba(239, 68, 68, 0.95)'
                                      : isPoolDegraded
                                        ? 'rgba(251, 191, 36, 0.95)'
                                        : 'rgba(59, 130, 246, 0.95)';
                                    const HeaderIcon = isPoolDegraded ? AlertTriangle : Layers;

                                    return (
                                      <div
                                        key={poolGroup.id}
                                        className="rounded-lg overflow-hidden transition-all"
                                        style={cardStyle}
                                      >
                                        {/* 卡片头：图标（降级时换 ⚠） + 名称 + 数量徽章（>1时） + 添加(hover) */}
                                        <div className="group flex items-center gap-2 py-2 px-2.5">
                                          <HeaderIcon size={12} className="shrink-0" style={{ color: headerAccent }} />
                                          <span className="text-[12px] font-medium truncate flex-1 min-w-0" style={{ color: headerAccent }} title={poolGroup.name}>
                                            {poolGroup.name}
                                          </span>
                                          {/* 数量徽章：仅当 >1 个模型时显示 */}
                                          {poolModels.length > 1 && (
                                            <span
                                              className="inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 rounded text-[10px] font-semibold shrink-0"
                                              style={{ background: 'rgba(59, 130, 246, 0.18)', color: 'rgba(59, 130, 246, 0.95)' }}
                                              title={`${poolModels.length} 个模型`}
                                            >
                                              {poolModels.length}
                                            </span>
                                          )}
                                          {/* 添加模型按钮 - hover 显示 */}
                                          <button
                                            className="h-6 px-1.5 inline-flex items-center gap-0.5 rounded hover:bg-blue-500/20 shrink-0 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                                            onClick={(e) => { e.stopPropagation(); openGroupModelsEditor(poolGroup); }}
                                            title="添加模型到模型池"
                                            style={{ color: 'rgba(59, 130, 246, 0.95)' }}
                                          >
                                            <Plus size={10} />
                                            添加
                                          </button>
                                        </div>

                                        {/* 卡片体：模型列表（永远展示，0 模型时显示占位） */}
                                        <div
                                          className="px-2 pb-2 pt-1.5 space-y-1"
                                          style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
                                        >
                                            {poolModels.length > 0 ? (
                                              poolModels.map((model: any) => {
                                                const status = HEALTH_STATUS_MAP[model.healthStatus as keyof typeof HEALTH_STATUS_MAP] || HEALTH_STATUS_MAP.Healthy;
                                                const platformName = getPlatformName(model.platformId);
                                                const poolStatsKey = `${selectedApp?.appCode || ''}:${model.platformId}:${model.modelId}`.toLowerCase();
                                                const stats = poolModelStats[poolStatsKey] || null;
                                                const isUnhealthy = model.healthStatus && model.healthStatus !== 'Healthy';
                                                const isModelUnavailable = model.healthStatus === 'Unavailable';
                                                const isModelDegraded = model.healthStatus === 'Degraded';
                                                const hasFooter = !!stats || !!platformName;
                                                // 模型行视觉：复用 LegacySingle 警示条的"不可用 = 红删除线"语言
                                                const rowBaseBg = isModelUnavailable
                                                  ? 'rgba(239, 68, 68, 0.08)'
                                                  : isModelDegraded
                                                    ? 'rgba(251, 191, 36, 0.08)'
                                                    : 'rgba(255,255,255,0.025)';
                                                const rowHoverBg = isModelUnavailable
                                                  ? 'rgba(239, 68, 68, 0.12)'
                                                  : isModelDegraded
                                                    ? 'rgba(251, 191, 36, 0.12)'
                                                    : 'rgba(255,255,255,0.05)';
                                                const modelNameColor = isModelUnavailable
                                                  ? 'rgba(239, 68, 68, 0.9)'
                                                  : isModelDegraded
                                                    ? 'rgba(251, 191, 36, 0.95)'
                                                    : 'var(--text-primary)';
                                                return (
                                                  <div
                                                    key={`${poolGroup.id}-${model.platformId}-${model.modelId}`}
                                                    className="group rounded-md px-2 py-1.5 transition-colors"
                                                    style={{ background: rowBaseBg }}
                                                    onMouseEnter={(e) => { e.currentTarget.style.background = rowHoverBg; }}
                                                    onMouseLeave={(e) => { e.currentTarget.style.background = rowBaseBg; }}
                                                  >
                                                    {/* Row 1: 模型名占满行 + 异常徽章（仅非 Healthy） + hover 操作 */}
                                                    <div className="flex items-center gap-1.5">
                                                      <Box size={12} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
                                                      <span
                                                        className="text-[12px] font-medium flex-1 min-w-0 break-words"
                                                        style={{
                                                          color: modelNameColor,
                                                          textDecoration: isModelUnavailable ? 'line-through' : 'none',
                                                        }}
                                                        title={model.modelId}
                                                      >
                                                        {model.modelId}
                                                      </span>
                                                      {/* 仅非 Healthy 才显示状态徽章；Healthy 状态不出现"健康"chip 减少视觉噪声 */}
                                                      {isUnhealthy && (
                                                        <button
                                                          className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
                                                          style={{ background: status.bg, color: status.color }}
                                                          title="点击重置为健康状态"
                                                          onClick={async (e) => {
                                                            e.stopPropagation();
                                                            try {
                                                              await resetModelHealth(poolGroup.id, model.modelId);
                                                              toast.success('已重置为健康状态');
                                                              loadData();
                                                            } catch (err: any) {
                                                              toast.error(err.message || '重置失败');
                                                            }
                                                          }}
                                                        >
                                                          {status.label} ↻
                                                        </button>
                                                      )}
                                                      {/* hover 显示操作按钮 */}
                                                      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                                        <button
                                                          className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-blue-500/20"
                                                          onClick={() => {
                                                            const params = new URLSearchParams();
                                                            params.set('tab', 'llm');
                                                            if (model.platformId) params.set('provider', platformName);
                                                            if (model.modelId) params.set('model', model.modelId);
                                                            navigate(`/logs?${params.toString()}`);
                                                          }}
                                                          title="查看该模型的调用日志"
                                                        >
                                                          <Eye size={11} style={{ color: 'rgba(59, 130, 246, 0.8)' }} />
                                                        </button>
                                                        <button
                                                          className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-red-500/20"
                                                          onClick={() => handleRemoveModelFromPool(poolGroup, model.platformId, model.modelId)}
                                                          title="从模型池中移除"
                                                        >
                                                          <Trash2 size={11} style={{ color: 'rgba(239, 68, 68, 0.8)' }} />
                                                        </button>
                                                      </div>
                                                    </div>
                                                    {/* Row 2: 平台 + 统计（仅有内容时显示，省略"暂无统计"占位） */}
                                                    {hasFooter && (
                                                      <div
                                                        className="flex items-center gap-1.5 mt-0.5 ml-[18px] text-[10px] flex-wrap"
                                                        style={{ color: 'var(--text-muted)' }}
                                                      >
                                                        <span>{platformName}</span>
                                                        {stats && (
                                                          <>
                                                            <span>·</span>
                                                            <span title="近7天请求次数">{stats.requestCount.toLocaleString()}次</span>
                                                            {stats.avgDurationMs != null && (
                                                              <>
                                                                <span>·</span>
                                                                <span title="平均耗时">{stats.avgDurationMs}ms</span>
                                                              </>
                                                            )}
                                                            {stats.avgTtfbMs != null && (
                                                              <>
                                                                <span>·</span>
                                                                <span title="首字延迟(TTFB)">TTFB:{stats.avgTtfbMs}ms</span>
                                                              </>
                                                            )}
                                                            {(stats.totalInputTokens != null || stats.totalOutputTokens != null) && (
                                                              <>
                                                                <span>·</span>
                                                                <span title="输入/输出Token">
                                                                  {((stats.totalInputTokens || 0) / 1000).toFixed(1)}k/{((stats.totalOutputTokens || 0) / 1000).toFixed(1)}k
                                                                </span>
                                                              </>
                                                            )}
                                                          </>
                                                        )}
                                                      </div>
                                                    )}
                                                  </div>
                                                );
                                              })
                                            ) : (
                                              <div className="py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                                模型池中暂无模型，点击右上角"添加"配置
                                              </div>
                                            )}
                                          </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
            </GlassCard>
          )}
        </div>
      </div>


      {/* 需求编辑弹窗 */}
      {showRequirementDialog && (
        <Dialog
          open={showRequirementDialog}
          onOpenChange={(open) => {
            setShowRequirementDialog(open);
            if (!open) setEditingRequirement(null);
          }}
          title={editingRequirement ? '编辑模型需求' : '添加模型需求'}
          maxWidth={520}
          content={
            <div className="space-y-4">
              <div>
                <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                  模型类型
                </label>
                <ModelTypePicker
                  value={requirementForm.modelType}
                  onChange={(v) => setRequirementForm({ ...requirementForm, modelType: v })}
                />
              </div>

              <div>
                <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                  用途说明
                </label>
                <input
                  type="text"
                  value={requirementForm.purpose}
                  onChange={(e) => setRequirementForm({ ...requirementForm, purpose: e.target.value })}
                  placeholder="例如：用户对话、意图识别、图片生成等"
                  className="w-full h-10 px-3 rounded-[12px] outline-none text-[13px]"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div>
                <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                  绑定模型池（可选，可多选）
                </label>
                <div
                  className="rounded-[12px] p-2 max-h-[200px] overflow-auto"
                  style={{ border: '1px solid var(--border-default)', background: 'var(--bg-input)' }}
                >
                  {modelGroups.filter(g => g.modelType === requirementForm.modelType).map((group) => (
                    <label
                      key={group.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-white/5"
                    >
                      <input
                        type="checkbox"
                        checked={requirementForm.modelGroupIds.includes(group.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setRequirementForm({ ...requirementForm, modelGroupIds: [...requirementForm.modelGroupIds, group.id] });
                          } else {
                            setRequirementForm({ ...requirementForm, modelGroupIds: requirementForm.modelGroupIds.filter(id => id !== group.id) });
                          }
                        }}
                        className="h-4 w-4 rounded"
                      />
                      <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
                        {group.name} {group.code ? `(${group.code})` : ''}
                      </span>
                    </label>
                  ))}
                  {modelGroups.filter(g => g.modelType === requirementForm.modelType).length === 0 && (
                    <div className="text-[12px] py-2 text-center" style={{ color: 'var(--text-muted)' }}>
                      暂无该类型的模型池
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isRequired"
                  checked={requirementForm.isRequired}
                  onChange={(e) => setRequirementForm({ ...requirementForm, isRequired: e.target.checked })}
                  className="h-4 w-4 rounded"
                />
                <label htmlFor="isRequired" className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  必需（失败时不降级到其他类型）
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" size="sm" onClick={() => setShowRequirementDialog(false)}>
                  取消
                </Button>
                <Button variant="primary" size="sm" onClick={handleSaveRequirement}>
                  保存
                </Button>
              </div>
            </div>
          }
        />
      )}

      {/* 模型池编辑弹窗 */}
      {showGroupDialog && (
        <Dialog
          open={showGroupDialog}
          onOpenChange={_setShowGroupDialog}
          title={editingGroup ? '编辑模型池' : '新建模型池'}
          maxWidth={640}
          content={
            <div className="space-y-4">
              <div>
                <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                  模型池名称
                </label>
                <input
                  type="text"
                  value={groupForm.name}
                  onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                  placeholder="例如：主对话模型池、快速意图模型池"
                  className="w-full h-10 px-3 rounded-[12px] outline-none text-[13px]"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-default)',
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
                  value={groupForm.code}
                  onChange={(e) => setGroupForm({ ...groupForm, code: e.target.value })}
                  placeholder="例如：main-chat、fast-intent"
                  disabled={!!editingGroup}
                  className="w-full h-10 px-3 rounded-[12px] outline-none text-[13px]"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                    opacity: editingGroup ? 0.6 : 1,
                  }}
                />
              </div>

              <div>
                <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                  模型类型
                </label>
                <ModelTypePicker
                  value={groupForm.modelType}
                  onChange={(v) => setGroupForm({ ...groupForm, modelType: v })}
                  disabled={!!editingGroup}
                />
              </div>

              <div>
                <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                  描述
                </label>
                <textarea
                  value={groupForm.description}
                  onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
                  placeholder="模型池用途说明..."
                  rows={3}
                  className="w-full px-3 py-2 rounded-[12px] outline-none text-[13px] resize-none"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isDefaultForType"
                  checked={groupForm.isDefaultForType}
                  onChange={(e) => setGroupForm({ ...groupForm, isDefaultForType: e.target.checked })}
                  disabled={!!editingGroup}
                  className="h-4 w-4 rounded"
                />
                <label htmlFor="isDefaultForType" className="text-[13px]" style={{ color: 'var(--text-secondary)', opacity: editingGroup ? 0.6 : 1 }}>
                  设为该类型的默认模型池
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" size="sm" onClick={() => _setShowGroupDialog(false)}>
                  取消
                </Button>
                <Button variant="primary" size="sm" onClick={handleSaveGroup}>
                  保存
                </Button>
              </div>
            </div>
          }
        />
      )}

      {/* 系统配置弹窗 */}
      {showConfigDialog && schedulerConfig && (
        <Dialog
          open={showConfigDialog}
          onOpenChange={setShowConfigDialog}
          title="调度器系统配置"
          description="配置全局降权策略与健康检查参数"
          maxWidth={640}
          content={
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                    降权失败阈值
                  </label>
                  <input
                    type="number"
                    value={configForm.consecutiveFailuresToDegrade}
                    onChange={(e) =>
                      setConfigForm({ ...configForm, consecutiveFailuresToDegrade: parseInt(e.target.value) || 1 })
                    }
                    min={1}
                    className="w-full h-10 px-3 rounded-[12px] outline-none text-[13px]"
                    style={{
                      background: 'var(--bg-input)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>

                <div>
                  <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                    不可用失败阈值
                  </label>
                  <input
                    type="number"
                    value={configForm.consecutiveFailuresToUnavailable}
                    onChange={(e) =>
                      setConfigForm({ ...configForm, consecutiveFailuresToUnavailable: parseInt(e.target.value) || 3 })
                    }
                    min={1}
                    className="w-full h-10 px-3 rounded-[12px] outline-none text-[13px]"
                    style={{
                      background: 'var(--bg-input)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>

                <div>
                  <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                    健康检查间隔（分钟）
                  </label>
                  <input
                    type="number"
                    value={configForm.healthCheckIntervalMinutes}
                    onChange={(e) =>
                      setConfigForm({ ...configForm, healthCheckIntervalMinutes: parseInt(e.target.value) || 5 })
                    }
                    min={1}
                    className="w-full h-10 px-3 rounded-[12px] outline-none text-[13px]"
                    style={{
                      background: 'var(--bg-input)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>

                <div>
                  <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                    健康检查超时（秒）
                  </label>
                  <input
                    type="number"
                    value={configForm.healthCheckTimeoutSeconds}
                    onChange={(e) =>
                      setConfigForm({ ...configForm, healthCheckTimeoutSeconds: parseInt(e.target.value) || 10 })
                    }
                    min={1}
                    className="w-full h-10 px-3 rounded-[12px] outline-none text-[13px]"
                    style={{
                      background: 'var(--bg-input)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>

                <div>
                  <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                    恢复成功阈值
                  </label>
                  <input
                    type="number"
                    value={configForm.recoverySuccessThreshold}
                    onChange={(e) =>
                      setConfigForm({ ...configForm, recoverySuccessThreshold: parseInt(e.target.value) || 2 })
                    }
                    min={1}
                    className="w-full h-10 px-3 rounded-[12px] outline-none text-[13px]"
                    style={{
                      background: 'var(--bg-input)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>

                <div>
                  <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                    统计窗口（分钟）
                  </label>
                  <input
                    type="number"
                    value={configForm.statsWindowMinutes}
                    onChange={(e) => setConfigForm({ ...configForm, statsWindowMinutes: parseInt(e.target.value) || 60 })}
                    min={1}
                    className="w-full h-10 px-3 rounded-[12px] outline-none text-[13px]"
                    style={{
                      background: 'var(--bg-input)',
                      border: '1px solid var(--border-default)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>
              </div>

              <div>
                <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                  健康检查提示词
                </label>
                <input
                  type="text"
                  value={configForm.healthCheckPrompt}
                  onChange={(e) => setConfigForm({ ...configForm, healthCheckPrompt: e.target.value })}
                  className="w-full h-10 px-3 rounded-[12px] outline-none text-[13px]"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border-default)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="autoRecovery"
                  checked={configForm.autoRecoveryEnabled}
                  onChange={(e) => setConfigForm({ ...configForm, autoRecoveryEnabled: e.target.checked })}
                  className="h-4 w-4 rounded"
                />
                <label htmlFor="autoRecovery" className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                  启用自动恢复
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" size="sm" onClick={() => setShowConfigDialog(false)}>
                  取消
                </Button>
                <Button variant="primary" size="sm" onClick={handleSaveConfig}>
                  保存
                </Button>
              </div>
            </div>
          }
        />
      )}

      {/* 同步结果弹窗 */}
      {initResult && (
        <Dialog
          open={!!initResult}
          onOpenChange={(open) => { if (!open) setInitResult(null); }}
          title="同步完成"
          description="应用注册表已与代码定义同步"
          maxWidth={480}
          content={
            <div className="space-y-3">
              {/* 统计摘要 */}
              <div className="grid grid-cols-2 gap-2">
                {initResult.created.length > 0 && (
                  <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(34,197,94,0.08)' }}>
                    <div className="text-[18px] font-semibold" style={{ color: 'rgba(34,197,94,0.9)' }}>{initResult.created.length}</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>新增应用</div>
                  </div>
                )}
                {initResult.updated.length > 0 && (
                  <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(59,130,246,0.08)' }}>
                    <div className="text-[18px] font-semibold" style={{ color: 'rgba(59,130,246,0.9)' }}>{initResult.updated.length}</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>更新应用</div>
                  </div>
                )}
                {initResult.unchanged.length > 0 && (
                  <div className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-input)' }}>
                    <div className="text-[18px] font-semibold" style={{ color: 'var(--text-secondary)' }}>{initResult.unchanged.length}</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>无变化</div>
                  </div>
                )}
                {initResult.orphanDeleted.length > 0 && (
                  <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(251,191,36,0.08)' }}>
                    <div className="text-[18px] font-semibold" style={{ color: 'rgba(251,191,36,0.9)' }}>{initResult.orphanDeleted.length}</div>
                    <div className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>清理孤儿</div>
                  </div>
                )}
              </div>

              {/* 专属绑定保留提示 */}
              {initResult.preservedBindingsCount > 0 && (
                <div className="rounded-lg px-3 py-2 flex items-center gap-2 text-[12px]" style={{ background: 'rgba(34,197,94,0.06)', color: 'rgba(34,197,94,0.9)' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  已保留 {initResult.preservedBindingsCount} 个专属模型池绑定
                </div>
              )}

              {/* 详情折叠 — 仅在有新增/清理时显示 */}
              {(initResult.created.length > 0 || initResult.orphanDeleted.length > 0) && (
                <details className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                  <summary className="cursor-pointer select-none py-1 hover:underline">查看详情</summary>
                  <div className="mt-2 space-y-2 max-h-[40vh] overflow-auto">
                    {initResult.created.length > 0 && (
                      <div>
                        <div className="font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>新增应用</div>
                        <div className="rounded-lg p-2 space-y-0.5" style={{ background: 'var(--bg-input)' }}>
                          {initResult.created.map((code: string) => (
                            <div key={code} className="font-mono px-1.5 py-0.5">{code}</div>
                          ))}
                        </div>
                      </div>
                    )}
                    {initResult.orphanDeleted.length > 0 && (
                      <div>
                        <div className="font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>清理的孤儿应用</div>
                        <div className="rounded-lg p-2 space-y-0.5" style={{ background: 'var(--bg-input)' }}>
                          {initResult.orphanDeleted.map((code: string) => (
                            <div key={code} className="font-mono px-1.5 py-0.5">{code}</div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </details>
              )}
            </div>
          }
        />
      )}

      {/* 配置模型统一弹窗 — 五个入口共用此 dialog：
            1) 配置模型（未配置功能）
            2) 升级为模型池（LegacySingle 功能）
            3) 选择已有池（multi-bind）
            4) 管理模型池（已绑定功能）
            5) 编辑现有池模型（editPool 模式，无 Tab）
      */}
      <ModelPoolPickerDialog
        open={quickConfigOpen}
        onOpenChange={(open) => {
          setQuickConfigOpen(open);
          if (!open) setQuickConfigContext(null);
        }}
        platforms={platforms}
        selectedModels={[]}
        preselectedModels={
          quickConfigContext?.editPool
            ? (quickConfigContext.editPool.models || []).map((m) => ({
                platformId: m.platformId,
                modelId: m.modelId,
                modelName: m.modelId,
                name: m.modelId,
              }))
            : quickConfigContext?.preselected
        }
        confirmText={quickConfigContext?.editPool ? '保存' : '自动建池并绑定'}
        title={
          quickConfigContext?.editPool
            ? `编辑模型池 → ${quickConfigContext.editPool.name}`
            : quickConfigContext?.app
              ? `配置模型 → ${quickConfigContext.app.displayName || quickConfigContext.app.appCode}`
              : '配置模型'
        }
        description={
          quickConfigContext?.editPool
            ? '在下方 picker 里勾选 = 加入该池；取消勾选 = 从该池移除。其余池字段（名字/策略/优先级）不变。'
            : '新建池或选择已有池绑定到此功能。后续可在「模型池管理」修改池名/策略。'
        }
        onConfirm={handleQuickConfigConfirm}
        defaultTab={quickConfigContext?.defaultTab}
        bindingMode={quickConfigContext && !quickConfigContext.editPool && quickConfigContext.modelType ? {
          targetModelType: quickConfigContext.modelType,
          targetModelTypeLabel: getModelTypeDisplayName(quickConfigContext.modelType),
          pools: modelGroups.map((g) => ({
            id: g.id,
            name: g.name,
            code: g.code,
            modelType: g.modelType,
            priority: g.priority,
            isDefaultForType: g.isDefaultForType,
            modelsCount: g.models?.length || 0,
          })),
          defaultSelectedPoolIds: quickConfigContext.currentBoundPoolIds || [],
          onConfirmBinding: handleConfirmBinding,
        } : undefined}
      />
    </div>
  );
}
