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
  deleteAppCaller,
  scanAppCallers,
  getModelGroups,
  createModelGroup,
  updateModelGroup,
  // deleteModelGroup, // 暂时未使用
  getGroupMonitoring,
  simulateDowngrade,
  simulateRecover,
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
  Search,
  Settings,
  Trash2,
  TrendingDown,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { systemDialog } from '@/lib/systemDialog';

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

  // 弹窗状态
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [showRequirementDialog, setShowRequirementDialog] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ModelGroup | null>(null);
  const [editingRequirement, setEditingRequirement] = useState<AppModelRequirement | null>(null);

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

  const handleScanAppCallers = async () => {
    try {
      await scanAppCallers();
      systemDialog.success('扫描完成', '已自动注册新应用');
      await loadData();
    } catch (error) {
      systemDialog.error('扫描失败', String(error));
    }
  };

  const handleInitDefaultApps = async () => {
    const confirmed = await systemDialog.confirm({
      title: '初始化/同步应用',
      message: '此操作将创建/更新默认应用，已有配置不会被覆盖。确定继续？',
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
        const { created, updated, skipped, message } = result.data;
        const createdCount = created?.length || 0;
        const updatedCount = updated?.length || 0;
        const skippedCount = skipped?.length || 0;
        
        systemDialog.success(
          '初始化成功',
          `${message || '操作完成'}\n\n创建：${createdCount} 个\n更新：${updatedCount} 个\n跳过：${skippedCount} 个`
        );
        await loadData();
      } else {
        throw new Error(result.error?.message || '初始化失败');
      }
    } catch (error) {
      console.error('[InitDefaultApps] 异常:', error);
      systemDialog.error('初始化失败', error instanceof Error ? error.message : String(error));
    }
  };

  const handleDeleteApp = async (appId: string) => {
    const confirmed = await systemDialog.confirm({ title: '确认删除', message: '删除应用后无法恢复，确定继续？' });
    if (!confirmed) return;

    try {
      await deleteAppCaller(appId);
      systemDialog.success('删除成功');
      await loadData();
      if (selectedAppId === appId) {
        setSelectedAppId(appCallers[0]?.id ?? null);
      }
    } catch (error) {
      systemDialog.error('删除失败', String(error));
    }
  };

  const handleAddRequirement = () => {
    setEditingRequirement(null);
    setRequirementForm({
      modelType: 'chat',
      purpose: '',
      modelGroupId: '',
      isRequired: true,
    });
    setShowRequirementDialog(true);
  };

  const handleEditRequirement = (req: AppModelRequirement) => {
    setEditingRequirement(req);
    setRequirementForm({
      modelType: req.modelType,
      purpose: req.purpose,
      modelGroupId: req.modelGroupId ?? '',
      isRequired: req.isRequired,
    });
    setShowRequirementDialog(true);
  };

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

  const handleDeleteRequirement = async (req: AppModelRequirement) => {
    if (!selectedApp) return;

    const confirmed = await systemDialog.confirm({ title: '确认删除', message: '删除需求后将使用默认模型，确定继续？' });
    if (!confirmed) return;

    const updatedReqs = selectedApp.modelRequirements.filter(
      (r: AppModelRequirement) => !(r.modelType === req.modelType && r.purpose === req.purpose)
    );

    try {
      await updateAppCaller(selectedApp.id, {
        displayName: selectedApp.displayName,
        description: selectedApp.description,
        modelRequirements: updatedReqs,
      });
      systemDialog.success('删除成功');
      await loadData();
    } catch (error) {
      systemDialog.error('删除失败', String(error));
    }
  };

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

  const handleSimulateDowngrade = async (groupId: string, modelId: string, platformId: string) => {
    try {
      await simulateDowngrade(groupId, modelId, platformId, 5);
      systemDialog.success('模拟降权成功');
      await loadMonitoringForApp(selectedAppId!);
    } catch (error) {
      systemDialog.error('模拟失败', String(error));
    }
  };

  const handleSimulateRecover = async (groupId: string, modelId: string, platformId: string) => {
    try {
      await simulateRecover(groupId, modelId, platformId, 3);
      systemDialog.success('模拟恢复成功');
      await loadMonitoringForApp(selectedAppId!);
    } catch (error) {
      systemDialog.error('模拟失败', String(error));
    }
  };

  const filteredApps = appCallers.filter(
    (app) =>
      app.appCode.toLowerCase().includes(searchTerm.toLowerCase()) ||
      app.displayName.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <PageHeader
        title="应用与分组管理"
        subtitle="应用身份识别、模型分组配置与智能降权监控"
        actions={
          <>
            {appCallers.length === 0 && (
              <Button variant="secondary" size="xs" onClick={handleInitDefaultApps}>
                <Plus size={14} />
                初始化默认应用
              </Button>
            )}
            <Button variant="secondary" size="xs" onClick={handleScanAppCallers}>
              <Search size={14} />
              全局扫描
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
            {filteredApps.length === 0 ? (
              <div className="p-8 text-center" style={{ color: 'var(--text-muted)' }}>
                <Activity size={32} className="mx-auto mb-2 opacity-40" />
                <div className="text-sm">暂无应用</div>
              </div>
            ) : (
              <div className="divide-y divide-white/10">
                {filteredApps.map((app) => {
                  const isSelected = app.id === selectedAppId;
                  const successRate = app.totalCalls > 0 ? ((app.successCalls / app.totalCalls) * 100).toFixed(1) : '0';
                  return (
                    <div
                      key={app.id}
                      onClick={() => setSelectedAppId(app.id)}
                      className="px-4 py-3 cursor-pointer hover:bg-white/[0.02] transition-colors"
                      style={isSelected ? { background: 'rgba(255,255,255,0.06)' } : undefined}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                              {app.displayName}
                            </div>
                            {app.isAutoRegistered && (
                              <Badge variant="subtle" size="sm">
                                自动
                              </Badge>
                            )}
                          </div>
                          <div className="mt-0.5 text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                            {app.appCode}
                          </div>
                          <div className="mt-2 flex items-center gap-3 text-[11px]">
                            <span style={{ color: 'var(--text-secondary)' }}>
                              调用 {app.totalCalls.toLocaleString()}
                            </span>
                            <span style={{ color: parseFloat(successRate) >= 95 ? 'rgba(34,197,94,0.95)' : 'rgba(251,191,36,0.95)' }}>
                              成功率 {successRate}%
                            </span>
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
        </Card>

        {/* 右侧：模型需求配置与监控 */}
        <div className="flex flex-col gap-4 min-h-0">
          {!selectedApp ? (
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
                        {selectedApp.displayName}
                      </h3>
                      {selectedApp.isAutoRegistered && (
                        <Badge variant="subtle" size="sm">
                          自动注册
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                      {selectedApp.description || '暂无描述'}
                    </div>
                    <div className="mt-3 flex items-center gap-4 text-[12px]">
                      <span style={{ color: 'var(--text-muted)' }}>
                        代码: <span style={{ color: 'var(--text-secondary)' }}>{selectedApp.appCode}</span>
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        总调用: <span style={{ color: 'var(--text-secondary)' }}>{selectedApp.totalCalls.toLocaleString()}</span>
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        成功: <span style={{ color: 'rgba(34,197,94,0.95)' }}>{selectedApp.successCalls.toLocaleString()}</span>
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        失败: <span style={{ color: 'rgba(239,68,68,0.95)' }}>{selectedApp.failedCalls.toLocaleString()}</span>
                      </span>
                    </div>
                  </div>
                  <Button variant="secondary" size="xs" onClick={() => handleDeleteApp(selectedApp.id)}>
                    <Trash2 size={14} />
                  </Button>
                </div>
              </Card>

              {/* 模型需求列表 */}
              <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-auto">
                <div className="flex items-center justify-between">
                  <h4 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    模型需求与分组配置
                  </h4>
                  <Button variant="secondary" size="xs" onClick={handleAddRequirement}>
                    <Plus size={14} />
                    添加需求
                  </Button>
                </div>

                {selectedApp.modelRequirements.length === 0 ? (
                  <Card className="flex-1 flex items-center justify-center">
                    <div className="text-center" style={{ color: 'var(--text-muted)' }}>
                      <Zap size={48} className="mx-auto mb-4 opacity-40" />
                      <div className="text-sm">暂无模型需求配置</div>
                      <div className="mt-1 text-[12px]">将使用系统默认模型</div>
                    </div>
                  </Card>
                ) : (
                  <div className="space-y-4">
                    {selectedApp.modelRequirements.map((req: AppModelRequirement, idx: number) => {
                      const group = modelGroups.find((g) => g.id === req.modelGroupId);
                      const monitoring = req.modelGroupId ? monitoringData[req.modelGroupId] : undefined;
                      const modelTypeLabel = MODEL_TYPES.find((t) => t.value === req.modelType)?.label ?? req.modelType;

                      return (
                        <Card key={idx} className="p-0 overflow-hidden">
                          {/* 需求头部 */}
                          <div className="p-4 border-b border-white/10 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <Badge variant="subtle">{modelTypeLabel}</Badge>
                              {req.isRequired && <Badge variant="success">必需</Badge>}
                              <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                                {req.purpose || '未设置用途'}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handleEditRequirement(req)}
                                className="h-8 w-8 inline-flex items-center justify-center rounded-[10px] hover:bg-white/5"
                              >
                                <Pencil size={14} style={{ color: 'var(--text-muted)' }} />
                              </button>
                              <button
                                onClick={() => handleDeleteRequirement(req)}
                                className="h-8 w-8 inline-flex items-center justify-center rounded-[10px] hover:bg-white/5"
                              >
                                <Trash2 size={14} style={{ color: 'var(--text-muted)' }} />
                              </button>
                            </div>
                          </div>

                          {/* 分组信息 */}
                          <div className="p-4">
                            {!group ? (
                              <div className="text-center py-4" style={{ color: 'var(--text-muted)' }}>
                                <div className="text-[13px]">未绑定分组，将使用默认分组</div>
                              </div>
                            ) : (
                              <div>
                                <div className="mb-3 flex items-center gap-2">
                                  <div className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                                    分组：{group.name}
                                  </div>
                                  {group.description && (
                                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                      {group.description}
                                    </div>
                                  )}
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
                                              <Tooltip content="模拟降权">
                                                <button
                                                  onClick={() => handleSimulateDowngrade(group.id, model.modelId, model.platformId)}
                                                  className="h-8 w-8 inline-flex items-center justify-center rounded-[10px] hover:bg-white/5"
                                                >
                                                  <TrendingDown size={14} style={{ color: 'var(--text-muted)' }} />
                                                </button>
                                              </Tooltip>
                                              <Tooltip content="模拟恢复">
                                                <button
                                                  onClick={() => handleSimulateRecover(group.id, model.modelId, model.platformId)}
                                                  className="h-8 w-8 inline-flex items-center justify-center rounded-[10px] hover:bg-white/5"
                                                >
                                                  <TrendingUp size={14} style={{ color: 'var(--text-muted)' }} />
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
