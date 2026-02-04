import { useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useToolboxStore } from '@/stores/toolboxStore';
import { ArrowLeft, Save, Loader2 } from 'lucide-react';

const EMOJI_OPTIONS = ['🤖', '💡', '🎯', '📊', '🔧', '🎨', '✨', '🚀', '📝', '💬', '🔍', '⚡', '🌟', '🎪', '🎭', '🎮'];

export function ToolEditor() {
  const { view, editingItem, saveItem, backToGrid } = useToolboxStore();
  const [form, setForm] = useState({
    name: editingItem?.name || '',
    description: editingItem?.description || '',
    icon: editingItem?.icon || '🤖',
    prompt: editingItem?.prompt || '',
    tags: editingItem?.tags?.join(', ') || '',
  });
  const [saving, setSaving] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  const isEdit = view === 'edit';
  const title = isEdit ? '编辑智能体' : '创建智能体';

  const handleSave = async () => {
    if (!form.name.trim() || !form.prompt.trim()) return;

    setSaving(true);
    const success = await saveItem({
      ...(editingItem?.id ? { id: editingItem.id } : {}),
      name: form.name.trim(),
      description: form.description.trim(),
      icon: form.icon,
      prompt: form.prompt.trim(),
      tags: form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      type: 'custom',
      category: 'custom',
    });
    setSaving(false);

    if (!success) {
      alert('保存失败，请重试');
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      {/* Header */}
      <TabBar
        title={title}
        icon={<span className="text-lg">{form.icon}</span>}
        items={[]}
        activeKey=""
        onChange={() => {}}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={backToGrid}>
              <ArrowLeft size={14} />
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={saving || !form.name.trim() || !form.prompt.trim()}
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              保存
            </Button>
          </div>
        }
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <div className="max-w-2xl mx-auto space-y-4 pb-4">
          {/* Basic Info */}
          <GlassCard className="p-4">
            <div className="text-sm font-medium mb-4" style={{ color: 'var(--text-primary)' }}>
              基本信息
            </div>

            {/* Icon */}
            <div className="mb-4">
              <label className="block text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                图标
              </label>
              <div className="relative">
                <button
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                  className="w-16 h-16 rounded-xl flex items-center justify-center text-3xl border transition-colors hover:border-[var(--accent-primary)]"
                  style={{
                    background: 'var(--bg-base)',
                    borderColor: 'var(--border-default)',
                  }}
                >
                  {form.icon}
                </button>
                {showEmojiPicker && (
                  <div
                    className="absolute top-full left-0 mt-2 p-2 rounded-lg border shadow-lg z-10 grid grid-cols-8 gap-1"
                    style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-default)' }}
                  >
                    {EMOJI_OPTIONS.map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => {
                          setForm({ ...form, icon: emoji });
                          setShowEmojiPicker(false);
                        }}
                        className="w-8 h-8 rounded flex items-center justify-center text-lg hover:bg-[var(--bg-hover)]"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Name */}
            <div className="mb-4">
              <label className="block text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                名称 <span style={{ color: 'var(--status-error)' }}>*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="给你的智能体起个名字"
                className="w-full px-3 py-2 rounded-lg border text-sm outline-none"
                style={{
                  background: 'var(--bg-base)',
                  borderColor: 'var(--border-default)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>

            {/* Description */}
            <div className="mb-4">
              <label className="block text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                描述
              </label>
              <input
                type="text"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="简单描述这个智能体能做什么"
                className="w-full px-3 py-2 rounded-lg border text-sm outline-none"
                style={{
                  background: 'var(--bg-base)',
                  borderColor: 'var(--border-default)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>

            {/* Tags */}
            <div>
              <label className="block text-xs mb-2" style={{ color: 'var(--text-muted)' }}>
                标签（用逗号分隔）
              </label>
              <input
                type="text"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                placeholder="例如：写作, 文案, 创意"
                className="w-full px-3 py-2 rounded-lg border text-sm outline-none"
                style={{
                  background: 'var(--bg-base)',
                  borderColor: 'var(--border-default)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>
          </GlassCard>

          {/* Prompt */}
          <GlassCard className="p-4">
            <div className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
              系统提示词 <span className="text-xs" style={{ color: 'var(--status-error)' }}>*</span>
            </div>
            <div className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
              定义智能体的行为和能力。用户输入将作为追加消息发送。
            </div>
            <textarea
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              placeholder={`例如：
你是一位专业的产品文案专家。请根据用户提供的产品信息，创作吸引人的营销文案。

要求：
1. 文案要简洁有力
2. 突出产品核心卖点
3. 使用情感化语言打动用户`}
              className="w-full h-64 p-3 rounded-lg border text-sm resize-none outline-none font-mono"
              style={{
                background: 'var(--bg-base)',
                borderColor: 'var(--border-default)',
                color: 'var(--text-primary)',
              }}
            />
          </GlassCard>

          {/* Tips */}
          <GlassCard className="p-4" style={{ borderColor: 'var(--accent-primary)/30' }}>
            <div className="text-sm font-medium mb-2" style={{ color: 'var(--accent-primary)' }}>
              提示
            </div>
            <ul className="text-xs space-y-1" style={{ color: 'var(--text-muted)' }}>
              <li>• 明确定义智能体的角色和专长</li>
              <li>• 提供清晰的输出格式要求</li>
              <li>• 可以包含示例来引导输出风格</li>
              <li>• 创建后可以在"我创建的"分类中找到</li>
            </ul>
          </GlassCard>
        </div>
      </div>
    </div>
  );
}
