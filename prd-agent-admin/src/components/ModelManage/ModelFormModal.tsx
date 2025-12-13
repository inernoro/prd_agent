import { useEffect, useState } from 'react';
import { Modal, Form, Input, Select, InputNumber, Switch, Collapse, Message, Button } from '@arco-design/web-react';
import { IconSettings } from '@arco-design/web-react/icon';
import { createModel, updateModel } from '../../services/api';
import type { LLMModel, LLMPlatform } from '../../types';

const FormItem = Form.Item;
const Option = Select.Option;
const CollapseItem = Collapse.Item;

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
        form.setFieldsValue({
          timeout: 360000,
          maxRetries: 3,
          maxConcurrency: 5,
          enabled: true,
        });
        setShowAdvanced(false);
      }
    }
  }, [open, model, form]);

  const handleSubmit = async () => {
    try {
      const values = await form.validate();
      if (isEdit) {
        await updateModel(model.id, values);
        Message.success('模型更新成功');
      } else {
        await createModel(values);
        Message.success('模型创建成功');
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
      title={isEdit ? '编辑模型' : '添加模型'}
      visible={open}
      onCancel={onClose}
      footer={null}
      style={{ maxWidth: 560 }}
      unmountOnExit
    >
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 'var(--space-4)' }}
      >
        {/* 基础配置 */}
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 'var(--space-3)' }}>
            基础配置
          </div>
          
          <FormItem
            field="modelName"
            label="模型ID"
            rules={[{ required: true, message: '请输入模型ID' }]}
            extra="实际调用时使用的模型名称，如: gpt-4o, claude-3-5-sonnet-20241022"
          >
            <Input placeholder="gpt-4o" />
          </FormItem>

          <FormItem
            field="name"
            label="显示名称"
            rules={[{ required: true, message: '请输入显示名称' }]}
          >
            <Input placeholder="GPT-4o" />
          </FormItem>

          <FormItem field="group" label="分组">
            <Input placeholder="用于界面分类展示，如: gpt-4o, claude-3.5" />
          </FormItem>
        </div>

        {/* 高级配置 */}
        <Collapse
          activeKey={showAdvanced ? ['advanced'] : []}
          onChange={(keys) => setShowAdvanced(keys.includes('advanced'))}
          bordered={false}
        >
          <CollapseItem
            name="advanced"
            header={
              <span style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <IconSettings />
                高级配置
              </span>
            }
          >
            <FormItem
              field="platformId"
              label="关联平台"
              extra="选择平台后将继承平台的API地址和密钥"
            >
              <Select
                allowClear
                placeholder="选择平台（可选）"
              >
                {platforms.filter(p => p.enabled).map(p => (
                  <Option key={p.id} value={p.id}>{p.name}</Option>
                ))}
              </Select>
            </FormItem>

            <FormItem
              field="apiUrl"
              label="API地址"
              extra="留空则使用平台的API地址"
            >
              <Input placeholder="https://api.openai.com/v1/chat/completions" />
            </FormItem>

            <FormItem
              field="apiKey"
              label="API密钥"
              extra={isEdit ? '留空则保持原密钥不变，或使用平台密钥' : '留空则使用平台密钥'}
            >
              <Input.Password placeholder="输入API密钥" />
            </FormItem>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-4)' }}>
              <FormItem field="timeout" label="超时时间(ms)">
                <InputNumber min={1000} max={600000} style={{ width: '100%' }} />
              </FormItem>

              <FormItem field="maxRetries" label="最大重试">
                <InputNumber min={0} max={10} style={{ width: '100%' }} />
              </FormItem>

              <FormItem field="maxConcurrency" label="最大并发">
                <InputNumber min={1} max={100} style={{ width: '100%' }} />
              </FormItem>
            </div>

            <FormItem field="remark" label="备注">
              <Input.TextArea rows={2} placeholder="可选备注信息" />
            </FormItem>

            <FormItem
              field="enabled"
              label="启用状态"
              triggerPropName="checked"
            >
              <Switch />
            </FormItem>
          </CollapseItem>
        </Collapse>

        <div className="flex justify-end gap-3" style={{ marginTop: 'var(--space-6)' }}>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" onClick={handleSubmit}>
            {isEdit ? '保存修改' : '创建模型'}
          </Button>
        </div>
      </Form>
    </Modal>
  );
}
