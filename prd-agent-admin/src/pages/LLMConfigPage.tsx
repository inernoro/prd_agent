import { useEffect, useState } from 'react';
import { Table, Button, Modal, Form, Input, InputNumber, Select, Switch, Tag, Message, Popconfirm } from '@arco-design/web-react';
import type { ColumnProps } from '@arco-design/web-react/es/Table';
import { IconPlus, IconEdit, IconDelete, IconCheck } from '@arco-design/web-react/icon';
import { getLLMConfigs, createLLMConfig, updateLLMConfig, deleteLLMConfig, activateLLMConfig } from '../services/api';

const FormItem = Form.Item;
const Option = Select.Option;

interface LLMConfig {
  id: string;
  provider: string;
  model: string;
  apiEndpoint?: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  rateLimitPerMinute: number;
  isActive: boolean;
  apiKeyMasked: string;
}

export default function LLMConfigPage() {
  const [loading, setLoading] = useState(true);
  const [configs, setConfigs] = useState<LLMConfig[]>([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingConfig, setEditingConfig] = useState<LLMConfig | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    loadConfigs();
  }, []);

  const loadConfigs = async () => {
    setLoading(true);
    try {
      const response = await getLLMConfigs() as any;
      if (response.success) {
        setConfigs(response.data);
      }
    } catch (error) {
      Message.error('加载配置失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validate();
      if (editingConfig) {
        await updateLLMConfig(editingConfig.id, values);
        Message.success('配置更新成功');
      } else {
        await createLLMConfig(values);
        Message.success('配置创建成功');
      }
      setModalVisible(false);
      form.resetFields();
      setEditingConfig(null);
      loadConfigs();
    } catch (error) {
      Message.error('操作失败');
    }
  };

  const handleDelete = async (configId: string) => {
    try {
      await deleteLLMConfig(configId);
      Message.success('配置删除成功');
      loadConfigs();
    } catch (error) {
      Message.error('删除失败');
    }
  };

  const handleActivate = async (configId: string) => {
    try {
      await activateLLMConfig(configId);
      Message.success('已设为默认配置');
      loadConfigs();
    } catch (error) {
      Message.error('操作失败');
    }
  };

  const openEditModal = (config: LLMConfig) => {
    setEditingConfig(config);
    form.setFieldsValue({ ...config, apiKey: '' });
    setModalVisible(true);
  };

  const columns: ColumnProps<LLMConfig>[] = [
    {
      title: '服务商',
      dataIndex: 'provider',
      render: (_, record) => (
        <div className="flex items-center gap-2">
          <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{record.provider}</span>
          {record.isActive && <Tag color="green" size="small">默认</Tag>}
        </div>
      ),
    },
    { 
      title: '模型', 
      dataIndex: 'model',
      render: (model) => <span style={{ color: 'var(--text-secondary)' }}>{model}</span>
    },
    {
      title: 'API Key',
      dataIndex: 'apiKeyMasked',
      render: (key) => (
        <code style={{ fontSize: 12, color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
          {key}
        </code>
      ),
    },
    { 
      title: 'Max Tokens', 
      dataIndex: 'maxTokens',
      width: 120,
      render: (val) => <span style={{ color: 'var(--text-secondary)' }}>{val}</span>
    },
    { 
      title: 'Temperature', 
      dataIndex: 'temperature',
      width: 120,
      render: (val) => <span style={{ color: 'var(--text-secondary)' }}>{val}</span>
    },
    {
      title: '限流',
      dataIndex: 'rateLimitPerMinute',
      width: 100,
      render: (limit) => <span style={{ color: 'var(--text-muted)' }}>{limit}/分钟</span>,
    },
    {
      title: '操作',
      width: 240,
      render: (_, record) => (
        <div className="flex items-center gap-2">
          {!record.isActive && (
            <Button size="mini" icon={<IconCheck />} onClick={() => handleActivate(record.id)}>
              设为默认
            </Button>
          )}
          <Button size="mini" icon={<IconEdit />} onClick={() => openEditModal(record)}>
            编辑
          </Button>
          <Popconfirm title="确定要删除此配置吗?" onOk={() => handleDelete(record.id)}>
            <Button size="mini" status="danger" icon={<IconDelete />}>删除</Button>
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <div className="animate-fadeIn">
      {/* 页面标题 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            LLM配置
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            管理大语言模型服务配置
          </p>
        </div>
        <Button
          type="primary"
          icon={<IconPlus />}
          onClick={() => {
            setEditingConfig(null);
            form.resetFields();
            form.setFieldsValue({
              provider: 'Claude',
              maxTokens: 4096,
              temperature: 0.7,
              topP: 0.95,
              rateLimitPerMinute: 60,
              isActive: false,
            });
            setModalVisible(true);
          }}
        >
          添加配置
        </Button>
      </div>

      {/* 表格卡片 */}
      <div className="card" style={{ padding: 'var(--space-5)' }}>
        <Table 
          columns={columns} 
          data={configs} 
          rowKey="id" 
          loading={loading} 
          pagination={false}
          border={false}
        />
      </div>

      {/* 弹窗 */}
      <Modal
        title={editingConfig ? '编辑配置' : '添加配置'}
        visible={modalVisible}
        onCancel={() => {
          setModalVisible(false);
          setEditingConfig(null);
          form.resetFields();
        }}
        footer={null}
        style={{ maxWidth: 560 }}
        unmountOnExit
      >
        <Form
          form={form}
          layout="vertical"
          style={{ marginTop: 'var(--space-4)' }}
        >
          <FormItem field="provider" label="服务商" rules={[{ required: true }]}>
            <Select placeholder="选择服务商">
              <Option value="Claude">Claude</Option>
              <Option value="OpenAI">OpenAI</Option>
            </Select>
          </FormItem>

          <FormItem field="model" label="模型名称" rules={[{ required: true, message: '请输入模型名称' }]}>
            <Input placeholder="如 claude-3-5-sonnet-20241022" />
          </FormItem>

          <FormItem field="apiKey" label="API Key" rules={[{ required: !editingConfig, message: '请输入API Key' }]}>
            <Input.Password placeholder={editingConfig ? '留空则保持原有Key' : '输入API Key'} />
          </FormItem>

          <FormItem field="apiEndpoint" label="API端点（可选）">
            <Input placeholder="自定义代理地址" />
          </FormItem>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
            <FormItem field="maxTokens" label="Max Tokens">
              <InputNumber min={1} max={100000} style={{ width: '100%' }} />
            </FormItem>
            <FormItem field="temperature" label="Temperature">
              <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} />
            </FormItem>
            <FormItem field="topP" label="Top P">
              <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} />
            </FormItem>
            <FormItem field="rateLimitPerMinute" label="限流（每分钟）">
              <InputNumber min={1} max={1000} style={{ width: '100%' }} />
            </FormItem>
          </div>

          <FormItem field="isActive" label="设为默认" triggerPropName="checked">
            <Switch />
          </FormItem>

          <div className="flex justify-end gap-3" style={{ marginTop: 'var(--space-6)' }}>
            <Button onClick={() => {
              setModalVisible(false);
              setEditingConfig(null);
              form.resetFields();
            }}>
              取消
            </Button>
            <Button type="primary" onClick={handleSubmit}>
              {editingConfig ? '保存修改' : '创建配置'}
            </Button>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
