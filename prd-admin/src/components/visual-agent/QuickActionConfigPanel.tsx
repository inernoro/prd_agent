import { GripVertical, Loader2, Plus, Trash, Wand2 } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { SparkleButton } from '@/components/effects/SparkleButton';
import { readSseStream } from '@/lib/sse';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/lib/toast';
import type { QuickActionConfig } from '@/services/contracts/userPreferences';
import { MAX_DIY_QUICK_ACTIONS } from './quickActionTypes';

function getApiBaseUrl() {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';
  return raw.trim().replace(/\/+$/, '');
}

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  if (!b) return `/${p}`;
  return `${b}/${p}`;
}

type PromptOptimizeStreamEvent = {
  type: 'start' | 'delta' | 'done' | 'error';
  content?: string;
  errorCode?: string;
  errorMessage?: string;
};

export type QuickActionConfigPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前 DIY 快捷指令列表 */
  actions: QuickActionConfig[];
  /** 列表变更回调 */
  onChange: (actions: QuickActionConfig[]) => void;
};

function generateId() {
  return `diy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function QuickActionConfigPanel({
  open,
  onOpenChange,
  actions,
  onChange,
}: QuickActionConfigPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [optimizingId, setOptimizingId] = useState<string | null>(null);
  const optAbortRef = useRef<AbortController | null>(null);

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
      if (optimizingId === id) {
        optAbortRef.current?.abort();
        optAbortRef.current = null;
        setOptimizingId(null);
      }
    },
    [actions, onChange, editingId, optimizingId],
  );

  const handleUpdate = useCallback(
    (id: string, patch: Partial<QuickActionConfig>) => {
      onChange(actions.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    },
    [actions, onChange],
  );

  const handleOptimize = useCallback(
    async (actionId: string) => {
      const action = actions.find((a) => a.id === actionId);
      if (!action) return;

      const promptText = (action.prompt || '').trim();
      if (!promptText) {
        toast.warning('请先输入提示词内容');
        return;
      }

      const token = useAuthStore.getState().token;
      if (!token) {
        toast.error('未登录');
        return;
      }

      // cancel any running optimize
      optAbortRef.current?.abort();
      const ac = new AbortController();
      optAbortRef.current = ac;
      setOptimizingId(actionId);

      let accumulated = '';

      let res: Response;
      try {
        const url = joinUrl(getApiBaseUrl(), '/api/prompts/optimize/stream');
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            promptKey: null,
            order: null,
            role: null,
            title: action.name || null,
            promptTemplate: promptText,
            mode: 'strict',
          }),
          signal: ac.signal,
        });
      } catch (e) {
        if (ac.signal.aborted) return;
        toast.error(`请求失败：${e instanceof Error ? e.message : '网络错误'}`);
        setOptimizingId(null);
        optAbortRef.current = null;
        return;
      }

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        toast.error(t || `HTTP ${res.status} ${res.statusText}`);
        setOptimizingId(null);
        optAbortRef.current = null;
        return;
      }

      try {
        await readSseStream(
          res,
          (evt) => {
            if (!evt.data) return;
            try {
              const obj = JSON.parse(evt.data) as PromptOptimizeStreamEvent;
              if (obj.type === 'delta' && obj.content) {
                accumulated += obj.content;
                // live-update the prompt field
                onChange(
                  actions.map((a) =>
                    a.id === actionId ? { ...a, prompt: accumulated } : a,
                  ),
                );
              } else if (obj.type === 'error') {
                toast.error(obj.errorMessage || '优化失败');
                setOptimizingId(null);
                optAbortRef.current = null;
              } else if (obj.type === 'done') {
                if (accumulated.trim()) {
                  toast.success('提示词优化完成');
                }
                setOptimizingId(null);
                optAbortRef.current = null;
              }
            } catch {
              // ignore parse errors
            }
          },
          ac.signal,
        );
      } finally {
        if (ac.signal.aborted) {
          setOptimizingId(null);
          optAbortRef.current = null;
        }
      }
    },
    [actions, onChange],
  );

  const content = (
    <div className="space-y-3" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
      {/* 列表 */}
      {actions.length === 0 ? (
        <div
          className="rounded-[12px] px-4 py-8 text-center text-[13px]"
          style={{
            border: '1px dashed rgba(255,255,255,0.12)',
            color: 'var(--text-muted)',
          }}
        >
          <Wand2 size={28} className="mx-auto mb-2.5 opacity-40" />
          <div>暂无自定义快捷指令</div>
          <div className="mt-1 text-[11px] opacity-60">
            点击右上角「新增」添加你的第一个快捷指令
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {actions.map((action, idx) => {
            const isEditing = editingId === action.id;
            const isOptimizing = optimizingId === action.id;
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
                      <div className="flex items-center justify-between mb-1">
                        <label
                          className="text-[11px] font-medium"
                          style={{ color: 'var(--text-secondary)' }}
                        >
                          提示词
                        </label>
                        {isOptimizing ? (
                          <span
                            className="inline-flex items-center gap-1 text-[11px]"
                            style={{ color: 'rgba(99, 102, 241, 0.85)' }}
                          >
                            <Loader2 size={12} className="animate-spin" />
                            优化中…
                          </span>
                        ) : null}
                      </div>
                      <textarea
                        className="w-full rounded-[8px] px-2.5 py-2 text-[13px] outline-none resize-none"
                        style={{
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.12)',
                          color: 'var(--text-primary)',
                          minHeight: 72,
                        }}
                        placeholder="描述操作指令，例如：Remove all watermarks from this image"
                        value={action.prompt}
                        onChange={(e) => handleUpdate(action.id, { prompt: e.target.value })}
                        maxLength={500}
                        onClick={(e) => e.stopPropagation()}
                        disabled={isOptimizing}
                      />
                      <div className="flex items-center justify-between mt-1">
                        <div
                          className="text-[10px]"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {action.prompt.length}/500
                        </div>
                      </div>

                      {/* AI 优化按钮 */}
                      <div className="mt-2 flex justify-end" style={{ fontSize: '13px' }}>
                        <SparkleButton
                          text={isOptimizing ? '优化中...' : 'AI 优化'}
                          onClick={() => {
                            if (!isOptimizing) handleOptimize(action.id);
                          }}
                          className={isOptimizing ? 'pointer-events-none opacity-60' : ''}
                        />
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

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="快捷指令管理"
      description={`自定义快捷操作，点击即可对选中图片执行。最多 ${MAX_DIY_QUICK_ACTIONS} 个。`}
      maxWidth={520}
      titleAction={
        <Button
          variant="secondary"
          size="xs"
          onClick={handleAdd}
          disabled={actions.length >= MAX_DIY_QUICK_ACTIONS}
        >
          <Plus size={14} />
          新增
        </Button>
      }
      content={content}
    />
  );
}
