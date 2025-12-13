import { useState, useMemo } from 'react';
import { Modal, Input, Checkbox, Button, Message, Tag } from '@arco-design/web-react';
import { IconSearch } from '@arco-design/web-react/icon';
import { addModelsFromLibrary } from '../../services/api';
import type { LLMPlatform } from '../../types';

interface Props {
  open: boolean;
  platforms: LLMPlatform[];
  onClose: () => void;
  onSuccess: () => void;
}

// 模型库数据
const MODEL_LIBRARY = {
  'openai': {
    name: 'OpenAI',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
      { id: 'gpt-4', name: 'GPT-4' },
      { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
      { id: 'o1', name: 'o1' },
      { id: 'o1-mini', name: 'o1-mini' },
      { id: 'o1-preview', name: 'o1-preview' },
    ],
  },
  'anthropic': {
    name: 'Anthropic',
    models: [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' },
      { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
    ],
  },
  'google': {
    name: 'Google',
    models: [
      { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
    ],
  },
  'deepseek': {
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-coder', name: 'DeepSeek Coder' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
  },
  'qwen': {
    name: 'Qwen',
    models: [
      { id: 'qwen-max', name: 'Qwen Max' },
      { id: 'qwen-plus', name: 'Qwen Plus' },
      { id: 'qwen-turbo', name: 'Qwen Turbo' },
      { id: 'qwen-long', name: 'Qwen Long' },
    ],
  },
};

function getPlatformColor(type: string): string {
  const colors: Record<string, string> = {
    openai: '#10a37f',
    anthropic: '#d97706',
    google: '#4285f4',
    deepseek: '#0066ff',
    qwen: '#6366f1',
    zhipu: '#2563eb',
    moonshot: '#8b5cf6',
    doubao: '#3b82f6',
    baidu: '#2563eb',
  };
  return colors[type.toLowerCase()] || '#6366f1';
}

export function ModelLibraryModal({ open, platforms, onClose, onSuccess }: Props) {
  const [search, setSearch] = useState('');
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [selectedPlatformId, setSelectedPlatformId] = useState<string>('');
  const [loading, setLoading] = useState(false);

  // 过滤后的模型库
  const filteredLibrary = useMemo(() => {
    if (!search) return MODEL_LIBRARY;
    const result: typeof MODEL_LIBRARY = {} as typeof MODEL_LIBRARY;
    Object.entries(MODEL_LIBRARY).forEach(([key, value]) => {
      const filtered = value.models.filter(
        m => m.id.toLowerCase().includes(search.toLowerCase()) ||
             m.name.toLowerCase().includes(search.toLowerCase())
      );
      if (filtered.length > 0) {
        (result as any)[key] = { ...value, models: filtered };
      }
    });
    return result;
  }, [search]);

  const handleToggleModel = (modelId: string) => {
    setSelectedModels(prev => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    if (selectedModels.size === 0) {
      Message.warning('请至少选择一个模型');
      return;
    }
    if (!selectedPlatformId) {
      Message.warning('请选择要关联的平台');
      return;
    }
    
    setLoading(true);
    try {
      const models = Array.from(selectedModels).map(id => {
        // 从库中找到模型
        for (const provider of Object.values(MODEL_LIBRARY)) {
          const model = provider.models.find(m => m.id === id);
          if (model) {
            return { modelName: model.id, name: model.name };
          }
        }
        return { modelName: id, name: id };
      });
      
      await addModelsFromLibrary(selectedPlatformId, models);
      Message.success(`成功添加 ${models.length} 个模型`);
      onSuccess();
      setSelectedModels(new Set());
    } catch (error: unknown) {
      const err = error as { error?: { message?: string } };
      Message.error(err?.error?.message || '添加失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="模型库"
      visible={open}
      onCancel={onClose}
      footer={null}
      style={{ maxWidth: 720 }}
      unmountOnExit
    >
      <div style={{ marginTop: 'var(--space-4)' }}>
        {/* 搜索栏 */}
        <Input
          prefix={<IconSearch style={{ color: 'var(--text-muted)' }} />}
          placeholder="搜索模型..."
          value={search}
          onChange={setSearch}
          allowClear
          style={{ marginBottom: 'var(--space-4)' }}
        />

        {/* 平台选择 */}
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>
            选择要关联的平台
          </div>
          <div className="flex flex-wrap gap-2">
            {platforms.filter(p => p.enabled).map(platform => (
              <button
                key={platform.id}
                onClick={() => setSelectedPlatformId(platform.id)}
                style={{
                  padding: '8px 16px',
                  borderRadius: 'var(--radius-md)',
                  border: selectedPlatformId === platform.id 
                    ? '2px solid var(--accent)' 
                    : '1px solid var(--border-default)',
                  background: selectedPlatformId === platform.id 
                    ? 'var(--accent-muted)' 
                    : 'var(--bg-card)',
                  color: 'var(--text-primary)',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <div 
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 4,
                    background: getPlatformColor(platform.platformType),
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  {(platform.name || '?').slice(0, 1).toUpperCase()}
                </div>
                {platform.name}
              </button>
            ))}
          </div>
        </div>

        {/* 模型列表 */}
        <div 
          style={{ 
            maxHeight: 400, 
            overflowY: 'auto',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
          }}
        >
          {Object.entries(filteredLibrary).map(([key, provider]) => (
            <div key={key}>
              {/* 提供商标题 */}
              <div 
                style={{
                  padding: 'var(--space-3) var(--space-4)',
                  background: 'var(--bg-card)',
                  borderBottom: '1px solid var(--border-subtle)',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                }}
              >
                <div className="flex items-center gap-2">
                  <div 
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 'var(--radius-sm)',
                      background: getPlatformColor(key),
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#fff',
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                  >
                    {provider.name.slice(0, 1)}
                  </div>
                  <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
                    {provider.name}
                  </span>
                  <Tag size="small">{provider.models.length}</Tag>
                </div>
              </div>
              
              {/* 模型列表 */}
              <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
                {provider.models.map(model => (
                  <label
                    key={model.id}
                    className="flex items-center gap-3 p-3 cursor-pointer rounded-md transition-colors"
                    style={{
                      background: selectedModels.has(model.id) ? 'var(--accent-muted)' : 'transparent',
                    }}
                  >
                    <Checkbox
                      checked={selectedModels.has(model.id)}
                      onChange={() => handleToggleModel(model.id)}
                    />
                    <div className="flex-1">
                      <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{model.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                        {model.id}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between" style={{ marginTop: 'var(--space-5)' }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            已选择 {selectedModels.size} 个模型
          </span>
          <div className="flex gap-3">
            <Button onClick={onClose}>取消</Button>
            <Button 
              type="primary" 
              onClick={handleSubmit}
              loading={loading}
              disabled={selectedModels.size === 0 || !selectedPlatformId}
            >
              添加到平台
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
