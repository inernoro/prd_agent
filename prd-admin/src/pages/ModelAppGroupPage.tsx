import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Select } from '@/components/design/Select';
import { Dialog } from '@/components/ui/Dialog';
import { Tooltip } from '@/components/ui/Tooltip';
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
} from '@/services';
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
  ChevronRight,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import {
  groupAppCallers,
  getFeatureDescription,
  getModelTypeDisplayName,
  getModelTypeIcon,
  normalizeModelType,
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
  const [appCallers, setAppCallers] = useState<LLMAppCaller[]>([]);
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [modelTypeFilter, setModelTypeFilter] = useState('all');
  
  // 树形结构状态
  const [, setAppGroups] = useState<AppGroup[]>([]);
  const [expandedApps, setExpandedApps] = useState<Set<string>>(new Set());

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

  useEffect(() => {
    if (selectedAppId) {
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
        if (ps.success) setPlatforms(ps.data || []);
        else setPlatforms([]);
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
      if (apps.length > 0 && !selectedAppId) {
        setSelectedAppId(apps[0].id);
      }
    } catch (error) {
      systemDialog.error('加载失败', String(error));
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
      systemDialog.error('绑定失败', error instanceof Error ? error.message : String(error));
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

      systemDialog.success('保存成功');
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
      systemDialog.error('保存失败', error instanceof Error ? error.message : String(error));
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

      const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
      const url = `${API_BASE}/settings/init/default-apps`;

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
      systemDialog.success('保存成功');
      await loadData();
      setShowRequirementDialog(false);
      setEditingRequirement(null);
    } catch (error) {
      systemDialog.error('保存失败', String(error));
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
      systemDialog.error('验证失败', '模型池名称不能为空');
      return;
    }
    if (!editingGroup && !groupForm.code.trim()) {
      systemDialog.error('验证失败', '模型池代码不能为空');
      return;
    }
    if (!groupForm.modelType.trim()) {
      systemDialog.error('验证失败', '模型类型不能为空');
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
      systemDialog.success('保存成功');
      await loadData();
      _setShowGroupDialog(false);
    } catch (error) {
      systemDialog.error('保存失败', String(error));
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
      systemDialog.success('保存成功');
      await loadData();
      setShowConfigDialog(false);
    } catch (error) {
      systemDialog.error('保存失败', String(error));
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

      <div className="grid gap-4 flex-1 min-h-0 transition-all lg:grid-cols-[320px_1fr]">
        {/* 左侧：应用列表 */}
        <Card className="flex flex-col min-h-0 p-0 overflow-hidden">
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
            {filteredAppGroups.length === 0 ? (
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
                  
                  // 计算应用组的统计数据
                  const totalCalls = appGroup.features.reduce((sum, f) => 
                    sum + f.items.reduce((s, i) => s + i.stats.totalCalls, 0), 0
                  );
                  const successCalls = appGroup.features.reduce((sum, f) => 
                    sum + f.items.reduce((s, i) => s + i.stats.successCalls, 0), 0
                  );
                  const successRate = totalCalls > 0 ? ((successCalls / totalCalls) * 100).toFixed(1) : '0';
                  
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
                      className="px-4 py-3 cursor-pointer hover:bg-white/[0.02] transition-colors"
                      style={isSelected ? { background: 'rgba(255,255,255,0.06)' } : undefined}
                    >
                      <div className="flex items-start justify-between gap-2">
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
                          {totalCalls > 0 && (
                            <div className="mt-2 flex items-center gap-3 text-[11px]">
                              <span style={{ color: 'var(--text-secondary)' }}>
                                调用 {totalCalls.toLocaleString()}
                              </span>
                              <span style={{ color: parseFloat(successRate) >= 95 ? 'rgba(34,197,94,0.95)' : 'rgba(251,191,36,0.95)' }}>
                                成功率 {successRate}%
                              </span>
                            </div>
                          )}
                        </div>
                        {isSelected && <ChevronRight size={16} style={{ color: 'var(--text-muted)' }} />}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>

        {/* 右侧：功能与模型池配置 */}
        <div className="flex flex-col gap-4 min-h-0">
          {!selectedAppGroup ? (
            <Card className="flex-1 flex items-center justify-center">
              <div className="text-center" style={{ color: 'var(--text-muted)' }}>
                <Activity size={48} className="mx-auto mb-4 opacity-40" />
                <div className="text-sm">请选择一个应用</div>
              </div>
            </Card>
          ) : (
            <>
              {/* 应用信息卡片 */}
              <Card className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {selectedAppGroup.appName}
                      </h3>
                      <Badge variant="subtle" size="sm">
                        {selectedAppFeatures.length} 个功能
                      </Badge>
                    </div>
                    <div className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                      {selectedAppGroup.app}
                    </div>
                    <div className="mt-3 flex items-center gap-4 text-[12px]">
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
                </div>
              </Card>

              {/* 功能列表 */}
              <Card className="flex-1 min-h-0 p-4 overflow-auto">
                <h4 className="text-[14px] font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
                  功能与模型配置
                </h4>

                {selectedAppFeatures.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center py-12">
                    <div className="text-center" style={{ color: 'var(--text-muted)' }}>
                      <Zap size={48} className="mx-auto mb-4 opacity-40" />
                      <div className="text-sm">暂无功能配置</div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {selectedAppFeatures.map((featureItem, idx: number) => {
                      const app = appCallers.find(a => a.id === featureItem.id);
                      if (!app) return null;
                      
                      const req = app.modelRequirements[0]; // 每个功能项只有一个需求
                      const boundGroupIds = req?.modelGroupIds || [];
                      const group = boundGroupIds.length > 0 ? modelGroups.find((g) => boundGroupIds.includes(g.id)) : undefined;
                      const monitoring = boundGroupIds.length > 0 ? monitoringData[boundGroupIds[0]] : undefined;
                      const ModelTypeIcon = getModelTypeIcon(featureItem.parsed.modelType);
                      const modelTypeLabel = getModelTypeDisplayName(featureItem.parsed.modelType);
                      const featureDescription = getFeatureDescription(featureItem.parsed);
                      const successRate = featureItem.stats.totalCalls > 0 
                        ? ((featureItem.stats.successCalls / featureItem.stats.totalCalls) * 100).toFixed(1) 
                        : '0';
                      
                      // 判断是否使用默认模型池
                      const isDefaultGroup = !group;
                      const groupLabel = isDefaultGroup 
                        ? `默认${modelTypeLabel}` 
                        : `专属${modelTypeLabel}`;

                      return (
                        <Card key={idx} className="p-0 overflow-hidden">
                          {/* 功能头部 */}
                          <div className="p-4 border-b border-white/10 flex items-center justify-between">
                            <div className="flex items-center gap-3 flex-1 min-w-0">
                              <span className="shrink-0" style={{ color: 'var(--text-secondary)' }} title={modelTypeLabel}>
                                <ModelTypeIcon size={16} />
                              </span>
                              <div className="flex-1 min-w-0">
                                <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                                  {featureDescription}
                                </div>
                                <div className="mt-0.5 flex items-center gap-2">
                                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                    模型：{featureItem.appCallerKey}
                                  </span>
                                  <button
                                    className="inline-flex items-center gap-1 rounded-full px-2.5 h-5 text-[11px] font-semibold tracking-wide shrink-0 hover:opacity-80 transition-opacity"
                                    style={{
                                      background: isDefaultGroup ? 'rgba(34, 197, 94, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                                      border: isDefaultGroup ? '1px solid rgba(34, 197, 94, 0.28)' : '1px solid rgba(59, 130, 246, 0.28)',
                                      color: isDefaultGroup ? 'rgba(34, 197, 94, 0.95)' : 'rgba(59, 130, 246, 0.95)',
                                    }}
                                    title={isDefaultGroup ? '使用默认模型池' : `使用专属模型池：${group?.name}`}
                                  >
                                    {groupLabel}
                                  </button>
                                </div>
                              </div>
                              {featureItem.stats.totalCalls > 0 && (
                                <div className="flex items-center gap-3 text-[11px]">
                                  <span style={{ color: 'var(--text-secondary)' }}>
                                    {featureItem.stats.totalCalls}次
                                  </span>
                                  <span style={{ color: parseFloat(successRate) >= 95 ? 'rgba(34,197,94,0.95)' : 'rgba(251,191,36,0.95)' }}>
                                    {successRate}%
                                  </span>
                                </div>
                              )}
                              {/* 添加模型按钮 - 始终显示 */}
                              <Button
                                variant="secondary"
                                size="xs"
                                className="ml-2 shrink-0"
                                onClick={() => {
                                  if (group) {
                                    // 已绑定专属模型池：直接打开模型编辑器
                                    openGroupModelsEditor(group);
                                  } else {
                                    // 未绑定模型池：打开绑定对话框
                                    openBindingDialog(
                                      app.id,
                                      req?.modelType || featureItem.parsed.modelType,
                                      req?.modelGroupIds || []
                                    );
                                  }
                                }}
                              >
                                <Plus size={12} />
                                {group ? '添加模型' : '绑定模型池'}
                              </Button>
                            </div>
                          </div>

                          {/* 模型配置 - 仅绑定专属模型池时显示 */}
                          {group && (
                            <div className="p-4">
                              <div className="mb-3">
                                <div className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                                  已配置模型
                                </div>
                              </div>

                              {/* 模型负载列表 */}
                              {monitoring && monitoring.models.length > 0 ? (
                                <div className="space-y-2">
                                  {monitoring.models.map((model: any, modelIdx: number) => {
                                    const status = HEALTH_STATUS_MAP[model.healthStatus as keyof typeof HEALTH_STATUS_MAP];
                                    return (
                                      <div
                                        key={`${model.platformId}-${model.modelId}`}
                                        className="rounded-[12px] p-3 border border-white/10"
                                        style={{ background: 'rgba(255,255,255,0.03)' }}
                                      >
                                        <div className="flex items-start justify-between gap-3">
                                          <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                              <span className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                                                #{modelIdx + 1}
                                              </span>
                                              <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                                                {model.modelId}
                                              </div>
                                              <span
                                                className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold"
                                                style={{ background: status.bg, border: `1px solid ${status.border}`, color: status.color }}
                                              >
                                                {status.label}
                                              </span>
                                            </div>
                                            <div className="mt-2 flex items-center gap-4 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                              <span>平台: <span style={{ color: 'var(--text-secondary)' }}>{model.platformId}</span></span>
                                              <span>优先级: <span style={{ color: 'var(--text-secondary)' }}>{model.priority}</span></span>
                                              <span>连续失败: <span style={{ color: model.consecutiveFailures > 0 ? 'rgba(239,68,68,0.95)' : 'var(--text-secondary)' }}>{model.consecutiveFailures}</span></span>
                                              <span>健康分: <span style={{ color: 'var(--text-secondary)' }}>{model.healthScore.toFixed(0)}</span></span>
                                            </div>
                                          </div>
                                          <div className="flex items-center gap-1">
                                            <Tooltip content="编辑">
                                              <button
                                                className="h-8 w-8 inline-flex items-center justify-center rounded-[10px] hover:bg-white/5"
                                              >
                                                <Pencil size={14} style={{ color: 'var(--text-muted)' }} />
                                              </button>
                                            </Tooltip>
                                            <Tooltip content="删除">
                                              <button
                                                className="h-8 w-8 inline-flex items-center justify-center rounded-[10px] hover:bg-white/5"
                                              >
                                                <Trash2 size={14} style={{ color: 'var(--text-muted)' }} />
                                              </button>
                                            </Tooltip>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div className="text-center py-4" style={{ color: 'var(--text-muted)' }}>
                                  <div className="text-[12px]">模型池中暂无模型</div>
                                </div>
                              )}
                            </div>
                          )}
                        </Card>
                      );
                    })}
                  </div>
                )}
              </Card>
            </>
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
                        void systemDialog.alert('请先选择平台');
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
      {bindingDialogOpen && bindingTarget && (
        <Dialog
          open={bindingDialogOpen}
          onOpenChange={(open) => {
            setBindingDialogOpen(open);
            if (!open) {
              setBindingTarget(null);
              setBindingSelectedIds([]);
            }
          }}
          title="绑定模型池"
          description="选择要绑定的模型池（可多选）"
          maxWidth={640}
          content={
            <div className="space-y-4">
              <div className="text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                可用模型池（{modelGroups.filter(g => g.modelType === bindingTarget.modelType).length}）
              </div>

              <div
                className="rounded-[12px] p-3 min-h-[200px] max-h-[400px] overflow-auto"
                style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)' }}
              >
                {modelGroups.filter(g => g.modelType === bindingTarget.modelType).length === 0 ? (
                  <div className="py-12 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    暂无可用模型池，请先在"模型池管理"中创建
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
                    {modelGroups
                      .filter(g => g.modelType === bindingTarget.modelType)
                      .sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50))
                      .map((g) => {
                        const isSelected = bindingSelectedIds.includes(g.id);
                        return (
                          <div
                            key={g.id}
                            onClick={() => toggleBindingPool(g.id)}
                            className="flex items-center justify-between gap-3 px-3 py-3 rounded-lg cursor-pointer transition-colors"
                            style={{
                              background: isSelected ? 'rgba(59, 130, 246, 0.12)' : 'rgba(255,255,255,0.04)',
                              border: isSelected ? '1px solid rgba(59, 130, 246, 0.4)' : '1px solid transparent',
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
                                <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                                  {g.name}
                                </div>
                                <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                                  Code: {g.code || '-'} | 优先级: {g.priority ?? 50} | 模型数: {g.models?.length || 0}
                                </div>
                              </div>
                            </div>
                            {g.isDefaultForType && (
                              <span className="px-2 py-0.5 rounded text-[10px]" style={{ background: 'rgba(34,197,94,0.12)', color: 'rgba(34,197,94,0.95)' }}>
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
                {bindingSelectedIds.length > 1 && '（多个模型池时将随机选择）'}
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
      )}
    </div>
  );
}
