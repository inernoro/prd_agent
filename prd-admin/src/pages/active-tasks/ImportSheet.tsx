/**
 * AI 一键导入 —— 粘一段话进来，拆成一条条任务。
 *
 * 手上真正的输入从来不是「一行一件」，而是一段会议纪要、一段聊天记录。
 * 按换行切的老路子遇到「周五前把登录页改完，另外顺手看一下张三那个 bug」只能切出一条。
 *
 * 等待期不给转圈（CLAUDE.md 规则 #6）：候选任务一条条冒出来，产物本身在长。
 * 拆完不直接入库：勾选、可改标题，确认了才建 —— 机器替人做决定的地方越少，人越敢用。
 */
import { useCallback, useRef, useState } from 'react';
import { toast } from '@/lib/toast';
import { useSseStream } from '@/lib/useSseStream';
import { ACTIVE_TASK_IMPORT_STREAM, createActiveTask } from '@/services/real/activeTasks';
import type { DraftTask } from '@/services/contracts/activeTasks';
import { TaskSheet } from './TaskSheet';
import { DraftTaskList, type DraftRow } from './DraftTaskList';

export interface ImportSheetProps {
  onClose: () => void;
  /** 建完之后让调用方刷新列表 */
  onCreated: () => void;
}

export function ImportSheet({ onClose, onCreated }: ImportSheetProps) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  const { phase, start, abort } = useSseStream({
    url: ACTIVE_TASK_IMPORT_STREAM,
    method: 'POST',
    onEvent: {
      model: (d) => {
        const m = d as { model?: string; platform?: string };
        if (m?.model) setModel(`${m.model}${m.platform ? ` · ${m.platform}` : ''}`);
      },
      task: (d) => {
        const t = d as DraftTask;
        if (!t?.title) return;
        seq.current += 1;
        setRows((prev) => [...prev, { ...t, key: `d${seq.current}`, picked: true }]);
      },
      summary: (d) => setSkipped((d as { skipped?: string })?.skipped ?? null),
    },
    onError: (m) => toast.error(m || '拆解失败'),
  });

  const streaming = phase === 'connecting' || phase === 'streaming';

  const onSplit = useCallback(() => {
    if (!text.trim()) return;
    setRows([]);
    setSkipped(null);
    seq.current = 0;
    void start({ body: { text: text.trim() } });
  }, [text, start]);

  const picked = rows.filter((r) => r.picked && r.title.trim());

  const onConfirm = useCallback(async () => {
    if (streaming) { onSplit(); return; }
    if (picked.length === 0) { onSplit(); return; }
    setSaving(true);
    let ok = 0;
    // 逐条建，走既有的创建接口，不为导入另造一条批量写入路径
    for (const r of picked) {
      const res = await createActiveTask({ title: r.title.trim(), dueAt: r.dueAt ?? null });
      if (res.success) ok += 1;
    }
    setSaving(false);
    if (ok > 0) {
      toast.success(`加了 ${ok} 件`);
      onCreated();
      onClose();
    } else {
      toast.error('一条都没加上');
    }
  }, [streaming, picked, onSplit, onCreated, onClose]);

  const hasDrafts = rows.length > 0;
  const confirmLabel = hasDrafts ? (picked.length > 0 ? `加 ${picked.length} 件` : '重拆') : '拆开看看';

  return (
    <TaskSheet
      title="粘一段话进来"
      confirmLabel={confirmLabel}
      confirmDisabled={saving || (!hasDrafts && !text.trim())}
      onConfirm={() => void onConfirm()}
      onClose={() => { abort(); onClose(); }}
    >
      {!hasDrafts && (
        <textarea
          className="atb-input"
          style={{ minHeight: 140 }}
          placeholder="会议纪要、聊天记录、需求段落都行"
          aria-label="要拆的文字"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}

      {streaming && !hasDrafts && (
        <span className="atb-sheet__hint">正在读这段话{model ? ` · ${model}` : ''}</span>
      )}

      {hasDrafts && (
        <>
          {model && <span className="atb-sheet__hint">{model}</span>}
          <DraftTaskList
            rows={rows}
            streaming={streaming}
            onToggle={(k) => setRows((p) => p.map((r) => (r.key === k ? { ...r, picked: !r.picked } : r)))}
            onRename={(k, title) => setRows((p) => p.map((r) => (r.key === k ? { ...r, title } : r)))}
          />
          {skipped && <span className="atb-sheet__hint">没要的：{skipped}</span>}
          <button className="atb-link atb-link--quiet" style={{ alignSelf: 'flex-start' }} onClick={() => { setRows([]); setSkipped(null); }}>
            换一段
          </button>
        </>
      )}
    </TaskSheet>
  );
}

export default ImportSheet;
