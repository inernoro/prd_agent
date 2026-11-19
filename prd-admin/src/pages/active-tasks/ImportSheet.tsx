/**
 * AI 一键导入 —— 粘一段话进来，拆成一条条任务。
 *
 * 手上真正的输入从来不是「一行一件」，而是一段会议纪要、一段聊天记录。
 * 按换行切的老路子遇到「周五前把登录页改完，另外顺手看一下张三那个 bug」只能切出一条。
 *
 * 等待期不给转圈（CLAUDE.md 规则 #6）：候选任务一条条冒出来，产物本身在长。
 * 拆完可以勾选、改标题、补任务，确认后才创建。
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
  const [focusKey, setFocusKey] = useState<string>();
  const seq = useRef(0);

  const { phase, start, abort, reset } = useSseStream({
    url: ACTIVE_TASK_IMPORT_STREAM,
    method: 'POST',
    onEvent: {
      model: (d) => {
        const m = d as { model?: string; platform?: string };
        if (m?.model) setModel(`${m.model}${m.platform ? ` · ${m.platform}` : ''}`);
      },
      task: (d) => {
        const t = d as DraftTask;
        if (typeof t?.title !== 'string' || !t.title.trim()) return;
        const key = `d${++seq.current}`;
        setRows((prev) => [...prev, { ...t, key, picked: true }]);
      },
      summary: (d) => setSkipped((d as { skipped?: string })?.skipped ?? null),
    },
    onError: (m) => toast.error(m || '拆解失败'),
  });

  const streaming = phase === 'connecting' || phase === 'streaming';
  const hasDrafts = rows.length > 0;
  const reviewing = phase === 'done' || phase === 'error';
  const picked = rows.filter((r) => r.picked && r.title.trim());

  const onConfirm = async () => {
    if (streaming || saving) return;
    if (!reviewing) {
      if (text.trim()) void start({ body: { text: text.trim() } });
      return;
    }
    if (!picked.length) return;
    setSaving(true);
    const created = new Set<string>();
    // 逐条建，走既有的创建接口，不为导入另造一条批量写入路径
    for (const r of picked) {
      const res = await createActiveTask({ title: r.title.trim(), dueAt: r.dueAt ?? null });
      if (res.success) created.add(r.key);
      else if (res.error.code === 'AUTH_SESSION_CHANGED') break;
    }
    setSaving(false);

    const failed = picked.filter((r) => !created.has(r.key));
    if (failed.length > 0) {
      setRows((p) => p.filter((r) => !created.has(r.key)));
      toast.error(created.size > 0
        ? `已加 ${created.size} 件，余下 ${failed.length} 件添加失败，可以重试`
        : '任务添加失败，草稿已保留，可以重试');
      if (created.size > 0) onCreated();
      return;
    }

    toast.success(`加了 ${created.size} 件`);
    onCreated();
    onClose();
  };

  const addDraft = () => {
    const key = `d${++seq.current}`;
    setRows((p) => [...p, { key, title: '', picked: true }]);
    setFocusKey(key);
  };

  const changeText = () => {
    setRows([]);
    setModel(null);
    setSkipped(null);
    setFocusKey(undefined);
    reset();
  };

  // 与 SuggestionsSheet 同一口径：建任务那几秒不许关窗，abort() 掐不断已经在跑的创建循环
  const onRequestClose = useCallback(() => {
    if (saving) { toast.error('正在加任务，先等这几秒'); return; }
    abort();
    onClose();
  }, [saving, abort, onClose]);

  return (
    <TaskSheet
      title="粘一段话进来"
      confirmLabel={saving ? '正在添加…' : reviewing || hasDrafts ? `加 ${picked.length} 件` : '拆开看看'}
      // 与 SuggestionsSheet 同一口径：流没完不许确认（那边点下去会丢掉后面才生成的条目）
      confirmDisabled={saving || streaming || (reviewing ? !picked.length : !text.trim())}
      onConfirm={() => void onConfirm()}
      onClose={onRequestClose}
    >
      {!hasDrafts && !reviewing && (
        <textarea
          className="atb-input"
          style={{ minHeight: 140 }}
          placeholder="会议纪要、聊天记录、需求段落都行"
          aria-label="要拆的文字"
          value={text}
          disabled={streaming}
          onChange={(e) => setText(e.target.value)}
        />
      )}

      {/* 第一条拆出来之前那段等待往往是最长的一段（模型还在读全文），
          而骨架住在 DraftTaskList 里、要等有行了才挂上。只留一句静止的话
          就是规则 #6 说的「静止的加载中超过 2 秒即为体验缺陷」。 */}
      {streaming && !hasDrafts && (
        <>
          <span className="atb-sheet__hint">正在读这段话{model ? ` · ${model}` : ''}</span>
          <div className="atb-list" role="list" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div className="atb-row" key={i}>
                <div className="atb-row__body"><span className="atb-skeleton" /></div>
              </div>
            ))}
          </div>
        </>
      )}

      {(hasDrafts || reviewing) && (
        <>
          {model && <span className="atb-sheet__hint">{model}</span>}
          {reviewing && (
            <>
              <span className="atb-sheet__hint">
                {hasDrafts ? `共 ${rows.length} 条草稿，可直接修改标题` : '暂无草稿，可以手动新增一条。'}
              </span>
              <div className="atb-import-actions">
                <button type="button" className="atb-link" disabled={saving} onClick={addDraft}>新增一条</button>
                <button type="button" className="atb-link atb-link--quiet" disabled={saving} onClick={changeText}>换一段</button>
              </div>
            </>
          )}
          <DraftTaskList
            rows={rows}
            streaming={streaming}
            disabled={saving}
            focusKey={focusKey}
            onToggle={(k) => setRows((p) => p.map((r) => (r.key === k ? { ...r, picked: !r.picked } : r)))}
            onRename={(k, title) => setRows((p) => p.map((r) => (r.key === k ? { ...r, title } : r)))}
          />
          {skipped && <span className="atb-sheet__hint">没要的：{skipped}</span>}
        </>
      )}
    </TaskSheet>
  );
}

export default ImportSheet;
