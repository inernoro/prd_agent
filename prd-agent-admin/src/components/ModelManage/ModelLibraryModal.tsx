import { useState, useEffect, useMemo } from 'react';
import { Modal, Input, Spin, Tag, Empty, message, Badge } from 'antd';
import { SearchOutlined, PlusOutlined, CheckOutlined } from '@ant-design/icons';
import { getAvailableModels, batchAddModelsFromPlatform } from '../../services/api';
import type { LLMPlatform, AvailableModel } from '../../types';

interface Props {
  open: boolean;
  platforms: LLMPlatform[];
  onClose: () => void;
  onSuccess: () => void;
}

export default function ModelLibraryModal({ open, platforms, onClose, onSuccess }: Props) {
  const [selectedPlatformId, setSelectedPlatformId] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [addedModels, setAddedModels] = useState<Set<string>>(new Set());
  const [addingModels, setAddingModels] = useState<Set<string>>(new Set());

  // 启用的平台
  const enabledPlatforms = useMemo(() => 
    platforms.filter(p => p.enabled), 
    [platforms]
  );

  useEffect(() => {
    if (open && enabledPlatforms.length > 0 && !selectedPlatformId) {
      setSelectedPlatformId(enabledPlatforms[0].id);
    }
    if (!open) {
      setAddedModels(new Set());
      setSearchText('');
    }
  }, [open, enabledPlatforms, selectedPlatformId]);

  useEffect(() => {
    if (selectedPlatformId) {
      loadAvailableModels(selectedPlatformId);
    }
  }, [selectedPlatformId]);

  const loadAvailableModels = async (platformId: string) => {
    setLoading(true);
    try {
      const res = await getAvailableModels(platformId) as unknown as { success: boolean; data: AvailableModel[] };
      if (res.success) {
        setAvailableModels(res.data);
      }
    } catch {
      setAvailableModels([]);
    } finally {
      setLoading(false);
    }
  };

  // 从模型名称中智能提取分组
  const extractGroupFromModelName = (modelName: string): string => {
    const name = modelName.toLowerCase();
    
    // 常见模型系列的正则匹配规则
    const patterns: [RegExp, (match: RegExpMatchArray) => string][] = [
      // Qwen 系列: qwen2.5-coder, qwen2.5-vl, qwen3-235b, qwen3-embedding, qwen3-reranker
      [/^(qwen\d*\.?\d*)-([a-z]+)/i, (m) => `${m[1]}-${m[2]}`.toLowerCase()],
      // GPT 系列: gpt-4, gpt-4o, gpt-3.5-turbo
      [/^(gpt-\d+\.?\d*[a-z]*)/i, (m) => m[1].toLowerCase()],
      // Claude 系列: claude-3, claude-3.5-sonnet
      [/^(claude-\d+\.?\d*)/i, (m) => m[1].toLowerCase()],
      // Gemini 系列
      [/^(gemini-\d*\.?\d*[a-z]*)/i, (m) => m[1].toLowerCase()],
      // DeepSeek 系列
      [/^(deepseek-[a-z]+)/i, (m) => m[1].toLowerCase()],
      // GLM 系列
      [/^(glm-\d+[a-z]*)/i, (m) => m[1].toLowerCase()],
      // ERNIE 系列
      [/^(ernie-[a-z0-9.-]+)/i, (m) => m[1].toLowerCase()],
      // Llama 系列
      [/^(llama-?\d*\.?\d*)/i, (m) => m[1].toLowerCase().replace(/-$/, '')],
      // Mixtral/Mistral 系列
      [/^(mixtral|mistral)[-_]?(\d*x?\d*)?/i, (m) => m[2] ? `${m[1]}-${m[2]}`.toLowerCase() : m[1].toLowerCase()],
    ];

    for (const [pattern, extractor] of patterns) {
      const match = name.match(pattern);
      if (match) {
        return extractor(match);
      }
    }

    // 默认策略：取前两段（用 - 分隔），组成分组名
    const parts = name.split(/[-_]/);
    if (parts.length >= 2) {
      // 如果第二段是数字或版本号，合并前两段
      if (/^\d/.test(parts[1])) {
        return `${parts[0]}-${parts[1]}`;
      }
      // 否则取第一段加第二段
      return `${parts[0]}-${parts[1]}`;
    }
    
    return parts[0] || 'other';
  };

  // 按分组整理模型
  const groupedModels = useMemo(() => {
    const filtered = searchText 
      ? availableModels.filter(m => 
          m.modelName.toLowerCase().includes(searchText.toLowerCase()) ||
          m.displayName.toLowerCase().includes(searchText.toLowerCase())
        )
      : availableModels;

    const groups: Record<string, AvailableModel[]> = {};
    filtered.forEach(m => {
      // 优先使用 API 返回的 group，否则从模型名称智能提取
      const group = m.group || extractGroupFromModelName(m.modelName);
      if (!groups[group]) groups[group] = [];
      groups[group].push(m);
    });
    
    // 按分组名称排序
    const sortedGroups: Record<string, AvailableModel[]> = {};
    Object.keys(groups).sort().forEach(key => {
      sortedGroups[key] = groups[key];
    });
    
    return sortedGroups;
  }, [availableModels, searchText]);

  // 添加单个模型
  const handleAddModel = async (model: AvailableModel) => {
    if (!selectedPlatformId || addedModels.has(model.modelName) || addingModels.has(model.modelName)) return;

    setAddingModels(prev => new Set([...prev, model.modelName]));
    try {
      const res = await batchAddModelsFromPlatform(selectedPlatformId, [{
        modelName: model.modelName,
        displayName: model.displayName,
        group: model.group,
      }]) as unknown as { success: boolean; data: { added: string[]; skipped: string[] } };
      
      if (res.success && res.data.added.length > 0) {
        setAddedModels(prev => new Set([...prev, model.modelName]));
        message.success(`已添加 ${model.displayName}`);
      } else if (res.data.skipped.length > 0) {
        setAddedModels(prev => new Set([...prev, model.modelName]));
        message.info(`${model.displayName} 已存在`);
      }
    } catch {
      message.error('添加失败');
    } finally {
      setAddingModels(prev => {
        const next = new Set(prev);
        next.delete(model.modelName);
        return next;
      });
    }
  };

  // 添加一组模型
  const handleAddGroup = async (_groupName: string, models: AvailableModel[]) => {
    if (!selectedPlatformId) return;

    const modelsToAdd = models.filter(m => !addedModels.has(m.modelName));
    if (modelsToAdd.length === 0) {
      message.info('该分组下的模型已全部添加');
      return;
    }

    modelsToAdd.forEach(m => {
      setAddingModels(prev => new Set([...prev, m.modelName]));
    });

    try {
      const res = await batchAddModelsFromPlatform(selectedPlatformId, modelsToAdd.map(m => ({
        modelName: m.modelName,
        displayName: m.displayName,
        group: m.group,
      }))) as unknown as { success: boolean; data: { added: string[]; skipped: string[]; addedCount: number } };

      if (res.success) {
        res.data.added.forEach(name => {
          setAddedModels(prev => new Set([...prev, name]));
        });
        res.data.skipped.forEach(name => {
          setAddedModels(prev => new Set([...prev, name]));
        });
        message.success(`已添加 ${res.data.addedCount} 个模型`);
      }
    } catch {
      message.error('批量添加失败');
    } finally {
      modelsToAdd.forEach(m => {
        setAddingModels(prev => {
          const next = new Set(prev);
          next.delete(m.modelName);
          return next;
        });
      });
    }
  };

  const selectedPlatform = enabledPlatforms.find(p => p.id === selectedPlatformId);

  return (
    <Modal
      title={
        <div className="flex items-center gap-2">
          <span>模型库</span>
          {selectedPlatform && (
            <Tag color="blue">{selectedPlatform.name}</Tag>
          )}
        </div>
      }
      open={open}
      onCancel={() => {
        onClose();
        if (addedModels.size > 0) {
          onSuccess();
        }
      }}
      footer={null}
      width={800}
      styles={{ body: { padding: 0, maxHeight: '70vh', overflow: 'hidden' } }}
      destroyOnClose
      centered
    >
      <div className="flex" style={{ height: '60vh', maxHeight: '500px' }}>
        {/* 左侧平台列表 */}
        <div className="w-48 border-r border-white/10 overflow-y-auto">
          {enabledPlatforms.map(platform => (
            <div
              key={platform.id}
              className={`
                px-4 py-3 cursor-pointer transition-colors flex items-center gap-2
                ${selectedPlatformId === platform.id 
                  ? 'bg-cyan-500/20 border-l-2 border-cyan-500' 
                  : 'hover:bg-white/5'
                }
              `}
              onClick={() => setSelectedPlatformId(platform.id)}
            >
              <div 
                className="w-7 h-7 rounded flex items-center justify-center text-white text-xs font-bold"
                style={{ background: getPlatformColor(platform.platformType) }}
              >
                {platform.name[0].toUpperCase()}
              </div>
              <span className={selectedPlatformId === platform.id ? 'text-white' : 'text-gray-400'}>
                {platform.name}
              </span>
            </div>
          ))}
          {enabledPlatforms.length === 0 && (
            <div className="p-4 text-center text-gray-500 text-sm">
              暂无可用平台
            </div>
          )}
        </div>

        {/* 右侧模型列表 */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {/* 搜索框 */}
          <div className="p-3 border-b border-white/10">
            <Input
              prefix={<SearchOutlined className="text-gray-500" />}
              placeholder="搜索模型ID或名称"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              allowClear
            />
          </div>

          {/* 模型列表 */}
          <div className="flex-1 min-h-0 p-3" style={{ overflowY: 'auto' }}>
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <Spin tip="加载中..." />
              </div>
            ) : Object.keys(groupedModels).length === 0 ? (
              <Empty description="暂无可用模型" />
            ) : (
              <div className="space-y-4">
                {Object.entries(groupedModels).map(([group, models]) => (
                  <div key={group}>
                    {/* 分组标题 */}
                    <div 
                      className="flex items-center justify-between py-2 px-3 bg-white/5 rounded-lg mb-2 cursor-pointer hover:bg-white/10 transition-colors"
                      onClick={() => handleAddGroup(group, models)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-300">{group}</span>
                        <Badge count={models.length} style={{ backgroundColor: '#3b82f6' }} />
                      </div>
                      <PlusOutlined className="text-gray-500" />
                    </div>
                    
                    {/* 模型列表 */}
                    <div className="space-y-1">
                      {models.map(model => {
                        const isAdded = addedModels.has(model.modelName);
                        const isAdding = addingModels.has(model.modelName);
                        
                        return (
                          <div
                            key={model.modelName}
                            className={`
                              flex items-center justify-between px-3 py-2 rounded-lg transition-colors
                              ${isAdded 
                                ? 'bg-green-500/10 cursor-default' 
                                : 'hover:bg-white/5 cursor-pointer'
                              }
                            `}
                            onClick={() => !isAdded && handleAddModel(model)}
                          >
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-sm">
                                {model.displayName[0]}
                              </div>
                              <div>
                                <div className="text-gray-200">{model.displayName}</div>
                                <div className="text-xs text-gray-500">{model.modelName}</div>
                              </div>
                            </div>
                            {isAdding ? (
                              <Spin size="small" />
                            ) : isAdded ? (
                              <CheckOutlined className="text-green-500" />
                            ) : (
                              <PlusOutlined className="text-gray-500" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
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

