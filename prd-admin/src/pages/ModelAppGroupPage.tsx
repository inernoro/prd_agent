import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { GlassCard } from '@/components/design/GlassCard';
import { Select } from '@/components/design/Select';
import { Dialog } from '@/components/ui/Dialog';
import { PlatformAvailableModelsDialog } from '@/components/model/PlatformAvailableModelsDialog';
import type { AvailableModel } from '@/components/model/PlatformAvailableModelsDialog';
import {
  getAppCallers,
  updateAppCaller,
  // deleteAppCaller, // 暂时未使用
  getModelGroups,
  getPlatforms,
  createModelGroup,
  updateModelGroup,
  // deleteModelGroup, // 暂时未使用
  getGroupMonitoring,
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
import type { Platform } from '@/types/admin';
import {
  Activity,
  Box,
  ChevronDown,
  ChevronRight,
  Circle,
  Eye,
  Layers,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Trash2,
  Zap,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import {
  groupAppCallers,
  getFeatureDescription,
  getModelTypeDisplayName,
  getModelTypeIcon,
  normalizeModelType,
  AppCallerKeyIcon,
} from '@/lib/appCallerUtils';
import type { AppGroup } from '@/lib/appCallerUtils';

const MODEL_TYPES = [
  { value: 'chat', label: '对话模型' },
  { value: 'intent', label: '意图识别' },
  { value: 'vision', label: '视觉理解' },
  { value: 'image-gen', label: '图像生成' },
  { value: 'code', label: '代码生成' },
  { value: 'long-context', label: '长上下文' },
  { value: 'embedding', label: '向量嵌入' },
  { value: 'rerank', label: '重排序' },
];

const MODEL_TYPE_FILTERS = [
  { value: 'all', label: '全部类型' },
  { value: 'chat', label: '对话模型' },
  { value: 'vision', label: '视觉理解' },
  { value: 'intent', label: '意图识别' },
  { value: 'image-gen', label: '图像生成' },
  { value: 'code', label: '代码生成' },
  { value: 'long-context', label: '长上下文' },
  { value: 'embedding', label: '向量嵌入' },
  { value: 'rerank', label: '重排' },
];

const HEALTH_STATUS_MAP = {
  Healthy: { label: '健康', color: 'rgba(34,197,94,0.95)', bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.28)' },
  Degraded: { label: '降权', color: 'rgba(251,191,36,0.95)', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.28)' },
  Unavailable: { label: '不可用', color: 'rgba(239,68,68,0.95)', bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.28)' },
};

export function ModelAppGroupPage({ onActionsReady }: { onActionsReady?: (actions: React.ReactNode) => void }) {
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

  // 模型池模型编辑弹窗（用于"添加模型"）
  const [groupModelsOpen, setGroupModelsOpen] = useState(false);
  const [groupModelsTarget, setGroupModelsTarget] = useState<ModelGroup | null>(null);
  const [groupModelsDraft, setGroupModelsDraft] = useState<ModelGroupItem[]>([]);
  const [availableOpen, setAvailableOpen] = useState(false);
  const [availablePlatformId, setAvailablePlatformId] = useState('');

  // 模型池绑定弹窗
  const [bindingDialogOpen, setBindingDialogOpen] = useState(false);
  const [bindingTarget, setBindingTarget] = useState<{ appId: string; modelType: string; currentIds: string[] } | null>(null);
  const [bindingSelectedIds, setBindingSelectedIds] = useState<string[]>([]);
  const [bindingShowOnlyMatching, setBindingShowOnlyMatching] = useState(true);

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

  const keyOfGroupModel = (m: Pick<ModelGroupItem, 'platformId' | 'modelId'>) =>
    `${String(m.platformId ?? '').trim()}:${String(m.modelId ?? '').trim()}`.toLowerCase();

  const openGroupModelsEditor = (group: ModelGroup) => {
    setGroupModelsTarget(group);
    // 复制一份作为草稿编辑（并按唯一键去重）
    const map = new Map<string, ModelGroupItem>();
    for (const m of group.models ?? []) {
      const k = keyOfGroupModel(m);
      if (!k || map.has(k)) continue;
      map.set(k, { ...m });
    }
    setGroupModelsDraft(Array.from(map.values()));
    setAvailablePlatformId((platforms[0]?.id ?? '').toString());
    setGroupModelsOpen(true);
  };

  const toggleDraftModel = (platformId: string, modelId: string) => {
    const pid = String(platformId ?? '').trim();
    const mid = String(modelId ?? '').trim();
    if (!pid || !mid) return;
    const k = `${pid}:${mid}`.toLowerCase();
    setGroupModelsDraft((prev) => {
      const exists = prev.some((x) => keyOfGroupModel(x) === k);
      if (exists) return prev.filter((x) => keyOfGroupModel(x) !== k);
      const maxP = prev.reduce((mx, x) => Math.max(mx, Number(x.priority ?? 0)), 0);
      return [
        ...prev,
        {
          platformId: pid,
          modelId: mid,
          priority: maxP + 1,
          healthStatus: 'Healthy' as any,
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
        } as ModelGroupItem,
      ];
    });
  };

  // 打开模型池绑定弹窗
  const openBindingDialog = (appId: string, modelType: string, currentIds: string[]) => {
    setBindingTarget({ appId, modelType, currentIds });
    setBindingSelectedIds([...currentIds]);
    setBindingShowOnlyMatching(true); // 默认只显示最佳适配
    setBindingDialogOpen(true);
  };

  // 保存模型池绑定
  const saveBindings = async () => {
    if (!bindingTarget) return;
    const { appId, modelType } = bindingTarget;

    try {
      const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
      const url = `${API_BASE}/open-platform/app-callers/${appId}/requirements/${modelType}/bindings`;

      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ modelGroupIds: bindingSelectedIds }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `HTTP ${response.status}`);
      }

      toast.success('绑定成功');
      setBindingDialogOpen(false);
      await loadData();

      // 刷新监控数据
      if (selectedAppId) {
        await loadMonitoringForApp(selectedAppId);
      }
    } catch (error) {
      toast.error('绑定失败', error instanceof Error ? error.message : String(error));
    }
  };

  // 切换模型池选择
  const toggleBindingPool = (groupId: string) => {
    setBindingSelectedIds(prev => {
      if (prev.includes(groupId)) {
        return prev.filter(id => id !== groupId);
      }
      return [...prev, groupId];
    });
  };

  const saveGroupModels = async () => {
    const g = groupModelsTarget;
    if (!g?.id) return;
    try {
      const models = [...groupModelsDraft]
        .filter((m) => String(m.platformId ?? '').trim() && String(m.modelId ?? '').trim())
        .map((m) => ({
          ...m,
          platformId: String(m.platformId ?? '').trim(),
          modelId: String(m.modelId ?? '').trim(),
          priority: Number.isFinite(Number(m.priority)) ? Number(m.priority) : 0,
          // 兜底字段（避免后端对必填字段的强校验）
          healthStatus: (m as any).healthStatus || 'Healthy',
          consecutiveFailures: Number.isFinite(Number((m as any).consecutiveFailures)) ? Number((m as any).consecutiveFailures) : 0,
          consecutiveSuccesses: Number.isFinite(Number((m as any).consecutiveSuccesses)) ? Number((m as any).consecutiveSuccesses) : 0,
        })) as ModelGroupItem[];

      const r = await updateModelGroup(g.id, { models });
      if (!r.success) throw new Error(r.error?.message || '保存失败');

      toast.success('保存成功');
      // 刷新模型池列表
      const groups = await getModelGroups();
      setModelGroups(groups);
      // 刷新当前模型池监控
      try {
        const monitoring = await getGroupMonitoring(g.id);
        setMonitoringData((prev) => ({ ...prev, [g.id]: monitoring }));
      } catch (e) {
        console.error('[GroupModels] 刷新监控失败:', e);
      }
      setGroupModelsOpen(false);
    } catch (error) {
      toast.error('保存失败', error instanceof Error ? error.message : String(error));
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
      title: '确认初始化',
      message: `此操作将：
1. 删除所有系统默认应用和子功能
2. 重新创建最新的系统默认应用
3. 保留用户自定义的应用和模型池
4. 系统默认应用的配置会被重置

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
        const { deleted, created, message } = result.data;
        const deletedCount = deleted?.length || 0;
        const createdCount = created?.length || 0;
        
        toast.success(
          '初始化成功',
          `${message || '操作完成'}\n删除 ${deletedCount} 个旧应用，创建 ${createdCount} 个新应用`
        );
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
    return byType.filter(
      (group) =>
        group.appName.toLowerCase().includes(normalizedSearch) ||
        group.app.toLowerCase().includes(normalizedSearch)
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
          <Button variant="secondary" size="sm" onClick={handleInitDefaultApps}>
            <RefreshCw size={14} />
            初始化应用
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setShowConfigDialog(true)}>
            <Settings size={14} />
            系统配置
          </Button>
          <Button variant="primary" size="sm" onClick={() => window.location.href = '/mds?tab=pools'}>
            <Plus size={14} />
            新建模型池
          </Button>
        </>
  ), [handleInitDefaultApps]);

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
        <GlassCard glow className="flex flex-col min-h-0 p-0 overflow-hidden">
          <div className="p-4 border-b border-white/10">
            <div className="flex items-center gap-2">
              <div className="w-[140px] shrink-0">
                <Select
                  value={modelTypeFilter}
                  onChange={(e) => setModelTypeFilter(e.target.value)}
                  className="h-9 rounded-[11px] text-[13px]"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  {MODEL_TYPE_FILTERS.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  placeholder="搜索应用..."
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
            </div>
          </div>

          <div className="flex-1 overflow-auto">
            {isLoading ? (
              <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
                <Loader2 size={32} className="mx-auto mb-2 opacity-40 animate-spin" />
                <div className="text-sm">加载中...</div>
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
                      className="px-3 py-3 cursor-pointer hover:bg-white/[0.02] transition-colors"
                      style={isSelected ? { background: 'rgba(255,255,255,0.06)' } : undefined}
                    >
                      <div className="flex items-center gap-3">
                        {/* 应用图标 */}
                        <div
                          className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center"
                          style={{
                            background: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'rgba(255,255,255,0.06)',
                            border: isSelected ? '1px solid rgba(59, 130, 246, 0.3)' : '1px solid rgba(255,255,255,0.08)',
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
          <GlassCard glow className="p-4 overflow-hidden">
            {isLoading ? (
              <div className="h-full flex items-center justify-center" style={{ color: 'var(--text-muted)' }}>
                <Loader2 size={20} className="animate-spin mr-2" />
                <span className="text-sm">加载中...</span>
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
            <GlassCard glow className="flex items-center justify-center overflow-hidden">
              <div className="text-center" style={{ color: 'var(--text-muted)' }}>
                <Loader2 size={48} className="mx-auto mb-4 opacity-40 animate-spin" />
                <div className="text-sm">加载中...</div>
              </div>
            </GlassCard>
          ) : !selectedAppGroup ? (
            <GlassCard glow className="flex items-center justify-center overflow-hidden">
              <div className="text-center" style={{ color: 'var(--text-muted)' }}>
                <Activity size={48} className="mx-auto mb-4 opacity-40" />
                <div className="text-sm">请选择一个应用</div>
              </div>
            </GlassCard>
          ) : (
            <GlassCard glow className="min-h-0 overflow-auto p-0">
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
                      const ModelTypeIcon = getModelTypeIcon(featureItem.parsed.modelType);
                      const modelTypeLabel = getModelTypeDisplayName(featureItem.parsed.modelType);
                      const featureDescription = getFeatureDescription(featureItem.parsed);

                      // 判断是否使用默认模型池（未绑定专属模型池）
                      const isDefaultGroup = boundGroups.length === 0;
                      
                      // 从后端解析结果获取默认模型信息
                      const resolveKey = `${app.appCode || ''}::${req?.modelType || featureItem.parsed.modelType}`;
                      const resolvedModel = isDefaultGroup ? resolvedModels[resolveKey] : null;

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

                      return (
                        <div key={idx} className="p-4">
                          {/* 功能头部 - 左侧竖线指示器 */}
                          <div className="flex items-start gap-3">
                            {/* 功能类型图标 - 未绑定专属模型池用灰色，已绑定用蓝色 */}
                            <div
                              className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center"
                              style={{
                                background: isDefaultGroup ? 'rgba(255, 255, 255, 0.05)' : 'rgba(59, 130, 246, 0.1)',
                                border: isDefaultGroup ? '1px solid rgba(255, 255, 255, 0.1)' : '1px solid rgba(59, 130, 246, 0.2)',
                              }}
                            >
                              {isDefaultGroup ? (
                                <Circle size={20} style={{ color: 'var(--text-muted)' }} />
                              ) : (
                                <ModelTypeIcon size={20} style={{ color: 'rgba(59, 130, 246, 0.9)' }} />
                              )}
                            </div>

                            {/* 功能信息 */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                                      {featureDescription}
                                    </span>
                                    <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                      <AppCallerKeyIcon size={11} className="opacity-60" />
                                      {featureItem.appCallerKey}
                                    </span>
                                  </div>
                                  <div className="mt-1">
                                    {isDefaultGroup ? (
                                      resolvedModel ? (
                                        (() => {
                                          // 使用后端返回的统计数据（基于 appCallerCode + model 组合）
                                          const defaultStats = resolvedModel.stats;
                                          const defaultStatus = HEALTH_STATUS_MAP[resolvedModel.healthStatus as keyof typeof HEALTH_STATUS_MAP] || HEALTH_STATUS_MAP.Healthy;
                                          return (
                                            <div
                                              className="group flex items-center gap-2 py-1.5 px-2 rounded-lg transition-colors"
                                              style={{ background: 'rgba(255, 255, 255, 0.02)' }}
                                              onMouseEnter={(e) => {
                                                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)';
                                              }}
                                              onMouseLeave={(e) => {
                                                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
                                              }}
                                              title={resolvedModel.source === 'legacy' ? '使用传统配置的单模型' : resolvedModel.modelGroupName ? `使用默认模型池：${resolvedModel.modelGroupName}` : '使用默认模型池'}
                                            >
                                              {/* 序号 */}
                                              <span className="text-[10px] font-medium w-5 text-center shrink-0" style={{ color: 'var(--text-muted)' }}>
                                                1
                                              </span>
                                              {/* 平台 */}
                                              <span
                                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] shrink-0"
                                                style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}
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
                                              {/* 状态 */}
                                              <span
                                                className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold shrink-0"
                                                style={{ background: defaultStatus.bg, color: defaultStatus.color }}
                                              >
                                                {defaultStatus.label}
                                              </span>
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
                                        {boundGroups.map((g) => (
                                          <span
                                            key={g.id}
                                            className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium shrink-0"
                                            style={{
                                              background: 'rgba(59, 130, 246, 0.12)',
                                              color: 'rgba(59, 130, 246, 0.95)',
                                            }}
                                          >
                                            {g.name}
                                          </span>
                                        ))}
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
                                  {/* 已绑定模型池时显示添加模型按钮 */}
                                  {boundGroups.length === 1 && (
                                    <Button
                                      variant="secondary"
                                      size="xs"
                                      onClick={() => openGroupModelsEditor(boundGroups[0])}
                                      title="添加模型到模型池"
                                    >
                                      <Plus size={12} />
                                      添加模型
                                    </Button>
                                  )}
                                  <Button
                                    variant={boundGroups.length > 0 ? 'ghost' : 'secondary'}
                                    size="xs"
                                    onClick={() => openBindingDialog(
                                      app.id,
                                      req?.modelType || featureItem.parsed.modelType,
                                      req?.modelGroupIds || []
                                    )}
                                    title={boundGroups.length > 0 ? '管理绑定的模型池' : '绑定模型池'}
                                  >
                                    <Link2 size={12} />
                                    {boundGroups.length > 0 ? '管理模型池' : '绑定模型池'}
                                  </Button>
                                </div>
                              </div>

                              {/* 模型列表 - 按模型池分组显示 */}
                              {boundGroups.length > 0 && !isCollapsed && (
                                <div className="mt-3 space-y-3">
                                  {boundGroups.map((poolGroup) => {
                                    const poolMonitoring = monitoringData[poolGroup.id];
                                    const poolModels = poolMonitoring?.models && poolMonitoring.models.length > 0
                                      ? poolMonitoring.models
                                      : (poolGroup.models || []).map(m => ({ ...m, healthScore: 100 }));

                                    return (
                                      <div
                                        key={poolGroup.id}
                                        className="pl-3 space-y-1"
                                        style={{ borderLeft: '2px solid rgba(59, 130, 246, 0.3)' }}
                                      >
                                        {/* 模型池标题 - 只在绑定多个模型池时显示 */}
                                        {boundGroups.length > 1 && (
                                          <div className="flex items-center justify-between gap-2 py-1">
                                            <div className="flex items-center gap-2">
                                              <span className="text-[11px] font-medium" style={{ color: 'rgba(59, 130, 246, 0.8)' }}>
                                                {poolGroup.name}
                                              </span>
                                              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                                {poolModels.length} 个模型
                                              </span>
                                            </div>
                                            <Button
                                              variant="ghost"
                                              size="xs"
                                              className="h-5 px-1.5 opacity-60 hover:opacity-100"
                                              onClick={() => openGroupModelsEditor(poolGroup)}
                                              title="编辑此模型池的模型"
                                            >
                                              <Plus size={10} />
                                              添加模型
                                            </Button>
                                          </div>
                                        )}
                                        {poolModels.length > 0 ? (
                                          poolModels.map((model: any, modelIdx: number) => {
                                            const status = HEALTH_STATUS_MAP[model.healthStatus as keyof typeof HEALTH_STATUS_MAP] || HEALTH_STATUS_MAP.Healthy;
                                            const platformName = getPlatformName(model.platformId);
                                            // 获取模型统计数据（按 appCallerCode + model 组合）
                                            const poolStatsKey = `${selectedApp?.appCode || ''}:${model.platformId}:${model.modelId}`.toLowerCase();
                                            const stats = poolModelStats[poolStatsKey] || null;
                                            return (
                                              <div
                                                key={`${poolGroup.id}-${model.platformId}-${model.modelId}`}
                                                className="group flex items-center gap-2 py-1.5 px-2 rounded-lg transition-colors"
                                                style={{
                                                  background: 'rgba(255, 255, 255, 0.02)',
                                                }}
                                                onMouseEnter={(e) => {
                                                  e.currentTarget.style.background = 'rgba(251, 191, 36, 0.08)';
                                                }}
                                                onMouseLeave={(e) => {
                                                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
                                                }}
                                              >
                                                {/* 序号 */}
                                                <span className="text-[10px] font-medium w-5 text-center shrink-0" style={{ color: 'var(--text-muted)' }}>
                                                  {modelIdx + 1}
                                                </span>
                                                {/* 平台 */}
                                                <span
                                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] shrink-0"
                                                  style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}
                                                >
                                                  <Server size={10} />
                                                  {platformName}
                                                </span>
                                                {/* 模型名 */}
                                                <div className="flex items-center gap-1 min-w-0 flex-1">
                                                  <Box size={12} style={{ color: 'var(--text-muted)' }} className="shrink-0" />
                                                  <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                                                    {model.modelId}
                                                  </span>
                                                </div>
                                                {/* 调用统计 */}
                                                {stats ? (
                                                  <div className="flex items-center gap-2 text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                                                    <span title="近7天请求次数">
                                                      {stats.requestCount.toLocaleString()}次
                                                    </span>
                                                    {stats.avgDurationMs != null && (
                                                      <span title="平均耗时">
                                                        {stats.avgDurationMs}ms
                                                      </span>
                                                    )}
                                                    {stats.avgTtfbMs != null && (
                                                      <span title="首字延迟(TTFB)">
                                                        TTFB:{stats.avgTtfbMs}ms
                                                      </span>
                                                    )}
                                                    {(stats.totalInputTokens != null || stats.totalOutputTokens != null) && (
                                                      <span title="输入/输出Token">
                                                        {((stats.totalInputTokens || 0) / 1000).toFixed(1)}k/{((stats.totalOutputTokens || 0) / 1000).toFixed(1)}k
                                                      </span>
                                                    )}
                                                  </div>
                                                ) : (
                                                  <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                                                    暂无统计
                                                  </span>
                                                )}
                                                {/* 状态 */}
                                                <span
                                                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold shrink-0"
                                                  style={{ background: status.bg, color: status.color }}
                                                >
                                                  {status.label}
                                                </span>
                                                {/* 操作按钮 - hover 显示 */}
                                                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                                  {/* 查看日志 */}
                                                  <button
                                                    className="h-6 w-6 inline-flex items-center justify-center rounded hover:bg-blue-500/20"
                                                    onClick={() => {
                                                      // 跳转到日志页，带上筛选参数
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
                                            );
                                          })
                                        ) : (
                                          <div className="py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                            模型池中暂无模型，点击"添加"配置
                                          </div>
                                        )}
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

      {/* 模型池模型编辑弹窗（"添加模型"） */}
      {groupModelsOpen && groupModelsTarget && (
        <Dialog
          open={groupModelsOpen}
          onOpenChange={(open) => {
            setGroupModelsOpen(open);
            if (!open) {
              setGroupModelsTarget(null);
              setGroupModelsDraft([]);
              setAvailableOpen(false);
            }
          }}
          title={`编辑模型池：${groupModelsTarget.name}`}
          description={groupModelsTarget.isSystemGroup ? '系统模型池（谨慎修改）' : groupModelsTarget.code}
          maxWidth={860}
          content={
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                  当前模型（{groupModelsDraft.length}）
                </div>
                <div className="flex items-center gap-2">
                  <Select value={availablePlatformId} onChange={(e) => setAvailablePlatformId(e.target.value)}>
                    {platforms.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      if (!availablePlatformId) {
                        toast.warning('请先选择平台');
                        return;
                      }
                      setAvailableOpen(true);
                    }}
                  >
                    从平台选择
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                {groupModelsDraft.length === 0 ? (
                  <div className="text-center py-6 text-sm" style={{ color: 'var(--text-muted)' }}>
                    暂无模型，请点击“从平台选择”添加
                  </div>
                ) : (
                  [...groupModelsDraft]
                    .sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))
                    .map((m) => (
                      <div
                        key={keyOfGroupModel(m)}
                        className="flex items-center justify-between gap-3 rounded-[12px] px-3 py-2"
                        style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.03)' }}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                            {m.modelId}
                          </div>
                          <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                            platformId: {m.platformId}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            value={Number(m.priority ?? 0)}
                            onChange={(e) => {
                              const v = parseInt(e.target.value) || 0;
                              setGroupModelsDraft((prev) =>
                                prev.map((x) => (keyOfGroupModel(x) === keyOfGroupModel(m) ? { ...x, priority: v } : x))
                              );
                            }}
                            className="h-9 w-24 px-2 rounded-[10px] outline-none text-[12px]"
                            style={{
                              background: 'var(--bg-input)',
                              border: '1px solid rgba(255,255,255,0.12)',
                              color: 'var(--text-primary)',
                            }}
                            title="优先级（越小越靠前）"
                          />
                          <Button variant="ghost" size="sm" onClick={() => toggleDraftModel(m.platformId, m.modelId)} title="移除">
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </div>
                    ))
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" size="sm" onClick={() => setGroupModelsOpen(false)}>
                  取消
                </Button>
                <Button variant="primary" size="sm" onClick={saveGroupModels}>
                  保存
                </Button>
              </div>

              <PlatformAvailableModelsDialog
                open={availableOpen}
                onOpenChange={setAvailableOpen}
                platform={platforms.find((p) => p.id === availablePlatformId) ?? null}
                description="从平台可用模型中勾选添加/移除（写入到该模型池）"
                selectedCount={groupModelsDraft.filter((x) => x.platformId === availablePlatformId).length}
                selectedCountLabel="已加入"
                selectedBadgeText="已加入"
                isSelected={(m: AvailableModel) => {
                  const pid = String(availablePlatformId ?? '').trim();
                  const mid = String(m.modelName ?? '').trim();
                  if (!pid || !mid) return false;
                  return groupModelsDraft.some((x) => keyOfGroupModel(x) === `${pid}:${mid}`.toLowerCase());
                }}
                onToggle={(m: AvailableModel) => toggleDraftModel(availablePlatformId, m.modelName)}
                onBulkAddGroup={(_groupName: string, ms: AvailableModel[]) => {
                  const pid = String(availablePlatformId ?? '').trim();
                  if (!pid) return;
                  for (const m of ms) toggleDraftModel(pid, m.modelName);
                }}
              />
            </div>
          }
        />
      )}

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
                <Select
                  value={requirementForm.modelType}
                  onChange={(e) => setRequirementForm({ ...requirementForm, modelType: e.target.value })}
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
                    border: '1px solid rgba(255,255,255,0.12)',
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
                  style={{ border: '1px solid rgba(255,255,255,0.12)', background: 'var(--bg-input)' }}
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
                  value={groupForm.code}
                  onChange={(e) => setGroupForm({ ...groupForm, code: e.target.value })}
                  placeholder="例如：main-chat、fast-intent"
                  disabled={!!editingGroup}
                  className="w-full h-10 px-3 rounded-[12px] outline-none text-[13px]"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    color: 'var(--text-primary)',
                    opacity: editingGroup ? 0.6 : 1,
                  }}
                />
              </div>

              <div>
                <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                  模型类型
                </label>
                <Select
                  value={groupForm.modelType}
                  onChange={(e) => setGroupForm({ ...groupForm, modelType: e.target.value })}
                  disabled={!!editingGroup}
                  style={{ opacity: editingGroup ? 0.6 : 1 }}
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
                    border: '1px solid rgba(255,255,255,0.12)',
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
                      border: '1px solid rgba(255,255,255,0.12)',
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
                      border: '1px solid rgba(255,255,255,0.12)',
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
                      border: '1px solid rgba(255,255,255,0.12)',
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
                      border: '1px solid rgba(255,255,255,0.12)',
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
                      border: '1px solid rgba(255,255,255,0.12)',
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
                      border: '1px solid rgba(255,255,255,0.12)',
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
                    border: '1px solid rgba(255,255,255,0.12)',
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

      {/* 模型池绑定弹窗 */}
      {bindingDialogOpen && bindingTarget && (() => {
        const targetModelTypeLabel = getModelTypeDisplayName(bindingTarget.modelType);
        const filteredGroups = bindingShowOnlyMatching
          ? modelGroups.filter(g => g.modelType === bindingTarget.modelType)
          : modelGroups;
        const matchingCount = modelGroups.filter(g => g.modelType === bindingTarget.modelType).length;

        return (
          <Dialog
            open={bindingDialogOpen}
            onOpenChange={(open) => {
              setBindingDialogOpen(open);
              if (!open) {
                setBindingTarget(null);
                setBindingSelectedIds([]);
              }
            }}
            title="绑定专属模型池"
            description={`为「${targetModelTypeLabel}」功能选择模型池（可多选）`}
            maxWidth={640}
            content={
              <div className="space-y-4">
                {/* 过滤开关 */}
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={bindingShowOnlyMatching}
                      onChange={(e) => setBindingShowOnlyMatching(e.target.checked)}
                      className="h-4 w-4 rounded"
                    />
                    <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                      只显示最佳适配（{targetModelTypeLabel}）
                    </span>
                  </label>
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    共 {filteredGroups.length} 个模型池
                  </span>
                </div>

                <div
                  className="rounded-[12px] p-3 min-h-[200px] max-h-[400px] overflow-auto"
                  style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)' }}
                >
                  {filteredGroups.length === 0 ? (
                    <div className="py-12 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      {bindingShowOnlyMatching
                        ? `暂无「${targetModelTypeLabel}」类型的模型池`
                        : '暂无可用模型池'}
                      <div className="mt-2 text-[11px]">
                        {bindingShowOnlyMatching && matchingCount === 0 && (
                          <span>取消勾选上方选项可查看全部模型池</span>
                        )}
                      </div>
                      <div className="mt-4">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => window.location.href = '/mds?tab=pools'}
                        >
                          <Plus size={12} />
                          新建模型池
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {filteredGroups
                        .sort((a, b) => {
                          // 最佳适配的排在前面
                          const aMatch = a.modelType === bindingTarget.modelType;
                          const bMatch = b.modelType === bindingTarget.modelType;
                          if (aMatch !== bMatch) return aMatch ? -1 : 1;
                          return (a.priority ?? 50) - (b.priority ?? 50);
                        })
                        .map((g) => {
                          const isSelected = bindingSelectedIds.includes(g.id);
                          const isMatching = g.modelType === bindingTarget.modelType;
                          const groupTypeLabel = getModelTypeDisplayName(g.modelType);

                          return (
                            <div
                              key={g.id}
                              onClick={() => toggleBindingPool(g.id)}
                              className="flex items-center justify-between gap-3 px-3 py-3 rounded-lg cursor-pointer transition-colors"
                              style={{
                                background: isSelected
                                  ? 'rgba(59, 130, 246, 0.12)'
                                  : isMatching
                                    ? 'rgba(34, 197, 94, 0.06)'
                                    : 'rgba(255,255,255,0.04)',
                                border: isSelected
                                  ? '1px solid rgba(59, 130, 246, 0.4)'
                                  : isMatching
                                    ? '1px solid rgba(34, 197, 94, 0.2)'
                                    : '1px solid transparent',
                              }}
                            >
                              <div className="flex items-center gap-3 min-w-0 flex-1">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleBindingPool(g.id)}
                                  className="h-4 w-4 rounded"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                                      {g.name}
                                    </span>
                                    {isMatching && (
                                      <span
                                        className="px-1.5 py-0.5 rounded text-[10px] shrink-0"
                                        style={{ background: 'rgba(34,197,94,0.12)', color: 'rgba(34,197,94,0.95)' }}
                                      >
                                        最佳适配
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                                    类型: {groupTypeLabel} | Code: {g.code || '-'} | 优先级: {g.priority ?? 50} | 模型数: {g.models?.length || 0}
                                  </div>
                                </div>
                              </div>
                              {g.isDefaultForType && (
                                <span className="px-2 py-0.5 rounded text-[10px] shrink-0" style={{ background: 'rgba(251,191,36,0.12)', color: 'rgba(251,191,36,0.95)' }}>
                                  默认
                                </span>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>

                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  已选择 {bindingSelectedIds.length} 个模型池
                  {bindingSelectedIds.length > 1 && '（多个模型池时将按优先级选择）'}
                  {!bindingShowOnlyMatching && bindingSelectedIds.some(id =>
                    modelGroups.find(g => g.id === id)?.modelType !== bindingTarget.modelType
                  ) && (
                    <span style={{ color: 'rgba(251,191,36,0.95)' }}>
                      {' '}· 包含非最佳适配类型
                    </span>
                  )}
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="secondary" size="sm" onClick={() => setBindingDialogOpen(false)}>
                    取消
                  </Button>
                  <Button variant="primary" size="sm" onClick={saveBindings}>
                    确认绑定
                  </Button>
                </div>
              </div>
            }
          />
        );
      })()}
    </div>
  );
}
