import { GripVertical, Plus, Trash, Wand2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button } from '@/components/design/Button';
import type { QuickActionConfig } from '@/services/contracts/userPreferences';
import { MAX_DIY_QUICK_ACTIONS } from './quickActionTypes';

export type QuickActionConfigPanelProps = {
  /** 当前 DIY 快捷指令列表 */
  actions: QuickActionConfig[];
  /** 列表变更回调 */
  onChange: (actions: QuickActionConfig[]) => void;
};

function generateId() {
  return `diy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function QuickActionConfigPanel({ actions, onChange }: QuickActionConfigPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleAdd = useCallback(() => {
    if (actions.length >= MAX_DIY_QUICK_ACTIONS) return;
    const newAction: QuickActionConfig = {
      id: generateId(),
      name: '',
      prompt: '',
      icon: 'Wand2',
    };
    const next = [...actions, newAction];
    onChange(next);
    setEditingId(newAction.id);
  }, [actions, onChange]);

  const handleRemove = useCallback(
    (id: string) => {
      onChange(actions.filter((a) => a.id !== id));
      if (editingId === id) setEditingId(null);
    },
    [actions, onChange, editingId],
  );

  const handleUpdate = useCallback(
    (id: string, patch: Partial<QuickActionConfig>) => {
      onChange(actions.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    },
    [actions, onChange],
  );

  return (
    <div className="space-y-3">
      {/* 标题区 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            快捷指令
          </div>
          <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            自定义快捷操作，点击即可对选中图片执行。最多 {MAX_DIY_QUICK_ACTIONS} 个。
          </div>
        </div>
        <Button
          variant="secondary"
          size="xs"
          onClick={handleAdd}
          disabled={actions.length >= MAX_DIY_QUICK_ACTIONS}
        >
          <Plus size={14} />
          新增
        </Button>
      </div>

      {/* 列表 */}
      {actions.length === 0 ? (
        <div
          className="rounded-[12px] px-4 py-6 text-center text-[13px]"
          style={{
            border: '1px dashed rgba(255,255,255,0.12)',
            color: 'var(--text-muted)',
          }}
        >
          <Wand2 size={24} className="mx-auto mb-2 opacity-40" />
          <div>暂无自定义快捷指令</div>
          <div className="mt-1 text-[11px] opacity-60">
            点击「新增」添加你的第一个快捷指令
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {actions.map((action, idx) => {
            const isEditing = editingId === action.id;
            return (
              <div
                key={action.id}
                className="rounded-[10px] transition-colors"
                style={{
                  border: isEditing
                    ? '1px solid rgba(99, 102, 241, 0.45)'
                    : '1px solid rgba(255,255,255,0.10)',
                  background: isEditing
                    ? 'rgba(99, 102, 241, 0.06)'
                    : 'rgba(255,255,255,0.02)',
                }}
              >
                {/* 头部行 */}
                <div
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer"
                  onClick={() => setEditingId(isEditing ? null : action.id)}
                >
                  <GripVertical size={14} className="shrink-0 opacity-30" />
                  <span
                    className="inline-flex items-center justify-center w-5 h-5 rounded-full shrink-0"
                    style={{
                      background: 'rgba(250, 204, 21, 0.14)',
                      border: '1px solid rgba(250, 204, 21, 0.30)',
                    }}
                  >
                    <Wand2 size={10} style={{ color: 'rgba(250, 204, 21, 0.85)' }} />
                  </span>
                  <span
                    className="flex-1 text-[13px] font-medium truncate"
                    style={{ color: action.name ? 'var(--text-primary)' : 'var(--text-muted)' }}
                  >
                    {action.name || `指令 ${idx + 1}（未命名）`}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 p-1 rounded hover:bg-white/8 transition-colors"
                    style={{ color: 'rgba(239, 68, 68, 0.7)' }}
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemove(action.id);
                    }}
                  >
                    <Trash size={14} />
                  </button>
                </div>

                {/* 展开编辑区 */}
                {isEditing ? (
                  <div className="px-3 pb-3 space-y-2.5">
                    {/* 名称 */}
                    <div>
                      <label
                        className="block text-[11px] font-medium mb-1"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        名称
                      </label>
                      <input
                        type="text"
                        className="w-full h-8 rounded-[8px] px-2.5 text-[13px] outline-none"
                        style={{
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.12)',
                          color: 'var(--text-primary)',
                        }}
                        placeholder="例如：移除水印"
                        value={action.name}
                        onChange={(e) => handleUpdate(action.id, { name: e.target.value })}
                        maxLength={20}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>

                    {/* 提示词 */}
                    <div>
                      <label
                        className="block text-[11px] font-medium mb-1"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        提示词
                      </label>
                      <textarea
                        className="w-full rounded-[8px] px-2.5 py-2 text-[13px] outline-none resize-none"
                        style={{
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.12)',
                          color: 'var(--text-primary)',
                          minHeight: 64,
                        }}
                        placeholder="描述操作指令，例如：Remove all watermarks from this image"
                        value={action.prompt}
                        onChange={(e) => handleUpdate(action.id, { prompt: e.target.value })}
                        maxLength={500}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div
                        className="text-right text-[10px] mt-0.5"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {action.prompt.length}/500
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* 底部提示 */}
      {actions.length > 0 ? (
        <div className="text-[11px] pt-1" style={{ color: 'var(--text-muted)' }}>
          已创建 {actions.length}/{MAX_DIY_QUICK_ACTIONS} 个自定义指令
        </div>
      ) : null}
    </div>
  );
}
