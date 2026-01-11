import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Select } from '@/components/design/Select';
import { PageHeader } from '@/components/design/PageHeader';
import { Dialog } from '@/components/ui/Dialog';
import { Tooltip } from '@/components/ui/Tooltip';
import {
  getAppCallers,
  updateAppCaller,
  // deleteAppCaller, // 暂时未使用
  getModelGroups,
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
import { useEffect, useState } from 'react';
import { systemDialog } from '@/lib/systemDialog';
import { toast } from '@/lib/toast';
import { groupAppCallers, getFeatureDescription, getModelTypeDisplayName, getModelTypeIcon } from '@/lib/appCallerUtils';
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

const HEALTH_STATUS_MAP = {
  Healthy: { label: '健康', color: 'rgba(34,197,94,0.95)', bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.28)' },
  Degraded: { label: '降权', color: 'rgba(251,191,36,0.95)', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.28)' },
  Unavailable: { label: '不可用', color: 'rgba(239,68,68,0.95)', bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.28)' },
};

export function ModelAppGroupPage() {
  const token = useAuthStore((s) => s.token);
  const [appCallers, setAppCallers] = useState<LLMAppCaller[]>([]);
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  
  // 树形结构状态
  const [, setAppGroups] = useState<AppGroup[]>([]);
  const [expandedApps, setExpandedApps] = useState<Set<string>>(new Set());

  // 弹窗状态
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [showRequirementDialog, setShowRequirementDialog] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ModelGroup | null>(null);
  const [editingRequirement] = useState<AppModelRequirement | null>(null); // 暂时未使用

  // 监控数据
  const [monitoringData, setMonitoringData] = useState<Record<string, ModelGroupMonitoringData>>({});
  const [schedulerConfig, setSchedulerConfig] = useState<ModelSchedulerConfig | null>(null);

  // 表单状态
  const [groupForm, setGroupForm] = useState({
    name: '',
    code: '',
    description: '',
    models: [] as ModelGroupItem[],
  });

  const [requirementForm, setRequirementForm] = useState({
    modelType: 'chat',
    purpose: '',
    modelGroupId: '',
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

  const loadData = async () => {
    try {
      const [apps, groups, config] = await Promise.all([
        getAppCallers(),
        getModelGroups(),
        getSchedulerConfig(),
      ]);
      setAppCallers(apps);
      setModelGroups(groups);
      setSchedulerConfig(config);
      
      // 分组应用
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

  const loadMonitoringForApp = async (appId: string) => {
    const app = appCallers.find((a) => a.id === appId);
    if (!app) return;

    const groupIds = app.modelRequirements
      .map((r: AppModelRequirement) => r.modelGroupId)
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

  const handleInitDefaultApps = async () => {
    const confirmed = await systemDialog.confirm({
      title: '确认初始化',
      message: `此操作将：
1. 删除所有系统默认应用和子功能
2. 重新创建最新的系统默认应用
3. 保留用户自定义的应用和分组
4. 系统默认应用的配置会被重置

确定继续？`,
    });
    if (!confirmed) return;

    try {
      if (!token) {
        throw new Error('未登录，请重新登录');
      }

      const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api/v1';
      const url = `${API_BASE}/admin/init/default-apps`;

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
  };

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
      modelGroupId: requirementForm.modelGroupId || undefined,
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

  const handleAddGroup = () => {
    setEditingGroup(null);
    setGroupForm({
      name: '',
      code: '',
      description: '',
      models: [],
    });
    setShowGroupDialog(true);
  };

  /* 暂时未使用，保留用于未来功能
  const handleEditGroup = (group: ModelGroup) => {
    setEditingGroup(group);
    setGroupForm({
      name: group.name,
      code: group.code,
      description: group.description ?? '',
      models: group.models,
    });
    setShowGroupDialog(true);
  };
  */

  const handleSaveGroup = async () => {
    if (!groupForm.name.trim() || !groupForm.code.trim()) {
      systemDialog.error('验证失败', '名称和代码不能为空');
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
          description: groupForm.description,
          models: groupForm.models,
        });
      }
      systemDialog.success('保存成功');
      await loadData();
      setShowGroupDialog(false);
    } catch (error) {
      systemDialog.error('保存失败', String(error));
    }
  };

  /* 暂时未使用，保留用于未来功能
  const handleDeleteGroup = async (groupId: string) => {
    const confirmed = await systemDialog.confirm({ title: '确认删除', message: '删除分组后无法恢复，确定继续？' });
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

  // 按应用分组
  const groupedApps = groupAppCallers(appCallers);
  
  // 过滤应用组
  const filteredAppGroups = searchTerm
    ? groupedApps.filter(g => 
        g.appName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        g.app.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : groupedApps;
  
  // 当前选中的应用组
  const selectedAppGroup = selectedAppId 
    ? groupedApps.find(g => g.features.some(f => f.items.some(i => i.id === selectedAppId)))
    : null;
  
  // 获取选中应用的所有功能项（扁平化）
  const selectedAppFeatures = selectedAppGroup 
    ? selectedAppGroup.features.flatMap(f => f.items)
    : [];

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <PageHeader
        title="应用与分组管理"
        subtitle="应用身份识别、模型分组配置与智能降权监控"
        actions={
          <>
            <Button variant="secondary" size="xs" onClick={handleInitDefaultApps}>
              <RefreshCw size={14} />
              初始化应用
            </Button>
            <Button variant="secondary" size="xs" onClick={() => setShowConfigDialog(true)}>
              <Settings size={14} />
              系统配置
            </Button>
            <Button variant="primary" size="xs" onClick={handleAddGroup}>
              <Plus size={14} />
              新建分组
            </Button>
          </>
        }
      />

      <div className="grid gap-4 flex-1 min-h-0 transition-all lg:grid-cols-[320px_1fr]">
        {/* 左侧：应用列表 */}
        <Card className="flex flex-col min-h-0 p-0 overflow-hidden">
          <div className="p-4 border-b border-white/10">
            <div className="relative">
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

        {/* 右侧：功能分组与模型配置 */}
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

              {/* 功能分组列表 */}
              <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-auto">
                <h4 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  功能与模型配置
                </h4>

                {selectedAppFeatures.length === 0 ? (
                  <Card className="flex-1 flex items-center justify-center">
                    <div className="text-center" style={{ color: 'var(--text-muted)' }}>
                      <Zap size={48} className="mx-auto mb-4 opacity-40" />
                      <div className="text-sm">暂无功能配置</div>
                    </div>
                  </Card>
                ) : (
                  <div className="space-y-4">
                    {selectedAppFeatures.map((featureItem, idx: number) => {
                      const app = appCallers.find(a => a.id === featureItem.id);
                      if (!app) return null;
                      
                      const req = app.modelRequirements[0]; // 每个功能项只有一个需求
                      const group = req?.modelGroupId ? modelGroups.find((g) => g.id === req.modelGroupId) : undefined;
                      const monitoring = req?.modelGroupId ? monitoringData[req.modelGroupId] : undefined;
                      const modelTypeIcon = getModelTypeIcon(featureItem.parsed.modelType);
                      const modelTypeLabel = getModelTypeDisplayName(featureItem.parsed.modelType);
                      const featureDescription = getFeatureDescription(featureItem.parsed);
                      const successRate = featureItem.stats.totalCalls > 0 
                        ? ((featureItem.stats.successCalls / featureItem.stats.totalCalls) * 100).toFixed(1) 
                        : '0';
                      
                      // 判断是否使用默认分组
                      const isDefaultGroup = !group;
                      const groupLabel = isDefaultGroup 
                        ? `默认${modelTypeLabel}` 
                        : `专属${modelTypeLabel}`;

                      return (
                        <Card key={idx} className="p-0 overflow-hidden">
                          {/* 功能头部 */}
                          <div className="p-4 border-b border-white/10 flex items-center justify-between">
                            <div className="flex items-center gap-3 flex-1 min-w-0">
                              <span className="text-[14px]">{modelTypeIcon}</span>
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
                                    title={isDefaultGroup ? '使用默认分组' : `使用专属分组：${group?.name}`}
                                  >
                                    {groupLabel}
                                  </button>
                                </div>
                              </div>
                              {featureItem.stats.totalCalls > 0 && (
                                <div className="ml-auto flex items-center gap-3 text-[11px]">
                                  <span style={{ color: 'var(--text-secondary)' }}>
                                    {featureItem.stats.totalCalls}次
                                  </span>
                                  <span style={{ color: parseFloat(successRate) >= 95 ? 'rgba(34,197,94,0.95)' : 'rgba(251,191,36,0.95)' }}>
                                    {successRate}%
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* 模型配置 */}
                          <div className="p-4">
                            <div className="flex items-center justify-between mb-3">
                              <div className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                                已配置模型
                              </div>
                              <Button variant="secondary" size="xs">
                                <Plus size={12} />
                                添加模型
                              </Button>
                            </div>

                            {!group ? (
                              <div className="text-center py-4" style={{ color: 'var(--text-muted)' }}>
                                <div className="text-[12px]">未绑定分组，将使用默认分组</div>
                              </div>
                            ) : (
                              <div>
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
                                    <div className="text-[12px]">分组中暂无模型</div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 需求编辑弹窗 */}
      {showRequirementDialog && (
        <Dialog
          open={showRequirementDialog}
          onOpenChange={setShowRequirementDialog}
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
                  绑定分组（可选）
                </label>
                <Select
                  value={requirementForm.modelGroupId}
                  onChange={(e) => setRequirementForm({ ...requirementForm, modelGroupId: e.target.value })}
                >
                  <option value="">使用默认分组</option>
                  {modelGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </Select>
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

      {/* 分组编辑弹窗 */}
      {showGroupDialog && (
        <Dialog
          open={showGroupDialog}
          onOpenChange={setShowGroupDialog}
          title={editingGroup ? '编辑模型分组' : '新建模型分组'}
          maxWidth={640}
          content={
            <div className="space-y-4">
              <div>
                <label className="block text-[12px] font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                  分组名称
                </label>
                <input
                  type="text"
                  value={groupForm.name}
                  onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                  placeholder="例如：主对话分组、快速意图分组"
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
                  分组代码
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
                  描述
                </label>
                <textarea
                  value={groupForm.description}
                  onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
                  placeholder="分组用途说明..."
                  rows={3}
                  className="w-full px-3 py-2 rounded-[12px] outline-none text-[13px] resize-none"
                  style={{
                    background: 'var(--bg-input)',
                    border: '1px solid rgba(255,255,255,0.12)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="secondary" size="sm" onClick={() => setShowGroupDialog(false)}>
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
    </div>
  );
}
