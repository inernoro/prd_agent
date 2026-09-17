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
    // 行号不重置，与 SuggestionsSheet 同一口径：键跨代唯一，
    // 将来这边也加「哪几行已经建过」时不会重蹈那个洞
    void start({ body: { text: text.trim() } });
  }, [text, start]);

  const picked = rows.filter((r) => r.picked && r.title.trim());

  const onConfirm = useCallback(async () => {
    if (streaming) { onSplit(); return; }
    if (picked.length === 0) { onSplit(); return; }
    setSaving(true);
    let ok = 0;
    const failed: typeof picked = [];
    // 逐条建，走既有的创建接口，不为导入另造一条批量写入路径
    for (const r of picked) {
      const res = await createActiveTask({ title: r.title.trim(), dueAt: r.dueAt ?? null });
      if (res.success) ok += 1;
      else failed.push(r);
    }
    setSaving(false);

    // 和 SuggestionsSheet 同一口径：有一条没加上就先别收摊。
    // 原来只看 ok > 0 就关窗，于是没加上的那几条连同 AI 刚拆出来的结果一起消失，
    // 用户既没看到失败、也没有重试的路（这段拆解是花了几十秒生成出来的）。
    if (failed.length > 0) {
      setRows((p) => p.map((r) => ({ ...r, picked: failed.some((f) => f.key === r.key) })));
      toast.error(ok > 0
        ? `加上了 ${ok} 件，还有 ${failed.length} 件没成，留在这儿了，可以再试一次`
        : '一条都没加上');
      if (ok > 0) onCreated();
      return;
    }

    toast.success(`加了 ${ok} 件`);
    onCreated();
    onClose();
  }, [streaming, picked, onSplit, onCreated, onClose]);

  const hasDrafts = rows.length > 0;
  const confirmLabel = hasDrafts ? (picked.length > 0 ? `加 ${picked.length} 件` : '重拆') : '拆开看看';

  // 与 SuggestionsSheet 同一口径：建任务那几秒不许关窗，abort() 掐不断已经在跑的创建循环
  const onRequestClose = useCallback(() => {
    if (saving) { toast.error('正在加任务，先等这几秒'); return; }
    abort();
    onClose();
  }, [saving, abort, onClose]);

  return (
    <TaskSheet
      title="粘一段话进来"
      confirmLabel={confirmLabel}
      // 与 SuggestionsSheet 同一口径：流没完不许确认（那边点下去会丢掉后面才生成的条目）
      confirmDisabled={saving || streaming || (!hasDrafts && !text.trim())}
      onConfirm={() => void onConfirm()}
      onClose={onRequestClose}
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
