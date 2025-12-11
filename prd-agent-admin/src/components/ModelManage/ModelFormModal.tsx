import { useEffect, useState } from 'react';
import { Modal, Form, Input, Select, InputNumber, Switch, Collapse, message, Button } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { createModel, updateModel } from '../../services/api';
import type { LLMModel, LLMPlatform } from '../../types';

interface Props {
  open: boolean;
  model: LLMModel | null;
  platforms: LLMPlatform[];
  onClose: () => void;
  onSuccess: () => void;
}

export default function ModelFormModal({ open, model, platforms, onClose, onSuccess }: Props) {
  const [form] = Form.useForm();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const isEdit = !!model;

  useEffect(() => {
    if (open) {
      if (model) {
        form.setFieldsValue({
          name: model.name,
          modelName: model.modelName,
          group: model.group,
          platformId: model.platformId,
          apiUrl: model.apiUrl,
          apiKey: '',
          timeout: model.timeout,
          maxRetries: model.maxRetries,
          maxConcurrency: model.maxConcurrency,
          enabled: model.enabled,
          remark: model.remark,
        });
        setShowAdvanced(true);
      } else {
        form.resetFields();
        setShowAdvanced(false);
      }
    }
  }, [open, model, form]);

  const handleSubmit = async (values: Record<string, unknown>) => {
    try {
      if (isEdit) {
        await updateModel(model.id, values);
        message.success('模型更新成功');
      } else {
        await createModel(values);
        message.success('模型创建成功');
      }
      onSuccess();
    } catch (error: unknown) {
      const err = error as { error?: { message?: string } };
      message.error(err?.error?.message || '操作失败');
    }
  };

  return (
    <Modal
      title={isEdit ? '编辑模型' : '添加模型'}
      open={open}
      onCancel={onClose}
      footer={null}
      width={600}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          timeout: 360000,
          maxRetries: 3,
          maxConcurrency: 5,
          enabled: true,
        }}
        className="mt-4"
      >
        {/* 基础配置 */}
        <div className="mb-4">
          <div className="text-sm text-gray-400 mb-3">基础配置</div>
          
          <Form.Item
            name="modelName"
            label="模型ID"
            rules={[{ required: true, message: '请输入模型ID' }]}
            extra="实际调用时使用的模型名称，如: gpt-4o, claude-3-5-sonnet-20241022"
          >
            <Input placeholder="gpt-4o" />
          </Form.Item>

          <Form.Item
            name="name"
            label="显示名称"
            rules={[{ required: true, message: '请输入显示名称' }]}
          >
            <Input placeholder="GPT-4o" />
          </Form.Item>

          <Form.Item
            name="group"
            label="分组"
          >
            <Input placeholder="用于界面分类展示，如: gpt-4o, claude-3.5" />
          </Form.Item>
        </div>

        {/* 高级配置 */}
        <Collapse
          ghost
          activeKey={showAdvanced ? ['advanced'] : []}
          onChange={(keys) => setShowAdvanced(keys.includes('advanced'))}
          items={[
            {
              key: 'advanced',
              label: (
                <span className="text-gray-400">
                  <SettingOutlined className="mr-2" />
                  高级配置
                </span>
              ),
              children: (
                <>
                  <Form.Item
                    name="platformId"
                    label="关联平台"
                    extra="选择平台后将继承平台的API地址和密钥"
                  >
                    <Select
                      allowClear
                      placeholder="选择平台（可选）"
                      options={platforms.filter(p => p.enabled).map(p => ({
                        value: p.id,
                        label: p.name,
                      }))}
                    />
                  </Form.Item>

                  <Form.Item
                    name="apiUrl"
                    label="API地址"
                    extra="留空则使用平台的API地址"
                  >
                    <Input placeholder="https://api.openai.com/v1/chat/completions" />
                  </Form.Item>

                  <Form.Item
                    name="apiKey"
                    label="API密钥"
                    extra={isEdit ? '留空则保持原密钥不变，或使用平台密钥' : '留空则使用平台密钥'}
                  >
                    <Input.Password placeholder="输入API密钥" />
                  </Form.Item>

                  <div className="grid grid-cols-3 gap-4">
                    <Form.Item
                      name="timeout"
                      label="超时时间(ms)"
                    >
                      <InputNumber min={1000} max={600000} className="w-full" />
                    </Form.Item>

                    <Form.Item
                      name="maxRetries"
                      label="最大重试"
                    >
                      <InputNumber min={0} max={10} className="w-full" />
                    </Form.Item>

                    <Form.Item
                      name="maxConcurrency"
                      label="最大并发"
                    >
                      <InputNumber min={1} max={100} className="w-full" />
                    </Form.Item>
                  </div>

                  <Form.Item
                    name="remark"
                    label="备注"
                  >
                    <Input.TextArea rows={2} placeholder="可选备注信息" />
                  </Form.Item>

                  <Form.Item
                    name="enabled"
                    label="启用状态"
                    valuePropName="checked"
                  >
                    <Switch />
                  </Form.Item>
                </>
              ),
            },
          ]}
        />

        <Form.Item className="mb-0 mt-6">
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>
              取消
            </Button>
            <Button type="primary" htmlType="submit">
              {isEdit ? '保存修改' : '创建模型'}
            </Button>
          </div>
        </Form.Item>
      </Form>
    </Modal>
  );
}

