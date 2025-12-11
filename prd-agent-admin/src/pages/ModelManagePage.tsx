import { useEffect, useState } from 'react';
import { 
  Tabs, Table, Button, Tag, Space, message, Popconfirm, Tooltip, 
  Switch, Progress
} from 'antd';
import { 
  PlusOutlined, EditOutlined, DeleteOutlined, ApiOutlined,
  StarOutlined, StarFilled, HolderOutlined, AppstoreAddOutlined
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { 
  getModels, getPlatforms, deleteModel, deletePlatform, testModel, 
  setMainModel, updateModelPriorities 
} from '../services/api';
import type { LLMModel, LLMPlatform } from '../types';
import PlatformFormModal from '../components/ModelManage/PlatformFormModal';
import ModelFormModal from '../components/ModelManage/ModelFormModal';
import ModelLibraryModal from '../components/ModelManage/ModelLibraryModal';

// 可排序行组件
function SortableRow({ children, ...props }: React.HTMLAttributes<HTMLTableRowElement> & { 'data-row-key': string }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: props['data-row-key'],
  });

  const style: React.CSSProperties = {
    ...props.style,
    transform: CSS.Transform.toString(transform),
    transition,
    cursor: 'move',
    ...(isDragging ? { opacity: 0.5, background: 'rgba(6, 182, 212, 0.1)' } : {}),
  };

  return (
    <tr {...props} ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </tr>
  );
}

export default function ModelManagePage() {
  const [activeTab, setActiveTab] = useState('models');
  const [models, setModels] = useState<LLMModel[]>([]);
  const [platforms, setPlatforms] = useState<LLMPlatform[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingModels, setTestingModels] = useState<Set<string>>(new Set());
  
  // 弹窗状态
  const [platformModalVisible, setPlatformModalVisible] = useState(false);
  const [modelModalVisible, setModelModalVisible] = useState(false);
  const [libraryModalVisible, setLibraryModalVisible] = useState(false);
  const [editingPlatform, setEditingPlatform] = useState<LLMPlatform | null>(null);
  const [editingModel, setEditingModel] = useState<LLMModel | null>(null);

  // 拖拽传感器
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

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
      message.error('加载数据失败');
    } finally {
      setLoading(false);
    }
  };


  // 处理拖拽结束
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = models.findIndex(m => m.id === active.id);
    const newIndex = models.findIndex(m => m.id === over.id);
    
    const newModels = arrayMove(models, oldIndex, newIndex);
    setModels(newModels);

    // 更新优先级
    const updates = newModels.map((m, idx) => ({ id: m.id, priority: idx + 1 }));
    try {
      await updateModelPriorities(updates);
    } catch {
      message.error('更新排序失败');
      loadData();
    }
  };

  // 测试模型
  const handleTestModel = async (model: LLMModel) => {
    setTestingModels(prev => new Set([...prev, model.id]));
    try {
      const res = await testModel(model.id) as unknown as { success: boolean; data: { success: boolean; duration: number; error?: string } };
      if (res.success && res.data.success) {
        message.success(`测试成功，耗时 ${res.data.duration}ms`);
      } else {
        message.error(`测试失败: ${res.data.error || '未知错误'}`);
      }
      loadData();
    } catch {
      message.error('测试请求失败');
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
      message.success(`已将 ${model.name} 设为主模型`);
      loadData();
    } catch {
      message.error('设置主模型失败');
    }
  };

  // 删除模型
  const handleDeleteModel = async (id: string) => {
    try {
      await deleteModel(id);
      message.success('模型已删除');
      loadData();
    } catch {
      message.error('删除失败');
    }
  };

  // 删除平台
  const handleDeletePlatform = async (id: string) => {
    try {
      await deletePlatform(id);
      message.success('平台已删除');
      loadData();
    } catch (error: unknown) {
      const err = error as { error?: { message?: string } };
      message.error(err?.error?.message || '删除失败');
    }
  };

  // 模型表格列
  const modelColumns: ColumnsType<LLMModel> = [
    {
      title: '',
      width: 30,
      render: () => <HolderOutlined className="text-gray-500" />,
    },
    {
      title: '模型',
      key: 'model',
      render: (_, record) => (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{record.name}</span>
            {record.isMain && <Tag color="gold">主模型</Tag>}
            {!record.enabled && <Tag color="default">已禁用</Tag>}
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <code>{record.modelName}</code>
            {record.group && <Tag color="blue" style={{ marginRight: 0 }}>{record.group}</Tag>}
            {record.platformName && <span>/ {record.platformName}</span>}
          </div>
        </div>
      ),
    },
    {
      title: '调用次数',
      dataIndex: 'callCount',
      key: 'callCount',
      width: 100,
      align: 'center',
    },
    {
      title: '平均耗时',
      key: 'avgDuration',
      width: 100,
      align: 'center',
      render: (_, record) => (
        <span>{record.averageDuration > 0 ? `${record.averageDuration}ms` : '-'}</span>
      ),
    },
    {
      title: '成功率',
      key: 'successRate',
      width: 120,
      render: (_, record) => (
        record.callCount > 0 ? (
          <Progress 
            percent={record.successRate} 
            size="small" 
            status={record.successRate >= 90 ? 'success' : record.successRate >= 70 ? 'normal' : 'exception'}
            format={p => `${p}%`}
          />
        ) : <span className="text-gray-500">-</span>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_, record) => (
        <Space>
          <Tooltip title="测试连接">
            <Button 
              size="small" 
              icon={<ApiOutlined />} 
              loading={testingModels.has(record.id)}
              onClick={() => handleTestModel(record)}
            />
          </Tooltip>
          <Tooltip title={record.isMain ? '当前主模型' : '设为主模型'}>
            <Button 
              size="small" 
              type={record.isMain ? 'primary' : 'default'}
              icon={record.isMain ? <StarFilled /> : <StarOutlined />}
              onClick={() => !record.isMain && handleSetMain(record)}
              disabled={record.isMain}
            />
          </Tooltip>
          <Button 
            size="small" 
            icon={<EditOutlined />} 
            onClick={() => {
              setEditingModel(record);
              setModelModalVisible(true);
            }}
          />
          <Popconfirm title="确定要删除此模型吗?" onConfirm={() => handleDeleteModel(record.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  // 平台表格列
  const platformColumns: ColumnsType<LLMPlatform> = [
    {
      title: '平台名称',
      key: 'name',
      render: (_, record) => (
        <div className="flex items-center gap-2">
          <div 
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold"
            style={{ background: getPlatformColor(record.platformType) }}
          >
            {record.name[0].toUpperCase()}
          </div>
          <div>
            <div className="font-medium">{record.name}</div>
            <div className="text-xs text-gray-500">{record.platformType}</div>
          </div>
          {!record.enabled && <Tag color="default">已禁用</Tag>}
        </div>
      ),
    },
    {
      title: 'API地址',
      dataIndex: 'apiUrl',
      key: 'apiUrl',
      render: (url: string) => (
        <code className="text-xs text-cyan-400 break-all">{url}</code>
      ),
    },
    {
      title: 'API密钥',
      dataIndex: 'apiKeyMasked',
      key: 'apiKeyMasked',
      width: 150,
      render: (key: string) => <code className="text-xs">{key}</code>,
    },
    {
      title: '并发数',
      dataIndex: 'maxConcurrency',
      key: 'maxConcurrency',
      width: 80,
      align: 'center',
    },
    {
      title: '状态',
      key: 'enabled',
      width: 80,
      render: (_, record) => (
        <Switch checked={record.enabled} disabled size="small" />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (_, record) => (
        <Space>
          <Button 
            size="small" 
            icon={<EditOutlined />} 
            onClick={() => {
              setEditingPlatform(record);
              setPlatformModalVisible(true);
            }}
          />
          <Popconfirm 
            title="确定要删除此平台吗?" 
            description="如果平台下有模型则无法删除"
            onConfirm={() => handleDeletePlatform(record.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">模型管理</h1>
      </div>

      <Tabs 
        activeKey={activeTab} 
        onChange={setActiveTab}
        tabBarExtraContent={
          activeTab === 'models' ? (
            <Space>
              <Button 
                icon={<AppstoreAddOutlined />} 
                onClick={() => setLibraryModalVisible(true)}
              >
                从平台添加
              </Button>
              <Button 
                type="primary" 
                icon={<PlusOutlined />} 
                onClick={() => {
                  setEditingModel(null);
                  setModelModalVisible(true);
                }}
              >
                手动添加
              </Button>
            </Space>
          ) : (
            <Button 
              type="primary" 
              icon={<PlusOutlined />} 
              onClick={() => {
                setEditingPlatform(null);
                setPlatformModalVisible(true);
              }}
            >
              添加平台
            </Button>
          )
        }
        items={[
          {
            key: 'models',
            label: `模型列表 (${models.length})`,
            children: (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={models.map(m => m.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <Table
                    columns={modelColumns}
                    dataSource={models}
                    rowKey="id"
                    loading={loading}
                    pagination={false}
                    components={{
                      body: {
                        row: SortableRow,
                      },
                    }}
                  />
                </SortableContext>
              </DndContext>
            ),
          },
          {
            key: 'platforms',
            label: `平台列表 (${platforms.length})`,
            children: (
              <Table
                columns={platformColumns}
                dataSource={platforms}
                rowKey="id"
                loading={loading}
                pagination={false}
              />
            ),
          },
        ]}
      />

      {/* 平台表单弹窗 */}
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

      {/* 模型表单弹窗 */}
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

      {/* 模型库弹窗 */}
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

function getPlatformColor(type: string): string {
  const colors: Record<string, string> = {
    openai: '#10a37f',
    anthropic: '#d97757',
    google: '#4285f4',
    qwen: '#6366f1',
    zhipu: '#3b82f6',
    baidu: '#2932e1',
    deepseek: '#0ea5e9',
    other: '#6b7280',
  };
  return colors[type] || colors.other;
}

