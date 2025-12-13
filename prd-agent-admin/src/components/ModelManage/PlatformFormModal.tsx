import { useEffect } from 'react';
import { Modal, Form, Input, Select, InputNumber, Switch, Message, Button } from '@arco-design/web-react';
import { createPlatform, updatePlatform } from '../../services/api';
import type { LLMPlatform } from '../../types';
import { PLATFORM_TYPES } from '../../types';

const FormItem = Form.Item;
const Option = Select.Option;

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
          apiKey: '',
          maxConcurrency: platform.maxConcurrency,
          enabled: platform.enabled,
          remark: platform.remark,
        });
      } else {
        form.resetFields();
        form.setFieldsValue({
          platformType: 'openai',
          maxConcurrency: 5,
          enabled: true,
        });
      }
    }
  }, [open, platform, form]);

  const handleSubmit = async () => {
    try {
      const values = await form.validate();
      if (isEdit) {
        await updatePlatform(platform.id, values);
        Message.success('平台更新成功');
      } else {
        await createPlatform(values);
        Message.success('平台创建成功');
      }
      onSuccess();
    } catch (error: unknown) {
      const err = error as { error?: { message?: string } };
      if (err?.error?.message) {
        Message.error(err.error.message);
      }
    }
  };

  return (
    <Modal
      title={isEdit ? '编辑平台' : '添加平台'}
      visible={open}
      onCancel={onClose}
      footer={null}
      style={{ maxWidth: 520 }}
      unmountOnExit
    >
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 'var(--space-4)' }}
      >
        <FormItem
          field="name"
          label="平台名称"
          rules={[{ required: true, message: '请输入平台名称' }]}
        >
          <Input placeholder="例如: OpenAI官方、硅基流动" />
        </FormItem>

        <FormItem
          field="platformType"
          label="提供商类型"
          rules={[{ required: true }]}
        >
          <Select placeholder="选择提供商">
            {PLATFORM_TYPES.map(t => (
              <Option key={t.value} value={t.value}>{t.label}</Option>
            ))}
          </Select>
        </FormItem>

        <FormItem
          field="apiUrl"
          label="API地址"
          rules={[{ required: true, message: '请输入API地址' }]}
          extra={
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              以 / 结尾忽略v1版本拼接 | 以 # 结尾强制使用原地址
            </span>
          }
        >
          <Input placeholder="https://api.openai.com" />
        </FormItem>

        <FormItem
          field="apiKey"
          label="API密钥"
          rules={[{ required: !isEdit, message: '请输入API密钥' }]}
        >
          <Input.Password placeholder={isEdit ? '留空则保持原密钥不变' : '输入API密钥'} />
        </FormItem>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
          <FormItem
            field="maxConcurrency"
            label="最大并发数"
          >
            <InputNumber min={1} max={100} style={{ width: '100%' }} />
          </FormItem>

          <FormItem
            field="enabled"
            label="启用状态"
            triggerPropName="checked"
          >
            <Switch />
          </FormItem>
        </div>

        <FormItem
          field="remark"
          label="备注"
        >
          <Input.TextArea rows={2} placeholder="可选备注信息" />
        </FormItem>

        <div className="flex justify-end gap-3" style={{ marginTop: 'var(--space-6)' }}>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" onClick={handleSubmit}>
            {isEdit ? '保存修改' : '创建平台'}
          </Button>
        </div>
      </Form>
    </Modal>
  );
}
