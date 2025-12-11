import { useEffect } from 'react';
import { Modal, Form, Input, Select, InputNumber, Switch, message, Button } from 'antd';
import { createPlatform, updatePlatform } from '../../services/api';
import type { LLMPlatform } from '../../types';
import { PLATFORM_TYPES } from '../../types';

interface Props {
  open: boolean;
  platform: LLMPlatform | null;
  onClose: () => void;
  onSuccess: () => void;
}

export default function PlatformFormModal({ open, platform, onClose, onSuccess }: Props) {
  const [form] = Form.useForm();
  const isEdit = !!platform;

  useEffect(() => {
    if (open) {
      if (platform) {
        form.setFieldsValue({
          name: platform.name,
          platformType: platform.platformType,
          apiUrl: platform.apiUrl,
          apiKey: '', // 不回填密钥
          maxConcurrency: platform.maxConcurrency,
          enabled: platform.enabled,
          remark: platform.remark,
        });
      } else {
        form.resetFields();
      }
    }
  }, [open, platform, form]);

  const handleSubmit = async (values: Record<string, unknown>) => {
    try {
      if (isEdit) {
        await updatePlatform(platform.id, values);
        message.success('平台更新成功');
      } else {
        await createPlatform(values);
        message.success('平台创建成功');
      }
      onSuccess();
    } catch (error: unknown) {
      const err = error as { error?: { message?: string } };
      message.error(err?.error?.message || '操作失败');
    }
  };

  return (
    <Modal
      title={isEdit ? '编辑平台' : '添加平台'}
      open={open}
      onCancel={onClose}
      footer={null}
      width={560}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          platformType: 'openai',
          maxConcurrency: 5,
          enabled: true,
        }}
        className="mt-4"
      >
        <Form.Item
          name="name"
          label="平台名称"
          rules={[{ required: true, message: '请输入平台名称' }]}
        >
          <Input placeholder="例如: OpenAI官方、硅基流动" />
        </Form.Item>

        <Form.Item
          name="platformType"
          label="提供商类型"
          rules={[{ required: true }]}
        >
          <Select options={PLATFORM_TYPES.map(t => ({ value: t.value, label: t.label }))} />
        </Form.Item>

        <Form.Item
          name="apiUrl"
          label="API地址"
          rules={[{ required: true, message: '请输入API地址' }]}
          extra={
            <span className="text-xs text-gray-500">
              以 / 结尾忽略v1版本拼接 | 以 # 结尾强制使用原地址 | 默认拼接 /v1/chat/completions
            </span>
          }
        >
          <Input placeholder="https://api.openai.com" />
        </Form.Item>

        <Form.Item
          name="apiKey"
          label="API密钥"
          rules={[{ required: !isEdit, message: '请输入API密钥' }]}
        >
          <Input.Password placeholder={isEdit ? '留空则保持原密钥不变' : '输入API密钥'} />
        </Form.Item>

        <div className="grid grid-cols-2 gap-4">
          <Form.Item
            name="maxConcurrency"
            label="最大并发数"
          >
            <InputNumber min={1} max={100} className="w-full" />
          </Form.Item>

          <Form.Item
            name="enabled"
            label="启用状态"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
        </div>

        <Form.Item
          name="remark"
          label="备注"
        >
          <Input.TextArea rows={2} placeholder="可选备注信息" />
        </Form.Item>

        <Form.Item className="mb-0 mt-6">
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>
              取消
            </Button>
            <Button type="primary" htmlType="submit">
              {isEdit ? '保存修改' : '创建平台'}
            </Button>
          </div>
        </Form.Item>
      </Form>
    </Modal>
  );
}

