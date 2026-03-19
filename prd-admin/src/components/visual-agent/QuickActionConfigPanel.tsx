import { Pencil, Plus, Trash, Wand2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import { SparkleButton } from '@/components/effects/SparkleButton';
import { useSseStream } from '@/lib/useSseStream';
import { SsePhaseBar } from '@/components/sse/SsePhaseBar';
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

export type QuickActionConfigPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: QuickActionConfig[];
  onChange: (actions: QuickActionConfig[]) => void;
};

function generateId() {
  return `diy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── 编辑/新增弹窗 ───────────────────────────────

type EditDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 新增模式 */
  initial: QuickActionConfig | null;
  onSubmit: (action: QuickActionConfig) => void;
};

function QuickActionEditDialog({ open, onOpenChange, initial, onSubmit }: EditDialogProps) {
  const isNew = !initial;
  const [name, setName] = useState(initial?.name ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [editId, setEditId] = useState(initial?.id ?? generateId());

  let accumulated = '';
  const optStream = useSseStream({
    url: joinUrl(getApiBaseUrl(), '/api/prompts/optimize/stream'),
    method: 'POST',
    onTyping: (text) => {
      accumulated += text;
      setPrompt(accumulated);
    },
    onDone: () => {
      if (accumulated.trim()) toast.success('提示词优化完成');
    },
    onError: (msg) => toast.error(msg),
  });
  const optimizing = optStream.isStreaming;

  // 当 initial 变化时重置表单
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setName(initial?.name ?? '');
    setPrompt(initial?.prompt ?? '');
    setEditId(initial?.id ?? generateId());
    optStream.abort();
  }

  const handleOptimize = useCallback(async () => {
    const promptText = prompt.trim();
    if (!promptText) {
      toast.warning('请先输入提示词内容');
      return;
    }

    accumulated = '';
    await optStream.start({
      body: {
        promptKey: 'visual-agent.quick-action',
        order: 1,
        role: 'PM',
        title: name || '快捷指令优化',
        promptTemplate: promptText,
        mode: 'strict',
      },
    });
  }, [prompt, name]);

  const handleSubmit = useCallback(() => {
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName) {
      toast.warning('请输入指令名称');
      return;
    }
    if (!trimmedPrompt) {
      toast.warning('请输入提示词');
      return;
    }
    onSubmit({
      id: editId,
      name: trimmedName,
      prompt: trimmedPrompt,
      icon: initial?.icon ?? 'Wand2',
    });
    onOpenChange(false);
  }, [name, prompt, initial, onSubmit, onOpenChange]);

  const content = (
    <div className="space-y-4">
      {/* 名称 */}
      <div>
        <label
          className="block text-[12px] font-medium mb-1.5"
          style={{ color: 'var(--text-secondary)' }}
        >
          名称
        </label>
        <input
          type="text"
          className="w-full h-9 rounded-[8px] px-3 text-[13px] outline-none"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'var(--text-primary)',
          }}
          placeholder="例如：移除水印"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={20}
        />
      </div>

      {/* 提示词 */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label
            className="text-[12px] font-medium"
            style={{ color: 'var(--text-secondary)' }}
          >
            提示词
          </label>
        </div>
        {optStream.phase !== 'idle' && (
          <div className="mb-2">
            <SsePhaseBar phase={optStream.phase} message={optStream.phaseMessage} />
          </div>
        )}
        <textarea
          className="w-full rounded-[8px] px-3 py-2.5 text-[13px] outline-none resize-none"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'var(--text-primary)',
            minHeight: 100,
          }}
          placeholder="描述操作指令，例如：Remove all watermarks from this image"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={500}
          disabled={optimizing}
        />
        <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
          {prompt.length}/500
        </div>
      </div>

      {/* 底部按钮行 */}
      <div className="flex items-center justify-end gap-3 pt-1">
        <div style={{ transform: 'scale(0.55)', transformOrigin: 'right center', marginRight: -8 }}>
          <SparkleButton
            text={optimizing ? '优化中...' : 'AI 优化'}
            onClick={() => { if (!optimizing) void handleOptimize(); }}
            className={optimizing ? 'pointer-events-none opacity-60' : ''}
          />
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          disabled={optimizing}
        >
          提交
        </Button>
      </div>
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) optStream.abort();
        onOpenChange(v);
      }}
      title={isNew ? '新建快捷指令' : '编辑快捷指令'}
      maxWidth={460}
      content={content}
    />
  );
}

// ─── 主列表弹窗 ───────────────────────────────────

export function QuickActionConfigPanel({
  open,
  onOpenChange,
  actions,
  onChange,
}: QuickActionConfigPanelProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [editingAction, setEditingAction] = useState<QuickActionConfig | null>(null);

  const handleOpenNew = useCallback(() => {
    if (actions.length >= MAX_DIY_QUICK_ACTIONS) return;
    setEditingAction(null);
    setEditOpen(true);
  }, [actions.length]);

  const handleOpenEdit = useCallback(
    (action: QuickActionConfig) => {
      setEditingAction(action);
      setEditOpen(true);
    },
    [],
  );

  const handleRemove = useCallback(
    (id: string) => {
      onChange(actions.filter((a) => a.id !== id));
    },
    [actions, onChange],
  );

  const handleEditSubmit = useCallback(
    (action: QuickActionConfig) => {
      const exists = actions.some((a) => a.id === action.id);
      if (exists) {
        onChange(actions.map((a) => (a.id === action.id ? action : a)));
      } else {
        onChange([...actions, action]);
      }
    },
    [actions, onChange],
  );

  const listContent = (
    <div className="space-y-3" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
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
        <div className="space-y-1.5">
          {actions.map((action, idx) => (
            <div
              key={action.id}
              className="surface-row flex items-center gap-2 px-3 py-2.5 rounded-[10px] group/row"
            >
              <span
                className="inline-flex items-center justify-center w-6 h-6 rounded-full shrink-0"
                style={{
                  background: 'rgba(250, 204, 21, 0.14)',
                  border: '1px solid rgba(250, 204, 21, 0.30)',
                }}
              >
                <Wand2 size={11} style={{ color: 'rgba(250, 204, 21, 0.85)' }} />
              </span>
              <div className="flex-1 min-w-0">
                <div
                  className="text-[13px] font-medium truncate"
                  style={{ color: action.name ? 'var(--text-primary)' : 'var(--text-muted)' }}
                >
                  {action.name || `指令 ${idx + 1}（未命名）`}
                </div>
                {action.prompt ? (
                  <div
                    className="text-[11px] truncate mt-0.5"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {action.prompt}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="shrink-0 p-1.5 rounded-[6px] transition-colors hover:bg-white/8"
                style={{ color: 'var(--text-secondary)' }}
                title="编辑"
                onClick={() => handleOpenEdit(action)}
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                className="shrink-0 p-1.5 rounded-[6px] transition-colors hover:bg-white/8"
                style={{ color: 'rgba(239, 68, 68, 0.7)' }}
                title="删除"
                onClick={() => handleRemove(action.id)}
              >
                <Trash size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {actions.length > 0 ? (
        <div className="text-[11px] pt-1" style={{ color: 'var(--text-muted)' }}>
          已创建 {actions.length}/{MAX_DIY_QUICK_ACTIONS} 个自定义指令
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="快捷指令管理"
        description={`自定义快捷操作，点击即可对选中图片执行。最多 ${MAX_DIY_QUICK_ACTIONS} 个。`}
        maxWidth={480}
        titleAction={
          <Button
            variant="secondary"
            size="xs"
            onClick={handleOpenNew}
            disabled={actions.length >= MAX_DIY_QUICK_ACTIONS}
          >
            <Plus size={14} />
            新增
          </Button>
        }
        content={listContent}
      />

      <QuickActionEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        initial={editingAction}
        onSubmit={handleEditSubmit}
      />
    </>
  );
}
