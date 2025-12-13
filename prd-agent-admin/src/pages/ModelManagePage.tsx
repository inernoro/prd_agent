import { useEffect, useState, useMemo } from 'react';
import { 
  Button, Tag, Message, Popconfirm, Tooltip, Input, Spin, Empty, Switch, Table, Collapse
} from '@arco-design/web-react';
import type { ColumnProps } from '@arco-design/web-react/es/Table';
import { 
  IconPlus, IconEdit, IconDelete, IconLink,
  IconStar, IconStarFill, IconApps, IconSearch,
  IconEye, IconEyeInvisible, IconSettings
} from '@arco-design/web-react/icon';
import { 
  getModels, getPlatforms, deleteModel, deletePlatform, testModel, 
  setMainModel, updateModel, updatePlatform
} from '../services/api';
import type { LLMModel, LLMPlatform } from '../types';
import PlatformFormModal from '../components/ModelManage/PlatformFormModal';
import ModelFormModal from '../components/ModelManage/ModelFormModal';
import { ModelLibraryModal } from '../components/ModelManage/ModelLibraryModal';
import { ModelIcon } from '../components/ModelManage/ModelIcon';

const CollapseItem = Collapse.Item;

// 模型类型定义
type ModelType = 'chat' | 'thinking' | 'vision' | 'embedding' | 'code' | 'audio' | 'image' | 'rerank';

// 通过模型名关键词匹配类型
function getModelType(modelName: string): ModelType {
  const n = modelName.toLowerCase();
  if (n.includes('thinking') || n.includes('think')) return 'thinking';
  if (n.includes('vision') || n.includes('-vl') || n.includes('vl-')) return 'vision';
  if (n.includes('embedding') || n.includes('embed')) return 'embedding';
  if (n.includes('rerank')) return 'rerank';
  if (n.includes('coder') || n.includes('code')) return 'code';
  if (n.includes('audio') || n.includes('tts') || n.includes('speech') || n.includes('whisper')) return 'audio';
  if (n.includes('image') || n.includes('dall') || n.includes('img')) return 'image';
  return 'chat';
}

// 模型类型配置
const MODEL_TYPE_CONFIG: Record<ModelType, { label: string; color: string }> = {
  thinking: { label: '思考', color: '#a855f7' },
  vision: { label: '视觉', color: '#06b6d4' },
  embedding: { label: '嵌入', color: '#6b7280' },
  rerank: { label: '重排', color: '#8b5cf6' },
  code: { label: '代码', color: '#22c55e' },
  audio: { label: '语音', color: '#f97316' },
  image: { label: '图像', color: '#ec4899' },
  chat: { label: '对话', color: '#3b82f6' },
};

// 模型类型标签组件
function ModelTypeTag({ modelName }: { modelName: string }) {
  const type = getModelType(modelName);
  const config = MODEL_TYPE_CONFIG[type];
  return (
    <span 
      style={{ 
        fontSize: 11,
        padding: '2px 6px',
        borderRadius: 'var(--radius-sm)',
        color: config.color, 
        background: `color-mix(in srgb, ${config.color} 15%, transparent)`,
      }}
    >
      {config.label}
    </span>
  );
}

// 从模型名称中提取分组
function extractGroupFromModelName(modelName: string): string {
  const name = modelName.toLowerCase();
  const parts = name.split('-');
  if (parts.length >= 2) {
    return `${parts[0]}-${parts[1]}`;
  }
  return parts[0] || 'other';
}

export default function ModelManagePage() {
  const [models, setModels] = useState<LLMModel[]>([]);
  const [platforms, setPlatforms] = useState<LLMPlatform[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingModels, setTestingModels] = useState<Set<string>>(new Set());
  const [togglingPlatforms, setTogglingPlatforms] = useState<Set<string>>(new Set());
  const [togglingModels, setTogglingModels] = useState<Set<string>>(new Set());
  const [selectedPlatformId, setSelectedPlatformId] = useState<string | null>('__all__');
  const [platformSearch, setPlatformSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  
  // 弹窗状态
  const [platformModalVisible, setPlatformModalVisible] = useState(false);
  const [modelModalVisible, setModelModalVisible] = useState(false);
  const [libraryModalVisible, setLibraryModalVisible] = useState(false);
  const [editingPlatform, setEditingPlatform] = useState<LLMPlatform | null>(null);
  const [editingModel, setEditingModel] = useState<LLMModel | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [modelsRes, platformsRes] = await Promise.all([
        getModels() as unknown as Promise<{ success: boolean; data: LLMModel[] }>,
        getPlatforms() as unknown as Promise<{ success: boolean; data: LLMPlatform[] }>
      ]);
      if (modelsRes.success) setModels(modelsRes.data);
      if (platformsRes.success) setPlatforms(platformsRes.data);
    } catch {
      Message.error('加载数据失败');
    } finally {
      setLoading(false);
    }
  };

  // 当前选中的平台
  const selectedPlatform = useMemo(() => 
    platforms.find(p => p.id === selectedPlatformId),
    [platforms, selectedPlatformId]
  );

  // 过滤后的平台列表
  const filteredPlatforms = useMemo(() => {
    if (!platformSearch) return platforms;
    const search = platformSearch.toLowerCase();
    return platforms.filter(p => 
      p.name.toLowerCase().includes(search) ||
      p.platformType.toLowerCase().includes(search)
    );
  }, [platforms, platformSearch]);

  // 当前平台的模型（按分组整理）
  const platformModels = useMemo(() => {
    const platformModelsList = selectedPlatformId === '__all__' 
      ? models 
      : models.filter(m => m.platformId === selectedPlatformId);
    
    const filtered = modelSearch 
      ? platformModelsList.filter(m => 
          m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
          m.modelName.toLowerCase().includes(modelSearch.toLowerCase())
        )
      : platformModelsList;

    const groups: Record<string, LLMModel[]> = {};
    filtered.forEach(m => {
      const group = m.group || extractGroupFromModelName(m.modelName);
      if (!groups[group]) groups[group] = [];
      groups[group].push(m);
    });

    const sortedEntries = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
    const sortedGroups: Record<string, LLMModel[]> = {};
    sortedEntries.forEach(([key, models]) => {
      sortedGroups[key] = models;
    });
    
    return sortedGroups;
  }, [models, selectedPlatformId, modelSearch]);

  const platformModelCount = useMemo(() => 
    Object.values(platformModels).reduce((sum, arr) => sum + arr.length, 0),
    [platformModels]
  );

  // 默认展开所有分组
  useEffect(() => {
    const groups = Object.keys(platformModels);
    if (groups.length > 0) {
      setExpandedGroups(groups.slice(0, 8));
    }
  }, [platformModels]);

  // 测试模型
  const handleTestModel = async (model: LLMModel) => {
    setTestingModels(prev => new Set([...prev, model.id]));
    try {
      const res = await testModel(model.id) as unknown as { success: boolean; data: { success: boolean; duration: number; error?: string } };
      if (res.success && res.data.success) {
        Message.success(`测试成功，耗时 ${res.data.duration}ms`);
      } else {
        Message.error(`测试失败: ${res.data.error || '未知错误'}`);
      }
      loadData();
    } catch {
      Message.error('测试请求失败');
    } finally {
      setTestingModels(prev => {
        const next = new Set(prev);
        next.delete(model.id);
        return next;
      });
    }
  };

  // 设置主模型
  const handleSetMain = async (model: LLMModel) => {
    try {
      await setMainModel(model.id);
      Message.success(`已将 ${model.name} 设为主模型`);
      loadData();
    } catch {
      Message.error('设置主模型失败');
    }
  };

  // 启用/禁用平台
  const handleTogglePlatformEnabled = async (platform: LLMPlatform, enabled: boolean) => {
    if (togglingPlatforms.has(platform.id)) return;
    setTogglingPlatforms(prev => new Set([...prev, platform.id]));
    const prevEnabled = platform.enabled;
    setPlatforms(prev => prev.map(p => (p.id === platform.id ? { ...p, enabled } : p)));
    try {
      await updatePlatform(platform.id, { enabled });
      Message.success(enabled ? '平台已启用' : '平台已禁用');
    } catch (error: unknown) {
      setPlatforms(prev => prev.map(p => (p.id === platform.id ? { ...p, enabled: prevEnabled } : p)));
      const err = error as { error?: { message?: string } };
      Message.error(err?.error?.message || '更新平台状态失败');
    } finally {
      setTogglingPlatforms(prev => {
        const next = new Set(prev);
        next.delete(platform.id);
        return next;
      });
    }
  };

  // 启用/禁用模型
  const handleToggleModelEnabled = async (model: LLMModel, enabled: boolean) => {
    if (togglingModels.has(model.id)) return;
    setTogglingModels(prev => new Set([...prev, model.id]));
    const prevEnabled = model.enabled;
    setModels(prev => prev.map(m => (m.id === model.id ? { ...m, enabled } : m)));
    try {
      await updateModel(model.id, { enabled });
      Message.success(enabled ? '模型已启用' : '模型已禁用');
    } catch (error: unknown) {
      setModels(prev => prev.map(m => (m.id === model.id ? { ...m, enabled: prevEnabled } : m)));
      const err = error as { error?: { message?: string } };
      Message.error(err?.error?.message || '更新模型状态失败');
    } finally {
      setTogglingModels(prev => {
        const next = new Set(prev);
        next.delete(model.id);
        return next;
      });
    }
  };

  const platformIdToName = useMemo(() => {
    const map = new Map<string, string>();
    platforms.forEach(p => map.set(p.id, p.name));
    return map;
  }, [platforms]);

  const modelTableColumns: ColumnProps<LLMModel>[] = useMemo(() => {
    const cols: ColumnProps<LLMModel>[] = [
      {
        title: '模型',
        dataIndex: 'name',
        width: selectedPlatformId === '__all__' ? 320 : undefined,
        render: (_: unknown, model: LLMModel) => (
          <div className="flex items-center gap-3 min-w-0">
            <ModelIcon
              modelName={model.platformName || platformIdToName.get(model.platformId || '') || model.name}
              displayName={model.platformName || model.name}
              size={32}
              className="shrink-0"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span style={{ fontSize: 13, color: 'var(--text-primary)' }} className="truncate">
                  {model.name}
                </span>
                {model.isMain && <Tag color="gold" size="small">主</Tag>}
                <ModelTypeTag modelName={model.modelName} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }} className="truncate mt-1">
                {model.modelName}
              </div>
            </div>
          </div>
        ),
      },
    ];

    if (selectedPlatformId === '__all__') {
      cols.push({
        title: '平台',
        width: 140,
        render: (_: unknown, model: LLMModel) => (
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {model.platformName || platformIdToName.get(model.platformId || '') || '-'}
          </span>
        ),
      });
    }

    cols.push(
      {
        title: '启用',
        width: 80,
        align: 'center',
        render: (_: unknown, model: LLMModel) => (
          <Switch
            size="small"
            checked={model.enabled}
            loading={togglingModels.has(model.id)}
            onChange={(checked) => handleToggleModelEnabled(model, checked)}
          />
        ),
      },
      {
        title: '操作',
        width: 140,
        align: 'right',
        render: (_: unknown, model: LLMModel) => (
          <div className="flex items-center justify-end gap-1">
            <Tooltip content="测试连接">
              <Button
                type="text"
                size="mini"
                icon={<IconLink />}
                loading={testingModels.has(model.id)}
                onClick={() => handleTestModel(model)}
              />
            </Tooltip>
            <Tooltip content={model.isMain ? '主模型' : '设为主模型'}>
              <Button
                type="text"
                size="mini"
                icon={model.isMain ? <IconStarFill style={{ color: '#f59e0b' }} /> : <IconStar />}
                onClick={() => !model.isMain && handleSetMain(model)}
                disabled={model.isMain}
              />
            </Tooltip>
            <Tooltip content="编辑">
              <Button
                type="text"
                size="mini"
                icon={<IconEdit />}
                onClick={() => {
                  setEditingModel(model);
                  setModelModalVisible(true);
                }}
              />
            </Tooltip>
            <Popconfirm
              title="确定删除此模型?"
              onOk={() => handleDeleteModel(model.id)}
            >
              <Tooltip content="删除">
                <Button type="text" size="mini" icon={<IconDelete />} status="danger" />
              </Tooltip>
            </Popconfirm>
          </div>
        ),
      }
    );

    return cols;
  }, [platformIdToName, selectedPlatformId, testingModels, togglingModels]);

  const handleDeleteModel = async (id: string) => {
    try {
      await deleteModel(id);
      Message.success('模型已删除');
      loadData();
    } catch {
      Message.error('删除失败');
    }
  };

  const handleDeletePlatform = async (id: string) => {
    try {
      await deletePlatform(id);
      Message.success('平台已删除');
      if (selectedPlatformId === id) {
        setSelectedPlatformId('__all__');
      }
      loadData();
    } catch (error: unknown) {
      const err = error as { error?: { message?: string } };
      Message.error(err?.error?.message || '删除失败');
    }
  };

  return (
    <div className="h-full flex flex-col animate-fadeIn">
      {/* 页面标题 */}
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            模型管理
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            平台 {platforms.length} 个（启用 {platforms.filter(p => p.enabled).length}） / 模型 {models.length} 个
          </p>
        </div>
      </div>

      <div className="flex-1 flex gap-6" style={{ minHeight: 0 }}>
        {/* 左侧：平台列表 */}
        <div 
          className="flex flex-col shrink-0"
          style={{
            width: 280,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-xl)',
            overflow: 'hidden',
          }}
        >
          {/* 搜索框 */}
          <div style={{ padding: 'var(--space-5)', borderBottom: '1px solid var(--border-subtle)' }}>
            <Input
              prefix={<IconSearch style={{ color: 'var(--text-muted)' }} />}
              placeholder="搜索平台..."
              value={platformSearch}
              onChange={setPlatformSearch}
              allowClear
            />
          </div>

          {/* 平台列表 */}
          <div className="flex-1 overflow-y-auto p-3" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Spin size={24} />
              </div>
            ) : (
              <>
                {/* 全部模型 */}
                <div
                  className="flex items-center gap-4 p-4 cursor-pointer transition-all rounded-lg"
                  style={{
                    background: selectedPlatformId === '__all__' ? 'var(--bg-card)' : 'transparent',
                    border: selectedPlatformId === '__all__' ? '1px solid var(--border-default)' : '1px solid transparent',
                  }}
                  onClick={() => setSelectedPlatformId('__all__')}
                >
                  <div 
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--accent)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#fff',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    All
                  </div>
                  <div className="min-w-0 flex-1">
                    <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>全部模型</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>共 {models.length} 个</div>
                  </div>
                </div>

                {/* 平台列表 */}
                {filteredPlatforms.map(platform => {
                  const modelCount = models.filter(m => m.platformId === platform.id).length;
                  const isSelected = selectedPlatformId === platform.id;
                  
                  return (
                    <div
                      key={platform.id}
                      className="flex items-center gap-4 p-4 cursor-pointer transition-all rounded-lg"
                      style={{
                        background: isSelected ? 'var(--bg-card)' : 'transparent',
                        border: isSelected ? '1px solid var(--border-default)' : '1px solid transparent',
                      }}
                      onClick={() => setSelectedPlatformId(platform.id)}
                    >
                      <ModelIcon
                        modelName={platform.platformType}
                        displayName={platform.name}
                        size={36}
                      />
                      <div className="min-w-0 flex-1">
                        <div 
                          className="truncate"
                          style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}
                        >
                          {platform.name}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {modelCount} 个模型
                        </div>
                      </div>
                      <div onClick={(e) => e.stopPropagation()}>
                        <Switch
                          size="small"
                          checked={platform.enabled}
                          loading={togglingPlatforms.has(platform.id)}
                          onChange={(checked) => handleTogglePlatformEnabled(platform, checked)}
                        />
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>

          {/* 添加平台按钮 */}
          <div style={{ padding: 'var(--space-4)', borderTop: '1px solid var(--border-subtle)' }}>
            <Button
              type="primary"
              long
              icon={<IconPlus />}
              onClick={() => {
                setEditingPlatform(null);
                setPlatformModalVisible(true);
              }}
            >
              添加平台
            </Button>
          </div>
        </div>

        {/* 右侧：模型列表 */}
        <div 
          className="flex-1 flex flex-col min-w-0"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-xl)',
            overflow: 'hidden',
          }}
        >
          {(selectedPlatformId === '__all__' || selectedPlatform) ? (
            <>
              {/* 平台详情头部 */}
              {selectedPlatform && (
                <div 
                  className="flex items-center justify-between"
                  style={{ 
                    padding: 'var(--space-4) var(--space-5)',
                    borderBottom: '1px solid var(--border-subtle)',
                    background: 'var(--bg-card)',
                  }}
                >
                  <div className="flex items-center gap-6" style={{ fontSize: 13 }}>
                    <div className="flex items-center gap-2">
                      <span style={{ color: 'var(--text-muted)' }}>API 密钥</span>
                      <button 
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
                        onClick={() => setShowApiKey(!showApiKey)}
                      >
                        {showApiKey ? <IconEyeInvisible /> : <IconEye />}
                      </button>
                      <code style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
                        {showApiKey ? selectedPlatform.apiKeyMasked : '************************'}
                      </code>
                    </div>
                    <div className="flex items-center gap-2">
                      <span style={{ color: 'var(--text-muted)' }}>API 地址</span>
                      <code style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
                        {selectedPlatform.apiUrl}
                      </code>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Tooltip content="编辑">
                      <Button 
                        type="text"
                        size="small"
                        icon={<IconEdit />}
                        onClick={() => {
                          setEditingPlatform(selectedPlatform);
                          setPlatformModalVisible(true);
                        }}
                      />
                    </Tooltip>
                    <Popconfirm 
                      title="确定删除此平台?" 
                      content="如果平台下有模型则无法删除"
                      onOk={() => handleDeletePlatform(selectedPlatform.id)}
                    >
                      <Tooltip content="删除">
                        <Button type="text" size="small" icon={<IconDelete />} status="danger" />
                      </Tooltip>
                    </Popconfirm>
                  </div>
                </div>
              )}

              {/* 模型列表头部 */}
              <div 
                className="flex items-center justify-between"
                style={{ padding: 'var(--space-4) var(--space-5)', borderBottom: '1px solid var(--border-subtle)' }}
              >
                <div className="flex items-center gap-4">
                  <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                    {selectedPlatformId === '__all__' ? '全部模型' : '模型'}
                  </span>
                  <Tag size="small">{platformModelCount}</Tag>
                  <Input
                    prefix={<IconSearch style={{ color: 'var(--text-muted)' }} />}
                    placeholder="搜索模型..."
                    value={modelSearch}
                    onChange={setModelSearch}
                    allowClear
                    style={{ width: 200 }}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button 
                    type="text"
                    size="small"
                    icon={<IconSettings />}
                    onClick={() => setLibraryModalVisible(true)}
                  >
                    管理
                  </Button>
                  <Button 
                    type="secondary"
                    size="small"
                    icon={<IconPlus />}
                    onClick={() => {
                      setEditingModel(null);
                      setModelModalVisible(true);
                    }}
                  >
                    添加
                  </Button>
                </div>
              </div>

              {/* 模型分组列表 */}
              <div className="flex-1 overflow-y-auto p-5">
                {Object.keys(platformModels).length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full">
                    <Empty
                      description="暂无模型"
                    />
                    <Button 
                      type="primary" 
                      icon={<IconApps />}
                      style={{ marginTop: 'var(--space-4)' }}
                      onClick={() => setLibraryModalVisible(true)}
                    >
                      从模型库添加
                    </Button>
                  </div>
                ) : (
                  <Collapse
                    activeKey={expandedGroups}
                    onChange={(_, keys) => setExpandedGroups(keys)}
                    bordered={false}
                  >
                    {Object.entries(platformModels).map(([group, groupModels]) => (
                      <CollapseItem
                        key={group}
                        name={group}
                        header={
                          <div className="flex items-center gap-3">
                            <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                              {group}
                            </span>
                            <Tag size="small">{groupModels.length} 个模型</Tag>
                          </div>
                        }
                      >
                        <Table
                          size="small"
                          rowKey="id"
                          columns={modelTableColumns}
                          data={groupModels}
                          pagination={false}
                          border={false}
                          noDataElement={<span style={{ color: 'var(--text-muted)' }}>暂无模型</span>}
                        />
                      </CollapseItem>
                    ))}
                  </Collapse>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center">
              <Empty description="请选择一个平台" />
              {platforms.length === 0 && (
                <Button 
                  type="primary" 
                  icon={<IconPlus />}
                  style={{ marginTop: 'var(--space-4)' }}
                  onClick={() => {
                    setEditingPlatform(null);
                    setPlatformModalVisible(true);
                  }}
                >
                  添加平台
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 弹窗 */}
      <PlatformFormModal
        open={platformModalVisible}
        platform={editingPlatform}
        onClose={() => {
          setPlatformModalVisible(false);
          setEditingPlatform(null);
        }}
        onSuccess={() => {
          setPlatformModalVisible(false);
          setEditingPlatform(null);
          loadData();
        }}
      />

      <ModelFormModal
        open={modelModalVisible}
        model={editingModel}
        platforms={platforms}
        onClose={() => {
          setModelModalVisible(false);
          setEditingModel(null);
        }}
        onSuccess={() => {
          setModelModalVisible(false);
          setEditingModel(null);
          loadData();
        }}
      />

      <ModelLibraryModal
        open={libraryModalVisible}
        platforms={platforms}
        onClose={() => setLibraryModalVisible(false)}
        onSuccess={() => {
          setLibraryModalVisible(false);
          loadData();
        }}
      />
    </div>
  );
}
