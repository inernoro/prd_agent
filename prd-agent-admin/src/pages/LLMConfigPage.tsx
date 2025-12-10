import { useEffect, useState } from 'react';
import {
  Card,
  Table,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Tag,
  Space,
  message,
  Popconfirm,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, CheckOutlined } from '@ant-design/icons';
import {
  getLLMConfigs,
  createLLMConfig,
  updateLLMConfig,
  deleteLLMConfig,
  activateLLMConfig,
} from '../services/api';

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
      message.error('加载配置失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (values: any) => {
    try {
      if (editingConfig) {
        await updateLLMConfig(editingConfig.id, values);
        message.success('配置更新成功');
      } else {
        await createLLMConfig(values);
        message.success('配置创建成功');
      }
      setModalVisible(false);
      form.resetFields();
      setEditingConfig(null);
      loadConfigs();
    } catch (error) {
      message.error('操作失败');
    }
  };

  const handleDelete = async (configId: string) => {
    try {
      await deleteLLMConfig(configId);
      message.success('配置删除成功');
      loadConfigs();
    } catch (error) {
      message.error('删除失败');
    }
  };

  const handleActivate = async (configId: string) => {
    try {
      await activateLLMConfig(configId);
      message.success('已设为默认配置');
      loadConfigs();
    } catch (error) {
      message.error('操作失败');
    }
  };

  const openEditModal = (config: LLMConfig) => {
    setEditingConfig(config);
    form.setFieldsValue({
      ...config,
      apiKey: '', // 不回显API Key
    });
    setModalVisible(true);
  };

  const columns = [
    {
      title: '服务商',
      dataIndex: 'provider',
      key: 'provider',
      render: (provider: string, record: LLMConfig) => (
        <div>
          <span className="font-medium">{provider}</span>
          {record.isActive && (
            <Tag color="green" className="ml-2">默认</Tag>
          )}
        </div>
      ),
    },
    {
      title: '模型',
      dataIndex: 'model',
      key: 'model',
    },
    {
      title: 'API Key',
      dataIndex: 'apiKeyMasked',
      key: 'apiKeyMasked',
      render: (key: string) => <code className="text-xs">{key}</code>,
    },
    {
      title: 'Max Tokens',
      dataIndex: 'maxTokens',
      key: 'maxTokens',
    },
    {
      title: 'Temperature',
      dataIndex: 'temperature',
      key: 'temperature',
    },
    {
      title: '限流',
      dataIndex: 'rateLimitPerMinute',
      key: 'rateLimitPerMinute',
      render: (limit: number) => `${limit}/分钟`,
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: any, record: LLMConfig) => (
        <Space>
          {!record.isActive && (
            <Button
              size="small"
              icon={<CheckOutlined />}
              onClick={() => handleActivate(record.id)}
            >
              设为默认
            </Button>
          )}
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => openEditModal(record)}
          >
            编辑
          </Button>
          <Popconfirm
            title="确定要删除此配置吗？"
            onConfirm={() => handleDelete(record.id)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-800">LLM配置</h1>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            setEditingConfig(null);
            form.resetFields();
            setModalVisible(true);
          }}
        >
          添加配置
        </Button>
      </div>

      <Card>
        <Table
          columns={columns}
          dataSource={configs}
          rowKey="id"
          loading={loading}
          pagination={false}
        />
      </Card>

      <Modal
        title={editingConfig ? '编辑配置' : '添加配置'}
        open={modalVisible}
        onCancel={() => {
          setModalVisible(false);
          setEditingConfig(null);
          form.resetFields();
        }}
        footer={null}
        width={600}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          initialValues={{
            provider: 'Claude',
            maxTokens: 4096,
            temperature: 0.7,
            topP: 0.95,
            rateLimitPerMinute: 60,
            isActive: false,
          }}
        >
          <Form.Item
            name="provider"
            label="服务商"
            rules={[{ required: true }]}
          >
            <Select>
              <Select.Option value="Claude">Claude</Select.Option>
              <Select.Option value="OpenAI">OpenAI</Select.Option>
            </Select>
          </Form.Item>

          <Form.Item
            name="model"
            label="模型名称"
            rules={[{ required: true }]}
          >
            <Input placeholder="如 claude-3-5-sonnet-20241022" />
          </Form.Item>

          <Form.Item
            name="apiKey"
            label="API Key"
            rules={[{ required: !editingConfig }]}
          >
            <Input.Password placeholder={editingConfig ? '留空则保持原有Key' : '输入API Key'} />
          </Form.Item>

          <Form.Item name="apiEndpoint" label="API端点（可选）">
            <Input placeholder="自定义代理地址" />
          </Form.Item>

          <div className="grid grid-cols-2 gap-4">
            <Form.Item name="maxTokens" label="Max Tokens">
              <InputNumber min={1} max={100000} className="w-full" />
            </Form.Item>

            <Form.Item name="temperature" label="Temperature">
              <InputNumber min={0} max={2} step={0.1} className="w-full" />
            </Form.Item>

            <Form.Item name="topP" label="Top P">
              <InputNumber min={0} max={1} step={0.05} className="w-full" />
            </Form.Item>

            <Form.Item name="rateLimitPerMinute" label="限流（每分钟）">
              <InputNumber min={1} max={1000} className="w-full" />
            </Form.Item>
          </div>

          <Form.Item name="isActive" label="设为默认" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" block>
              {editingConfig ? '保存修改' : '创建配置'}
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}


